import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Health probes with a deadline and a shared verdict',
  concept: 'grpc',
  file: 'probe',
  focus: ['discovery', 'instances', 'redis'],
  task: `## Task

**Starting point.** The starter is the probe round every discovery replica runs before it answers a
read: \`probe_service(service)\` walks \`instances.members(service)\`, calls \`Health/Check\` on each
live instance at \`{address}:{port}\`, stores the verdict under \`sd:probe:{service}:{instance_id}\`,
removes an instance whose probe fails from the registry and returns \`{instance_id: verdict}\`. With
every instance healthy it answers the demo, and it hides four flaws.

**Failure mode the checks target.** A hung instance holds the round for as long as it hangs and is
then called healthy; an instance that answers \`NOT_SERVING\` while it drains is routed to; every
router probes every instance on every round; and one failed probe deregisters an instance that is
back a second later, so it never returns.

\`\`\`proto
service Health { rpc Check(HealthCheckRequest) returns (HealthCheckResponse); }  // status: SERVING, NOT_SERVING
\`\`\`

- Every \`Check\` carries a **200 ms** deadline (\`PROBE_DEADLINE_S = 0.2\`); an error of any code is
  \`NOT_SERVING\`.
- An instance is \`SERVING\` only when the reply's \`status\` is \`SERVING\`.
- Read the shared verdict first and probe only when it is absent; write it with a
  \`PROBE_TTL_S = 5\` second TTL.
- A failing instance stays registered: its verdict excludes it, and a passing probe after the TTL
  readmits it.`,
  sequence: {
    participants: ['Probe round', 'Redis', 'Instance'],
    messages: [
      {from: 'Probe round', to: 'Redis', label: 'SMEMBERS sd:members:checkout · HGETALL each record', kind: 'sync'},
      {from: 'Probe round', to: 'Redis', label: 'GET sd:probe:checkout:checkout-3', kind: 'sync'},
      {from: 'Redis', to: 'Probe round', label: 'nil: no verdict in the last 5 s', kind: 'reply'},
      {from: 'Probe round', to: 'Instance', label: 'Health/Check · deadline 200 ms', kind: 'sync'},
      {
        from: 'Instance',
        to: 'Probe round',
        label: 'SERVING · NOT_SERVING · DEADLINE_EXCEEDED · UNAVAILABLE',
        kind: 'reply',
      },
      {from: 'Probe round', to: 'Redis', label: 'SET sd:probe:checkout:checkout-3 verdict EX 5', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'probe-deadline',
      title: 'Every probe carries a 200 ms deadline',
      detail:
        'The `Check` call is made with `PROBE_DEADLINE_S` (0.2 s; `PROBE_DEADLINE_MS`, `probeDeadline`, `ProbeDeadlineMs`, `kProbeDeadline`), so a hung instance is `NOT_SERVING` after 200 ms. The starter waits as long as the instance hangs and then calls it healthy.',
      match: {
        python: {all: [/PROBE_DEADLINE_S\s*=\s*0\.2\b/, /\.Check\([\s\S]{0,200}?timeout\s*=\s*PROBE_DEADLINE_S/]},
        typescript: {all: [/PROBE_DEADLINE_MS\s*=\s*200\b/, /deadline:\s*Date\.now\(\)\s*\+\s*PROBE_DEADLINE_MS/]},
        go: {all: [/probeDeadline\s*=\s*200\s*\*\s*time\.Millisecond/, /context\.WithTimeout\([^\n]*probeDeadline\)/]},
        scala: {all: [/ProbeDeadlineMs\s*=\s*200L?\b/, /withDeadlineAfter\(\s*ProbeDeadlineMs/]},
        cpp: {all: [/kProbeDeadline\{200\}/, /set_deadline\([^\n]*kProbeDeadline\)/]},
      },
    },
    {
      id: 'serving-status',
      title: 'SERVING only when the instance says so',
      detail:
        'The verdict reads the reply: `status` equal to `SERVING` is `SERVING`, a reply of `NOT_SERVING` and any error are `NOT_SERVING`. The starter calls every reply healthy, including a draining instance that says it is not.',
      match: {
        python: {all: [/HealthCheckResponse\.SERVING/]},
        typescript: {all: [/\.status\s*===\s*['"]SERVING['"]/]},
        go: {all: [/HealthCheckResponse_SERVING/]},
        scala: {all: [/ServingStatus\.SERVING/]},
        cpp: {all: [/HealthCheckResponse::SERVING/]},
      },
    },
    {
      id: 'shared-verdict',
      title: 'The verdict is read before probing and expires after 5 s',
      detail:
        'The round reads `sd:probe:{service}:{instance_id}` first and probes only on a miss, then writes the verdict with a `PROBE_TTL_S` expiry, so all routers share one call per instance per 5 s. The starter probes on every round and stores a verdict that never expires.',
      match: {
        python: {all: [/r\.get\(|instances\.verdict\(/, /ex\s*=\s*PROBE_TTL_S/]},
        typescript: {all: [/redis\.get\(|instances\.verdict\(/, /['"]EX['"]\s*,\s*PROBE_TTL_S/]},
        go: {all: [/rdb\.Get\(|instances\.Verdict\(/, /rdb\.Set\([^\n]*probeTTL\)/]},
        scala: {all: [/jedis\.get\(|Instances\.verdict\(/, /\.ex\(\s*ProbeTtlS/]},
        cpp: {all: [/redis\.get\(|instances::verdict\(/, /redis\.set\([^\n]*kProbeTtl\)/]},
      },
    },
    {
      id: 'keep-registered',
      title: 'A failing instance is excluded, not deregistered',
      detail:
        'A failed probe writes a `NOT_SERVING` verdict and leaves the record and the members set alone, so the next round after the TTL can readmit it. The starter deletes the record and the member, and a recovered instance never comes back.',
      match: {
        python: {all: [/instances\.members\(/], none: [/\.delete\(/, /\.srem\(/]},
        typescript: {all: [/instances\.members\(/], none: [/redis\.del\(/, /redis\.srem\(/]},
        go: {all: [/instances\.Members\(/], none: [/rdb\.Del\(/, /rdb\.SRem\(/]},
        scala: {all: [/Instances\.members\(/], none: [/jedis\.del\(/, /jedis\.srem\(/]},
        cpp: {all: [/instances::members\(/], none: [/redis\.del\(/, /redis\.srem\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc
import redis

import service_discovery_pb2 as pb
import service_discovery_pb2_grpc as pb_grpc
from discovery import instances  # members, lookup, record_key, members_key, verdict_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

_stubs: dict[str, pb_grpc.HealthStub] = {}


def _stub(target: str) -> pb_grpc.HealthStub:
    if target not in _stubs:
        _stubs[target] = pb_grpc.HealthStub(grpc.insecure_channel(target))
    return _stubs[target]


def check_health(service: str, instance: dict) -> str:
    """Ask the instance at address:port whether it can take traffic: SERVING or NOT_SERVING."""
    try:
        _stub(f"{instance['address']}:{instance['port']}").Check(pb.HealthCheckRequest(service=service))
    except grpc.RpcError:
        return "NOT_SERVING"
    return "SERVING"


def probe_service(service: str) -> dict[str, str]:
    """The verdict for every live member of service."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    verdicts = {}
    for instance_id in instances.members(service):
        instance = instances.lookup(service, instance_id)
        if instance is None:
            continue
        verdict = check_health(service, instance)
        r.set(instances.verdict_key(service, instance_id), verdict)
        if verdict != "SERVING":
            r.delete(instances.record_key(service, instance_id))
            r.srem(instances.members_key(service), instance_id)
        verdicts[instance_id] = verdict
    return verdicts
`,
      solution: `import grpc
import redis

import service_discovery_pb2 as pb
import service_discovery_pb2_grpc as pb_grpc
from discovery import instances  # members, lookup, record_key, members_key, verdict_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

PROBE_DEADLINE_S = 0.2
PROBE_TTL_S = 5

_stubs: dict[str, pb_grpc.HealthStub] = {}


def _stub(target: str) -> pb_grpc.HealthStub:
    if target not in _stubs:
        _stubs[target] = pb_grpc.HealthStub(grpc.insecure_channel(target))
    return _stubs[target]


def check_health(service: str, instance: dict) -> str:
    """Ask the instance at address:port whether it can take traffic: SERVING or NOT_SERVING."""
    try:
        reply = _stub(f"{instance['address']}:{instance['port']}").Check(
            pb.HealthCheckRequest(service=service), timeout=PROBE_DEADLINE_S
        )
    except grpc.RpcError:
        return "NOT_SERVING"  # DEADLINE_EXCEEDED, UNAVAILABLE: a hung or stopped process
    # Alive is not ready: a draining instance answers, and answers NOT_SERVING.
    return "SERVING" if reply.status == pb.HealthCheckResponse.SERVING else "NOT_SERVING"


def probe_service(service: str) -> dict[str, str]:
    """The verdict for every live member of service."""
    verdicts = {}
    for instance_id in instances.members(service):
        instance = instances.lookup(service, instance_id)
        if instance is None:
            continue  # lapsed: the expiry sweep announces it, there is nobody to ask
        key = instances.verdict_key(service, instance_id)
        verdict = r.get(key)
        if verdict is None:
            # One probe per instance per PROBE_TTL_S for every router; the TTL is also the retry.
            verdict = check_health(service, instance)
            r.set(key, verdict, ex=PROBE_TTL_S)
        verdicts[instance_id] = verdict
    return verdicts
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import * as instances from 'discovery/instances'; // members, lookup, recordKey, membersKey, verdictKey

interface HealthReply {
  status: string;
}

interface HealthClient extends grpc.Client {
  Check(
    request: {service: string},
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (err: grpc.ServiceError | null, reply?: HealthReply) => void,
  ): void;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('service_discovery.proto', {enums: String})) as unknown as {
  discoveryd: {Health: grpc.ServiceClientConstructor};
};
const redis = new Redis({host: 'redis', port: 6379});
const stubs = new Map<string, HealthClient>();

function stub(target: string): HealthClient {
  let client = stubs.get(target);
  if (client === undefined) {
    client = new pkg.discoveryd.Health(target, grpc.credentials.createInsecure()) as HealthClient;
    stubs.set(target, client);
  }
  return client;
}

/** Ask the instance at address:port whether it can take traffic: SERVING or NOT_SERVING. */
export async function checkHealth(service: string, instance: instances.Instance): Promise<string> {
  const client = stub(\`\${instance.address}:\${instance.port}\`);
  try {
    await new Promise<HealthReply | undefined>((resolve, reject) =>
      client.Check({service}, new grpc.Metadata(), {}, (err, reply) => (err ? reject(err) : resolve(reply))),
    );
    return 'SERVING';
  } catch {
    return 'NOT_SERVING';
  }
}

/** The verdict for every live member of service. */
export async function probeService(service: string): Promise<Record<string, string>> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const verdicts: Record<string, string> = {};
  for (const instanceId of await instances.members(service)) {
    const instance = await instances.lookup(service, instanceId);
    if (instance === null) continue;
    const verdict = await checkHealth(service, instance);
    await redis.set(instances.verdictKey(service, instanceId), verdict);
    if (verdict !== 'SERVING') {
      await redis.del(instances.recordKey(service, instanceId));
      await redis.srem(instances.membersKey(service), instanceId);
    }
    verdicts[instanceId] = verdict;
  }
  return verdicts;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import * as instances from 'discovery/instances'; // members, lookup, recordKey, membersKey, verdictKey

export const PROBE_DEADLINE_MS = 200;
export const PROBE_TTL_S = 5;

interface HealthReply {
  status: string;
}

interface HealthClient extends grpc.Client {
  Check(
    request: {service: string},
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (err: grpc.ServiceError | null, reply?: HealthReply) => void,
  ): void;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('service_discovery.proto', {enums: String})) as unknown as {
  discoveryd: {Health: grpc.ServiceClientConstructor};
};
const redis = new Redis({host: 'redis', port: 6379});
const stubs = new Map<string, HealthClient>();

function stub(target: string): HealthClient {
  let client = stubs.get(target);
  if (client === undefined) {
    client = new pkg.discoveryd.Health(target, grpc.credentials.createInsecure()) as HealthClient;
    stubs.set(target, client);
  }
  return client;
}

/** Ask the instance at address:port whether it can take traffic: SERVING or NOT_SERVING. */
export async function checkHealth(service: string, instance: instances.Instance): Promise<string> {
  const client = stub(\`\${instance.address}:\${instance.port}\`);
  try {
    const reply = await new Promise<HealthReply | undefined>((resolve, reject) =>
      client.Check({service}, new grpc.Metadata(), {deadline: Date.now() + PROBE_DEADLINE_MS}, (err, res) =>
        err ? reject(err) : resolve(res),
      ),
    );
    // Alive is not ready: a draining instance answers, and answers NOT_SERVING.
    return reply?.status === 'SERVING' ? 'SERVING' : 'NOT_SERVING';
  } catch {
    return 'NOT_SERVING'; // DEADLINE_EXCEEDED, UNAVAILABLE: a hung or stopped process
  }
}

/** The verdict for every live member of service. */
export async function probeService(service: string): Promise<Record<string, string>> {
  const verdicts: Record<string, string> = {};
  for (const instanceId of await instances.members(service)) {
    const instance = await instances.lookup(service, instanceId);
    if (instance === null) continue; // lapsed: the expiry sweep announces it, there is nobody to ask
    const key = instances.verdictKey(service, instanceId);
    let verdict = await redis.get(key);
    if (verdict === null) {
      // One probe per instance per PROBE_TTL_S for every router; the TTL is also the retry.
      verdict = await checkHealth(service, instance);
      await redis.set(key, verdict, 'EX', PROBE_TTL_S);
    }
    verdicts[instanceId] = verdict;
  }
  return verdicts;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"discovery/instances" // instances.Members, Lookup, RecordKey, MembersKey, VerdictKey
	pb "discovery/gen/service_discovery"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var stubs = map[string]pb.HealthClient{}

func stub(target string) (pb.HealthClient, error) {
	if client, ok := stubs[target]; ok {
		return client, nil
	}
	conn, err := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}
	stubs[target] = pb.NewHealthClient(conn)
	return stubs[target], nil
}

// checkHealth asks the instance at address:port whether it can take traffic: "SERVING" or "NOT_SERVING".
func checkHealth(ctx context.Context, service string, inst *instances.Instance) string {
	client, err := stub(fmt.Sprintf("%s:%d", inst.Address, inst.Port))
	if err != nil {
		return "NOT_SERVING"
	}
	if _, err := client.Check(ctx, &pb.HealthCheckRequest{Service: service}); err != nil {
		return "NOT_SERVING"
	}
	return "SERVING"
}

// probeService is the verdict for every live member of service.
func probeService(ctx context.Context, service string) (map[string]string, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	ids, err := instances.Members(ctx, service)
	if err != nil {
		return nil, err
	}
	verdicts := map[string]string{}
	for _, id := range ids {
		inst, err := instances.Lookup(ctx, service, id)
		if err != nil {
			return nil, err
		}
		if inst == nil {
			continue
		}
		verdict := checkHealth(ctx, service, inst)
		if err := rdb.Set(ctx, instances.VerdictKey(service, id), verdict, 0).Err(); err != nil {
			return nil, err
		}
		if verdict != "SERVING" {
			rdb.Del(ctx, instances.RecordKey(service, id))
			rdb.SRem(ctx, instances.MembersKey(service), id)
		}
		verdicts[id] = verdict
	}
	return verdicts, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"discovery/instances" // instances.Members, Lookup, RecordKey, MembersKey, VerdictKey
	pb "discovery/gen/service_discovery"
)

const (
	probeDeadline = 200 * time.Millisecond
	probeTTL      = 5 * time.Second
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var stubs = map[string]pb.HealthClient{}

func stub(target string) (pb.HealthClient, error) {
	if client, ok := stubs[target]; ok {
		return client, nil
	}
	conn, err := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}
	stubs[target] = pb.NewHealthClient(conn)
	return stubs[target], nil
}

// checkHealth asks the instance at address:port whether it can take traffic: "SERVING" or "NOT_SERVING".
func checkHealth(ctx context.Context, service string, inst *instances.Instance) string {
	client, err := stub(fmt.Sprintf("%s:%d", inst.Address, inst.Port))
	if err != nil {
		return "NOT_SERVING"
	}
	callCtx, cancel := context.WithTimeout(ctx, probeDeadline)
	defer cancel()
	reply, err := client.Check(callCtx, &pb.HealthCheckRequest{Service: service})
	// DeadlineExceeded, Unavailable: a hung or stopped process. Alive is not ready: a draining
	// instance answers, and answers NOT_SERVING.
	if err != nil || reply.GetStatus() != pb.HealthCheckResponse_SERVING {
		return "NOT_SERVING"
	}
	return "SERVING"
}

// probeService is the verdict for every live member of service.
func probeService(ctx context.Context, service string) (map[string]string, error) {
	ids, err := instances.Members(ctx, service)
	if err != nil {
		return nil, err
	}
	verdicts := map[string]string{}
	for _, id := range ids {
		inst, err := instances.Lookup(ctx, service, id)
		if err != nil {
			return nil, err
		}
		if inst == nil {
			continue // lapsed: the expiry sweep announces it, there is nobody to ask
		}
		key := instances.VerdictKey(service, id)
		verdict, err := rdb.Get(ctx, key).Result()
		if err == redis.Nil {
			// One probe per instance per probeTTL for every router; the TTL is also the retry.
			verdict = checkHealth(ctx, service, inst)
			err = rdb.Set(ctx, key, verdict, probeTTL).Err()
		}
		if err != nil {
			return nil, err
		}
		verdicts[id] = verdict
	}
	return verdicts, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import redis.clients.jedis.JedisPooled

import discovery.Instances // Instances.members, lookup, recordKey, membersKey, verdictKey
import discoveryd.service_discovery.{HealthCheckRequest, HealthGrpc}

object Probe {
  val jedis = new JedisPooled("redis", 6379)

  private val stubs = scala.collection.mutable.Map.empty[String, HealthGrpc.HealthBlockingStub]

  private def stub(target: String): HealthGrpc.HealthBlockingStub =
    stubs.getOrElseUpdate(target, HealthGrpc.blockingStub(ManagedChannelBuilder.forTarget(target).usePlaintext().build()))

  /** Ask the instance at address:port whether it can take traffic: SERVING or NOT_SERVING. */
  def checkHealth(service: String, instance: Instances.Instance): String =
    try {
      stub(s"\${instance.address}:\${instance.port}").check(HealthCheckRequest(service))
      "SERVING"
    } catch { case _: StatusRuntimeException => "NOT_SERVING" }

  /** The verdict for every live member of service. */
  def probeService(service: String): Map[String, String] = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    Instances.members(service).flatMap { instanceId =>
      Instances.lookup(service, instanceId).map { instance =>
        val verdict = checkHealth(service, instance)
        jedis.set(Instances.verdictKey(service, instanceId), verdict)
        if (verdict != "SERVING") {
          jedis.del(Instances.recordKey(service, instanceId))
          jedis.srem(Instances.membersKey(service), instanceId)
        }
        instanceId -> verdict
      }
    }.toMap
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import discovery.Instances // Instances.members, lookup, recordKey, membersKey, verdictKey
import discoveryd.service_discovery.{HealthCheckRequest, HealthCheckResponse, HealthGrpc}

object Probe {
  val ProbeDeadlineMs = 200L
  val ProbeTtlS = 5L

  val jedis = new JedisPooled("redis", 6379)

  private val stubs = scala.collection.mutable.Map.empty[String, HealthGrpc.HealthBlockingStub]

  private def stub(target: String): HealthGrpc.HealthBlockingStub =
    stubs.getOrElseUpdate(target, HealthGrpc.blockingStub(ManagedChannelBuilder.forTarget(target).usePlaintext().build()))

  /** Ask the instance at address:port whether it can take traffic: SERVING or NOT_SERVING. */
  def checkHealth(service: String, instance: Instances.Instance): String =
    try {
      val reply = stub(s"\${instance.address}:\${instance.port}")
        .withDeadlineAfter(ProbeDeadlineMs, TimeUnit.MILLISECONDS)
        .check(HealthCheckRequest(service))
      // Alive is not ready: a draining instance answers, and answers NOT_SERVING.
      if (reply.status == HealthCheckResponse.ServingStatus.SERVING) "SERVING" else "NOT_SERVING"
    } catch { case _: StatusRuntimeException => "NOT_SERVING" } // DEADLINE_EXCEEDED, UNAVAILABLE

  /** The verdict for every live member of service. */
  def probeService(service: String): Map[String, String] =
    Instances.members(service).flatMap { instanceId =>
      // A lapsed record has nobody to ask: the expiry sweep announces it.
      Instances.lookup(service, instanceId).map { instance =>
        val key = Instances.verdictKey(service, instanceId)
        val verdict = Option(jedis.get(key)).getOrElse {
          // One probe per instance per ProbeTtlS for every router; the TTL is also the retry.
          val fresh = checkHealth(service, instance)
          jedis.set(key, fresh, SetParams.setParams().ex(ProbeTtlS))
          fresh
        }
        instanceId -> verdict
      }
    }.toMap
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <map>
#include <memory>
#include <string>

#include "discovery/instances.h"  // instances::members, lookup, recordKey, membersKey, verdictKey
#include "service_discovery.grpc.pb.h"

sw::redis::Redis redis("tcp://redis:6379");

std::map<std::string, std::unique_ptr<discoveryd::Health::Stub>> stubs;

discoveryd::Health::Stub& stub(const std::string& target) {
  auto& slot = stubs[target];
  if (!slot) slot = discoveryd::Health::NewStub(grpc::CreateChannel(target, grpc::InsecureChannelCredentials()));
  return *slot;
}

// Ask the instance at address:port whether it can take traffic: "SERVING" or "NOT_SERVING".
std::string checkHealth(const std::string& service, const instances::Instance& instance) {
  grpc::ClientContext ctx;
  discoveryd::HealthCheckRequest request;
  request.set_service(service);
  discoveryd::HealthCheckResponse reply;
  const grpc::Status status = stub(instance.address + ":" + std::to_string(instance.port)).Check(&ctx, request, &reply);
  return status.ok() ? "SERVING" : "NOT_SERVING";
}

// The verdict for every live member of service.
std::map<std::string, std::string> probeService(const std::string& service) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  std::map<std::string, std::string> verdicts;
  for (const std::string& instance_id : instances::members(service)) {
    const auto instance = instances::lookup(service, instance_id);
    if (!instance) continue;
    const std::string verdict = checkHealth(service, *instance);
    redis.set(instances::verdictKey(service, instance_id), verdict);
    if (verdict != "SERVING") {
      redis.del(instances::recordKey(service, instance_id));
      redis.srem(instances::membersKey(service), instance_id);
    }
    verdicts[instance_id] = verdict;
  }
  return verdicts;
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <map>
#include <memory>
#include <string>

#include "discovery/instances.h"  // instances::members, lookup, recordKey, membersKey, verdictKey
#include "service_discovery.grpc.pb.h"

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::milliseconds kProbeDeadline{200};
constexpr std::chrono::seconds kProbeTtl{5};

std::map<std::string, std::unique_ptr<discoveryd::Health::Stub>> stubs;

discoveryd::Health::Stub& stub(const std::string& target) {
  auto& slot = stubs[target];
  if (!slot) slot = discoveryd::Health::NewStub(grpc::CreateChannel(target, grpc::InsecureChannelCredentials()));
  return *slot;
}

// Ask the instance at address:port whether it can take traffic: "SERVING" or "NOT_SERVING".
std::string checkHealth(const std::string& service, const instances::Instance& instance) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kProbeDeadline);
  discoveryd::HealthCheckRequest request;
  request.set_service(service);
  discoveryd::HealthCheckResponse reply;
  const grpc::Status status = stub(instance.address + ":" + std::to_string(instance.port)).Check(&ctx, request, &reply);
  // DEADLINE_EXCEEDED, UNAVAILABLE: a hung or stopped process. Alive is not ready: a draining
  // instance answers, and answers NOT_SERVING.
  return status.ok() && reply.status() == discoveryd::HealthCheckResponse::SERVING ? "SERVING" : "NOT_SERVING";
}

// The verdict for every live member of service.
std::map<std::string, std::string> probeService(const std::string& service) {
  std::map<std::string, std::string> verdicts;
  for (const std::string& instance_id : instances::members(service)) {
    const auto instance = instances::lookup(service, instance_id);
    if (!instance) continue;  // lapsed: the expiry sweep announces it, there is nobody to ask
    const std::string key = instances::verdictKey(service, instance_id);
    const auto cached = redis.get(key);
    std::string verdict;
    if (cached) {
      verdict = *cached;
    } else {
      // One probe per instance per kProbeTtl for every router; the TTL is also the retry.
      verdict = checkHealth(service, *instance);
      redis.set(key, verdict, kProbeTtl);
    }
    verdicts[instance_id] = verdict;
  }
  return verdicts;
}
`,
    },
  },
  harness: {
    python: `import service_discovery_pb2 as pb
import service_discovery_pb2_grpc as pb_grpc
from discovery import instances

FLEET = {"checkout-1": "10.4.2.1:8080", "checkout-2": "10.4.2.2:8080", "checkout-3": "10.4.2.3:8080"}


class Peer(pb_grpc.HealthServicer):
    """One instance's health endpoint: it answers with whatever status it holds."""

    def __init__(self, status="SERVING"):
        self.status = status

    def Check(self, request, context):
        return pb.HealthCheckResponse(status=getattr(pb.HealthCheckResponse, self.status))


def _serve(ctx, instance_id, status="SERVING"):
    peer = Peer(status)
    ctx.grpc.serve(pb_grpc.add_HealthServicer_to_server, peer, target=FLEET[instance_id])
    return peer


def _fleet(ctx, statuses=None):
    """checkout-1..3 registered with 5 s heartbeats; statuses maps an id to its answer, None for no process at all."""
    for instance_id, target in FLEET.items():
        address, port = target.split(":")
        instances.register_instance("checkout", instance_id, address, int(port), 5, 1)
        status = (statuses or {}).get(instance_id, "SERVING")
        if status is not None:
            _serve(ctx, instance_id, status)
    return ctx.load("probe")


def check_probe_deadline(ctx):
    m = _fleet(ctx)
    ctx.grpc.set_latency("Check", 2.0, target=FLEET["checkout-3"])  # checkout-3 is hung
    before = ctx.clock.time()
    verdicts = m.probe_service("checkout")
    waited = ctx.clock.time() - before
    assert verdicts.get("checkout-3") == "NOT_SERVING", f"checkout-3 takes 2 s to answer its health check and was judged {verdicts.get('checkout-3')!r}: past the 200 ms deadline it is NOT_SERVING"
    assert verdicts.get("checkout-1") == "SERVING" and verdicts.get("checkout-2") == "SERVING", f"the healthy instances were judged {verdicts}"
    for call in ctx.grpc.calls_to("Check"):
        assert call.timeout is not None, f"the Check call to {call.target} carries no deadline: a hung instance holds the whole round"
        assert call.timeout <= 0.25, f"the Check call to {call.target} carries a {call.timeout} s deadline, expected PROBE_DEADLINE_S = 0.2"
    assert waited < 1.0, f"one probe round over three instances took {waited:.1f} s because one of them hung"


def check_serving_status(ctx):
    m = _fleet(ctx, {"checkout-2": "NOT_SERVING", "checkout-3": None})
    verdicts = m.probe_service("checkout")
    assert verdicts.get("checkout-2") == "NOT_SERVING", f"checkout-2 answered status NOT_SERVING (it is draining) and was judged {verdicts.get('checkout-2')!r}: read the reply's status, not only whether the call returned"
    assert verdicts.get("checkout-3") == "NOT_SERVING", f"checkout-3 has no process listening and was judged {verdicts.get('checkout-3')!r}"
    assert verdicts.get("checkout-1") == "SERVING", f"checkout-1 answered SERVING and was judged {verdicts.get('checkout-1')!r}"
    assert ctx.redis.get("sd:probe:checkout:checkout-2") == "NOT_SERVING", f"sd:probe:checkout:checkout-2 holds {ctx.redis.get('sd:probe:checkout:checkout-2')!r}, expected the shared verdict NOT_SERVING"


def check_shared_verdict(ctx):
    m = _fleet(ctx)
    m.probe_service("checkout")
    assert len(ctx.grpc.calls_to("Check")) == 3, f"the first round over three instances made {len(ctx.grpc.calls_to('Check'))} Check calls"
    ttl = ctx.redis.ttl("sd:probe:checkout:checkout-1")
    assert 0 < ttl <= 5, f"sd:probe:checkout:checkout-1 has TTL {ttl}: the shared verdict expires after PROBE_TTL_S = 5 s, or a recovered instance is judged on a stale answer"
    ctx.clock.advance(1)
    other = ctx.reload("probe")  # a second router, a second later
    verdicts = other.probe_service("checkout")
    assert verdicts == {"checkout-1": "SERVING", "checkout-2": "SERVING", "checkout-3": "SERVING"}, f"the second router judged {verdicts}"
    assert len(ctx.grpc.calls_to("Check")) == 3, f"a second router within the verdicts' 5 s made {len(ctx.grpc.calls_to('Check')) - 3} more Check calls: read sd:probe:{{service}}:{{instance_id}} before probing"
    ctx.clock.advance(5)
    other.probe_service("checkout")
    assert len(ctx.grpc.calls_to("Check")) == 6, f"after the verdicts lapsed the next round made {len(ctx.grpc.calls_to('Check')) - 3} Check calls, expected one per instance"


def check_keep_registered(ctx):
    m = _fleet(ctx, {"checkout-2": None})
    verdicts = m.probe_service("checkout")
    assert verdicts.get("checkout-2") == "NOT_SERVING", f"checkout-2 has no process listening and was judged {verdicts.get('checkout-2')!r}"
    assert ctx.redis.exists("sd:checkout:checkout-2") == 1 and ctx.redis.sismember("sd:members:checkout", "checkout-2"), "one failed probe deregistered checkout-2: a failing instance is excluded by its verdict and stays registered, so a later probe can readmit it"
    _serve(ctx, "checkout-2")  # the process is back
    ctx.clock.advance(6)
    verdicts = m.probe_service("checkout")
    assert verdicts.get("checkout-2") == "SERVING", f"checkout-2 is serving again and its old verdict lapsed, yet the round judged it {verdicts.get('checkout-2')!r}: a passing probe readmits it"
`,
    typescript: `const FLEET: Record<string, string> = {'checkout-1': '10.4.2.1:8080', 'checkout-2': '10.4.2.2:8080', 'checkout-3': '10.4.2.3:8080'};

/** One instance's health endpoint: it answers with whatever status it holds. */
function serve(ctx, instanceId: string, status = 'SERVING') {
  const pkg = ctx.proto('service_discovery.proto');
  const peer = {status};
  ctx.grpc.serve(pkg.discoveryd.Health.service, {Check: (_call, callback) => callback(null, {status: peer.status})}, FLEET[instanceId]);
  return peer;
}

/** checkout-1..3 registered with 5 s heartbeats; statuses maps an id to its answer, null for no process at all. */
async function fleet(ctx, statuses: Record<string, string | null> = {}) {
  const instances = ctx.load('/support/discovery/instances.ts');
  for (const [instanceId, target] of Object.entries(FLEET)) {
    const [address, port] = target.split(':');
    await instances.registerInstance('checkout', instanceId, address, Number(port), 5, 1);
    const status = instanceId in statuses ? statuses[instanceId] : 'SERVING';
    if (status !== null) serve(ctx, instanceId, status);
  }
  return ctx.load('probe');
}

export async function check_probe_deadline(ctx) {
  const m = await fleet(ctx);
  ctx.grpc.setLatency('Check', 2.0, FLEET['checkout-3']); // checkout-3 is hung
  const before = ctx.clock.now();
  const verdicts = await m.probeService('checkout');
  const waited = (ctx.clock.now() - before) / 1000;
  assert.equal(verdicts['checkout-3'], 'NOT_SERVING', \`checkout-3 takes 2 s to answer its health check and was judged \${JSON.stringify(verdicts['checkout-3'])}: past the 200 ms deadline it is NOT_SERVING\`);
  assert(verdicts['checkout-1'] === 'SERVING' && verdicts['checkout-2'] === 'SERVING', \`the healthy instances were judged \${JSON.stringify(verdicts)}\`);
  for (const call of ctx.grpc.callsTo('Check')) {
    assert(call.timeout !== null, \`the Check call to \${call.target} carries no deadline: a hung instance holds the whole round\`);
    assert(call.timeout <= 0.25, \`the Check call to \${call.target} carries a \${call.timeout} s deadline, expected PROBE_DEADLINE_MS = 200\`);
  }
  assert(waited < 1.0, \`one probe round over three instances took \${waited.toFixed(1)} s because one of them hung\`);
}

export async function check_serving_status(ctx) {
  const m = await fleet(ctx, {'checkout-2': 'NOT_SERVING', 'checkout-3': null});
  const verdicts = await m.probeService('checkout');
  assert.equal(verdicts['checkout-2'], 'NOT_SERVING', \`checkout-2 answered status NOT_SERVING (it is draining) and was judged \${JSON.stringify(verdicts['checkout-2'])}: read the reply's status, not only whether the call returned\`);
  assert.equal(verdicts['checkout-3'], 'NOT_SERVING', \`checkout-3 has no process listening and was judged \${JSON.stringify(verdicts['checkout-3'])}\`);
  assert.equal(verdicts['checkout-1'], 'SERVING', \`checkout-1 answered SERVING and was judged \${JSON.stringify(verdicts['checkout-1'])}\`);
  assert.equal(ctx.redis.get('sd:probe:checkout:checkout-2'), 'NOT_SERVING', 'sd:probe:checkout:checkout-2 must hold the shared verdict NOT_SERVING');
}

export async function check_shared_verdict(ctx) {
  const m = await fleet(ctx);
  await m.probeService('checkout');
  assert.equal(ctx.grpc.callsTo('Check').length, 3, \`the first round over three instances made \${ctx.grpc.callsTo('Check').length} Check calls\`);
  const ttl = ctx.redis.ttl('sd:probe:checkout:checkout-1');
  assert(0 < ttl && ttl <= 5, \`sd:probe:checkout:checkout-1 has TTL \${ttl}: the shared verdict expires after PROBE_TTL_S = 5 s, or a recovered instance is judged on a stale answer\`);
  ctx.clock.advance(1);
  const other = ctx.load('probe'); // a second router, a second later
  const verdicts = await other.probeService('checkout');
  assert.deepEqual(verdicts, {'checkout-1': 'SERVING', 'checkout-2': 'SERVING', 'checkout-3': 'SERVING'}, \`the second router judged \${JSON.stringify(verdicts)}\`);
  assert.equal(ctx.grpc.callsTo('Check').length, 3, \`a second router within the verdicts' 5 s made \${ctx.grpc.callsTo('Check').length - 3} more Check calls: read sd:probe:{service}:{instance_id} before probing\`);
  ctx.clock.advance(5);
  await other.probeService('checkout');
  assert.equal(ctx.grpc.callsTo('Check').length, 6, \`after the verdicts lapsed the next round made \${ctx.grpc.callsTo('Check').length - 3} Check calls, expected one per instance\`);
}

export async function check_keep_registered(ctx) {
  const m = await fleet(ctx, {'checkout-2': null});
  let verdicts = await m.probeService('checkout');
  assert.equal(verdicts['checkout-2'], 'NOT_SERVING', \`checkout-2 has no process listening and was judged \${JSON.stringify(verdicts['checkout-2'])}\`);
  assert(ctx.redis.exists('sd:checkout:checkout-2') === 1 && ctx.redis.sismember('sd:members:checkout', 'checkout-2') === 1, 'one failed probe deregistered checkout-2: a failing instance is excluded by its verdict and stays registered, so a later probe can readmit it');
  serve(ctx, 'checkout-2'); // the process is back
  ctx.clock.advance(6);
  verdicts = await m.probeService('checkout');
  assert.equal(verdicts['checkout-2'], 'SERVING', \`checkout-2 is serving again and its old verdict lapsed, yet the round judged it \${JSON.stringify(verdicts['checkout-2'])}: a passing probe readmits it\`);
}
`,
    go: `package main

import (
	"context"
	"strconv"
	"strings"
	"time"

	"discovery/instances"
	pb "discovery/gen/service_discovery"

	"leetbuild/harness"
)

var (
	probeBg = context.Background()
	fleet   = map[string]string{"checkout-1": "10.4.2.1:8080", "checkout-2": "10.4.2.2:8080", "checkout-3": "10.4.2.3:8080"}
	fleetIDs = []string{"checkout-1", "checkout-2", "checkout-3"}
)

// healthPeer is one instance's health endpoint: it answers with whatever status it holds.
type healthPeer struct {
	pb.UnimplementedHealthServer
	status pb.HealthCheckResponse_ServingStatus
}

func (p *healthPeer) Check(context.Context, *pb.HealthCheckRequest) (*pb.HealthCheckResponse, error) {
	return &pb.HealthCheckResponse{Status: p.status}, nil
}

func serveHealth(ctx *harness.Ctx, instanceID string, status pb.HealthCheckResponse_ServingStatus) {
	pb.RegisterHealthServer(ctx.GRPC.Server(fleet[instanceID]), &healthPeer{status: status})
}

// startFleet registers checkout-1..3 with 5 s heartbeats; down lists the ids with no process at all.
func startFleet(ctx *harness.Ctx, statuses map[string]pb.HealthCheckResponse_ServingStatus, down ...string) {
	for _, id := range fleetIDs {
		address, port, _ := strings.Cut(fleet[id], ":")
		n, _ := strconv.Atoi(port)
		_, err := instances.RegisterInstance(probeBg, "checkout", id, address, n, 5, 1)
		ctx.NoError(err, "registering %s", id)
		skip := false
		for _, d := range down {
			skip = skip || d == id
		}
		if skip {
			continue
		}
		status, ok := statuses[id]
		if !ok {
			status = pb.HealthCheckResponse_SERVING
		}
		serveHealth(ctx, id, status)
	}
}

func round(ctx *harness.Ctx) map[string]string {
	verdicts, err := probeService(probeBg, "checkout")
	ctx.NoError(err, "probeService(checkout) failed")
	return verdicts
}

func CheckProbeDeadline(ctx *harness.Ctx) {
	startFleet(ctx, nil)
	ctx.GRPC.SetLatency("Check", 2.0, fleet["checkout-3"]) // checkout-3 is hung
	before := ctx.Clock.Now()
	verdicts := round(ctx)
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Equal(verdicts["checkout-3"], "NOT_SERVING", "checkout-3 takes 2 s to answer its health check: past the 200 ms deadline it is NOT_SERVING; its verdict")
	ctx.Assert(verdicts["checkout-1"] == "SERVING" && verdicts["checkout-2"] == "SERVING", "the healthy instances were judged %v", verdicts)
	for _, call := range ctx.GRPC.CallsTo("Check", "") {
		ctx.Assert(call.HasDeadline(), "a Check call carries no deadline: a hung instance holds the whole round")
		ctx.Assert(call.Timeout <= 250*time.Millisecond, "a Check call carries a %v deadline, expected probeDeadline = 200 ms", call.Timeout)
	}
	ctx.Assert(waited < 1.0, "one probe round over three instances took %.1f s because one of them hung", waited)
}

func CheckServingStatus(ctx *harness.Ctx) {
	startFleet(ctx, map[string]pb.HealthCheckResponse_ServingStatus{"checkout-2": pb.HealthCheckResponse_NOT_SERVING}, "checkout-3")
	verdicts := round(ctx)
	ctx.Equal(verdicts["checkout-2"], "NOT_SERVING", "checkout-2 answered status NOT_SERVING (it is draining): read the reply's status, not only whether the call returned; its verdict")
	ctx.Equal(verdicts["checkout-3"], "NOT_SERVING", "checkout-3 has no process listening; its verdict")
	ctx.Equal(verdicts["checkout-1"], "SERVING", "checkout-1 answered SERVING; its verdict")
	shared, _ := ctx.Redis.Get("sd:probe:checkout:checkout-2")
	ctx.Equal(shared, "NOT_SERVING", "the shared verdict in sd:probe:checkout:checkout-2")
}

func CheckSharedVerdict(ctx *harness.Ctx) {
	startFleet(ctx, nil)
	round(ctx)
	ctx.Equal(len(ctx.GRPC.CallsTo("Check", "")), 3, "the first round over three instances; Check calls")
	ttl := ctx.Redis.TTL("sd:probe:checkout:checkout-1")
	ctx.Assert(0 < ttl && ttl <= 5, "sd:probe:checkout:checkout-1 has TTL %d: the shared verdict expires after 5 s, or a recovered instance is judged on a stale answer", ttl)
	ctx.Clock.Advance(1)
	verdicts := round(ctx) // another round a second later, as a second router would run it
	ctx.Equal(verdicts, map[string]string{"checkout-1": "SERVING", "checkout-2": "SERVING", "checkout-3": "SERVING"}, "the verdicts of the second round")
	ctx.Equal(len(ctx.GRPC.CallsTo("Check", "")), 3, "a second round within the verdicts' 5 s must read sd:probe:{service}:{instance_id} before probing; Check calls")
	ctx.Clock.Advance(5)
	round(ctx)
	ctx.Equal(len(ctx.GRPC.CallsTo("Check", "")), 6, "after the verdicts lapsed the next round must probe each instance once; Check calls")
}

func CheckKeepRegistered(ctx *harness.Ctx) {
	startFleet(ctx, nil, "checkout-2")
	verdicts := round(ctx)
	ctx.Equal(verdicts["checkout-2"], "NOT_SERVING", "checkout-2 has no process listening; its verdict")
	ctx.Assert(ctx.Redis.Exists("sd:checkout:checkout-2") == 1 && ctx.Redis.SIsMember("sd:members:checkout", "checkout-2"), "one failed probe deregistered checkout-2: a failing instance is excluded by its verdict and stays registered, so a later probe can readmit it")
	serveHealth(ctx, "checkout-2", pb.HealthCheckResponse_SERVING) // the process is back
	ctx.Clock.Advance(6)
	verdicts = round(ctx)
	ctx.Equal(verdicts["checkout-2"], "SERVING", "checkout-2 is serving again and its old verdict lapsed: a passing probe readmits it; its verdict")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "discovery/instances.h"
#include "service_discovery.grpc.pb.h"

namespace {

using Status = discoveryd::HealthCheckResponse::ServingStatus;

const std::map<std::string, std::string> kFleet = {
    {"checkout-1", "10.4.2.1"}, {"checkout-2", "10.4.2.2"}, {"checkout-3", "10.4.2.3"}};

std::string target(const std::string& instance_id) { return kFleet.at(instance_id) + ":8080"; }

// One instance's health endpoint: it answers with whatever status it holds.
class HealthPeer final : public discoveryd::Health::Service {
 public:
  explicit HealthPeer(Status s) : status(s) {}
  Status status;
  grpc::Status Check(grpc::ServerContext*, const discoveryd::HealthCheckRequest*, discoveryd::HealthCheckResponse* out) override {
    out->set_status(status);
    return grpc::Status::OK;
  }
};

std::vector<std::unique_ptr<HealthPeer>>& peers() {
  static std::vector<std::unique_ptr<HealthPeer>> all;
  return all;
}

void serveHealth(harness::Ctx& ctx, const std::string& instance_id, Status status) {
  peers().push_back(std::make_unique<HealthPeer>(status));
  ctx.GRPC.Server(target(instance_id))->RegisterService(peers().back().get());
}

// checkout-1..3 registered with 5 s heartbeats; down lists the ids with no process at all.
void startFleet(harness::Ctx& ctx, const std::map<std::string, Status>& statuses, const std::set<std::string>& down = {}) {
  for (const auto& [instance_id, address] : kFleet) {
    instances::registerInstance("checkout", instance_id, address, 8080, 5, 1);
    if (down.count(instance_id)) continue;
    const auto it = statuses.find(instance_id);
    serveHealth(ctx, instance_id, it == statuses.end() ? discoveryd::HealthCheckResponse::SERVING : it->second);
  }
}

std::string verdictOf(const std::map<std::string, std::string>& verdicts, const std::string& instance_id) {
  const auto it = verdicts.find(instance_id);
  return it == verdicts.end() ? "" : it->second;
}

}  // namespace

void CheckProbeDeadline(harness::Ctx& ctx) {
  startFleet(ctx, {});
  ctx.GRPC.SetLatency("Check", 2.0, target("checkout-3"));  // checkout-3 is hung
  const int64_t before = ctx.Clock.Now();
  const auto verdicts = probeService("checkout");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Equal(verdictOf(verdicts, "checkout-3"), "NOT_SERVING", "checkout-3 takes 2 s to answer its health check: past the 200 ms deadline it is NOT_SERVING; its verdict");
  ctx.Assert(verdictOf(verdicts, "checkout-1") == "SERVING" && verdictOf(verdicts, "checkout-2") == "SERVING", "the healthy instances must be SERVING");
  for (const auto& call : ctx.GRPC.CallsTo("Check")) {
    ctx.Assert(call.HasDeadline(), "a Check call carries no deadline: a hung instance holds the whole round");
    ctx.Assert(call.TimeoutSeconds() <= 0.25, "a Check call carries a %v s deadline, expected kProbeDeadline = 200 ms", call.TimeoutSeconds());
  }
  ctx.Assert(waited < 1.0, "one probe round over three instances took %.1f s because one of them hung", waited);
}

void CheckServingStatus(harness::Ctx& ctx) {
  startFleet(ctx, {{"checkout-2", discoveryd::HealthCheckResponse::NOT_SERVING}}, {"checkout-3"});
  const auto verdicts = probeService("checkout");
  ctx.Equal(verdictOf(verdicts, "checkout-2"), "NOT_SERVING", "checkout-2 answered status NOT_SERVING (it is draining): read the reply's status, not only whether the call returned; its verdict");
  ctx.Equal(verdictOf(verdicts, "checkout-3"), "NOT_SERVING", "checkout-3 has no process listening; its verdict");
  ctx.Equal(verdictOf(verdicts, "checkout-1"), "SERVING", "checkout-1 answered SERVING; its verdict");
  ctx.Equal(ctx.Redis.Get("sd:probe:checkout:checkout-2").value_or(""), "NOT_SERVING", "the shared verdict in sd:probe:checkout:checkout-2");
}

void CheckSharedVerdict(harness::Ctx& ctx) {
  startFleet(ctx, {});
  probeService("checkout");
  ctx.Equal(ctx.GRPC.CallsTo("Check").size(), 3, "the first round over three instances; Check calls");
  const long long ttl = ctx.Redis.TTL("sd:probe:checkout:checkout-1");
  ctx.Assert(0 < ttl && ttl <= 5, "sd:probe:checkout:checkout-1 has TTL %d: the shared verdict expires after 5 s, or a recovered instance is judged on a stale answer", ttl);
  ctx.Clock.Advance(1);
  const auto verdicts = probeService("checkout");  // another round a second later, as a second router would run it
  ctx.Assert(verdicts.size() == 3 && verdictOf(verdicts, "checkout-1") == "SERVING" && verdictOf(verdicts, "checkout-2") == "SERVING" && verdictOf(verdicts, "checkout-3") == "SERVING", "the second round must judge all three SERVING");
  ctx.Equal(ctx.GRPC.CallsTo("Check").size(), 3, "a second round within the verdicts' 5 s must read sd:probe:{service}:{instance_id} before probing; Check calls");
  ctx.Clock.Advance(5);
  probeService("checkout");
  ctx.Equal(ctx.GRPC.CallsTo("Check").size(), 6, "after the verdicts lapsed the next round must probe each instance once; Check calls");
}

void CheckKeepRegistered(harness::Ctx& ctx) {
  startFleet(ctx, {}, {"checkout-2"});
  auto verdicts = probeService("checkout");
  ctx.Equal(verdictOf(verdicts, "checkout-2"), "NOT_SERVING", "checkout-2 has no process listening; its verdict");
  ctx.Assert(ctx.Redis.Exists("sd:checkout:checkout-2") == 1 && ctx.Redis.SIsMember("sd:members:checkout", "checkout-2"), "one failed probe deregistered checkout-2: a failing instance is excluded by its verdict and stays registered, so a later probe can readmit it");
  serveHealth(ctx, "checkout-2", discoveryd::HealthCheckResponse::SERVING);  // the process is back
  ctx.Clock.Advance(6);
  verdicts = probeService("checkout");
  ctx.Equal(verdictOf(verdicts, "checkout-2"), "SERVING", "checkout-2 is serving again and its old verdict lapsed: a passing probe readmits it; its verdict");
}
`,
  },
  hints: [
    'Freeze one checkout pod: every probe round stalls for as long as it is frozen and then marks it SERVING. A pod that is draining answers NOT_SERVING and still gets traffic.',
    'The Check call has no deadline, and only whether it raised is looked at, not the reply. The verdict is written without a TTL and never read back, and a failure deletes the record and the member.',
    'Pass `timeout=PROBE_DEADLINE_S` to `Check` and compare `reply.status` with `HealthCheckResponse.SERVING`; `r.get` the verdict key first and `set(key, verdict, ex=PROBE_TTL_S)` on a miss; drop the `delete` and the `srem`.',
  ],
  debrief: `A probe is a question with a time limit: an instance that cannot answer its health check in 200 ms cannot answer a user either, so the deadline turns a hang into a verdict. The status field matters because a process can be alive and still refuse traffic, which is what a drain looks like. Sharing the verdict in Redis with a short TTL bounds the load to one call per instance per five seconds for every router, and the TTL is also the retry: the verdict lapses, the next round asks again, and a recovered instance comes back without re-registering. Production health checkers spread probes with jitter and want a few consecutive failures before excluding an instance, so one lost packet does not flap the routing table.`,
};
