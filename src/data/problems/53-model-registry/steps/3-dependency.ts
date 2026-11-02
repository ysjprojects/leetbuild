import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Serving probes before promotion traffic',
  concept: 'grpc',
  file: 'client',
  focus: ['registry', 'serving', 'redis'],
  task: `## Task

**Starting point.** \`promote_with_probe(pool, name, version, digest, percent)\` calls
\`probe.Probe(ProbeRequest(pool, expected_digest))\` over gRPC with no timeout, ignores the reply,
calls \`serving.set_traffic(pool, name, version, percent)\` and returns \`{"promoted": true}\`.
It compiles and hides four flaws.

**Failure mode the checks target.** A pool that loaded the wrong artifact, or that did not answer
at all, receives production traffic because the probe reply was not read and the call had no
deadline.

- Every probe attempt carries \`PROBE_DEADLINE_MS = 10_000\` (\`timeout=\` on the stub call). At
  most two attempts per pool; retry only \`UNAVAILABLE\`.
- The reply's \`loaded_digest\` must equal the registered digest. A difference returns
  \`{"promoted": false, "reason": "digest_mismatch"}\`.
- \`DEADLINE_EXCEEDED\` returns \`{"promoted": false, "reason": "probe_timeout"}\`; any other
  status returns \`"reason": "probe_failed"\`.
- \`serving.set_traffic\` is called only after the digest comparison passed, so on every failure
  path the previous version keeps 100% and the operator sees the reason.
- The probe request shape and the traffic call stay as they are.`,
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
        'Each probe attempt carries a 10 000 ms deadline. The starter has none, so a pool that never answers blocks the promotion worker forever.',
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
        'The probe reports `loaded_digest` and a difference returns `digest_mismatch` without moving traffic. The starter promotes on connection success and never reads the digest.',
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
        'A `DEADLINE_EXCEEDED` returns `{"promoted": false, "reason": "probe_timeout"}`. The starter promotes anyway when the timeout hits, which is how the wrong artifact reaches a fleet.',
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
        'The traffic shift happens after the digest comparison, so a mismatch or a failure leaves the previous version serving. The starter shifts traffic first and checks nothing.',
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
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
      starter: `/** Promote: probes the pool, then shifts traffic. */
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
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
    "A pool still serving last week's artifact got promoted to 100% and the dashboard shows `promoted: true`. On another day the promotion worker hung for forty minutes on one pool.",
    'The reply of `probe.Probe` is discarded, so the loaded digest is never compared, and the call has no timeout, so a silent pool blocks the worker instead of failing the promotion.',
    'Call `Probe` with `timeout=PROBE_DEADLINE_MS / 1000`, two attempts on `UNAVAILABLE`; map `DEADLINE_EXCEEDED` to `probe_timeout`, `loaded_digest != digest` to `digest_mismatch`, else `probe_failed`; call `set_traffic` after the comparison only.',
  ],
  debrief: `The comparison sits between the probe and the traffic call because that is the only point where the registry knows both digests: the one it registered and the one the pool reports it loaded. A deadline makes "no answer" a bounded, named failure, and returning before set_traffic makes every failure leave the previous version serving. Production serving platforms layer more on this gate. KServe's canary rollout tracks the last revision that reached 100%, routes only \`canaryTrafficPercent\` to the new revision, refuses to route to a revision that is not ready, and on rollback pins all traffic to the previous good revision while it is still loaded.`,
};
