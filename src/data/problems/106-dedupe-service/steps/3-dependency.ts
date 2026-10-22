import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Fuzzy resolution calls that degrade to exact-only',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'similarity', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the similarity client. It
compiles, it works when the similarity service is healthy, and it hides three production flaws.
Review it like the on-call engineer, fix it, and prove the fix with the checks below.

Implement the fuzzy-resolution client that the check endpoint calls.

- The call to the similarity service carries a **200 ms deadline** per attempt. A deadline bounds the
  caller's latency; waiting without one lets a slow service hold the request open.
- A failure — a timeout or an unavailable service — **degrades to exact-only comparison** rather than
  blocking the check or raising. The caller still gets an answer.
- The degraded result carries the **\`exact_only\` marker** so the caller knows the fuzzy pass did not
  run. A degraded result never silently claims thoroughness.
- **No retries inside the request path**: a retry doubles the caller's latency and hides the failure
  from the operator. Retries belong in a background job, not in a synchronous check.

**Failure mode the checks target.** The draft waits without a deadline, retries a timeout inside the
request, and treats the timeout as "not a duplicate" — so a real duplicate slips through silently and
the caller believes the fuzzy comparison ran.`,
  sequence: {
    participants: ['Dedupe API', 'Similarity service', 'Redis', 'Client'],
    messages: [
      {
        from: 'Dedupe API',
        to: 'Similarity service',
        label: 'Resolve(scope, keys, fuzzy) · deadline 200 ms',
        kind: 'sync',
      },
      {from: 'Similarity service', to: 'Dedupe API', label: 'hit / DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Dedupe API', to: 'Redis', label: 'exact-only lookup on degrade', kind: 'sync'},
      {from: 'Redis', to: 'Dedupe API', label: 'exact key hit / miss', kind: 'reply'},
      {from: 'Dedupe API', to: 'Dedupe API', label: 'mark exact_only = true', kind: 'sync'},
      {from: 'Dedupe API', to: 'Client', label: '200 {match, exact_only}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'call',
      title: 'Calls the similarity service',
      detail: "Invoke the similarity stub's `Resolve` method to get the fuzzy candidates.",
      match: {
        python: {all: [/\.Resolve\(/]},
        typescript: {all: [/\.Resolve\(/]},
        go: {all: [/\.Resolve\(/]},
        scala: {all: [/\.resolve\(/]},
        cpp: {all: [/Resolve\(/]},
      },
    },
    {
      id: 'deadline',
      title: 'Sets a 200 ms deadline on the call',
      detail:
        'The call carries a 200 ms deadline so a slow similarity service cannot hold the request open. The draft waits without a deadline.',
      match: {
        python: {all: [/SIMILARITY_DEADLINE_MS/, /timeout\s*=/]},
        typescript: {all: [/SIMILARITY_DEADLINE_MS/, /deadline/]},
        go: {all: [/similarityDeadline/, /context\.WithTimeout/]},
        scala: {all: [/SimilarityDeadline/]},
        cpp: {all: [/kSimilarityDeadline/, /deadline/]},
      },
    },
    {
      id: 'degrade',
      title: 'Degrades a timeout to exact-only',
      detail:
        'A timeout or unavailable similarity service is caught and answered with an exact-only result carrying the marker, not raised and not treated as a miss. The draft returns "no match" without the marker.',
      match: {
        python: {all: [/grpc\.RpcError/, /exact_only/]},
        typescript: {all: [/DEADLINE_EXCEEDED|UNAVAILABLE/, /exact_only/]},
        go: {all: [/DeadlineExceeded|Unavailable/, /exact_only/]},
        scala: {all: [/StatusRuntimeException/, /exact_only/]},
        cpp: {all: [/DEADLINE_EXCEEDED|UNAVAILABLE/, /exact_only/]},
      },
    },
    {
      id: 'marker',
      title: 'Marks the degraded result exact-only',
      detail:
        'The degraded response sets the `exact_only` marker true, so the caller knows the fuzzy comparison did not run. The draft answers with a bare "no match".',
      match: {
        python: {all: [/"exact_only"\s*:\s*True/]},
        typescript: {all: [/exact_only\s*:\s*true/]},
        go: {all: [/"exact_only"\s*:\s*true/]},
        scala: {all: [/exact_only\s*=\s*true/]},
        cpp: {all: [/"exact_only"\s*,\s*true/]},
      },
    },
    {
      id: 'no-retry',
      title: 'Keeps retries out of the request path',
      detail:
        "The client does not retry a timeout inside the synchronous check: a retry doubles the caller's latency and hides the failure. The draft loops up to three attempts inside the request.",
      match: {
        python: {none: [/for\s+attempt\s+in\s+range\(/]},
        typescript: {none: [/for\s*\(\s*let\s+attempt/]},
        go: {none: [/for\s+attempt\s*:=/]},
        scala: {none: [/while\s*\(\s*attempt/]},
        cpp: {none: [/for\s*\(\s*int\s+attempt/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc


class SimilarityClient:
    def __init__(self, channel: grpc.Channel) -> None:
        self.stub = similarity_pb2_grpc.SimilarityStub(channel)

    def resolve(self, scope: str, candidate: dict) -> dict:
        # TODO: this draft waits without a deadline, retries a timeout inside the request, and treats a
        # timeout as "not a duplicate" without marking the result exact-only. Review all three.
        request = similarity_pb2.ResolveRequest(scope=scope, keys=candidate["keys"], fuzzy=candidate["fuzzy"])
        for attempt in range(3):
            try:
                reply = self.stub.Resolve(request)
                return {"match": {"record_id": reply.record_id, "score": reply.score}}
            except grpc.RpcError:
                continue
        return {"match": None}
`,
      solution: `import grpc

SIMILARITY_DEADLINE_MS = 200


class SimilarityClient:
    def __init__(self, channel: grpc.Channel) -> None:
        self.stub = similarity_pb2_grpc.SimilarityStub(channel)

    def resolve(self, scope: str, candidate: dict) -> dict:
        """Resolve fuzzy candidates inside one tenant's scope under a hard deadline."""
        request = similarity_pb2.ResolveRequest(scope=scope, keys=candidate["keys"], fuzzy=candidate["fuzzy"])
        try:
            reply = self.stub.Resolve(request, timeout=SIMILARITY_DEADLINE_MS / 1000)
        except grpc.RpcError:
            # A slow similarity service must not block the check: fall back to exact-only.
            return {"match": None, "exact_only": True}
        return {"match": {"record_id": reply.record_id, "score": reply.score}, "exact_only": False}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const definition = protoLoader.loadSync('similarity.proto');
const proto = grpc.loadPackageDefinition(definition) as never;
const stub = new (proto as unknown as {Similarity: new (target: string, credentials: unknown) => unknown}).Similarity(
  'similarity:50051',
  grpc.credentials.createInsecure(),
) as {Resolve: (request: unknown, callback: (error: unknown, response: never) => void) => void};

interface Candidate {
  keys: string[];
  fuzzy: string;
}

async function resolve(scope: string, candidate: Candidate): Promise<{match: unknown}> {
  // TODO: this draft waits without a deadline, retries a timeout inside the request, and treats a
  // timeout as "not a duplicate" without marking the result exact-only. Review all three.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const reply = await new Promise<{record_id: string; score: number}>((accept, reject) =>
        stub.Resolve({scope, keys: candidate.keys, fuzzy: candidate.fuzzy}, error =>
          error ? reject(error) : accept({record_id: '', score: 0}),
        ),
      );
      return {match: {record_id: reply.record_id, score: reply.score}};
    } catch {
      continue;
    }
  }
  return {match: null};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const definition = protoLoader.loadSync('similarity.proto');
const proto = grpc.loadPackageDefinition(definition) as never;
const stub = new (proto as unknown as {Similarity: new (target: string, credentials: unknown) => unknown}).Similarity(
  'similarity:50051',
  grpc.credentials.createInsecure(),
) as {
  Resolve: (
    request: unknown,
    metadata: grpc.Metadata,
    options: {deadline: Date},
    callback: (error: unknown, response: {record_id: string; score: number}) => void,
  ) => void;
};

const SIMILARITY_DEADLINE_MS = 200;

interface Candidate {
  keys: string[];
  fuzzy: string;
}

async function resolve(scope: string, candidate: Candidate): Promise<{match: unknown; exact_only: boolean}> {
  const deadline = new Date(Date.now() + SIMILARITY_DEADLINE_MS);
  try {
    const reply = await new Promise<{record_id: string; score: number}>((accept, reject) =>
      stub.Resolve(
        {scope, keys: candidate.keys, fuzzy: candidate.fuzzy},
        new grpc.Metadata(),
        {deadline},
        (error, response) => (error ? reject(error) : accept(response)),
      ),
    );
    return {match: {record_id: reply.record_id, score: reply.score}, exact_only: false};
  } catch (error) {
    const code = (error as grpc.ServiceError).code;
    if (code === grpc.status.DEADLINE_EXCEEDED || code === grpc.status.UNAVAILABLE)
      // A slow or unavailable similarity service degrades to exact-only; it never blocks the check.
      return {match: null, exact_only: true};
    throw error;
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
)

type SimilarityClient struct {
	client SimilarityServiceClient
}

func (c *SimilarityClient) Resolve(ctx context.Context, scope string, candidate Candidate) (map[string]any, error) {
	// TODO: this draft waits without a deadline, retries a timeout inside the request, and treats a
	// timeout as "not a duplicate" without marking the result exact-only. Review all three.
	for attempt := 0; attempt < 3; attempt++ {
		reply, err := c.client.Resolve(ctx, &ResolveRequest{Scope: scope, Keys: candidate.Keys, Fuzzy: candidate.Fuzzy})
		if err == nil {
			return map[string]any{"match": map[string]any{"record_id": reply.RecordId, "score": reply.Score}}, nil
		}
	}
	return map[string]any{"match": nil}, nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const similarityDeadline = 200 * time.Millisecond

type SimilarityClient struct {
	client SimilarityServiceClient
}

func (c *SimilarityClient) Resolve(ctx context.Context, scope string, candidate Candidate) (map[string]any, error) {
	callCtx, cancel := context.WithTimeout(ctx, similarityDeadline)
	defer cancel()
	reply, err := c.client.Resolve(callCtx, &ResolveRequest{Scope: scope, Keys: candidate.Keys, Fuzzy: candidate.Fuzzy})
	if err != nil {
		code := status.Code(err)
		if code == codes.DeadlineExceeded || code == codes.Unavailable {
			// A slow similarity service degrades to exact-only; it never blocks the check.
			return map[string]any{"match": nil, "exact_only": true}, nil
		}
		return nil, err
	}
	return map[string]any{
		"match":      map[string]any{"record_id": reply.RecordId, "score": reply.Score},
		"exact_only": false,
	}, nil
}
`,
    },
    scala: {
      starter: `import scala.concurrent.{ExecutionContext, Future}

final case class Candidate(keys: List[String], fuzzy: String)
final case class Resolution(matchResult: Option[Hit], exact_only: Boolean)

class SimilarityClient(stub: SimilarityGrpc.SimilarityStub)(implicit ec: ExecutionContext) {
  def resolve(scope: String, candidate: Candidate): Future[Resolution] = {
    // TODO: this draft waits without a deadline, retries a timeout inside the request, and treats a
    // timeout as "not a duplicate" without marking the result exact-only. Review all three.
    var attempt = 0
    while (attempt < 3) {
      try {
        val hit = stub.resolve(ResolveRequest(scope, candidate.keys, candidate.fuzzy))
        return Future.successful(Resolution(Some(hit), exact_only = false))
      } catch {
        case _: Throwable => attempt += 1
      }
    }
    Future.successful(Resolution(None, exact_only = false))
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.StatusRuntimeException
import io.grpc.stub.StreamObserver

import scala.concurrent.{ExecutionContext, Future, Promise}

final case class Candidate(keys: List[String], fuzzy: String)
final case class Resolution(matchResult: Option[Hit], exact_only: Boolean)

class SimilarityClient(stub: SimilarityGrpc.SimilarityStub)(implicit ec: ExecutionContext) {
  val SimilarityDeadline: Long = 200

  def resolve(scope: String, candidate: Candidate): Future[Resolution] = {
    val withDeadline = stub.withDeadlineAfter(SimilarityDeadline, TimeUnit.MILLISECONDS)
    val promise = Promise[Resolution]()
    withDeadline.resolve(
      ResolveRequest(scope, candidate.keys, candidate.fuzzy),
      new StreamObserver[Hit] {
        override def onNext(value: Hit): Unit = ()
        override def onCompleted(): Unit = ()
        override def onError(error: Throwable): Unit = error match {
          case _: StatusRuntimeException =>
            // A slow similarity service degrades to exact-only; it never blocks the check.
            promise.success(Resolution(None, exact_only = true))
          case other =>
            promise.failure(other)
        }
      },
    )
    promise.future
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <memory>
#include <string>
#include <vector>

struct Candidate {
  std::vector<std::string> keys;
  std::string fuzzy;
};

class SimilarityClient {
 public:
  explicit SimilarityClient(std::shared_ptr<grpc::Channel> channel)
      : stub_(Similarity::NewStub(channel)) {}

  json resolve(const std::string& scope, const Candidate& candidate) {
    // TODO: this draft waits without a deadline, retries a timeout inside the request, and treats a
    // timeout as "not a duplicate" without marking the result exact-only. Review all three.
    ResolveRequest request;
    request.set_scope(scope);
    request.set_fuzzy(candidate.fuzzy);
    for (int attempt = 0; attempt < 3; ++attempt) {
      grpc::ClientContext context;
      ResolveReply reply;
      const grpc::Status status = stub_->Resolve(&context, request, &reply);
      if (status.ok()) {
        return json{{"match", json{{"record_id", reply.record_id()}, {"score", reply.score()}}}};
      }
    }
    return json{{"match", nullptr}};
  }

 private:
  std::unique_ptr<Similarity::Stub> stub_;
};
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <memory>
#include <string>
#include <vector>

constexpr int kSimilarityDeadlineMs = 200;

struct Candidate {
  std::vector<std::string> keys;
  std::string fuzzy;
};

class SimilarityClient {
 public:
  explicit SimilarityClient(std::shared_ptr<grpc::Channel> channel)
      : stub_(Similarity::NewStub(channel)) {}

  json resolve(const std::string& scope, const Candidate& candidate) {
    ResolveRequest request;
    request.set_scope(scope);
    request.set_fuzzy(candidate.fuzzy);
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() +
                         std::chrono::milliseconds(kSimilarityDeadlineMs));
    ResolveReply reply;
    const grpc::Status status = stub_->Resolve(&context, request, &reply);
    if (!status.ok()) {
      if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED ||
          status.error_code() == grpc::StatusCode::UNAVAILABLE) {
        // A slow or unavailable similarity service degrades to exact-only; it never blocks the check.
        return json{{"match", nullptr}, {"exact_only", true}};
      }
      throw std::runtime_error(status.error_message());
    }
    return json{{"match", json{{"record_id", reply.record_id()}, {"score", reply.score()}}},
                {"exact_only", false}};
  }

 private:
  std::unique_ptr<Similarity::Stub> stub_;
};
`,
    },
  },
  hints: [
    "A deadline is a promise about latency, not a timeout constant. Set it on the call (`timeout=` / `withDeadlineAfter`) so the server-side work is abandoned at 200 ms, and keep retries out of the request — a retry doubles the caller's latency and hides the failure from the operator.",
    "Degrade, don't fail: a similarity timeout returns an exact-only result carrying the `exact_only` marker, so the check still answers and the caller knows the fuzzy pass did not run. A timeout is neither a duplicate nor a miss — it is a downgrade.",
    'The marker is the contract. A degraded result must never claim thoroughness; if the response says `exact_only: false` after a timeout, the caller merges on a comparison that never happened.',
  ],
  debrief: `The interviewer is testing whether you can review a generated client at the failure boundary. Three defects are being checked: the deadline (waiting without one lets a slow dependency hold the request open), the retry loop (it doubles latency and hides the failure), and the silent degradation (a timeout reported as "no match" is a real duplicate slipping through). The subtle part is the marker: degrading without saying so is worse than failing loudly, because the caller cannot tell a thorough check from a downgraded one. Real clients add a per-call deadline that is shorter than the request budget, a circuit breaker around the dependency, and metrics that count degraded checks so the similarity service's health is visible.`,
};
