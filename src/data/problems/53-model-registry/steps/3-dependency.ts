import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'A serving probe that gates the pointer',
  concept: 'grpc',
  guides: ['failing-dependencies', 'deadlines-and-retries'],
  file: 'client',
  focus: ['registry', 'serving', 'redis'],
  task: `## Task

**Starting point.** The starter is the promotion path:
\`promote_with_probe(pool, name, version, digest, eval_id)\` calls
\`Serving.Probe(ProbeRequest(pool, model, version, expected_digest))\` over gRPC, ignores what comes
back, then calls \`pointer.promote\` (step 2, provided as \`registry.pointer\`) and answers
\`{"promoted": bool, "reason": str | None}\`. With a healthy pool it promotes, and it hides four flaws.

**Failure mode the checks target.** A pool that loaded other bytes gets the traffic; a pool that
never answers holds the promotion forever; a refused or timed-out probe still moves the pointer; and
a pool that was restarting for one call blocks a promotion a second look would allow.

\`\`\`proto
service Serving { rpc Probe(ProbeRequest) returns (ProbeReply); }  // ProbeReply { loaded_digest }
\`\`\`

- Every attempt carries **\`PROBE_DEADLINE_S\` = 10 s**.
- \`UNAVAILABLE\` is retried once (\`MAX_ATTEMPTS\` = 2); every other status is final.
- \`loaded_digest\` must equal the registered digest, else \`reason: "digest_mismatch"\`.
- \`DEADLINE_EXCEEDED\` answers \`reason: "probe_timeout"\`, any other failure \`"probe_failed"\`.
- \`pointer.promote\` runs only after the digests matched; on every failure the pool keeps the version
  it serves.`,
  sequence: {
    participants: ['registryd', 'Serving pool', 'Redis'],
    messages: [
      {from: 'registryd', to: 'Serving pool', label: 'Probe(prod, fraud, 3, sha256:a3) · deadline 10 s', kind: 'sync'},
      {from: 'Serving pool', to: 'registryd', label: 'UNAVAILABLE (restarting)', kind: 'reply'},
      {from: 'registryd', to: 'Serving pool', label: 'Probe again · attempt 2 of 2', kind: 'sync'},
      {from: 'Serving pool', to: 'registryd', label: 'loaded_digest = sha256:a3', kind: 'reply'},
      {from: 'registryd', to: 'Redis', label: 'pointer.promote: only after the digests match', kind: 'sync'},
      {from: 'registryd', to: 'registryd', label: '{promoted: false, reason} on any failure', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'probe-deadline',
      title: 'Every probe carries a 10-second deadline',
      detail:
        'Each `Probe` attempt is made with `PROBE_DEADLINE_S` (10 s); without one a pool that never answers holds the promotion worker, and the timeout is reported as `probe_timeout` without a retry.',
      match: {
        python: {all: [/PROBE_DEADLINE_S\s*=\s*10\b/, /\.Probe\([\s\S]{0,200}?timeout\s*=\s*PROBE_DEADLINE_S/]},
        typescript: {
          all: [/PROBE_DEADLINE_MS\s*=\s*10_?000\b/, /\.Probe\([\s\S]{0,200}?deadline:[^\n]*PROBE_DEADLINE_MS/],
        },
        go: {all: [/probeDeadline\s*=\s*10\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*probeDeadline\)/]},
        cpp: {all: [/kProbeDeadline\{10\}/, /set_deadline\([^\n]*kProbeDeadline\)/]},
      },
    },
    {
      id: 'digest-match',
      title: 'Promotes only when the loaded digest matches',
      detail:
        "The reply's `loaded_digest` must equal the registered digest exactly (an empty one or a longer one is a mismatch), else `digest_mismatch` without touching the pointer; the starter never reads the reply.",
      match: {
        python: {all: [/\.loaded_digest/, /["']digest_mismatch["']/]},
        typescript: {all: [/\.loaded_digest/, /['"]digest_mismatch['"]/]},
        go: {all: [/GetLoadedDigest\(\)|\.LoadedDigest/, /"digest_mismatch"/]},
        cpp: {all: [/\.loaded_digest\(\)/, /"digest_mismatch"/]},
      },
    },
    {
      id: 'failure-blocks',
      title: 'A failed or timed-out probe leaves the pointer',
      detail:
        'A probe that ends in `DEADLINE_EXCEEDED` answers `probe_timeout`, any other failure `probe_failed`, and neither reaches `promote`. Several non-retryable statuses are each tried once; the starter swallows the error and promotes.',
      match: {
        python: {
          all: [/["']probe_timeout["']/, /["']probe_failed["']/, /DEADLINE_EXCEEDED/],
          none: [/except grpc\.RpcError:\s*\n\s*pass\b/],
        },
        typescript: {all: [/['"]probe_timeout['"]/, /['"]probe_failed['"]/, /DEADLINE_EXCEEDED/]},
        go: {all: [/"probe_timeout"/, /"probe_failed"/, /codes\.DeadlineExceeded/]},
        cpp: {all: [/"probe_timeout"/, /"probe_failed"/, /DEADLINE_EXCEEDED/]},
      },
    },
    {
      id: 'unavailable-retry',
      title: 'One retry when the pool is UNAVAILABLE',
      detail:
        '`UNAVAILABLE` (a restarting pool) is retried once, `MAX_ATTEMPTS` = 2 in all; every other status is final. A first attempt that fails late leaves the retry its own full 10 s. The starter makes one attempt and promotes whatever it says.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*2\b/, /StatusCode\.UNAVAILABLE/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*2\b/, /status\.UNAVAILABLE/]},
        go: {all: [/maxAttempts\s*=\s*2\b/, /codes\.Unavailable/]},
        cpp: {all: [/kMaxAttempts\s*=\s*2\b/, /StatusCode::UNAVAILABLE/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import modelregistry_pb2
import modelregistry_pb2_grpc
from registry import pointer  # pointer.promote(name, version, pool, eval_id) -> bool

serving = modelregistry_pb2_grpc.ServingStub(grpc.insecure_channel("serving:9000"))


def promote_with_probe(pool: str, name: str, version: int, digest: str, eval_id: str) -> dict:
    """Probe the pool for the registered digest, then point the pool at the version."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    request = modelregistry_pb2.ProbeRequest(pool=pool, model=name, version=version, expected_digest=digest)
    try:
        serving.Probe(request)
    except grpc.RpcError:
        pass  # the pool reports its state on its next heartbeat
    if not pointer.promote(name, version, pool, eval_id):
        return {"promoted": False, "reason": "stage_refused"}
    return {"promoted": True, "reason": None}
`,
      solution: `import grpc

import modelregistry_pb2
import modelregistry_pb2_grpc
from registry import pointer  # pointer.promote(name, version, pool, eval_id) -> bool

PROBE_DEADLINE_S = 10
MAX_ATTEMPTS = 2

serving = modelregistry_pb2_grpc.ServingStub(grpc.insecure_channel("serving:9000"))


def probe(pool: str, name: str, version: int, digest: str) -> str:
    """The digest the pool has loaded for the version; raises the last attempt's grpc.RpcError."""
    request = modelregistry_pb2.ProbeRequest(pool=pool, model=name, version=version, expected_digest=digest)
    attempt = 1
    while True:
        try:
            return serving.Probe(request, timeout=PROBE_DEADLINE_S).loaded_digest
        except grpc.RpcError as exc:
            # A restarting pool may answer the next attempt; any other status will not change.
            if exc.code() != grpc.StatusCode.UNAVAILABLE or attempt >= MAX_ATTEMPTS:
                raise
            attempt += 1


def promote_with_probe(pool: str, name: str, version: int, digest: str, eval_id: str) -> dict:
    """Probe the pool for the registered digest, then point the pool at the version."""
    try:
        loaded = probe(pool, name, version, digest)
    except grpc.RpcError as exc:
        # The pool keeps the version it serves, and the operator sees why.
        reason = "probe_timeout" if exc.code() == grpc.StatusCode.DEADLINE_EXCEEDED else "probe_failed"
        return {"promoted": False, "reason": reason}
    if loaded != digest:
        return {"promoted": False, "reason": "digest_mismatch"}
    # Only a pool that proved it holds these bytes gets the pointer.
    if not pointer.promote(name, version, pool, eval_id):
        return {"promoted": False, "reason": "stage_refused"}
    return {"promoted": True, "reason": None}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {promote} from 'registry/pointer';

interface ProbeRequest {
  pool: string;
  model: string;
  version: number;
  expected_digest: string;
}

export interface ProbeResult {
  promoted: boolean;
  reason: string | null;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('modelregistry.proto')) as unknown as {
  modelregistry: {Serving: grpc.ServiceClientConstructor};
};
const serving = new pkg.modelregistry.Serving('serving:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Probe(request: ProbeRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{loaded_digest: string}>;
};

/** Probe the pool for the registered digest, then point the pool at the version. */
export async function promoteWithProbe(pool: string, name: string, version: number, digest: string, evalId: string): Promise<ProbeResult> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  try {
    await serving.Probe({pool, model: name, version, expected_digest: digest}, new grpc.Metadata(), {});
  } catch {
    // the pool reports its state on its next heartbeat
  }
  if (!(await promote(name, version, pool, evalId))) return {promoted: false, reason: 'stage_refused'};
  return {promoted: true, reason: null};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {promote} from 'registry/pointer';

export const PROBE_DEADLINE_MS = 10_000;
export const MAX_ATTEMPTS = 2;

interface ProbeRequest {
  pool: string;
  model: string;
  version: number;
  expected_digest: string;
}

export interface ProbeResult {
  promoted: boolean;
  reason: string | null;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('modelregistry.proto')) as unknown as {
  modelregistry: {Serving: grpc.ServiceClientConstructor};
};
const serving = new pkg.modelregistry.Serving('serving:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Probe(request: ProbeRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{loaded_digest: string}>;
};

/** The digest the pool has loaded for the version; throws the last attempt's ServiceError. */
async function probe(pool: string, name: string, version: number, digest: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const reply = await serving.Probe({pool, model: name, version, expected_digest: digest}, new grpc.Metadata(), {
        deadline: Date.now() + PROBE_DEADLINE_MS,
      });
      return reply.loaded_digest;
    } catch (e) {
      // A restarting pool may answer the next attempt; any other status will not change.
      if ((e as grpc.ServiceError).code !== grpc.status.UNAVAILABLE || attempt >= MAX_ATTEMPTS) throw e;
    }
  }
}

/** Probe the pool for the registered digest, then point the pool at the version. */
export async function promoteWithProbe(pool: string, name: string, version: number, digest: string, evalId: string): Promise<ProbeResult> {
  let loaded: string;
  try {
    loaded = await probe(pool, name, version, digest);
  } catch (e) {
    // The pool keeps the version it serves, and the operator sees why.
    const timedOut = (e as grpc.ServiceError).code === grpc.status.DEADLINE_EXCEEDED;
    return {promoted: false, reason: timedOut ? 'probe_timeout' : 'probe_failed'};
  }
  if (loaded !== digest) return {promoted: false, reason: 'digest_mismatch'};
  // Only a pool that proved it holds these bytes gets the pointer.
  if (!(await promote(name, version, pool, evalId))) return {promoted: false, reason: 'stage_refused'};
  return {promoted: true, reason: null};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"registry/pointer" // pointer.Promote(ctx, name, version, pool, evalID) (bool, error)
	pb "registry/gen/modelregistry"
)

var (
	servingConn, _ = grpc.NewClient("serving:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	serving        = pb.NewServingClient(servingConn)
)

// probeResult is what the operator sees: whether the pool now serves the version, and why not.
type probeResult struct {
	Promoted bool   \`json:"promoted"\`
	Reason   string \`json:"reason"\`
}

// promoteWithProbe probes the pool for the registered digest, then points the pool at the version.
func promoteWithProbe(ctx context.Context, pool, name string, version int, digest, evalID string) (probeResult, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	serving.Probe(ctx, &pb.ProbeRequest{Pool: pool, Model: name, Version: int64(version), ExpectedDigest: digest}) // the pool reports its state on its next heartbeat
	moved, err := pointer.Promote(ctx, name, version, pool, evalID)
	if err != nil {
		return probeResult{}, err
	}
	if !moved {
		return probeResult{Reason: "stage_refused"}, nil
	}
	return probeResult{Promoted: true}, nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"registry/pointer" // pointer.Promote(ctx, name, version, pool, evalID) (bool, error)
	pb "registry/gen/modelregistry"
)

const (
	probeDeadline = 10 * time.Second
	maxAttempts   = 2
)

var (
	servingConn, _ = grpc.NewClient("serving:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	serving        = pb.NewServingClient(servingConn)
)

// probeResult is what the operator sees: whether the pool now serves the version, and why not.
type probeResult struct {
	Promoted bool   \`json:"promoted"\`
	Reason   string \`json:"reason"\`
}

// probe is the digest the pool has loaded for the version, or the last attempt's error.
func probe(ctx context.Context, pool, name string, version int, digest string) (string, error) {
	req := &pb.ProbeRequest{Pool: pool, Model: name, Version: int64(version), ExpectedDigest: digest}
	for attempt := 1; ; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, probeDeadline)
		reply, err := serving.Probe(callCtx, req)
		cancel()
		if err == nil {
			return reply.GetLoadedDigest(), nil
		}
		// A restarting pool may answer the next attempt; any other status will not change.
		if status.Code(err) != codes.Unavailable || attempt >= maxAttempts {
			return "", err
		}
	}
}

// promoteWithProbe probes the pool for the registered digest, then points the pool at the version.
func promoteWithProbe(ctx context.Context, pool, name string, version int, digest, evalID string) (probeResult, error) {
	loaded, err := probe(ctx, pool, name, version, digest)
	if err != nil {
		// The pool keeps the version it serves, and the operator sees why.
		if status.Code(err) == codes.DeadlineExceeded {
			return probeResult{Reason: "probe_timeout"}, nil
		}
		return probeResult{Reason: "probe_failed"}, nil
	}
	if loaded != digest {
		return probeResult{Reason: "digest_mismatch"}, nil
	}
	// Only a pool that proved it holds these bytes gets the pointer.
	moved, err := pointer.Promote(ctx, name, version, pool, evalID)
	if err != nil {
		return probeResult{}, err
	}
	if !moved {
		return probeResult{Reason: "stage_refused"}, nil
	}
	return probeResult{Promoted: true}, nil
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <string>

#include "registry/pointer.h"  // pointer::promote(name, version, pool, eval_id) -> bool
#include "modelregistry.grpc.pb.h"

auto serving = modelregistry::Serving::NewStub(grpc::CreateChannel("serving:9000", grpc::InsecureChannelCredentials()));

// What the operator sees: whether the pool now serves the version, and why not.
struct ProbeResult {
  bool promoted = false;
  std::string reason;
};

// Probe the pool for the registered digest, then point the pool at the version.
ProbeResult promoteWithProbe(const std::string& pool, const std::string& name, long version, const std::string& digest,
                             const std::string& eval_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  grpc::ClientContext ctx;
  modelregistry::ProbeRequest request;
  request.set_pool(pool);
  request.set_model(name);
  request.set_version(version);
  request.set_expected_digest(digest);
  modelregistry::ProbeReply reply;
  serving->Probe(&ctx, request, &reply);  // the pool reports its state on its next heartbeat
  if (!pointer::promote(name, version, pool, eval_id)) return {false, "stage_refused"};
  return {true, ""};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

#include "registry/pointer.h"  // pointer::promote(name, version, pool, eval_id) -> bool
#include "modelregistry.grpc.pb.h"

constexpr std::chrono::seconds kProbeDeadline{10};
constexpr int kMaxAttempts = 2;

auto serving = modelregistry::Serving::NewStub(grpc::CreateChannel("serving:9000", grpc::InsecureChannelCredentials()));

// What the operator sees: whether the pool now serves the version, and why not.
struct ProbeResult {
  bool promoted = false;
  std::string reason;
};

// The pool's answer: the status of the last attempt, and on success the digest it has loaded.
grpc::Status probe(const std::string& pool, const std::string& name, long version, const std::string& digest, std::string* loaded) {
  modelregistry::ProbeRequest request;
  request.set_pool(pool);
  request.set_model(name);
  request.set_version(version);
  request.set_expected_digest(digest);
  grpc::Status status;
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kProbeDeadline);
    modelregistry::ProbeReply reply;
    status = serving->Probe(&ctx, request, &reply);
    if (status.ok()) {
      *loaded = reply.loaded_digest();
      return status;
    }
    // A restarting pool may answer the next attempt; any other status will not change.
    if (status.error_code() != grpc::StatusCode::UNAVAILABLE) return status;
  }
  return status;
}

// Probe the pool for the registered digest, then point the pool at the version.
ProbeResult promoteWithProbe(const std::string& pool, const std::string& name, long version, const std::string& digest,
                             const std::string& eval_id) {
  std::string loaded;
  const grpc::Status status = probe(pool, name, version, digest, &loaded);
  // The pool keeps the version it serves, and the operator sees why.
  if (!status.ok()) return {false, status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED ? "probe_timeout" : "probe_failed"};
  if (loaded != digest) return {false, "digest_mismatch"};
  // Only a pool that proved it holds these bytes gets the pointer.
  if (!pointer::promote(name, version, pool, eval_id)) return {false, "stage_refused"};
  return {true, ""};
}
`,
    },
  },
  harness: {
    python: `import grpc

import modelregistry_pb2
import modelregistry_pb2_grpc

DIGEST = "sha256:a3"


class Pool(modelregistry_pb2_grpc.ServingServicer):
    """Every pool has loaded the bytes it was asked about, except the versions in loaded ("model:version" → digest)."""

    def __init__(self):
        self.loaded = {}
        # The next calls that find the pool restarting: they answer UNAVAILABLE after their latency.
        self.restarting = 0

    def Probe(self, request, context):
        if self.restarting:
            self.restarting -= 1
            context.abort(grpc.StatusCode.UNAVAILABLE, "pool restarting")
        digest = self.loaded.get(f"{request.model}:{request.version}", request.expected_digest)
        return modelregistry_pb2.ProbeReply(loaded_digest=digest)


def _client(ctx):
    pool = Pool()
    ctx.grpc.serve(modelregistry_pb2_grpc.add_ServingServicer_to_server, pool)
    for n, stage in ((2, "promoted"), (3, "staged")):
        ctx.redis.hset(
            f"model:fraud:v{n}",
            mapping={"name": "fraud", "version": n, "artifact_digest": f"sha256:a{n}", "training_run_id": f"r-{n}", "eval_id": f"e-{n}", "stage": stage},
        )
    ctx.redis.set("active:prod", "fraud:2")
    return ctx.load("client"), pool


def _promote(m):
    return m.promote_with_probe("prod", "fraud", 3, DIGEST, "e-3")


def _held(ctx, result, reason, why):
    assert result == {"promoted": False, "reason": reason}, f"{why}: promote_with_probe answered {result}, expected promoted False with reason {reason!r}"
    pointer = ctx.redis.get("active:prod")
    assert pointer == "fraud:2", f"{why}: active:prod moved to {pointer!r}; prod must keep serving fraud:2"
    stage = ctx.redis.hget("model:fraud:v3", "stage")
    assert stage == "staged", f"{why}: fraud version 3 is {stage!r}, expected it still staged"


def _promoted(ctx, result, why):
    assert result == {"promoted": True, "reason": None}, f"{why}: promote_with_probe answered {result}, expected promoted True"
    assert ctx.redis.get("active:prod") == "fraud:3", f"{why}: active:prod holds {ctx.redis.get('active:prod')!r}, expected fraud:3"


def check_probe_deadline(ctx):
    m, _ = _client(ctx)
    _promoted(ctx, _promote(m), "with a healthy pool holding the registered digest")
    calls = ctx.grpc.calls_to("Probe")
    assert calls, "no Probe call was made before the pointer moved"
    for call in calls:
        assert call.timeout is not None, "a Probe call carries no deadline: a pool that never answers would hold the promotion forever"
        assert 9.5 <= call.timeout <= 10.5, f"a Probe call carries a {call.timeout} s deadline, expected PROBE_DEADLINE_S = 10"
    ctx.redis.set("active:prod", "fraud:2")
    ctx.redis.hset("model:fraud:v3", "stage", "staged")
    ctx.grpc.set_latency("Probe", 30.0)
    before = len(ctx.grpc.calls_to("Probe"))
    _held(ctx, _promote(m), "probe_timeout", "with a pool that takes 30 s to answer")
    made = len(ctx.grpc.calls_to("Probe")) - before
    assert made == 1, f"a probe that ran out of time was attempted {made} times: DEADLINE_EXCEEDED is final, reported as probe_timeout"


def check_digest_match(ctx):
    m, pool = _client(ctx)
    pool.loaded["fraud:3"] = "sha256:stale"
    _held(ctx, _promote(m), "digest_mismatch", "with the pool holding sha256:stale instead of the registered sha256:a3")
    pool.loaded["fraud:3"] = ""
    _held(ctx, _promote(m), "digest_mismatch", "with the pool answering an empty loaded_digest (nothing loaded yet)")
    pool.loaded["fraud:3"] = "sha256:a3.partial"
    _held(ctx, _promote(m), "digest_mismatch", "with the pool holding sha256:a3.partial instead of the registered sha256:a3")
    pool.loaded.clear()
    _promoted(ctx, _promote(m), "once the pool loaded the registered digest")


def check_failure_blocks(ctx):
    m, _ = _client(ctx)
    ctx.grpc.fail("Probe", grpc.StatusCode.PERMISSION_DENIED, "registryd may not probe prod")
    _held(ctx, _promote(m), "probe_failed", "with the probe refused PERMISSION_DENIED")
    made = len(ctx.grpc.calls_to("Probe"))
    assert made == 1, f"a PERMISSION_DENIED probe was attempted {made} times: only UNAVAILABLE is worth a retry"
    for code in (grpc.StatusCode.INTERNAL, grpc.StatusCode.RESOURCE_EXHAUSTED, grpc.StatusCode.ABORTED, grpc.StatusCode.NOT_FOUND):
        ctx.grpc.fail("Probe", code, "probe refused")
        before = len(ctx.grpc.calls_to("Probe"))
        _held(ctx, _promote(m), "probe_failed", f"with the probe refused {code.name}")
        made = len(ctx.grpc.calls_to("Probe")) - before
        assert made == 1, f"a {code.name} probe was attempted {made} times: only UNAVAILABLE is worth a retry"
    before = len(ctx.grpc.calls_to("Probe"))
    ctx.grpc.fail("Probe", grpc.StatusCode.UNAVAILABLE, "pool restarting", times=5)
    _held(ctx, _promote(m), "probe_failed", "with the pool UNAVAILABLE on every attempt")
    made = len(ctx.grpc.calls_to("Probe")) - before
    assert made == 2, f"a pool that stays UNAVAILABLE was probed {made} times, expected MAX_ATTEMPTS = 2"


def check_unavailable_retry(ctx):
    m, pool = _client(ctx)
    ctx.grpc.fail("Probe", grpc.StatusCode.UNAVAILABLE, "pool restarting", times=1)
    result = _promote(m)
    made = len(ctx.grpc.calls_to("Probe"))
    assert made == 2, f"the pool answered UNAVAILABLE once and the promotion made {made} probe call(s): it must probe again and see the digest before the pointer moves"
    _promoted(ctx, result, "after one UNAVAILABLE and a healthy second attempt")
    # The pool restarts slowly: the first attempt answers UNAVAILABLE after 8 s. The retry gets its own 10 s.
    ctx.redis.set("active:prod", "fraud:2")
    ctx.redis.hset("model:fraud:v3", "stage", "staged")
    ctx.grpc.set_latency("Probe", 8.0)
    pool.restarting = 1
    before = len(ctx.grpc.calls_to("Probe"))
    result = _promote(m)
    calls = ctx.grpc.calls_to("Probe")[before:]
    assert len(calls) == 2, f"the pool answered UNAVAILABLE after 8 s and the promotion made {len(calls)} probe call(s), expected a retry"
    for call in calls:
        assert call.timeout is not None and 9.5 <= call.timeout <= 10.5, f"a Probe attempt carried a {call.timeout} s deadline after the first one took 8 s: every attempt gets the full PROBE_DEADLINE_S = 10"
    _promoted(ctx, result, "after an UNAVAILABLE that took 8 s and a second attempt that answers in 8 s")
`,
    typescript: `const DIGEST = 'sha256:a3';

/** Every pool has loaded the bytes it was asked about, except the versions in loaded ("model:version" → digest). */
function client(ctx) {
  const pkg = ctx.proto('modelregistry.proto');
  const loaded = new Map<string, string>();
  // The next calls that find the pool restarting: they answer UNAVAILABLE after their latency.
  const pool = {restarting: 0};
  ctx.grpc.serve(pkg.modelregistry.Serving.service, {
    Probe(call, callback) {
      if (pool.restarting > 0) {
        pool.restarting -= 1;
        return callback({code: ctx.grpc.status.UNAVAILABLE, details: 'pool restarting'});
      }
      const {model, version, expected_digest} = call.request;
      callback(null, {loaded_digest: loaded.get(\`\${model}:\${version}\`) ?? expected_digest});
    },
  });
  for (const [n, stage] of [[2, 'promoted'], [3, 'staged']]) {
    ctx.redis.hset(\`model:fraud:v\${n}\`, 'name', 'fraud', 'version', String(n), 'artifact_digest', \`sha256:a\${n}\`, 'training_run_id', \`r-\${n}\`, 'eval_id', \`e-\${n}\`, 'stage', stage);
  }
  ctx.redis.set('active:prod', 'fraud:2');
  return {m: ctx.load('client'), loaded, pool};
}

const promote = m => m.promoteWithProbe('prod', 'fraud', 3, DIGEST, 'e-3');

function held(ctx, result, reason: string, why: string): void {
  assert.deepStrictEqual(result, {promoted: false, reason}, \`\${why}: promoteWithProbe answered \${JSON.stringify(result)}, expected promoted false with reason \${reason}\`);
  const pointer = ctx.redis.get('active:prod');
  assert.equal(pointer, 'fraud:2', \`\${why}: active:prod moved to \${pointer}; prod must keep serving fraud:2\`);
  const stage = ctx.redis.hget('model:fraud:v3', 'stage');
  assert.equal(stage, 'staged', \`\${why}: fraud version 3 is \${stage}, expected it still staged\`);
}

function promoted(ctx, result, why: string): void {
  assert.deepStrictEqual(result, {promoted: true, reason: null}, \`\${why}: promoteWithProbe answered \${JSON.stringify(result)}, expected promoted true\`);
  assert.equal(ctx.redis.get('active:prod'), 'fraud:3', \`\${why}: active:prod must hold fraud:3\`);
}

export async function check_probe_deadline(ctx) {
  const {m} = client(ctx);
  promoted(ctx, await promote(m), 'with a healthy pool holding the registered digest');
  const calls = ctx.grpc.callsTo('Probe');
  assert(calls.length > 0, 'no Probe call was made before the pointer moved');
  for (const call of calls) {
    assert(call.timeout !== null, 'a Probe call carries no deadline: a pool that never answers would hold the promotion forever');
    assert(9.5 <= call.timeout && call.timeout <= 10.5, \`a Probe call carries a \${call.timeout} s deadline, expected PROBE_DEADLINE_MS = 10000\`);
  }
  ctx.redis.set('active:prod', 'fraud:2');
  ctx.redis.hset('model:fraud:v3', 'stage', 'staged');
  ctx.grpc.setLatency('Probe', 30.0);
  const before = ctx.grpc.callsTo('Probe').length;
  held(ctx, await promote(m), 'probe_timeout', 'with a pool that takes 30 s to answer');
  const made = ctx.grpc.callsTo('Probe').length - before;
  assert.equal(made, 1, \`a probe that ran out of time was attempted \${made} times: DEADLINE_EXCEEDED is final, reported as probe_timeout\`);
}

export async function check_digest_match(ctx) {
  const {m, loaded} = client(ctx);
  loaded.set('fraud:3', 'sha256:stale');
  held(ctx, await promote(m), 'digest_mismatch', 'with the pool holding sha256:stale instead of the registered sha256:a3');
  loaded.set('fraud:3', '');
  held(ctx, await promote(m), 'digest_mismatch', 'with the pool answering an empty loaded_digest (nothing loaded yet)');
  loaded.set('fraud:3', 'sha256:a3.partial');
  held(ctx, await promote(m), 'digest_mismatch', 'with the pool holding sha256:a3.partial instead of the registered sha256:a3');
  loaded.clear();
  promoted(ctx, await promote(m), 'once the pool loaded the registered digest');
}

export async function check_failure_blocks(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('Probe', ctx.grpc.status.PERMISSION_DENIED, 'registryd may not probe prod');
  held(ctx, await promote(m), 'probe_failed', 'with the probe refused PERMISSION_DENIED');
  let made = ctx.grpc.callsTo('Probe').length;
  assert.equal(made, 1, \`a PERMISSION_DENIED probe was attempted \${made} times: only UNAVAILABLE is worth a retry\`);
  for (const code of ['INTERNAL', 'RESOURCE_EXHAUSTED', 'ABORTED', 'NOT_FOUND']) {
    ctx.grpc.fail('Probe', ctx.grpc.status[code], 'probe refused');
    const before = ctx.grpc.callsTo('Probe').length;
    held(ctx, await promote(m), 'probe_failed', \`with the probe refused \${code}\`);
    made = ctx.grpc.callsTo('Probe').length - before;
    assert.equal(made, 1, \`a \${code} probe was attempted \${made} times: only UNAVAILABLE is worth a retry\`);
  }
  const before = ctx.grpc.callsTo('Probe').length;
  ctx.grpc.fail('Probe', ctx.grpc.status.UNAVAILABLE, 'pool restarting', 5);
  held(ctx, await promote(m), 'probe_failed', 'with the pool UNAVAILABLE on every attempt');
  made = ctx.grpc.callsTo('Probe').length - before;
  assert.equal(made, 2, \`a pool that stays UNAVAILABLE was probed \${made} times, expected MAX_ATTEMPTS = 2\`);
}

export async function check_unavailable_retry(ctx) {
  const {m, pool} = client(ctx);
  ctx.grpc.fail('Probe', ctx.grpc.status.UNAVAILABLE, 'pool restarting', 1);
  const result = await promote(m);
  const made = ctx.grpc.callsTo('Probe').length;
  assert.equal(made, 2, \`the pool answered UNAVAILABLE once and the promotion made \${made} probe call(s): it must probe again and see the digest before the pointer moves\`);
  promoted(ctx, result, 'after one UNAVAILABLE and a healthy second attempt');
  // The pool restarts slowly: the first attempt answers UNAVAILABLE after 8 s. The retry gets its own 10 s.
  ctx.redis.set('active:prod', 'fraud:2');
  ctx.redis.hset('model:fraud:v3', 'stage', 'staged');
  ctx.grpc.setLatency('Probe', 8.0);
  pool.restarting = 1;
  const before = ctx.grpc.callsTo('Probe').length;
  const slow = await promote(m);
  const calls = ctx.grpc.callsTo('Probe').slice(before);
  assert.equal(calls.length, 2, \`the pool answered UNAVAILABLE after 8 s and the promotion made \${calls.length} probe call(s), expected a retry\`);
  for (const call of calls) {
    assert(call.timeout !== null && 9.5 <= call.timeout && call.timeout <= 10.5, \`a Probe attempt carried a \${call.timeout} s deadline after the first one took 8 s: every attempt gets the full PROBE_DEADLINE_MS = 10000\`);
  }
  promoted(ctx, slow, 'after an UNAVAILABLE that took 8 s and a second attempt that answers in 8 s');
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "registry/gen/modelregistry"

	"leetbuild/harness"
)

const hRegistered = "sha256:a3"

var hBg = context.Background()

// hPoolPeer has loaded the bytes it is asked about, except the versions in loaded ("model:version" → digest).
type hPoolPeer struct {
	pb.UnimplementedServingServer
	loaded map[string]string
	// The next calls that find the pool restarting: they answer UNAVAILABLE after their latency.
	restarting int
}

func (p *hPoolPeer) Probe(_ context.Context, req *pb.ProbeRequest) (*pb.ProbeReply, error) {
	if p.restarting > 0 {
		p.restarting--
		return nil, status.Error(codes.Unavailable, "pool restarting")
	}
	digest, ok := p.loaded[fmt.Sprintf("%s:%d", req.GetModel(), req.GetVersion())]
	if !ok {
		digest = req.GetExpectedDigest()
	}
	return &pb.ProbeReply{LoadedDigest: digest}, nil
}

func hSetup(ctx *harness.Ctx) *hPoolPeer {
	peer := &hPoolPeer{loaded: map[string]string{}}
	pb.RegisterServingServer(ctx.GRPC.Server(""), peer)
	ctx.Redis.Do("HSET", "model:fraud:v2", "name", "fraud", "version", "2", "artifact_digest", "sha256:a2", "training_run_id", "r-2", "eval_id", "e-2", "stage", "promoted")
	ctx.Redis.Do("HSET", "model:fraud:v3", "name", "fraud", "version", "3", "artifact_digest", "sha256:a3", "training_run_id", "r-3", "eval_id", "e-3", "stage", "staged")
	ctx.Redis.Set("active:prod", "fraud:2")
	return peer
}

func hTryPromote(ctx *harness.Ctx) probeResult {
	result, err := promoteWithProbe(hBg, "prod", "fraud", 3, hRegistered, "e-3")
	ctx.NoError(err, "promoteWithProbe failed")
	return result
}

func hHeld(ctx *harness.Ctx, result probeResult, reason, why string) {
	ctx.Assert(!result.Promoted && result.Reason == reason, "%s: promoteWithProbe answered %+v, expected promoted false with reason %q", why, result, reason)
	pointer, _ := ctx.Redis.Get("active:prod")
	ctx.Equal(pointer, "fraud:2", "%s: prod must keep serving fraud:2; active:prod", why)
	stage, _ := ctx.Redis.HGet("model:fraud:v3", "stage")
	ctx.Equal(stage, "staged", "%s: fraud version 3 must stay staged; its stage", why)
}

func hPromoted(ctx *harness.Ctx, result probeResult, why string) {
	ctx.Assert(result.Promoted && result.Reason == "", "%s: promoteWithProbe answered %+v, expected promoted true", why, result)
	pointer, _ := ctx.Redis.Get("active:prod")
	ctx.Equal(pointer, "fraud:3", "%s: active:prod", why)
}

func CheckProbeDeadline(ctx *harness.Ctx) {
	hSetup(ctx)
	hPromoted(ctx, hTryPromote(ctx), "with a healthy pool holding the registered digest")
	calls := ctx.GRPC.CallsTo("Probe", "")
	ctx.Assert(len(calls) > 0, "no Probe call was made before the pointer moved")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "a Probe call carries no deadline: a pool that never answers would hold the promotion forever")
		ctx.Assert(9500*time.Millisecond <= call.Timeout && call.Timeout <= 10500*time.Millisecond, "a Probe call carries a %v deadline, expected 10 s", call.Timeout)
	}
	ctx.Redis.Set("active:prod", "fraud:2")
	ctx.Redis.Do("HSET", "model:fraud:v3", "stage", "staged")
	ctx.GRPC.SetLatency("Probe", 30.0, "")
	before := len(ctx.GRPC.CallsTo("Probe", ""))
	hHeld(ctx, hTryPromote(ctx), "probe_timeout", "with a pool that takes 30 s to answer")
	ctx.Equal(len(ctx.GRPC.CallsTo("Probe", ""))-before, 1, "DEADLINE_EXCEEDED is final, reported as probe_timeout; the attempts")
}

func CheckDigestMatch(ctx *harness.Ctx) {
	peer := hSetup(ctx)
	peer.loaded["fraud:3"] = "sha256:stale"
	hHeld(ctx, hTryPromote(ctx), "digest_mismatch", "with the pool holding sha256:stale instead of the registered sha256:a3")
	peer.loaded["fraud:3"] = ""
	hHeld(ctx, hTryPromote(ctx), "digest_mismatch", "with the pool answering an empty loaded_digest (nothing loaded yet)")
	peer.loaded["fraud:3"] = "sha256:a3.partial"
	hHeld(ctx, hTryPromote(ctx), "digest_mismatch", "with the pool holding sha256:a3.partial instead of the registered sha256:a3")
	delete(peer.loaded, "fraud:3")
	hPromoted(ctx, hTryPromote(ctx), "once the pool loaded the registered digest")
}

func CheckFailureBlocks(ctx *harness.Ctx) {
	hSetup(ctx)
	ctx.GRPC.Fail("Probe", codes.PermissionDenied, "registryd may not probe prod", 1, "")
	hHeld(ctx, hTryPromote(ctx), "probe_failed", "with the probe refused PERMISSION_DENIED")
	ctx.Equal(len(ctx.GRPC.CallsTo("Probe", "")), 1, "only UNAVAILABLE is worth a retry; the attempts of a PERMISSION_DENIED probe")
	for _, code := range []codes.Code{codes.Internal, codes.ResourceExhausted, codes.Aborted, codes.NotFound} {
		ctx.GRPC.Fail("Probe", code, "probe refused", 1, "")
		before := len(ctx.GRPC.CallsTo("Probe", ""))
		hHeld(ctx, hTryPromote(ctx), "probe_failed", fmt.Sprintf("with the probe refused %v", code))
		ctx.Equal(len(ctx.GRPC.CallsTo("Probe", ""))-before, 1, "only UNAVAILABLE is worth a retry; the attempts of a %v probe", code)
	}
	before := len(ctx.GRPC.CallsTo("Probe", ""))
	ctx.GRPC.Fail("Probe", codes.Unavailable, "pool restarting", 5, "")
	hHeld(ctx, hTryPromote(ctx), "probe_failed", "with the pool UNAVAILABLE on every attempt")
	ctx.Equal(len(ctx.GRPC.CallsTo("Probe", ""))-before, 2, "a pool that stays UNAVAILABLE gets maxAttempts = 2 probes; the attempts")
}

func CheckUnavailableRetry(ctx *harness.Ctx) {
	peer := hSetup(ctx)
	ctx.GRPC.Fail("Probe", codes.Unavailable, "pool restarting", 1, "")
	result := hTryPromote(ctx)
	ctx.Equal(len(ctx.GRPC.CallsTo("Probe", "")), 2, "the pool answered UNAVAILABLE once: the promotion must probe again and see the digest before the pointer moves; the probe calls")
	hPromoted(ctx, result, "after one UNAVAILABLE and a healthy second attempt")
	// The pool restarts slowly: the first attempt answers UNAVAILABLE after 8 s. The retry gets its own 10 s.
	ctx.Redis.Set("active:prod", "fraud:2")
	ctx.Redis.Do("HSET", "model:fraud:v3", "stage", "staged")
	ctx.GRPC.SetLatency("Probe", 8.0, "")
	peer.restarting = 1
	before := len(ctx.GRPC.CallsTo("Probe", ""))
	slow := hTryPromote(ctx)
	calls := ctx.GRPC.CallsTo("Probe", "")[before:]
	ctx.Equal(len(calls), 2, "the pool answered UNAVAILABLE after 8 s: the promotion must retry; the probe calls")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline() && 9500*time.Millisecond <= call.Timeout && call.Timeout <= 10500*time.Millisecond, "a Probe attempt carried a %v deadline after the first one took 8 s: every attempt gets the full probeDeadline = 10 s", call.Timeout)
	}
	hPromoted(ctx, slow, "after an UNAVAILABLE that took 8 s and a second attempt that answers in 8 s")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>

namespace {

const std::string kHRegistered = "sha256:a3";

// Every pool has loaded the bytes it is asked about, except the versions in loaded ("model:version" → digest).
class HPoolPeer final : public modelregistry::Serving::Service {
 public:
  std::map<std::string, std::string> loaded;
  // The next calls that find the pool restarting: they answer UNAVAILABLE after their latency.
  int restarting = 0;
  grpc::Status Probe(grpc::ServerContext*, const modelregistry::ProbeRequest* req, modelregistry::ProbeReply* out) override {
    if (restarting > 0) {
      --restarting;
      return grpc::Status(grpc::StatusCode::UNAVAILABLE, "pool restarting");
    }
    const auto it = loaded.find(req->model() + ":" + std::to_string(req->version()));
    out->set_loaded_digest(it == loaded.end() ? req->expected_digest() : it->second);
    return grpc::Status::OK;
  }
};

HPoolPeer& hSetup(harness::Ctx& ctx) {
  static HPoolPeer* peer = nullptr;
  delete peer;
  peer = new HPoolPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  ctx.Redis.Do("HSET", "model:fraud:v2", "name", "fraud", "version", "2", "artifact_digest", "sha256:a2", "training_run_id", "r-2", "eval_id", "e-2", "stage", "promoted");
  ctx.Redis.Do("HSET", "model:fraud:v3", "name", "fraud", "version", "3", "artifact_digest", "sha256:a3", "training_run_id", "r-3", "eval_id", "e-3", "stage", "staged");
  ctx.Redis.Set("active:prod", "fraud:2");
  return *peer;
}

ProbeResult hTryPromote() { return promoteWithProbe("prod", "fraud", 3, kHRegistered, "e-3"); }

void hHeld(harness::Ctx& ctx, const ProbeResult& result, const std::string& reason, const std::string& why) {
  ctx.Assert(!result.promoted && result.reason == reason, "%s: promoteWithProbe answered promoted %t reason %q, expected promoted false with reason %q", why,
             result.promoted, result.reason, reason);
  ctx.Equal(ctx.Redis.Get("active:prod").value_or(""), "fraud:2", "%s: prod must keep serving fraud:2; active:prod", why);
  ctx.Equal(ctx.Redis.HGet("model:fraud:v3", "stage").value_or(""), "staged", "%s: fraud version 3 must stay staged; its stage", why);
}

void hPromoted(harness::Ctx& ctx, const ProbeResult& result, const std::string& why) {
  ctx.Assert(result.promoted && result.reason.empty(), "%s: promoteWithProbe answered promoted %t reason %q, expected promoted true", why, result.promoted, result.reason);
  ctx.Equal(ctx.Redis.Get("active:prod").value_or(""), "fraud:3", "%s: active:prod", why);
}

}  // namespace

void CheckProbeDeadline(harness::Ctx& ctx) {
  hSetup(ctx);
  hPromoted(ctx, hTryPromote(), "with a healthy pool holding the registered digest");
  const auto calls = ctx.GRPC.CallsTo("Probe");
  ctx.Assert(!calls.empty(), "no Probe call was made before the pointer moved");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "a Probe call carries no deadline: a pool that never answers would hold the promotion forever");
    ctx.Assert(9.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 10.5, "a Probe call carries a %v s deadline, expected kProbeDeadline = 10 s", call.TimeoutSeconds());
  }
  ctx.Redis.Set("active:prod", "fraud:2");
  ctx.Redis.Do("HSET", "model:fraud:v3", "stage", "staged");
  ctx.GRPC.SetLatency("Probe", 30.0);
  const size_t before = ctx.GRPC.CallsTo("Probe").size();
  hHeld(ctx, hTryPromote(), "probe_timeout", "with a pool that takes 30 s to answer");
  ctx.Equal(ctx.GRPC.CallsTo("Probe").size() - before, 1, "DEADLINE_EXCEEDED is final, reported as probe_timeout; the attempts");
}

void CheckDigestMatch(harness::Ctx& ctx) {
  HPoolPeer& peer = hSetup(ctx);
  peer.loaded["fraud:3"] = "sha256:stale";
  hHeld(ctx, hTryPromote(), "digest_mismatch", "with the pool holding sha256:stale instead of the registered sha256:a3");
  peer.loaded["fraud:3"] = "";
  hHeld(ctx, hTryPromote(), "digest_mismatch", "with the pool answering an empty loaded_digest (nothing loaded yet)");
  peer.loaded["fraud:3"] = "sha256:a3.partial";
  hHeld(ctx, hTryPromote(), "digest_mismatch", "with the pool holding sha256:a3.partial instead of the registered sha256:a3");
  peer.loaded.clear();
  hPromoted(ctx, hTryPromote(), "once the pool loaded the registered digest");
}

void CheckFailureBlocks(harness::Ctx& ctx) {
  hSetup(ctx);
  ctx.GRPC.Fail("Probe", grpc::StatusCode::PERMISSION_DENIED, "registryd may not probe prod", 1);
  hHeld(ctx, hTryPromote(), "probe_failed", "with the probe refused PERMISSION_DENIED");
  ctx.Equal(ctx.GRPC.CallsTo("Probe").size(), 1, "only UNAVAILABLE is worth a retry; the attempts of a PERMISSION_DENIED probe");
  const std::pair<grpc::StatusCode, std::string> terminal[] = {{grpc::StatusCode::INTERNAL, "INTERNAL"},
                                                               {grpc::StatusCode::RESOURCE_EXHAUSTED, "RESOURCE_EXHAUSTED"},
                                                               {grpc::StatusCode::ABORTED, "ABORTED"},
                                                               {grpc::StatusCode::NOT_FOUND, "NOT_FOUND"}};
  for (const auto& [code, name] : terminal) {
    ctx.GRPC.Fail("Probe", code, "probe refused", 1);
    const size_t made = ctx.GRPC.CallsTo("Probe").size();
    hHeld(ctx, hTryPromote(), "probe_failed", "with the probe refused " + name);
    ctx.Equal(ctx.GRPC.CallsTo("Probe").size() - made, 1, "only UNAVAILABLE is worth a retry; the attempts of a %s probe", name);
  }
  const size_t before = ctx.GRPC.CallsTo("Probe").size();
  ctx.GRPC.Fail("Probe", grpc::StatusCode::UNAVAILABLE, "pool restarting", 5);
  hHeld(ctx, hTryPromote(), "probe_failed", "with the pool UNAVAILABLE on every attempt");
  ctx.Equal(ctx.GRPC.CallsTo("Probe").size() - before, 2, "a pool that stays UNAVAILABLE gets kMaxAttempts = 2 probes; the attempts");
}

void CheckUnavailableRetry(harness::Ctx& ctx) {
  HPoolPeer& peer = hSetup(ctx);
  ctx.GRPC.Fail("Probe", grpc::StatusCode::UNAVAILABLE, "pool restarting", 1);
  const ProbeResult result = hTryPromote();
  ctx.Equal(ctx.GRPC.CallsTo("Probe").size(), 2,
            "the pool answered UNAVAILABLE once: the promotion must probe again and see the digest before the pointer moves; the probe calls");
  hPromoted(ctx, result, "after one UNAVAILABLE and a healthy second attempt");
  // The pool restarts slowly: the first attempt answers UNAVAILABLE after 8 s. The retry gets its own 10 s.
  ctx.Redis.Set("active:prod", "fraud:2");
  ctx.Redis.Do("HSET", "model:fraud:v3", "stage", "staged");
  ctx.GRPC.SetLatency("Probe", 8.0);
  peer.restarting = 1;
  const size_t before = ctx.GRPC.CallsTo("Probe").size();
  const ProbeResult slow = hTryPromote();
  const auto calls = ctx.GRPC.CallsTo("Probe");
  ctx.Equal(calls.size() - before, 2, "the pool answered UNAVAILABLE after 8 s: the promotion must retry; the probe calls");
  for (size_t i = before; i < calls.size(); ++i) {
    ctx.Assert(calls[i].HasDeadline() && 9.5 <= calls[i].TimeoutSeconds() && calls[i].TimeoutSeconds() <= 10.5,
               "a Probe attempt carried a %v s deadline after the first one took 8 s: every attempt gets the full kProbeDeadline = 10 s", calls[i].TimeoutSeconds());
  }
  hPromoted(ctx, slow, "after an UNAVAILABLE that took 8 s and a second attempt that answers in 8 s");
}
`,
  },
  hints: [
    'Have the pool load other bytes, or stop answering: the version still gets prod, and a pool that never answers holds the promotion until someone kills the worker.',
    'The probe call has no deadline and its reply and errors are thrown away, so `pointer.promote` runs whatever the pool said; one attempt also means a pool restarting for a second blocks a valid promotion.',
    'Probe with `timeout=PROBE_DEADLINE_S`, retry only `UNAVAILABLE` up to `MAX_ATTEMPTS`; map `DEADLINE_EXCEEDED` to `probe_timeout` and other errors to `probe_failed`; compare `loaded_digest` and answer `digest_mismatch`; call `pointer.promote` last.',
  ],
  debrief: `The probe is the only evidence that the pool holds the bytes the registry vouched for, so the pointer waits for it and every way it can fail keeps the old version serving. The status code decides the retry: UNAVAILABLE describes a pool between restarts, while a timeout or a refusal will say the same thing again and only delays the operator's answer. Ten seconds bounds how long a stuck pool can hold a promotion worker. Production rollouts probe every replica rather than one endpoint, back off between attempts, shift traffic in steps with health checks between them as KServe's canary rollouts do, and record the failed probe on the version so the next attempt starts from it.`,
};
