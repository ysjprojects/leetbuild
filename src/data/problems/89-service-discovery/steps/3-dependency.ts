import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Health checks before traffic, not after',
  concept: 'grpc',
  file: 'client',
  focus: ['discovery', 'instances', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it reads the registry and
returns what it finds. It hides the flaw that turns a crash into minutes of errors — registered is
treated as healthy, so the routing set is a list of what *was* true when the last heartbeat arrived.

Implement \`routable(service)\` — the function every router calls before it picks a backend — and the
internal route \`GET /v1/routable/{service}\` that exposes it as
\`{"instances": […], "excluded": [{"instance_id", "address", "reason"}]}\`.

- Candidates come from the registry (\`sd:{service}:*\`). Each candidate must be **probed over gRPC
  before it is returned**, never after a caller complains: the probe is the \`Health/Check\` RPC and
  it carries a **200 ms deadline**. A process that was killed, is blocked, or is draining must fail
  the probe rather than hold a request for as long as it takes to time out at the client.
- A candidate that fails its probe is **excluded from the routing set** and stays registered: the
  registry entry is untouched, and the exclusion is recorded with a reason so the read API can
  explain it. The draft's alternative — routing to it and discovering the failure when a request
  fails — puts the error on a user and takes an interval to notice.
- Probe verdicts are **shared, not per-caller**. Cache the verdict in Redis under
  \`sd:probe:{service}:{instance_id}\` (\`SERVING\` / \`NOT_SERVING\`) with a **5-second TTL**: ten
  routers asking for the same service must not each open ten sockets to the same instance, and two
  callers must never see two different verdicts for the same instance in the same second.
- The exclusion lives in \`sd:excluded:{service}\` as a hash of \`instance_id → {"reason": …}\`. A
  passing probe **readmits** the instance: drop the exclusion and write the fresh \`SERVING\`
  verdict, so recovery needs no operator and no re-registration.
- Excluded instances appear in \`excluded\` with their address and reason; only \`SERVING\`
  instances appear in \`instances\`, with \`instance_id\`, \`address\`, \`port\` and
  \`metadata_version\`.

**Failure mode the checks target.** Registration is an intent; health is an observation. A
discovery layer that returns registered instances has replaced the question "who can serve this?"
with "who said they were here recently?", and the difference is exactly one crashed process lasting
one heartbeat interval — the interval during which a user sees 503s from a backend the platform
still advertises. The probe cache is the second half of the story: probing per caller multiplies
the load on a struggling instance, and *not* sharing the verdict means two routers disagree about
the same backend, so one excludes it while the other keeps sending traffic.

The tests: an instance that fails its probe is absent from \`instances\` and present in
\`excluded\`; a passing probe readmits it; and two callers reading the same probe state get the
same verdict.`,
  sequence: {
    participants: ['Router', 'Discovery client', 'Redis', 'Instance'],
    messages: [
      {from: 'Router', to: 'Discovery client', label: 'GET /v1/routable/checkout', kind: 'sync'},
      {
        from: 'Discovery client',
        to: 'Redis',
        label: 'GET sd:probe:checkout:checkout-3 (shared verdict)',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Discovery client', label: 'nil — verdict is stale or never taken', kind: 'reply'},
      {from: 'Discovery client', to: 'Instance', label: 'Health/Check · deadline 200 ms', kind: 'sync'},
      {from: 'Instance', to: 'Discovery client', label: 'SERVING · UNAVAILABLE · DEADLINE_EXCEEDED', kind: 'reply'},
      {
        from: 'Discovery client',
        to: 'Redis',
        label: 'SET sd:probe:checkout:checkout-3 SERVING EX 5 · HSET sd:excluded:checkout on failure',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Discovery client', label: 'OK', kind: 'reply'},
      {
        from: 'Discovery client',
        to: 'Router',
        label: '200 {instances: [probed SERVING], excluded: [{reason: "probe failed"}]}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'probe-deadline',
      title: 'The probe carries a 200 ms deadline',
      detail:
        'The gRPC `Health/Check` is issued with a **200 ms** deadline (`timeout`, `withDeadlineAfter`, `context.WithTimeout`, `set_deadline`). The draft issues no probe at all, so a hung instance holds routing decisions for as long as the client waits.',
      match: {
        python: {all: [/PROBE_DEADLINE_MS/, /timeout=/, /200/]},
        typescript: {all: [/PROBE_DEADLINE_MS/, /deadline/, /200/]},
        go: {all: [/probeDeadlineMs/, /context\.WithTimeout/, /200/]},
        scala: {all: [/ProbeDeadlineMs/, /withDeadlineAfter|deadline/, /200/]},
        cpp: {all: [/kProbeDeadlineMs/, /deadline/, /200/]},
      },
    },
    {
      id: 'probe-before-return',
      title: 'Instances are probed before they are returned',
      detail:
        'The candidate loop consults the shared probe state (`sd:probe:`) and splits the result into `instances` and `excluded`. The draft returns what the registry holds, so failures are discovered by the caller.',
      match: {
        python: {all: [/sd:probe:/, /for instance in/, /excluded/]},
        typescript: {all: [/sd:probe:/, /for \(const instance/, /excluded/]},
        go: {all: [/probeKey|sd:probe:/, /for _, instance/, /excluded/]},
        scala: {all: [/sd:probe:/, /\.foreach|for \(/, /excluded/]},
        cpp: {all: [/kProbeKey|sd:probe:/, /for \(const auto&/, /excluded/]},
      },
    },
    {
      id: 'shared-verdict',
      title: 'Probe verdicts are cached and shared',
      detail:
        'The verdict is written to Redis under `sd:probe:{service}:{instance_id}` with a short TTL, so every caller reads one observation instead of probing per request — and no caller invents its own answer.',
      match: {
        python: {all: [/sd:probe:/, /ex=/, /PROBE_TTL_S/], none: [/random\./]},
        typescript: {all: [/sd:probe:/, /'EX'/, /PROBE_TTL_S/], none: [/Math\.random/]},
        go: {all: [/probeKey/, /time\.Second/, /probeTtl/], none: [/rand\./]},
        scala: {all: [/sd:probe:/, /ex\(/, /ProbeTtl/]},
        cpp: {all: [/sd:probe:/, /std::chrono::seconds/, /kProbeTtlSeconds/]},
      },
    },
    {
      id: 'excluded-stays-registered',
      title: 'A failing instance is excluded, not deregistered',
      detail:
        'A failed probe writes the instance into `sd:excluded:{service}` with a `reason` and leaves the registry entry alone, so the instance can be probed again. The draft never records why routing skipped a backend.',
      match: {
        python: {all: [/sd:excluded:/, /reason/, /SERVING/]},
        typescript: {all: [/sd:excluded:/, /reason/, /SERVING/]},
        go: {all: [/sd:excluded:/, /reason/, /SERVING/]},
        scala: {all: [/sd:excluded:/, /reason/, /SERVING/]},
        cpp: {all: [/sd:excluded:/, /reason/, /SERVING/]},
      },
    },
    {
      id: 'recovery-readmit',
      title: 'A passing probe readmits the instance',
      detail:
        'A `SERVING` verdict removes the exclusion (`HDEL`) and writes the fresh verdict, so a recovered instance returns to routing without an operator. The draft only re-probes after a client complains.',
      match: {
        python: {all: [/hdel/, /sd:excluded:/, /SERVING/]},
        typescript: {all: [/hdel/, /sd:excluded:/, /SERVING/]},
        go: {all: [/HDel/, /sd:excluded:/, /SERVING/]},
        scala: {all: [/hdel/, /sd:excluded:/, /SERVING/]},
        cpp: {all: [/hdel/, /sd:excluded:/, /SERVING/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("discovery")
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class Registry:
    def candidates(self, service: str) -> list[dict]:
        """Every instance key the registry still holds for this service."""
        raise NotImplementedError


registry = Registry()


@app.get("/v1/routable/{service}")
def routable(service: str) -> JSONResponse:
    # TODO: this draft returns instances as soon as they are registered — no gRPC health probe
    # before routing, no 200 ms deadline and no shared verdict cache — and it only asks an instance
    # how it feels after a client complains. Review it.
    instances = registry.candidates(service)
    logger.info("routable service=%s instances=%d", service, len(instances))
    return JSONResponse({"service": service, "instances": instances}, status_code=200)


def note_complaint(service: str, instance_id: str) -> None:
    """The draft's only health signal: a client told us a request failed."""
    logger.warning("complaint service=%s instance=%s", service, instance_id)
`,
      solution: `import json
import logging

import grpc
import health_pb2
import health_pb2_grpc
import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("discovery")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

PROBE_DEADLINE_MS = 200
PROBE_TTL_S = 5
SERVING = "SERVING"
NOT_SERVING = "NOT_SERVING"


class Registry:
    def candidates(self, service: str) -> list[dict]:
        """Every instance the registry still holds for this service."""
        raise NotImplementedError


registry = Registry()


def health_check(instance: dict) -> bool:
    """One Health/Check with a hard deadline: a hung process fails instead of delaying routing."""
    target = f"{instance['address']}:{instance['port']}"
    try:
        with grpc.insecure_channel(target) as channel:
            stub = health_pb2_grpc.HealthStub(channel)
            reply = stub.Check(health_pb2.HealthCheckRequest(service=""), timeout=PROBE_DEADLINE_MS / 1000)
            return reply.status == health_pb2.HealthCheckResponse.SERVING
    except grpc.RpcError:
        return False


def probe_key(service: str, instance_id: str) -> str:
    return f"sd:probe:{service}:{instance_id}"


def excluded_key(service: str) -> str:
    return f"sd:excluded:{service}"


def probe_and_share(service: str, instance: dict) -> str:
    """Probe once and share the verdict: every router reads the same observation for 5 seconds."""
    healthy = health_check(instance)
    verdict = SERVING if healthy else NOT_SERVING
    r.set(probe_key(service, instance["instance_id"]), verdict, ex=PROBE_TTL_S)
    if healthy:
        r.hdel(excluded_key(service), instance["instance_id"])
    else:
        r.hset(excluded_key(service), instance["instance_id"], json.dumps({"reason": "probe failed"}))
        logger.warning("excluded service=%s instance=%s", service, instance["instance_id"])
    return verdict


@app.get("/v1/routable/{service}")
def routable(service: str) -> JSONResponse:
    instances = []
    excluded = []
    for instance in registry.candidates(service):
        instance_id = instance["instance_id"]
        verdict = r.get(probe_key(service, instance_id))
        if verdict is None:
            verdict = probe_and_share(service, instance)
        if verdict == SERVING:
            instances.append({field: instance[field] for field in ("instance_id", "address", "port", "metadata_version")})
        else:
            excluded.append({"instance_id": instance_id, "address": instance["address"], "reason": "probe failed"})
    return JSONResponse({"service": service, "instances": instances, "excluded": excluded}, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/routable/{service}: a model-generated draft that trusts the registry. */
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
export const redis = new Redis({host: 'redis', port: 6379});

export const registry = {
  /** Every instance the registry still holds for this service. */
  candidates(service: string): Promise<InstanceRecord[]> {
    throw new Error('not implemented');
  },
};

interface InstanceRecord {
  instance_id: string;
  address: string;
  port: number;
  metadata_version: number;
}

app.get('/v1/routable/:service', async (request, reply) => {
  // TODO: this draft returns instances as soon as they are registered — no gRPC health probe
  // before routing, no 200 ms deadline and no shared verdict cache — and it only asks an instance
  // how it feels after a client complains. Review it.
  const {service} = request.params as {service: string};
  const instances = await registry.candidates(service);
  request.log.info({service, instances: instances.length}, 'routable');
  return reply.code(200).send({service, instances});
});

export function noteComplaint(service: string, instanceId: string): void {
  app.log.warn({service, instance_id: instanceId}, 'complaint');
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/routable/{service}: probed, cached, explainable routing sets. */
import * as grpc from '@grpc/grpc-js';

import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
export const redis = new Redis({host: 'redis', port: 6379});

export const registry = {
  /** Every instance the registry still holds for this service. */
  candidates(service: string): Promise<InstanceRecord[]> {
    throw new Error('not implemented');
  },
};

interface InstanceRecord {
  instance_id: string;
  address: string;
  port: number;
  metadata_version: number;
}

interface HealthClient {
  Check(
    request: {service: string},
    metadata: grpc.Metadata,
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply?: {status: string}) => void,
  ): void;
}

const PROBE_DEADLINE_MS = 200;
const PROBE_TTL_S = 5;
const SERVING = 'SERVING';
const NOT_SERVING = 'NOT_SERVING';

const probeKey = (service: string, instanceId: string): string => \`sd:probe:\${service}:\${instanceId}\`;
const excludedKey = (service: string): string => \`sd:excluded:\${service}\`;

function healthCheck(instance: InstanceRecord, stubFactory: (target: string) => HealthClient): Promise<boolean> {
  const {promise, resolve} = Promise.withResolvers<boolean>();
  const client = stubFactory(\`\${instance.address}:\${instance.port}\`);
  client.Check(
    {service: ''},
    new grpc.Metadata(),
    {deadline: Date.now() + PROBE_DEADLINE_MS},
    (error, reply) => resolve(error === null && reply !== undefined && reply.status === SERVING),
  );
  return promise;
}

/** Probe once and share the verdict: every router reads the same observation for 5 seconds. */
async function probeAndShare(
  service: string,
  instance: InstanceRecord,
  stubFactory: (target: string) => HealthClient,
): Promise<string> {
  const healthy = await healthCheck(instance, stubFactory);
  const verdict = healthy ? SERVING : NOT_SERVING;
  await redis.set(probeKey(service, instance.instance_id), verdict, 'EX', PROBE_TTL_S);
  if (healthy) {
    await redis.hdel(excludedKey(service), instance.instance_id);
  } else {
    await redis.hset(excludedKey(service), instance.instance_id, JSON.stringify({reason: 'probe failed'}));
    app.log.warn({service, instance_id: instance.instance_id}, 'excluded');
  }
  return verdict;
}

app.get('/v1/routable/:service', async (request, reply) => {
  const {service} = request.params as {service: string};
  const instances: InstanceRecord[] = [];
  const excluded: {instance_id: string; address: string; reason: string}[] = [];
  for (const instance of await registry.candidates(service)) {
    let verdict = await redis.get(probeKey(service, instance.instance_id));
    if (verdict === null) verdict = await probeAndShare(service, instance, () => {
      throw new Error('no health stub configured');
    });
    if (verdict === SERVING) {
      instances.push(instance);
    } else {
      excluded.push({instance_id: instance.instance_id, address: instance.address, reason: 'probe failed'});
    }
  }
  return reply.code(200).send({service, instances, excluded});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"
)

type InstanceRecord struct {
	InstanceID      string \`json:"instance_id"\`
	Address         string \`json:"address"\`
	Port            int    \`json:"port"\`
	MetadataVersion int    \`json:"metadata_version"\`
}

type Registry struct{}

func (r *Registry) Candidates(ctx context.Context, service string) ([]InstanceRecord, error) {
	return nil, nil
}

var (
	registry = &Registry{}
	rdb      = redis.NewClient(&redis.Options{Addr: "redis:6379"})
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func routable(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft returns instances as soon as they are registered — no gRPC health probe
	// before routing, no 200 ms deadline and no shared verdict cache — and it only asks an instance
	// how it feels after a client complains. Review it.
	service := r.PathValue("service")
	instances, err := registry.Candidates(r.Context(), service)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("routable service=%s instances=%d", service, len(instances))
	writeJSON(rw, http.StatusOK, map[string]any{"service": service, "instances": instances})
}

func noteComplaint(service, instanceID string) {
	log.Printf("complaint service=%s instance=%s", service, instanceID)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/routable/{service}", routable)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
)

const (
	probeDeadlineMs = 200
	probeTtlSeconds = 5
	serving         = "SERVING"
	notServing      = "NOT_SERVING"
)

type InstanceRecord struct {
	InstanceID      string \`json:"instance_id"\`
	Address         string \`json:"address"\`
	Port            int    \`json:"port"\`
	MetadataVersion int    \`json:"metadata_version"\`
}

type Registry struct{}

func (r *Registry) Candidates(ctx context.Context, service string) ([]InstanceRecord, error) {
	return nil, nil
}

var (
	registry = &Registry{}
	rdb      = redis.NewClient(&redis.Options{Addr: "redis:6379"})
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func probeKey(service, instanceID string) string { return "sd:probe:" + service + ":" + instanceID }

func excludedKey(service string) string { return "sd:excluded:" + service }

/** healthCheck is one Health/Check with a hard deadline: a hung process fails it. */
func healthCheck(instance InstanceRecord) bool {
	ctx, cancel := context.WithTimeout(context.Background(), probeDeadlineMs*time.Millisecond)
	defer cancel()
	target := net.JoinHostPort(instance.Address, strconv.Itoa(instance.Port))
	conn, err := grpc.DialContext(ctx, target, grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithBlock())
	if err != nil {
		return false
	}
	defer conn.Close()
	reply, err := healthpb.NewHealthClient(conn).Check(ctx, &healthpb.HealthCheckRequest{Service: ""})
	if err != nil {
		return false
	}
	return reply.GetStatus() == healthpb.HealthCheckResponse_SERVING
}

/** probeAndShare probes once and shares the verdict: every router reads one observation for 5 s. */
func probeAndShare(ctx context.Context, service string, instance InstanceRecord) string {
	verdict := notServing
	if healthCheck(instance) {
		verdict = serving
	}
	rdb.Set(ctx, probeKey(service, instance.InstanceID), verdict, time.Duration(probeTtlSeconds)*time.Second)
	if verdict == serving {
		rdb.HDel(ctx, excludedKey(service), instance.InstanceID)
	} else {
		reason, _ := json.Marshal(map[string]string{"reason": "probe failed"})
		rdb.HSet(ctx, excludedKey(service), instance.InstanceID, reason)
		log.Printf("excluded service=%s instance=%s", service, instance.InstanceID)
	}
	return verdict
}

func routable(rw http.ResponseWriter, r *http.Request) {
	service := r.PathValue("service")
	candidates, err := registry.Candidates(r.Context(), service)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	instances := make([]InstanceRecord, 0, len(candidates))
	excluded := make([]map[string]any, 0)
	for _, instance := range candidates {
		verdict, err := rdb.Get(r.Context(), probeKey(service, instance.InstanceID)).Result()
		if err == redis.Nil {
			verdict = probeAndShare(r.Context(), service, instance)
		}
		if verdict == serving {
			instances = append(instances, instance)
		} else {
			excluded = append(excluded, map[string]any{
				"instance_id": instance.InstanceID,
				"address":     instance.Address,
				"reason":      "probe failed",
			})
		}
	}
	writeJSON(rw, http.StatusOK, map[string]any{"service": service, "instances": instances, "excluded": excluded})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/routable/{service}", routable)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class InstanceRecord(instance_id: String, address: String, port: Int, metadata_version: Int)

trait Registry {
  def candidates(service: String): List[InstanceRecord]
}

object Client {
  implicit val system: ActorSystem = ActorSystem("discovery")
  implicit val instanceFormat: RootJsonFormat[InstanceRecord] = jsonFormat4(InstanceRecord)

  val registry: Registry = ???

  val route: Route =
    path("v1" / "routable" / Segment) { service =>
      get {
        // TODO: this draft returns instances as soon as they are registered — no gRPC health probe
        // before routing, no 200 ms deadline and no shared verdict cache — and it only asks an
        // instance how it feels after a client complains. Review it.
        val instances = registry.candidates(service)
        system.log.info(s"routable service=$service instances=\${instances.size}")
        complete(StatusCodes.OK, instances)
      }
    }

  /** The draft's only health signal: a client told us a request failed. */
  def noteComplaint(service: String, instanceId: String): Unit =
    system.log.warning(s"complaint service=$service instance=$instanceId")

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import io.grpc.ManagedChannelBuilder
import io.grpc.StatusRuntimeException
import io.grpc.health.v1.HealthCheckRequest
import io.grpc.health.v1.HealthCheckResponse
import io.grpc.health.v1.HealthGrpc
import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat
import spray.json._

import java.util.concurrent.TimeUnit
import scala.jdk.CollectionConverters._

final case class InstanceRecord(instance_id: String, address: String, port: Int, metadata_version: Int)

trait Registry {
  def candidates(service: String): List[InstanceRecord]
}

object Client {
  implicit val system: ActorSystem = ActorSystem("discovery")
  implicit val instanceFormat: RootJsonFormat[InstanceRecord] = jsonFormat4(InstanceRecord)

  val ProbeDeadlineMs = 200
  val ProbeTtlSeconds = 5
  val Serving = "SERVING"
  val NotServing = "NOT_SERVING"

  val registry: Registry = ???
  val jedis = new Jedis("redis", 6379)

  private def probeKey(service: String, instanceId: String): String = "sd:probe:" + service + ":" + instanceId

  private def excludedKey(service: String): String = "sd:excluded:" + service

  /** healthCheck is one Health/Check with a hard deadline: a hung process fails it. */
  def healthCheck(instance: InstanceRecord): Boolean = {
    val channel = ManagedChannelBuilder.forAddress(instance.address, instance.port).usePlaintext().build()
    try {
      val stub = HealthGrpc.newBlockingStub(channel).withDeadlineAfter(ProbeDeadlineMs.toLong, TimeUnit.MILLISECONDS)
      val reply = stub.check(HealthCheckRequest.newBuilder().setService("").build())
      reply.getStatus == HealthCheckResponse.ServingStatus.SERVING
    } catch {
      case _: StatusRuntimeException => false
    } finally {
      channel.shutdownNow()
    }
  }

  /** probeAndShare probes once and shares the verdict: every router reads one observation for 5 s. */
  def probeAndShare(service: String, instance: InstanceRecord): String = {
    val healthy = healthCheck(instance)
    val verdict = if (healthy) Serving else NotServing
    jedis.set(probeKey(service, instance.instance_id), verdict, SetParams.setParams().ex(ProbeTtlSeconds.toLong))
    if (healthy) {
      jedis.hdel(excludedKey(service), instance.instance_id)
    } else {
      jedis.hset(excludedKey(service), instance.instance_id, """{"reason":"probe failed"}""")
      system.log.warning(s"excluded service=$service instance=\${instance.instance_id}")
    }
    verdict
  }

  val route: Route =
    path("v1" / "routable" / Segment) { service =>
      get {
        val instances = scala.collection.mutable.ListBuffer.empty[InstanceRecord]
        val excluded = scala.collection.mutable.ListBuffer.empty[Map[String, String]]
        registry.candidates(service).foreach { instance =>
          val cached = Option(jedis.get(probeKey(service, instance.instance_id)))
          val verdict = cached.getOrElse(probeAndShare(service, instance))
          if (verdict == Serving) {
            instances += instance
          } else {
            excluded += Map(
              "instance_id" -> instance.instance_id,
              "address" -> instance.address,
              "reason" -> "probe failed")
          }
        }
        val body = JsObject(
          "service" -> JsString(service),
          "instances" -> instances.toList.toJson,
          "excluded" -> excluded.toList.toJson)
        complete(StatusCodes.OK, body)
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <string>
#include <vector>

using json = nlohmann::json;

struct InstanceRecord {
  std::string instance_id;
  std::string address;
  int port;
  int metadata_version;
};

struct Registry {
  std::vector<InstanceRecord> candidates(const std::string& service);
};

Registry registry;
sw::redis::Redis redis("tcp://redis:6379");

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/routable/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft returns instances as soon as they are registered — no gRPC health probe
    // before routing, no 200 ms deadline and no shared verdict cache — and it only asks an instance
    // how it feels after a client complains. Review it.
    const auto service = req.matches[1].str();
    const auto candidates = registry.candidates(service);
    json instances = json::array();
    for (const auto& instance : candidates) {
      instances.push_back(json{{"instance_id", instance.instance_id},
                               {"address", instance.address},
                               {"port", instance.port},
                               {"metadata_version", instance.metadata_version}});
    }
    std::cout << "routable service=" << service << " instances=" << instances.size() << "\\n";
    res.status = 200;
    res.set_content(json{{"service", service}, {"instances", instances}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <string>
#include <vector>

#include "grpc/health/v1/health.grpc.pb.h"

using json = nlohmann::json;

constexpr int kProbeDeadlineMs = 200;
constexpr int kProbeTtlSeconds = 5;
const std::string kServing = "SERVING";
const std::string kNotServing = "NOT_SERVING";

struct InstanceRecord {
  std::string instance_id;
  std::string address;
  int port;
  int metadata_version;
};

struct Registry {
  std::vector<InstanceRecord> candidates(const std::string& service);
};

Registry registry;
sw::redis::Redis redis("tcp://redis:6379");

std::string probeKey(const std::string& service, const std::string& instanceId) {
  return "sd:probe:" + service + ":" + instanceId;
}

std::string excludedKey(const std::string& service) { return "sd:excluded:" + service; }

/** healthCheck is one Health/Check with a hard deadline: a hung process fails it. */
bool healthCheck(const InstanceRecord& instance) {
  auto channel = grpc::CreateChannel(instance.address + ":" + std::to_string(instance.port),
                                    grpc::InsecureChannelCredentials());
  auto stub = grpc::health::v1::Health::NewStub(channel);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kProbeDeadlineMs));
  grpc::health::v1::HealthCheckRequest request;
  request.set_service("");
  grpc::health::v1::HealthCheckResponse reply;
  const auto status = stub->Check(&ctx, request, &reply);
  return status.ok() && reply.status() == grpc::health::v1::HealthCheckResponse::SERVING;
}

/** probeAndShare probes once and shares the verdict: every router reads one observation for 5 s. */
std::string probeAndShare(const std::string& service, const InstanceRecord& instance) {
  const bool healthy = healthCheck(instance);
  const std::string verdict = healthy ? kServing : kNotServing;
  redis.set(probeKey(service, instance.instance_id), verdict, std::chrono::seconds(kProbeTtlSeconds));
  if (healthy) {
    redis.hdel(excludedKey(service), instance.instance_id);
  } else {
    redis.hset(excludedKey(service), instance.instance_id, json{{"reason", "probe failed"}}.dump());
    std::cout << "excluded service=" << service << " instance=" << instance.instance_id << "\\n";
  }
  return verdict;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/routable/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto service = req.matches[1].str();
    json instances = json::array();
    json excluded = json::array();
    for (const auto& instance : registry.candidates(service)) {
      auto cached = redis.get(probeKey(service, instance.instance_id));
      const auto verdict = cached ? *cached : probeAndShare(service, instance);
      if (verdict == kServing) {
        instances.push_back(json{{"instance_id", instance.instance_id},
                                 {"address", instance.address},
                                 {"port", instance.port},
                                 {"metadata_version", instance.metadata_version}});
      } else {
        excluded.push_back(json{{"instance_id", instance.instance_id},
                                {"address", instance.address},
                                {"reason", "probe failed"}});
      }
    }
    res.status = 200;
    res.set_content(
        json{{"service", service}, {"instances", instances}, {"excluded", excluded}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Probe inside the loop that builds the answer: for each registered candidate read the cached verdict, probe when the cache is empty, then append to `instances` or to `excluded` with a reason. Returning the registry read directly is the whole bug.',
    'The deadline is why the probe is a gRPC call and not a TCP connect: `timeout=0.2`, `withDeadlineAfter(200, MILLISECONDS)`, `context.WithTimeout(ctx, 200*time.Millisecond)`, `set_deadline`. A connect that hangs is a failure, not a slow success.',
    'Write the verdict to Redis with a short TTL and read it back before probing — the registry cannot tell “new” from “dead”, but a shared observation can. Keep the failing instance registered and record *why* it was skipped, so a later probe can readmit it without an operator.',
  ],
  debrief: `The interviewer is testing whether you separate registration from readiness. Registration is a claim made by a process; health is an observation made by the platform, and only the observation is allowed to influence routing. A draft that returns registered instances looks correct because the demo never kills a process, and it fails in the one way users feel most: a backend that is in the routing set but cannot serve, for a full heartbeat interval, while the platform reports it as up. The second half of the answer is about where the observation lives. Probing per caller duplicates work and makes two routers disagree about the same instance; caching the verdict in Redis with a short TTL gives every caller the same answer and bounds the probe rate. The exclusion hash is what keeps failure and registration separate: the instance stays in the registry for its recovery probe, and the read API can explain the exclusion instead of silently dropping a backend. Real systems add jittered probe schedules, per-instance circuit breakers, drain states that make an instance fail its probe on purpose, and probe attribution so the traffic to a struggling instance is visible.`,
};
