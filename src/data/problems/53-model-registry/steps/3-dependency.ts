import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Serving probes before promotion traffic',
  concept: 'grpc',
  file: 'client',
  focus: ['registry', 'serving', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the probe connects, the
call returns and the pool gets traffic, so the demo promotes. It compiles, and it treats a
connection and a timeout as proof of two different things. Review it like the service owner, fix it,
and prove the fix with the checks below.

Implement the serving probe that must pass before a pool's traffic increases:

- Promotion first warms the target pool over **gRPC** (\`ServingProbe.Probe(pool, expected_digest)\`).
  Every attempt carries a **10-second deadline** (\`PROBE_DEADLINE_MS = 10_000\`); the draft has
  none, so one slow pool pins the promotion worker indefinitely.
- At most **two attempts** per pool. Retry only \`UNAVAILABLE\`; every other status fails fast. The
  draft retries nothing and bounds nothing.
- The probe reply carries the digest the pool **actually loaded** (\`loaded_digest\`). Promotion may
  increase traffic **only when it equals the registered digest**; any difference returns
  \`{"promoted": false, "reason": "digest_mismatch"}\` and leaves traffic on the previous version.
  The draft never looks at the loaded digest, so a pool serving stale bytes is promoted.
- A probe **timeout is a blocked promotion**, not a reason to proceed: return
  \`{"promoted": false, "reason": "probe_timeout"}\`. The draft promotes anyway "to keep the
  pipeline moving", which is how a version with the wrong artifact reaches half the fleet.
- Any other probe failure returns \`{"promoted": false, "reason": "probe_failed"}\` with the same
  property: **traffic does not move**. Only after a verified digest does the code call
  \`serving.set_traffic(pool, name, version, percent)\`.

**Failure mode the checks target.** A timeout must block rather than proceed, a loaded digest that
differs from the registered one must block, and a failure must leave the previous version serving
100% with a reason an operator can read. The draft passes the serial happy path and fails all three
at the moment they are the only thing standing between a bad artifact and production traffic.

## What to keep

The probe call shape and the traffic-shifting call are fine. The fix is the deadline, the bounded
retry, the digest comparison and the no-move-on-failure rule.`,
  sequence: {
    participants: ['Registry promotion', 'Serving pool'],
    messages: [
      {
        from: 'Registry promotion',
        to: 'Serving pool',
        label: 'Probe(pool, expected_digest) · deadline 10 s',
        kind: 'sync',
      },
      {from: 'Serving pool', to: 'Registry promotion', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Registry promotion', to: 'Registry promotion', label: 'block · reason = probe_timeout', kind: 'sync'},
      {from: 'Registry promotion', to: 'Serving pool', label: 'Probe again · attempt 2', kind: 'sync'},
      {from: 'Serving pool', to: 'Registry promotion', label: 'loaded_digest = sha256:…b7', kind: 'reply'},
      {
        from: 'Registry promotion',
        to: 'Registry promotion',
        label: 'loaded_digest == registered? else digest_mismatch',
        kind: 'sync',
      },
      {
        from: 'Registry promotion',
        to: 'Serving pool',
        label: 'set_traffic only after the digest matches',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'probe-call',
      title: 'Probes the serving pool over gRPC before promoting',
      detail: 'The promotion path invokes the `Probe` RPC with the pool and the registered digest.',
      match: {
        python: {all: [/Probe/]},
        typescript: {all: [/Probe/]},
        go: {all: [/Probe/]},
        scala: {all: [/[Pp]robe/]},
        cpp: {all: [/Probe/]},
      },
    },
    {
      id: 'probe-deadline',
      title: 'Gives every probe a 10-second deadline',
      detail:
        'Each probe attempt carries a 10 000 ms deadline. The draft has none, so a pool that never answers blocks the promotion worker forever.',
      match: {
        python: {all: [/PROBE_DEADLINE_MS/, /timeout=/]},
        typescript: {all: [/PROBE_DEADLINE_MS/, /deadline/]},
        go: {all: [/probeDeadlineMs/, /WithTimeout/]},
        scala: {all: [/ProbeDeadlineMs/, /withDeadlineAfter/]},
        cpp: {all: [/kProbeDeadlineMs/, /set_deadline/]},
      },
    },
    {
      id: 'digest-match',
      title: 'Promotes only when the loaded digest matches the registered digest',
      detail:
        'The probe reports `loaded_digest` and a difference returns `digest_mismatch` without moving traffic. The draft promotes on connection success and never reads the digest.',
      match: {
        python: {all: [/loaded_digest/, /digest_mismatch/]},
        typescript: {all: [/loadedDigest/, /digest_mismatch/]},
        go: {all: [/LoadedDigest/, /digest_mismatch/]},
        scala: {all: [/loadedDigest/, /digest_mismatch/]},
        cpp: {all: [/loaded_digest/, /digest_mismatch/]},
      },
    },
    {
      id: 'timeout-blocks',
      title: 'Treats a probe timeout as a blocked promotion',
      detail:
        'A `DEADLINE_EXCEEDED` returns `{"promoted": false, "reason": "probe_timeout"}`. The draft promotes anyway when the timeout hits, which is how the wrong artifact reaches a fleet.',
      match: {
        python: {all: [/DEADLINE_EXCEEDED/, /probe_timeout/]},
        typescript: {all: [/DEADLINE_EXCEEDED/, /probe_timeout/]},
        go: {all: [/DeadlineExceeded/, /probe_timeout/]},
        scala: {all: [/DEADLINE_EXCEEDED/, /probe_timeout/]},
        cpp: {all: [/DEADLINE_EXCEEDED/, /probe_timeout/]},
      },
    },
    {
      id: 'no-move-on-failure',
      title: 'Increases traffic only after the digest is verified',
      detail:
        'The traffic shift happens after the digest comparison, so a mismatch or a failure leaves the previous version serving. The draft shifts traffic first and checks nothing.',
      match: {
        python: {order: [/loaded_digest/, /\.set_traffic\(/]},
        typescript: {order: [/loadedDigest/, /\.setTraffic\(/]},
        go: {order: [/LoadedDigest/, /\.SetTraffic\(/]},
        scala: {order: [/loadedDigest/, /\.setTraffic\(/]},
        cpp: {order: [/loaded_digest/, /\.set_traffic\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import serving_pb2
import serving_pb2_grpc

channel = grpc.insecure_channel("serving-prod:9000")
probe = serving_pb2_grpc.ServingProbeStub(channel)


class ServingPool:
    def set_traffic(self, pool: str, name: str, version: str, percent: int) -> None:
        """Shift the given percent of the pool to this version."""
        raise NotImplementedError


serving = ServingPool()


def promote_with_probe(pool: str, name: str, version: str, digest: str, percent: int) -> dict:
    # TODO: the draft promotes as soon as the probe call returns, never checks the digest the pool
    # loaded, gives the probe no deadline, and on a timeout promotes anyway to keep the pipeline
    # moving. Verify loaded_digest against the registered digest, block on a timeout with a visible
    # reason, and only then move traffic.
    probe.Probe(serving_pb2.ProbeRequest(pool=pool, expected_digest=digest))
    serving.set_traffic(pool, name, version, percent)
    return {"promoted": True, "pool": pool, "version": version}
`,
      solution: `import grpc

import serving_pb2
import serving_pb2_grpc

PROBE_DEADLINE_MS = 10_000
MAX_PROBE_ATTEMPTS = 2

channel = grpc.insecure_channel("serving-prod:9000")
probe = serving_pb2_grpc.ServingProbeStub(channel)


class ServingPool:
    def set_traffic(self, pool: str, name: str, version: str, percent: int) -> None:
        """Shift the given percent of the pool to this version."""
        raise NotImplementedError


serving = ServingPool()


def probe_pool(pool: str, digest: str) -> str:
    """Warm the pool and return the digest it actually loaded, or raise."""
    last_error: grpc.RpcError | None = None
    for _ in range(MAX_PROBE_ATTEMPTS):
        try:
            reply = probe.Probe(
                serving_pb2.ProbeRequest(pool=pool, expected_digest=digest),
                timeout=PROBE_DEADLINE_MS / 1000,
            )
            return reply.loaded_digest
        except grpc.RpcError as error:
            last_error = error
            if error.code() != grpc.StatusCode.UNAVAILABLE:
                break
    raise last_error


def promote_with_probe(pool: str, name: str, version: str, digest: str, percent: int) -> dict:
    try:
        loaded_digest = probe_pool(pool, digest)
    except grpc.RpcError as error:
        if error.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
            return {"promoted": False, "reason": "probe_timeout"}
        return {"promoted": False, "reason": "probe_failed"}
    if loaded_digest != digest:
        return {"promoted": False, "reason": "digest_mismatch"}
    serving.set_traffic(pool, name, version, percent)
    return {"promoted": True, "pool": pool, "name": name, "version": version}
`,
    },
    typescript: {
      starter: `/** Promote: a model-generated draft that promotes when the probe call returns. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface ProbeReply {
  loaded_digest: string;
}

interface ServingProbeClient {
  Probe(
    request: {pool: string; expected_digest: string},
    callback: (error: grpc.ServiceError | null, reply: ProbeReply) => void,
  ): void;
}

const {serving: servingPackage} = grpc.loadPackageDefinition(protoLoader.loadSync('serving.proto')) as unknown as {
  serving: {ServingProbe: new (target: string, credentials: grpc.ChannelCredentials) => ServingProbeClient};
};
const probe = new servingPackage.ServingProbe('serving-prod:9000', grpc.credentials.createInsecure());

class ServingPool {
  setTraffic(pool: string, name: string, version: string, percent: number): void {
    throw new Error(\`shift \${percent}% of \${pool} to \${name}:\${version}\`);
  }
}

const serving = new ServingPool();

export async function promoteWithProbe(
  pool: string,
  name: string,
  version: string,
  digest: string,
  percent: number,
): Promise<{promoted: boolean; reason?: string}> {
  // TODO: the draft promotes as soon as the probe call returns, never checks the digest the pool
  // loaded, gives the probe no deadline, and on a timeout promotes anyway to keep the pipeline
  // moving. Verify loadedDigest against the registered digest, block on a timeout with a visible
  // reason, and only then move traffic.
  await new Promise<void>((resolve, reject) => {
    probe.Probe({pool, expected_digest: digest}, error => (error ? reject(error) : resolve()));
  });
  serving.setTraffic(pool, name, version, percent);
  return {promoted: true};
}
`,
      solution: `/** Promote: probe with a 10 s deadline and shift traffic only after a verified digest. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const PROBE_DEADLINE_MS = 10_000;
const MAX_PROBE_ATTEMPTS = 2;

interface ProbeReply {
  loaded_digest: string;
}

interface ServingProbeClient {
  Probe(
    request: {pool: string; expected_digest: string},
    metadata: grpc.Metadata,
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply: ProbeReply) => void,
  ): void;
}

const {serving: servingPackage} = grpc.loadPackageDefinition(protoLoader.loadSync('serving.proto')) as unknown as {
  serving: {ServingProbe: new (target: string, credentials: grpc.ChannelCredentials) => ServingProbeClient};
};
const probe = new servingPackage.ServingProbe('serving-prod:9000', grpc.credentials.createInsecure());

class ServingPool {
  setTraffic(pool: string, name: string, version: string, percent: number): void {
    throw new Error(\`shift \${percent}% of \${pool} to \${name}:\${version}\`);
  }
}

const serving = new ServingPool();

async function probePool(pool: string, digest: string): Promise<string> {
  let lastError: grpc.ServiceError | null = null;
  for (let attempt = 0; attempt < MAX_PROBE_ATTEMPTS; attempt++) {
    try {
      return await new Promise<string>((resolve, reject) => {
        probe.Probe(
          {pool, expected_digest: digest},
          new grpc.Metadata(),
          {deadline: Date.now() + PROBE_DEADLINE_MS},
          (error, reply) => (error ? reject(error) : resolve(reply.loaded_digest)),
        );
      });
    } catch (error) {
      lastError = error as grpc.ServiceError;
      if (lastError.code !== grpc.status.UNAVAILABLE) break;
    }
  }
  throw lastError ?? new Error('probe failed');
}

export async function promoteWithProbe(
  pool: string,
  name: string,
  version: string,
  digest: string,
  percent: number,
): Promise<{promoted: boolean; reason?: string}> {
  let loadedDigest: string;
  try {
    loadedDigest = await probePool(pool, digest);
  } catch (error) {
    const serviceError = error as grpc.ServiceError;
    if (serviceError.code === grpc.status.DEADLINE_EXCEEDED) return {promoted: false, reason: 'probe_timeout'};
    return {promoted: false, reason: 'probe_failed'};
  }
  if (loadedDigest !== digest) return {promoted: false, reason: 'digest_mismatch'};
  serving.setTraffic(pool, name, version, percent);
  return {promoted: true, pool, name, version};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
)

type ServingPool struct{}

func (s *ServingPool) SetTraffic(ctx context.Context, pool, name, version string, percent int) error {
	return nil
}

var serving = &ServingPool{}

func PromoteWithProbe(ctx context.Context, pool, name, version, digest string, percent int) map[string]any {
	// TODO: the draft promotes as soon as the probe call returns, never checks the digest the pool
	// loaded, gives the probe no deadline, and on a timeout promotes anyway to keep the pipeline
	// moving. Verify LoadedDigest against the registered digest, block on a timeout with a visible
	// reason, and only then move traffic.
	conn, _ := grpc.DialContext(ctx, "serving-"+pool+":9000", grpc.WithInsecure())
	client := NewServingProbeClient(conn)
	_, _ = client.Probe(ctx, &ProbeRequest{Pool: pool, ExpectedDigest: digest})
	_ = serving.SetTraffic(ctx, pool, name, version, percent)
	return map[string]any{"promoted": true, "pool": pool, "version": version}
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	probeDeadlineMs  = 10000
	maxProbeAttempts = 2
)

type ServingPool struct{}

func (s *ServingPool) SetTraffic(ctx context.Context, pool, name, version string, percent int) error {
	return nil
}

var serving = &ServingPool{}

func probePool(ctx context.Context, pool, digest string) (string, error) {
	conn, err := grpc.DialContext(ctx, "serving-"+pool+":9000", grpc.WithInsecure())
	if err != nil {
		return "", err
	}
	client := NewServingProbeClient(conn)
	var lastErr error
	for attempt := 0; attempt < maxProbeAttempts; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, probeDeadlineMs*time.Millisecond)
		reply, err := client.Probe(attemptCtx, &ProbeRequest{Pool: pool, ExpectedDigest: digest})
		cancel()
		if err != nil {
			lastErr = err
			if status.Code(err) != codes.Unavailable {
				break
			}
			continue
		}
		return reply.GetLoadedDigest(), nil
	}
	return "", lastErr
}

func PromoteWithProbe(ctx context.Context, pool, name, version, digest string, percent int) map[string]any {
	loadedDigest, err := probePool(ctx, pool, digest)
	if err != nil {
		if status.Code(err) == codes.DeadlineExceeded {
			return map[string]any{"promoted": false, "reason": "probe_timeout"}
		}
		return map[string]any{"promoted": false, "reason": "probe_failed"}
	}
	if loadedDigest != digest {
		return map[string]any{"promoted": false, "reason": "digest_mismatch"}
	}
	_ = serving.SetTraffic(ctx, pool, name, version, percent)
	return map[string]any{"promoted": true, "pool": pool, "name": name, "version": version}
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

object Promotion {
  val probe = ServingProbeGrpc
    .blockingStub(ManagedChannelBuilder.forAddress("serving-prod", 9000).usePlaintext().build())

  class ServingPool {
    def setTraffic(pool: String, name: String, version: String, percent: Int): Unit =
      throw new UnsupportedOperationException("shift traffic")
  }

  val serving = new ServingPool

  def promoteWithProbe(pool: String, name: String, version: String, digest: String, percent: Int): Map[String, Any] = {
    // TODO: the draft promotes as soon as the probe call returns, never checks the digest the pool
    // loaded, gives the probe no deadline, and on a timeout promotes anyway to keep the pipeline
    // moving. Verify loadedDigest against the registered digest, block on a timeout with a visible
    // reason, and only then move traffic.
    probe.probe(ProbeRequest(pool = pool, expectedDigest = digest))
    serving.setTraffic(pool, name, version, percent)
    Map("promoted" -> true, "pool" -> pool, "version" -> version)
  }
}
`,
      solution: `import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import java.util.concurrent.TimeUnit

object Promotion {
  val ProbeDeadlineMs = 10000L
  val MaxProbeAttempts = 2

  val probe = ServingProbeGrpc
    .blockingStub(ManagedChannelBuilder.forAddress("serving-prod", 9000).usePlaintext().build())

  class ServingPool {
    def setTraffic(pool: String, name: String, version: String, percent: Int): Unit =
      throw new UnsupportedOperationException("shift traffic")
  }

  val serving = new ServingPool

  def probePool(pool: String, digest: String): String = {
    var attempt = 0
    var last: StatusRuntimeException = null
    while (attempt < MaxProbeAttempts) {
      try {
        val reply = probe
          .withDeadlineAfter(ProbeDeadlineMs, TimeUnit.MILLISECONDS)
          .probe(ProbeRequest(pool = pool, expectedDigest = digest))
        return reply.loadedDigest
      } catch {
        case error: StatusRuntimeException =>
          last = error
          if (error.getStatus.getCode != Status.Code.UNAVAILABLE) attempt = MaxProbeAttempts
      }
      attempt += 1
    }
    throw last
  }

  def promoteWithProbe(pool: String, name: String, version: String, digest: String, percent: Int): Map[String, Any] = {
    val loadedDigest =
      try probePool(pool, digest)
      catch {
        case error: StatusRuntimeException if error.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED =>
          return Map("promoted" -> false, "reason" -> "probe_timeout")
        case _: StatusRuntimeException =>
          return Map("promoted" -> false, "reason" -> "probe_failed")
      }
    if (loadedDigest != digest) return Map("promoted" -> false, "reason" -> "digest_mismatch")
    serving.setTraffic(pool, name, version, percent)
    Map("promoted" -> true, "pool" -> pool, "name" -> name, "version" -> version)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include "serving.grpc.pb.h"

#include <memory>
#include <string>

using json = nlohmann::json;

struct ServingPool {
  void set_traffic(const std::string& pool, const std::string& name, const std::string& version, int percent);
};

ServingPool serving;

std::unique_ptr<ServingProbe::Stub> stub;

json promote_with_probe(const std::string& pool, const std::string& name, const std::string& version,
                        const std::string& digest, int percent) {
  // TODO: the draft promotes as soon as the probe call returns, never checks the digest the pool
  // loaded, gives the probe no deadline, and on a timeout promotes anyway to keep the pipeline
  // moving. Verify loaded_digest against the registered digest, block on a timeout with a visible
  // reason, and only then move traffic.
  grpc::ClientContext ctx;
  ProbeRequest request;
  request.set_pool(pool);
  request.set_expected_digest(digest);
  ProbeReply reply;
  stub->Probe(&ctx, request, &reply);
  serving.set_traffic(pool, name, version, percent);
  return json{{"promoted", true}, {"pool", pool}, {"version", version}};
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include "serving.grpc.pb.h"

#include <chrono>
#include <memory>
#include <string>

using json = nlohmann::json;

constexpr long long kProbeDeadlineMs = 10000;
constexpr int kMaxProbeAttempts = 2;

struct ServingPool {
  void set_traffic(const std::string& pool, const std::string& name, const std::string& version, int percent);
};

ServingPool serving;

std::unique_ptr<ServingProbe::Stub> stub;

std::string probe_pool(const std::string& pool, const std::string& digest) {
  grpc::Status last = grpc::Status::OK;
  for (int attempt = 0; attempt < kMaxProbeAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kProbeDeadlineMs));
    ProbeRequest request;
    request.set_pool(pool);
    request.set_expected_digest(digest);
    ProbeReply reply;
    const grpc::Status status = stub->Probe(&ctx, request, &reply);
    if (status.ok()) return reply.loaded_digest();
    last = status;
    if (status.error_code() != grpc::StatusCode::UNAVAILABLE) break;
  }
  throw last;
}

json promote_with_probe(const std::string& pool, const std::string& name, const std::string& version,
                        const std::string& digest, int percent) {
  std::string loaded_digest;
  try {
    loaded_digest = probe_pool(pool, digest);
  } catch (const grpc::Status& status) {
    if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
      return json{{"promoted", false}, {"reason", "probe_timeout"}};
    }
    return json{{"promoted", false}, {"reason", "probe_failed"}};
  }
  if (loaded_digest != digest) {
    return json{{"promoted", false}, {"reason", "digest_mismatch"}};
  }
  serving.set_traffic(pool, name, version, percent);
  return json{{"promoted", true}, {"pool", pool}, {"name", name}, {"version", version}};
}
`,
    },
  },
  hints: [
    'A connection is not a proof. The probe must return the digest the pool *loaded* — `loaded_digest` — and promotion may proceed only when it equals the registered digest; anything else is `digest_mismatch` and traffic stays where it is.',
    'Bound both axes: a deadline per attempt (`withDeadlineAfter(10_000, MILLISECONDS)`, `context.WithTimeout`, `{deadline: Date.now() + PROBE_DEADLINE_MS}`) and a cap on attempts, retrying only `UNAVAILABLE`. A pool that never answers must fail the promotion, not stall the worker or get a free pass.',
    'On every failure path, return before the traffic call. A timeout is `probe_timeout`, a mismatch is `digest_mismatch`, a repeated `UNAVAILABLE` is `probe_failed` — and in all three the previous version keeps 100% and the reason is visible to the operator.',
  ],
  debrief: `The interview question behind this step is what counts as proof before traffic moves. A TCP connection proves a listener exists; it says nothing about which artifact that listener loaded. The draft promotes on the weaker signal and, worse, treats a timeout as a reason to proceed — the exact moment when you know the least. The fix is a deadline so "no answer" stays a bounded failure, a digest comparison so the pool has to prove which bytes it holds, and a return before the traffic call so a failed probe leaves the previous version serving with a readable reason. Real platforms add a cache-warm step that verifies the artifact checksum after load, a gradual 1%-then-100% ramp, and automatic rollback when the promoted version's error rate crosses a threshold.`,
};
