import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Fuzzy resolution calls that degrade to exact-only',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'similarity', 'redis'],
  task: `## Task

**Starting point.** The starter is the similarity client the check endpoint calls: \`resolve()\` builds
a \`ResolveRequest\`, calls the stub's \`Resolve\` up to three times in a loop with no deadline, swallows
every \`RpcError\`, and returns \`{"match": None}\` when all attempts fail. It compiles, it works
when the similarity service is healthy, and it hides four flaws.

**Failure mode the checks target.** The starter waits without a deadline, retries a timeout inside the
request, and treats the timeout as "not a duplicate", so a real duplicate slips through silently and
the caller believes the fuzzy comparison ran.

Requirements:

- The call to the similarity service carries a **200 ms deadline** per attempt. A deadline bounds the
  caller's latency; waiting without one lets a slow service hold the request open.
- A failure, a timeout or an unavailable service, **degrades to exact-only comparison** rather than
  blocking the check or raising. The caller still gets an answer.
- The degraded result carries the **\`exact_only\` marker** so the caller knows the fuzzy pass did not
  run. A degraded result must not silently claim thoroughness.
- **No retries inside the request path**: a retry doubles the caller's latency and hides the failure
  from the operator. Retries belong in a background job, not in a synchronous check.`,
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
        'The call carries a 200 ms deadline so a slow similarity service cannot hold the request open. The starter waits without a deadline.',
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
        'A timeout or unavailable similarity service is caught and answered with an exact-only result carrying the marker, not raised and not treated as a miss. The starter returns "no match" without the marker.',
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
        'The degraded response sets the `exact_only` marker true, so the caller knows the fuzzy comparison did not run. The starter answers with a bare "no match".',
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
        "The client does not retry a timeout inside the synchronous check: a retry doubles the caller's latency and hides the failure. The starter loops up to three attempts inside the request.",
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
        # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
    'Symptom: when the similarity service stalls, a check takes seconds instead of milliseconds and then answers "no duplicate" for a record that is a known fuzzy match.',
    'Mechanism: `resolve()` calls `Resolve` with no deadline, so each attempt waits as long as the server does; the loop retries three times; the final `{"match": None}` is indistinguishable from a real miss.',
    'Change: define `SIMILARITY_DEADLINE_MS = 200` and pass `timeout=` on the call; drop the attempt loop; catch `grpc.RpcError` once and return `{"match": None, "exact_only": True}`.',
  ],
  debrief: `The fix has three parts that only work together. The deadline bounds the caller's latency, which is the reason the retry loop has to go: a retry inside the request spends the budget the deadline just protected. And once the call can fail quickly, the result has to say that it did, because a caller cannot tell a thorough miss from a downgraded one, and will merge, or refuse to merge, on a comparison that did not happen. Degrading without the marker is worse than failing loudly. Production clients also pick the per-call deadline from the remaining request budget rather than a constant, wrap the dependency in a circuit breaker so a dead service stops costing 200 ms per check, and count degraded results so the similarity service's health shows up on a dashboard.`,
};
