import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Provider calls with terminal and retryable outcomes',
  concept: 'grpc',
  file: 'client',
  focus: ['purge', 'cdn', 'edges'],
  task: `## Task

**Starting point.** The starter's \`submit_batch(purge_id, domain, paths)\` calls the provider's \`BatchPurge\` RPC in a loop with no deadline, mints a fresh \`batch_id\` per attempt, skips to the next attempt on any \`RpcError\`, and returns \`succeeded\` as soon as one path is accepted. It works against a healthy provider and hides five flaws.

**Failure mode the checks target.** A rejected pattern is retried until someone kills the pod, a hung connection holds the request forever, a retry after a timeout purges the same paths under a new id, a partial purge looks complete, and the per-path results an operator needs are thrown away.

- \`BatchPurgeRequest\` carries \`batch_id\`, \`domain\`, the \`patterns\` still being attempted and the \`attempt\` number; \`BatchPurgeReply\` carries one \`results\` entry per pattern.
- Every path ends in \`accepted\`, \`invalid_pattern\` or \`failed\`, and the result carries the full \`outcomes\` map.
- \`invalid_pattern\` is terminal, and so is an RPC failing with \`INVALID_ARGUMENT\` or \`FAILED_PRECONDITION\`.
- Only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` (the \`RETRYABLE\` set) earn another attempt, at most \`MAX_ATTEMPTS\` = 3 in total, each under a **two-second deadline** (\`DEADLINE_S\`; \`DEADLINE_MS\`/\`DeadlineMs\` elsewhere).
- Retries replay only the \`pending\` paths under the same \`batch_id\`, minted once so the provider can dedupe on it.
- The batch \`succeeded\` only when **every** path reached \`accepted\`.

:::widget deadline-retry {"base": 100, "deadline": 2000, "attempts": 3}`,
  sequence: {
    participants: ['Purge API', 'provider client', 'CDN provider'],
    messages: [
      {from: 'Purge API', to: 'provider client', label: 'submit_batch(purge_id, domain, paths)', kind: 'sync'},
      {from: 'provider client', to: 'provider client', label: 'batch_id minted · outcomes = pending', kind: 'sync'},
      {
        from: 'provider client',
        to: 'CDN provider',
        label: 'BatchPurge(batch_id, pending paths) · 2 s deadline',
        kind: 'sync',
      },
      {
        from: 'CDN provider',
        to: 'provider client',
        label: 'results: accepted · invalid_pattern · retryable',
        kind: 'reply',
      },
      {from: 'provider client', to: 'CDN provider', label: 'retry: same batch_id, pending paths only', kind: 'sync'},
      {from: 'provider client', to: 'Purge API', label: '{batch_id, outcomes, succeeded}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt runs under a two-second deadline',
      detail:
        'The call carries a deadline (`DEADLINE_S` = 2 s per attempt) so a hung provider cannot pin the request. The starter calls the RPC with no deadline at all.',
      match: {
        python: {all: [/DEADLINE_S/, /timeout=DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS/, /deadline:/, /\b2000\b/]},
        go: {all: [/deadlineMS/, /WithTimeout/, /time\.Millisecond/]},
        scala: {all: [/DeadlineMs/, /withDeadlineAfter/, /MILLISECONDS/]},
        cpp: {all: [/kDeadlineMs/, /set_deadline/, /milliseconds/]},
      },
    },
    {
      id: 'outcomes',
      title: 'Reports a per-path outcome for every path',
      detail:
        'Paths end as `OUTCOME_ACCEPTED`, `OUTCOME_INVALID_PATTERN` or `OUTCOME_FAILED`, and the result carries the `outcomes` map. The starter returns a single status and drops the per-path results.',
      match: {
        python: {all: [/OUTCOME_ACCEPTED/, /OUTCOME_INVALID_PATTERN/, /OUTCOME_FAILED/, /outcomes/]},
        typescript: {
          all: [/OUTCOME_ACCEPTED/, /OUTCOME_INVALID_PATTERN/, /OUTCOME_FAILED/, /outcomes/],
        },
        go: {all: [/outcomeAccepted/, /outcomeInvalidPattern/, /outcomeFailed/, /outcomes/]},
        scala: {all: [/OutcomeAccepted/, /OutcomeInvalidPattern/, /OutcomeFailed/, /outcomes/]},
        cpp: {all: [/kOutcomeAccepted/, /kOutcomeInvalidPattern/, /kOutcomeFailed/, /outcomes/]},
      },
    },
    {
      id: 'terminal',
      title: 'Terminal 4xx stops its path instead of looping forever',
      detail:
        '`INVALID_ARGUMENT`/`FAILED_PRECONDITION` are terminal for the paths in the batch, and only the `RETRYABLE` set (`UNAVAILABLE`, `DEADLINE_EXCEEDED`) earns another attempt. The starter retries every failure forever, including a rejected pattern.',
      match: {
        python: {all: [/RETRYABLE/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /INVALID_ARGUMENT/]},
        typescript: {all: [/RETRYABLE/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /INVALID_ARGUMENT/]},
        go: {
          all: [/codes\.Unavailable/, /codes\.DeadlineExceeded/, /codes\.InvalidArgument/, /retryable/],
        },
        scala: {
          all: [
            /Status\.Code\.UNAVAILABLE/,
            /Status\.Code\.DEADLINE_EXCEEDED/,
            /Status\.Code\.INVALID_ARGUMENT/,
            /Retryable/,
          ],
        },
        cpp: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /INVALID_ARGUMENT/, /kRetryable/]},
      },
    },
    {
      id: 'batch-id',
      title: 'One batch id, bounded attempts, only pending paths replayed',
      detail:
        'The `batch_id` is minted once for the batch and reused by every attempt, the loop is bounded by `MAX_ATTEMPTS`, and a retry sends only the paths that are still `pending`. The starter mints a fresh id per attempt, which lets the provider purge the same path twice.',
      match: {
        python: {all: [/batch_id/, /MAX_ATTEMPTS/, /pending/]},
        typescript: {all: [/batchId/, /MAX_ATTEMPTS/, /pending/]},
        go: {all: [/batchID/, /maxAttempts/, /pending/]},
        scala: {all: [/batchId/, /MaxAttempts/, /pending/]},
        cpp: {all: [/batch_id/, /kMaxAttempts/, /pending/]},
      },
    },
    {
      id: 'complete',
      title: 'A batch completes only when every path is terminal',
      detail:
        'The terminal set is closed over `accepted`/`invalid_pattern`/`failed`, the leftover paths are resolved by `unfinished`, and `succeeded` is true only when every outcome is accepted. The starter declares success when a single path is accepted.',
      match: {
        python: {all: [/TERMINAL/, /unfinished\(/, /succeeded =/]},
        typescript: {all: [/TERMINAL/, /unfinished\(/, /succeeded =/]},
        go: {all: [/terminalOutcomes/, /unfinished\(/, /succeeded :=/]},
        scala: {all: [/Terminal/, /unfinished\(/, /succeeded/]},
        cpp: {all: [/kTerminalCodes/, /unfinished\(/, /succeeded =/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

import grpc

import cdn_pb2
import cdn_pb2_grpc

channel = grpc.insecure_channel("cdn-provider:9000")
cdn = cdn_pb2_grpc.PurgeServiceStub(channel)


def submit_batch(purge_id: str, domain: str, paths: list[str]) -> dict:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    while True:
        request = cdn_pb2.BatchPurgeRequest(batch_id=str(uuid.uuid4()), domain=domain, patterns=paths)
        try:
            reply = cdn.Purge(request)
        except grpc.RpcError:
            continue
        accepted = [result.path for result in reply.results if result.status == "accepted"]
        if accepted:
            return {"status": "succeeded", "paths": accepted}
`,
      solution: `import uuid

import grpc

import cdn_pb2
import cdn_pb2_grpc

DEADLINE_S = 2.0
MAX_ATTEMPTS = 3
OUTCOME_ACCEPTED = "accepted"
OUTCOME_INVALID_PATTERN = "invalid_pattern"
OUTCOME_FAILED = "failed"
PENDING = "pending"
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}
TERMINAL_CODES = {
    grpc.StatusCode.INVALID_ARGUMENT: OUTCOME_INVALID_PATTERN,
    grpc.StatusCode.FAILED_PRECONDITION: OUTCOME_FAILED,
}
TERMINAL = {OUTCOME_ACCEPTED, OUTCOME_INVALID_PATTERN, OUTCOME_FAILED}

channel = grpc.insecure_channel("cdn-provider:9000")
cdn = cdn_pb2_grpc.PurgeServiceStub(channel)


def unfinished(outcomes: dict[str, str]) -> list[str]:
    """The paths that have not reached a terminal outcome yet."""
    return [path for path, outcome in outcomes.items() if outcome not in TERMINAL]


def submit_batch(purge_id: str, domain: str, paths: list[str]) -> dict:
    """Purge the batch under one batch id, retrying only the paths still pending."""
    batch_id = f"{purge_id}:{uuid.uuid4()}"
    outcomes = {path: PENDING for path in paths}
    attempt = 0
    while unfinished(outcomes) and attempt < MAX_ATTEMPTS:
        attempt += 1
        pending = unfinished(outcomes)
        request = cdn_pb2.BatchPurgeRequest(
            batch_id=batch_id,
            domain=domain,
            patterns=pending,
            attempt=attempt,
        )
        try:
            reply = cdn.Purge(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            terminal = TERMINAL_CODES.get(exc.code())
            if terminal is not None:
                for path in unfinished(outcomes):
                    outcomes[path] = terminal
                break
            if exc.code() not in RETRYABLE:
                for path in unfinished(outcomes):
                    outcomes[path] = OUTCOME_FAILED
                break
            continue
        for result in reply.results:
            if result.status == OUTCOME_ACCEPTED:
                outcomes[result.path] = OUTCOME_ACCEPTED
            elif result.status == OUTCOME_INVALID_PATTERN:
                outcomes[result.path] = OUTCOME_INVALID_PATTERN
            else:
                outcomes[result.path] = PENDING
    for path in unfinished(outcomes):
        outcomes[path] = OUTCOME_FAILED
    succeeded = all(outcome == OUTCOME_ACCEPTED for outcome in outcomes.values())
    return {"batch_id": batch_id, "outcomes": outcomes, "attempts": attempt, "succeeded": succeeded}
`,
    },
    typescript: {
      starter: `/** Batch purge client: flawed code that retries every failure forever. */
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface PurgeReply {
  results: {path: string; status: string}[];
}

interface PurgeClient {
  Purge(
    request: {batch_id: string; domain: string; patterns: string[]; attempt: number},
    callback: (error: grpc.ServiceError | null, reply: PurgeReply) => void,
  ): void;
}

const {cdn} = grpc.loadPackageDefinition(protoLoader.loadSync('cdn.proto')) as unknown as {
  cdn: {PurgeService: new (target: string, credentials: grpc.ChannelCredentials) => PurgeClient};
};
const cdnProvider = new cdn.PurgeService('cdn-provider:9000', grpc.credentials.createInsecure());
const purge = promisify(cdnProvider.Purge.bind(cdnProvider));

export async function submitBatch(purgeId: string, domain: string, paths: string[]): Promise<unknown> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  for (;;) {
    const reply = (await purge({
      batch_id: randomUUID(),
      domain,
      patterns: paths,
      attempt: 1,
    })) as PurgeReply;
    const accepted = reply.results.filter(result => result.status === 'accepted').map(result => result.path);
    if (accepted.length > 0) return {status: 'succeeded', paths: accepted};
  }
}
`,
      solution: `/** Batch purge client: one batch id, per-path outcomes, retries only what is still pending. */
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 2000;
const MAX_ATTEMPTS = 3;
const OUTCOME_ACCEPTED = 'accepted';
const OUTCOME_INVALID_PATTERN = 'invalid_pattern';
const OUTCOME_FAILED = 'failed';
const PENDING = 'pending';

const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

/** A batch-level failure code is terminal for every path in that batch, with its own outcome. */
const TERMINAL_CODES: Record<number, string> = {
  [grpc.status.INVALID_ARGUMENT]: OUTCOME_INVALID_PATTERN,
  [grpc.status.FAILED_PRECONDITION]: OUTCOME_FAILED,
};

const TERMINAL_OUTCOMES: Record<string, true> = {
  [OUTCOME_ACCEPTED]: true,
  [OUTCOME_INVALID_PATTERN]: true,
  [OUTCOME_FAILED]: true,
};

interface PurgeReply {
  results: {path: string; status: string}[];
}

interface PurgeClient {
  Purge(
    request: {batch_id: string; domain: string; patterns: string[]; attempt: number},
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply: PurgeReply) => void,
  ): void;
}

interface BatchResult {
  batch_id: string;
  outcomes: Record<string, string>;
  attempts: number;
  succeeded: boolean;
}

const {cdn} = grpc.loadPackageDefinition(protoLoader.loadSync('cdn.proto')) as unknown as {
  cdn: {PurgeService: new (target: string, credentials: grpc.ChannelCredentials) => PurgeClient};
};
const cdnProvider = new cdn.PurgeService('cdn-provider:9000', grpc.credentials.createInsecure());
const purge = promisify(cdnProvider.Purge.bind(cdnProvider));

function unfinished(outcomes: Record<string, string>): string[] {
  return Object.keys(outcomes).filter(path => TERMINAL_OUTCOMES[outcomes[path]] !== true);
}

export async function submitBatch(purgeId: string, domain: string, paths: string[]): Promise<BatchResult> {
  const batchId = \`\${purgeId}:\${randomUUID()}\`;
  const outcomes: Record<string, string> = {};
  for (const path of paths) outcomes[path] = PENDING;
  let attempt = 0;
  while (unfinished(outcomes).length > 0 && attempt < MAX_ATTEMPTS) {
    attempt += 1;
    const pending = unfinished(outcomes);
    try {
      const reply = (await purge(
        {batch_id: batchId, domain, patterns: pending, attempt},
        {deadline: Date.now() + DEADLINE_MS},
      )) as PurgeReply;
      for (const result of reply.results) {
        if (result.status === OUTCOME_ACCEPTED) outcomes[result.path] = OUTCOME_ACCEPTED;
        else if (result.status === OUTCOME_INVALID_PATTERN) outcomes[result.path] = OUTCOME_INVALID_PATTERN;
        else outcomes[result.path] = PENDING;
      }
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      const terminal = TERMINAL_CODES[serviceError.code];
      if (terminal !== undefined) {
        for (const path of unfinished(outcomes)) outcomes[path] = terminal;
        break;
      }
      if (RETRYABLE[serviceError.code] !== true) {
        for (const path of unfinished(outcomes)) outcomes[path] = OUTCOME_FAILED;
        break;
      }
    }
  }
  for (const path of unfinished(outcomes)) outcomes[path] = OUTCOME_FAILED;
  const succeeded = Object.values(outcomes).every(outcome => outcome === OUTCOME_ACCEPTED);
  return {batch_id: batchId, outcomes, attempts: attempt, succeeded};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strconv"
	"time"

	pb "cdn/cdnpb"
)

func submitBatch(ctx context.Context, client pb.PurgeServiceClient, purgeID, domain string, paths []string) (*BatchResult, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	for {
		batchID := purgeID + ":" + strconv.FormatInt(time.Now().UnixNano(), 10)
		reply, err := client.Purge(ctx, &pb.BatchPurgeRequest{BatchId: batchID, Domain: domain, Patterns: paths})
		if err != nil {
			continue
		}
		accepted := []string{}
		for _, result := range reply.GetResults() {
			if result.GetStatus() == "accepted" {
				accepted = append(accepted, result.GetPath())
			}
		}
		if len(accepted) > 0 {
			return &BatchResult{Status: "succeeded", Paths: accepted}, nil
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"strconv"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "cdn/cdnpb"
)

const (
	deadlineMS  = 2000
	maxAttempts = 3

	outcomeAccepted       = "accepted"
	outcomeInvalidPattern = "invalid_pattern"
	outcomeFailed         = "failed"
	pendingOutcome        = "pending"
)

// retryable is the only set worth another attempt; everything else has reached a terminal state.
var retryable = map[codes.Code]bool{
	codes.Unavailable:      true,
	codes.DeadlineExceeded: true,
}

// terminalCodes maps a batch-level failure to the outcome every path in that batch gets.
var terminalCodes = map[codes.Code]string{
	codes.InvalidArgument:    outcomeInvalidPattern,
	codes.FailedPrecondition: outcomeFailed,
}

var terminalOutcomes = map[string]bool{
	outcomeAccepted:       true,
	outcomeInvalidPattern: true,
	outcomeFailed:         true,
}

type BatchResult struct {
	BatchID   string
	Outcomes  map[string]string
	Attempts  int
	Succeeded bool
}

// unfinished is the set of paths that have not reached a terminal outcome yet.
func unfinished(outcomes map[string]string) []string {
	pending := make([]string, 0, len(outcomes))
	for path, outcome := range outcomes {
		if !terminalOutcomes[outcome] {
			pending = append(pending, path)
		}
	}
	return pending
}

func submitBatch(
	ctx context.Context,
	client pb.PurgeServiceClient,
	purgeID, domain string,
	paths []string,
) (*BatchResult, error) {
	batchID := purgeID + ":" + strconv.FormatInt(time.Now().UnixNano(), 10)
	outcomes := make(map[string]string, len(paths))
	for _, path := range paths {
		outcomes[path] = pendingOutcome
	}
	attempt := 0
	for len(unfinished(outcomes)) > 0 && attempt < maxAttempts {
		attempt++
		pending := unfinished(outcomes)
		request := &pb.BatchPurgeRequest{
			BatchId:  batchID,
			Domain:   domain,
			Patterns: pending,
			Attempt:  int32(attempt),
		}
		callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
		reply, err := client.Purge(callCtx, request)
		cancel()
		if err != nil {
			if terminal, ok := terminalCodes[status.Code(err)]; ok {
				for _, path := range unfinished(outcomes) {
					outcomes[path] = terminal
				}
				break
			}
			if !retryable[status.Code(err)] {
				for _, path := range unfinished(outcomes) {
					outcomes[path] = outcomeFailed
				}
				break
			}
			continue
		}
		for _, result := range reply.GetResults() {
			switch result.GetStatus() {
			case outcomeAccepted:
				outcomes[result.GetPath()] = outcomeAccepted
			case outcomeInvalidPattern:
				outcomes[result.GetPath()] = outcomeInvalidPattern
			default:
				outcomes[result.GetPath()] = pendingOutcome
			}
		}
	}
	for _, path := range unfinished(outcomes) {
		outcomes[path] = outcomeFailed
	}
	succeeded := true
	for _, outcome := range outcomes {
		if outcome != outcomeAccepted {
			succeeded = false
			break
		}
	}
	return &BatchResult{BatchID: batchID, Outcomes: outcomes, Attempts: attempt, Succeeded: succeeded}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import java.util.UUID

final case class BatchResult(batchId: String, outcomes: Map[String, String], attempts: Int, succeeded: Boolean)

object PurgeClient {
  val stub = PurgeServiceGrpc
    .blockingStub(ManagedChannelBuilder.forAddress("cdn-provider", 9000).usePlaintext().build())

  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  def submitBatch(purgeId: String, domain: String, paths: List[String]): Map[String, String] = {
    var outcome = Map.empty[String, String]
    var done = false
    while (!done) {
      try {
        val reply = stub.purge(
          BatchPurgeRequest(batchId = UUID.randomUUID().toString, domain = domain, patterns = paths))
        val accepted = reply.results.filter(_.status == "accepted").map(_.path)
        if (accepted.nonEmpty) {
          outcome = Map("status" -> "succeeded")
          done = true
        }
      } catch {
        case _: StatusRuntimeException => ()
      }
    }
    outcome
  }
}
`,
      solution: `import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import java.util.UUID
import java.util.concurrent.TimeUnit

final case class BatchResult(batchId: String, outcomes: Map[String, String], attempts: Int, succeeded: Boolean)

object PurgeClient {
  val DeadlineMs = 2000
  val MaxAttempts = 3
  val OutcomeAccepted = "accepted"
  val OutcomeInvalidPattern = "invalid_pattern"
  val OutcomeFailed = "failed"
  val Pending = "pending"

  val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)
  val TerminalCodes = Map(
    Status.Code.INVALID_ARGUMENT -> OutcomeInvalidPattern,
    Status.Code.FAILED_PRECONDITION -> OutcomeFailed,
  )
  val Terminal = Set(OutcomeAccepted, OutcomeInvalidPattern, OutcomeFailed)

  val stub = PurgeServiceGrpc
    .blockingStub(ManagedChannelBuilder.forAddress("cdn-provider", 9000).usePlaintext().build())

  // unfinished is the set of paths that have not reached a terminal outcome yet.
  def unfinished(outcomes: Map[String, String]): List[String] =
    outcomes.collect { case (path, outcome) if !Terminal.contains(outcome) => path }.toList

  def submitBatch(purgeId: String, domain: String, paths: List[String]): BatchResult = {
    val batchId = s"$purgeId:\${UUID.randomUUID().toString}"
    val outcomes = scala.collection.mutable.LinkedHashMap(paths.map(path => path -> Pending): _*)
    var attempt = 0
    var running = true
    while (unfinished(outcomes.toMap).nonEmpty && attempt < MaxAttempts && running) {
      attempt += 1
      val request = BatchPurgeRequest(
        batchId = batchId,
        domain = domain,
        patterns = unfinished(outcomes.toMap),
        attempt = attempt,
      )
      try {
        val reply = stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).purge(request)
        reply.results.foreach { result =>
          result.status match {
            case OutcomeAccepted => outcomes.update(result.path, OutcomeAccepted)
            case OutcomeInvalidPattern => outcomes.update(result.path, OutcomeInvalidPattern)
            case _ => outcomes.update(result.path, Pending)
          }
        }
      } catch {
        case exc: StatusRuntimeException =>
          TerminalCodes.get(exc.getStatus.getCode) match {
            case Some(outcome) =>
              unfinished(outcomes.toMap).foreach(path => outcomes.update(path, outcome))
              running = false
            case None =>
              if (!Retryable.contains(exc.getStatus.getCode)) {
                unfinished(outcomes.toMap).foreach(path => outcomes.update(path, OutcomeFailed))
                running = false
              }
          }
      }
    }
    unfinished(outcomes.toMap).foreach(path => outcomes.update(path, OutcomeFailed))
    val succeeded = outcomes.values.forall(_ == OutcomeAccepted)
    BatchResult(batchId, outcomes.toMap, attempt, succeeded)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "cdn.grpc.pb.h"

#include <map>
#include <string>
#include <vector>

std::string uuidString();

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
std::vector<std::string> submitBatch(
    PurgeService::Stub* client,
    const std::string& purgeId,
    const std::string& domain,
    const std::vector<std::string>& paths) {
  while (true) {
    grpc::ClientContext ctx;
    BatchPurgeRequest request;
    request.set_batch_id(uuidString());
    request.set_domain(domain);
    for (const auto& path : paths) request.add_patterns(path);
    request.set_attempt(1);
    BatchPurgeReply reply;
    const grpc::Status status = client->Purge(&ctx, request, &reply);
    if (!status.ok()) continue;
    std::vector<std::string> accepted;
    for (const auto& result : reply.results()) {
      if (result.status() == "accepted") accepted.push_back(result.path());
    }
    if (!accepted.empty()) return accepted;
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "cdn.grpc.pb.h"

#include <chrono>
#include <map>
#include <set>
#include <string>
#include <vector>

constexpr int kDeadlineMs = 2000;
constexpr int kMaxAttempts = 3;
const std::string kOutcomeAccepted = "accepted";
const std::string kOutcomeInvalidPattern = "invalid_pattern";
const std::string kOutcomeFailed = "failed";
const std::string kPending = "pending";

std::string uuidString();

struct BatchResult {
  std::string batch_id;
  std::map<std::string, std::string> outcomes;
  int attempts = 0;
  bool succeeded = false;
};

// kRetryable is the only set worth another attempt; everything else has reached a terminal state.
const std::set<grpc::StatusCode> kRetryable = {
    grpc::StatusCode::UNAVAILABLE,
    grpc::StatusCode::DEADLINE_EXCEEDED,
};

// kTerminalCodes maps a batch-level failure to the outcome every path in that batch gets.
const std::map<grpc::StatusCode, std::string> kTerminalCodes = {
    {grpc::StatusCode::INVALID_ARGUMENT, kOutcomeInvalidPattern},
    {grpc::StatusCode::FAILED_PRECONDITION, kOutcomeFailed},
};

bool isTerminal(const std::string& outcome) {
  return outcome == kOutcomeAccepted || outcome == kOutcomeInvalidPattern || outcome == kOutcomeFailed;
}

// unfinished is the set of paths that have not reached a terminal outcome yet.
std::vector<std::string> unfinished(const std::map<std::string, std::string>& outcomes) {
  std::vector<std::string> pending;
  for (const auto& entry : outcomes) {
    if (!isTerminal(entry.second)) pending.push_back(entry.first);
  }
  return pending;
}

BatchResult submitBatch(
    PurgeService::Stub* client,
    const std::string& purgeId,
    const std::string& domain,
    const std::vector<std::string>& paths) {
  BatchResult result;
  result.batch_id = purgeId + ":" + uuidString();
  for (const auto& path : paths) result.outcomes[path] = kPending;
  for (int attempt = 1; attempt <= kMaxAttempts && !unfinished(result.outcomes).empty(); attempt++) {
    result.attempts = attempt;
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    BatchPurgeRequest request;
    request.set_batch_id(result.batch_id);
    request.set_domain(domain);
    request.set_attempt(attempt);
    for (const auto& path : unfinished(result.outcomes)) request.add_patterns(path);
    BatchPurgeReply reply;
    const grpc::Status status = client->Purge(&ctx, request, &reply);
    if (!status.ok()) {
      const auto terminal = kTerminalCodes.find(status.error_code());
      if (terminal != kTerminalCodes.end()) {
        for (const auto& path : unfinished(result.outcomes)) result.outcomes[path] = terminal->second;
        break;
      }
      if (kRetryable.count(status.error_code()) == 0) {
        for (const auto& path : unfinished(result.outcomes)) result.outcomes[path] = kOutcomeFailed;
        break;
      }
      continue;
    }
    for (const auto& pathResult : reply.results()) {
      if (pathResult.status() == kOutcomeAccepted) {
        result.outcomes[pathResult.path()] = kOutcomeAccepted;
      } else if (pathResult.status() == kOutcomeInvalidPattern) {
        result.outcomes[pathResult.path()] = kOutcomeInvalidPattern;
      } else {
        result.outcomes[pathResult.path()] = kPending;
      }
    }
  }
  for (const auto& path : unfinished(result.outcomes)) result.outcomes[path] = kOutcomeFailed;
  result.succeeded = true;
  for (const auto& entry : result.outcomes) {
    if (entry.second != kOutcomeAccepted) result.succeeded = false;
  }
  return result;
}
`,
    },
  },
  hints: [
    'One malformed pattern pins a worker in a hot loop against the provider until the pod is killed; a batch with one accepted path out of thirty reports success and nobody learns which twenty-nine failed.',
    '`submit_batch` loops `while True`, mints a fresh `batch_id` on each attempt, calls the RPC with no timeout, `continue`s on every `RpcError`, and returns as soon as any result is `accepted`.',
    'Mint `batch_id` once, keep an `outcomes` map driven by `unfinished`, call with `timeout=DEADLINE_S` at most `MAX_ATTEMPTS` times, retry only `RETRYABLE` codes with the `pending` paths, and set `succeeded` only when all are accepted.',
  ],
  debrief: `The fix has its shape because every piece bounds one dimension of the worst case. The deadline bounds an attempt, \`MAX_ATTEMPTS\` bounds the call, and the \`RETRYABLE\` set bounds which failures are worth repeating: a rejected pattern is a fact, and retrying a fact turns a client bug into a provider incident. The \`outcomes\` map makes a partial failure actionable, because an operator with thirty paths to fix needs to know which ones the CDN refused. One reused \`batch_id\` is the correctness half: a purge is not idempotent on its own, so the client hands the provider something to dedupe on.

Production clients space attempts with jittered backoff, put a breaker per provider endpoint, and persist the outcome map so the status read in step 5 answers from it.`,
};
