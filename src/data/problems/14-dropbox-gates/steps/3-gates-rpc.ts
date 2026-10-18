import type {Step} from '@/lib/types';

export const gatesRpcStep: Step = {
  id: 'gates-rpc',
  title: 'Gates.GetVariants: every gate a client needs, in one call',
  concept: 'grpc',
  file: 'gate_service',
  focus: ['clients', 'svc', 'web'],
  task: `## Task

Desktop and mobile builds cannot hold the config snapshot, so they ask once at start-up. Implement the
\`Gates\` service from \`gates.proto\`: \`GetVariants(GetVariantsRequest{user_id, attrs, features}) →
GetVariantsReply{variants, version}\`, on top of step 2's \`get_variant\` and \`snapshot\` (import them; the loader
is already running beside the server).

- \`user_id\` must be non-empty: **INVALID_ARGUMENT** otherwise. The attributes are the request's \`attrs\` map
  plus \`user_id\` — the client passes what it knows (platform, app version, locale), exactly as the post
  recommends: the gating system does no lookups of its own.
- \`variants\` has one entry per requested feature, computed with \`get_variant\`; a feature the snapshot does not
  know answers **\`OFF\`** rather than an error — a newer build asking about a gate that is not published yet must
  still start.
- An empty \`features\` list means **every gate in the snapshot**.
- \`version\` is the snapshot's version, so a client can tell which edit its answers came from. The handler never
  calls \`refresh()\` and never touches Redis: it is a batch of pure decisions.

:::widget grpc-streams {"mode": "unary"}

> One unary call instead of thirty: the client's start-up pays one round trip, the server pays thirty hash
> computations and no I/O.`,
  sequence: {
    participants: ['Desktop app', 'Gates', 'snapshot'],
    messages: [
      {
        from: 'Desktop app',
        to: 'Gates',
        label:
          'GetVariants(user_id: ana, attrs: {platform: mac, locale: de}, features: [button_color, dark_mode, new_sidebar])',
        kind: 'sync',
      },
      {from: 'Gates', to: 'snapshot', label: 'get_variant × 3 (in memory, no Redis)', kind: 'sync'},
      {from: 'snapshot', to: 'Gates', label: 'RED_BUTTON · ON · OFF (unknown gate)', kind: 'reply'},
      {
        from: 'Gates',
        to: 'Desktop app',
        label: '{variants: {button_color: RED_BUTTON, dark_mode: ON, new_sidebar: OFF}, version: 7}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Build the attributes once per call — the `attrs` map with `user_id` added — then map every feature through `get_variant`. The unknown-gate case is already OFF in step 2; do not special-case it here.',
    'An empty `features` list is not an error: iterate the snapshot’s gate names instead. Read `snapshot` once at the top of the handler so the variants and the version come from the same snapshot even if the loader swaps it mid-call.',
    'Validation is the only status code you set: `INVALID_ARGUMENT` with a message naming the field. Everything else is a normal reply, including a request for gates that do not exist.',
  ],
  checks: [
    {
      id: 'batch',
      title: 'Answers every requested gate in one reply',
      detail:
        '`variants` holds one entry per requested feature, each equal to `get_variant(feature, attrs + user_id)`; the attributes the client sent decide which population matches.',
      match: {
        python: {
          all: [
            /dict\(request\.attrs\)/,
            /attrs\["user_id"\] = request\.user_id/,
            /get_variant\(\s*\w+\s*,\s*attrs\s*\)/,
          ],
        },
        typescript: {all: [/\{\s*\.\.\.attrs\s*,\s*user_id\s*\}/, /getVariant\(\s*\w+\s*,\s*\w+\s*\)/]},
        go: {
          all: [
            /range req\.GetAttrs\(\)/,
            /attrs\["user_id"\] = req\.GetUserId\(\)/,
            /(?<!func )getVariant\(\s*\w+\s*,\s*attrs\s*\)/,
          ],
        },
        scala: {
          all: [/request\.attrs \+ \("user_id" -> request\.userId\)/, /(?<!def )getVariant\(\s*\w+\s*,\s*attrs\s*\)/],
        },
        cpp: {
          all: [
            /request->attrs\(\)/,
            /attrs\["user_id"\] = request->user_id\(\)/,
            /get_variant\(\s*\w+\s*,\s*attrs\s*\)/,
          ],
        },
      },
    },
    {
      id: 'unknown-off',
      title: 'An unknown gate answers OFF, not an error',
      detail: 'A feature that is not in the snapshot appears in `variants` as `OFF`; the call succeeds.',
      match: {
        python: {all: [/get_variant\(/], none: [/StatusCode\.NOT_FOUND/, /\bOFF\b/]},
        typescript: {all: [/getVariant\(/], none: [/status\.NOT_FOUND/, /\bOFF\b/]},
        go: {all: [/(?<!func )getVariant\(/], none: [/codes\.NotFound/, /\boff\b/]},
        scala: {all: [/(?<!def )getVariant\(/], none: [/Status\.NOT_FOUND/, /\bOff\b/]},
        cpp: {all: [/get_variant\(/], none: [/StatusCode::NOT_FOUND/, /\bkOff\b/]},
      },
    },
    {
      id: 'invalid-argument',
      title: 'An empty user_id is INVALID_ARGUMENT',
      detail: 'A request without `user_id` fails with status `INVALID_ARGUMENT`; nothing is evaluated.',
      match: {
        python: {
          order: [/if not request\.user_id:/, /context\.abort\(\s*grpc\.StatusCode\.INVALID_ARGUMENT/, /get_variant\(/],
        },
        typescript: {
          order: [/user_id === ''|!user_id|user_id\.length === 0/, /grpc\.status\.INVALID_ARGUMENT/, /getVariant\(/],
        },
        go: {order: [/req\.GetUserId\(\) == ""/, /codes\.InvalidArgument/, /(?<!func )getVariant\(/]},
        scala: {order: [/request\.userId\.isEmpty/, /Status\.INVALID_ARGUMENT/, /(?<!def )getVariant\(/]},
        cpp: {order: [/request->user_id\(\)\.empty\(\)/, /StatusCode::INVALID_ARGUMENT/, /get_variant\(/]},
      },
    },
    {
      id: 'snapshot-served',
      title: 'Served from the snapshot: no Redis, the version in the reply',
      detail:
        'Fifty calls send no Redis command; `version` equals the snapshot’s version; an empty `features` list answers every gate in the snapshot; after the loader refreshes, the next reply carries the new version and variants.',
      match: {
        python: {
          all: [/= gates\.snapshot/, /version\s*=\s*\w+\.version/, /list\(\w+\.gates\)/],
          none: [/\brefresh\(/, /\br\.\w+\(|redis\.Redis\(/],
        },
        typescript: {
          all: [/= snapshot;/, /String\(\s*\w+\.version\s*\)/, /\.gates\.keys\(\)/],
          none: [/\brefresh\(/, /new Redis\(/],
        },
        go: {
          all: [/= snapshot\.Load\(\)/, /Version:\s*uint64\(\s*\w+\.Version\s*\)/, /range \w+\.Gates/],
          none: [/\brefresh\(/, /\brdb\./],
        },
        scala: {all: [/= snapshot\b/, /version\s*=\s*\w+\.version/, /\.gates\.keys/], none: [/\brefresh\(/, /jedis\./]},
        cpp: {
          all: [/std::atomic_load\(&snapshot\)/, /set_version\(\s*\w+->version\s*\)/, /\w+->gates\)/],
          none: [/\brefresh\(/, /\bredis\./],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Gates.GetVariants: every gate a desktop or mobile build asks about, answered in one call from the snapshot."""
import asyncio

import grpc

import gates  # built in step 2: gates.snapshot is the live Snapshot(version, gates), reassigned whole by the loader
import gates_pb2
import gates_pb2_grpc
from gates import get_variant, start_loader


class GatesService(gates_pb2_grpc.GatesServicer):
    async def GetVariants(self, request, context: grpc.aio.ServicerContext):
        # TODO: an empty request.user_id → context.abort(INVALID_ARGUMENT, a message naming the field)
        # TODO: read gates.snapshot once; attrs = the request's attrs map plus user_id
        # TODO: features = request.features, or every gate name in the snapshot when empty
        # TODO: GetVariantsReply(variants={feature: get_variant(feature, attrs) …}, version=the snapshot's)
        await context.abort(grpc.StatusCode.UNIMPLEMENTED, "not implemented")


async def serve() -> None:
    server = grpc.aio.server()
    gates_pb2_grpc.add_GatesServicer_to_server(GatesService(), server)
    server.add_insecure_port("[::]:9000")
    await server.start()
    await server.wait_for_termination()


if __name__ == "__main__":
    start_loader()  # step 2's loader beside the server: one load now, then every POLL_INTERVAL_S in the background
    asyncio.run(serve())
`,
      solution: `"""Gates.GetVariants: every gate a desktop or mobile build asks about, answered in one call from the snapshot."""
import asyncio

import grpc

import gates  # built in step 2: gates.snapshot is the live Snapshot(version, gates), reassigned whole by the loader
import gates_pb2
import gates_pb2_grpc
from gates import get_variant, start_loader


class GatesService(gates_pb2_grpc.GatesServicer):
    async def GetVariants(self, request, context: grpc.aio.ServicerContext):
        if not request.user_id:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "user_id is required")
        snapshot = gates.snapshot  # read once: the names and the version come from the same snapshot
        attrs = dict(request.attrs)
        attrs["user_id"] = request.user_id
        features = list(request.features) or list(snapshot.gates)
        return gates_pb2.GetVariantsReply(
            variants={feature: get_variant(feature, attrs) for feature in features},
            version=snapshot.version,
        )


async def serve() -> None:
    server = grpc.aio.server()
    gates_pb2_grpc.add_GatesServicer_to_server(GatesService(), server)
    server.add_insecure_port("[::]:9000")
    await server.start()
    await server.wait_for_termination()


if __name__ == "__main__":
    start_loader()  # step 2's loader beside the server: one load now, then every POLL_INTERVAL_S in the background
    asyncio.run(serve())
`,
    },
    typescript: {
      starter: `/** Gates.GetVariants: every gate a desktop or mobile build asks about, answered in one call from the snapshot. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Attrs, getVariant, snapshot, startLoader} from './gates'; // built in step 2: snapshot is the live {version, gates}, replaced whole by the loader

const proto = grpc.loadPackageDefinition(protoLoader.loadSync('gates.proto', {longs: String})) as unknown as {
  gates: {Gates: grpc.ServiceClientConstructor};
};

export interface GetVariantsRequest {
  user_id: string;
  attrs: Record<string, string>;
  features: string[];
}

export interface GetVariantsReply {
  variants: Record<string, string>;
  version: string; // uint64 on the wire: a decimal string here
}

export const gatesService = {
  GetVariants(call: grpc.ServerUnaryCall<GetVariantsRequest, GetVariantsReply>, callback: grpc.sendUnaryData<GetVariantsReply>) {
    // TODO: an empty user_id → callback({code: grpc.status.INVALID_ARGUMENT, details: a message naming the field})
    // TODO: read snapshot once; attrs = the request's attrs map plus user_id
    // TODO: features = call.request.features, or every gate name in the snapshot when empty
    // TODO: callback(null, {variants: {feature: getVariant(feature, attrs) …}, version: String(the snapshot's)})
    callback({code: grpc.status.UNIMPLEMENTED, details: 'not implemented'});
  },
};

export function serve(): grpc.Server {
  const server = new grpc.Server();
  server.addService(proto.gates.Gates.service, gatesService);
  server.bindAsync('0.0.0.0:9000', grpc.ServerCredentials.createInsecure(), () => undefined);
  return server;
}

/** Step 2's loader beside the server: one load now, then every POLL_INTERVAL_S in the background. */
export async function main(): Promise<void> {
  await startLoader();
  serve();
}
`,
      solution: `/** Gates.GetVariants: every gate a desktop or mobile build asks about, answered in one call from the snapshot. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Attrs, getVariant, snapshot, startLoader} from './gates'; // built in step 2: snapshot is the live {version, gates}, replaced whole by the loader

const proto = grpc.loadPackageDefinition(protoLoader.loadSync('gates.proto', {longs: String})) as unknown as {
  gates: {Gates: grpc.ServiceClientConstructor};
};

export interface GetVariantsRequest {
  user_id: string;
  attrs: Record<string, string>;
  features: string[];
}

export interface GetVariantsReply {
  variants: Record<string, string>;
  version: string; // uint64 on the wire: a decimal string here
}

export const gatesService = {
  GetVariants(call: grpc.ServerUnaryCall<GetVariantsRequest, GetVariantsReply>, callback: grpc.sendUnaryData<GetVariantsReply>) {
    const {user_id, attrs, features} = call.request;
    if (user_id === '') {
      callback({code: grpc.status.INVALID_ARGUMENT, details: 'user_id is required'});
      return;
    }
    const current = snapshot; // read once: the names and the version come from the same snapshot
    const merged: Attrs = {...attrs, user_id};
    const names = features.length > 0 ? features : [...current.gates.keys()];
    const variants: Record<string, string> = {};
    for (const feature of names) variants[feature] = getVariant(feature, merged);
    callback(null, {variants, version: String(current.version)});
  },
};

export function serve(): grpc.Server {
  const server = new grpc.Server();
  server.addService(proto.gates.Gates.service, gatesService);
  server.bindAsync('0.0.0.0:9000', grpc.ServerCredentials.createInsecure(), () => undefined);
  return server;
}

/** Step 2's loader beside the server: one load now, then every POLL_INTERVAL_S in the background. */
export async function main(): Promise<void> {
  await startLoader();
  serve();
}
`,
    },
    go: {
      starter: `// Gates.GetVariants: every gate a desktop or mobile build asks about, answered in one call from the snapshot.
package main

import (
	"context"
	"log"
	"net"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "gates/gen/gates"
)

// Built in step 2 (gates.go, this package): snapshot.Load() is the live *Snapshot{Version, Gates},
// replaced whole by the loader; getVariant(name, attrs) is the pure decision over it.

type gatesServer struct {
	pb.UnimplementedGatesServer
}

func (s *gatesServer) GetVariants(ctx context.Context, req *pb.GetVariantsRequest) (*pb.GetVariantsReply, error) {
	// TODO: an empty req.GetUserId() → codes.InvalidArgument with a message naming the field
	// TODO: read snapshot.Load() once; attrs = the request's attrs map plus user_id
	// TODO: features = req.GetFeatures(), or every gate name in the snapshot when empty
	// TODO: &pb.GetVariantsReply{Variants: {feature: getVariant(feature, attrs) …}, Version: the snapshot's}
	return nil, status.Error(codes.Unimplemented, "not implemented")
}

func main() {
	if err := startLoader(context.Background(), pollInterval); err != nil { // step 2's loader beside the server
		log.Fatal(err)
	}
	lis, err := net.Listen("tcp", ":9000")
	if err != nil {
		log.Fatal(err)
	}
	srv := grpc.NewServer()
	pb.RegisterGatesServer(srv, &gatesServer{})
	log.Fatal(srv.Serve(lis))
}
`,
      solution: `// Gates.GetVariants: every gate a desktop or mobile build asks about, answered in one call from the snapshot.
package main

import (
	"context"
	"log"
	"net"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "gates/gen/gates"
)

// Built in step 2 (gates.go, this package): snapshot.Load() is the live *Snapshot{Version, Gates},
// replaced whole by the loader; getVariant(name, attrs) is the pure decision over it.

type gatesServer struct {
	pb.UnimplementedGatesServer
}

func (s *gatesServer) GetVariants(ctx context.Context, req *pb.GetVariantsRequest) (*pb.GetVariantsReply, error) {
	if req.GetUserId() == "" {
		return nil, status.Error(codes.InvalidArgument, "user_id is required")
	}
	current := snapshot.Load() // read once: the names and the version come from the same snapshot
	attrs := make(map[string]string, len(req.GetAttrs())+1)
	for key, value := range req.GetAttrs() {
		attrs[key] = value
	}
	attrs["user_id"] = req.GetUserId()
	features := req.GetFeatures()
	if len(features) == 0 {
		for name := range current.Gates {
			features = append(features, name)
		}
	}
	variants := make(map[string]string, len(features))
	for _, feature := range features {
		variants[feature] = getVariant(feature, attrs)
	}
	return &pb.GetVariantsReply{Variants: variants, Version: uint64(current.Version)}, nil
}

func main() {
	if err := startLoader(context.Background(), pollInterval); err != nil { // step 2's loader beside the server
		log.Fatal(err)
	}
	lis, err := net.Listen("tcp", ":9000")
	if err != nil {
		log.Fatal(err)
	}
	srv := grpc.NewServer()
	pb.RegisterGatesServer(srv, &gatesServer{})
	log.Fatal(srv.Serve(lis))
}
`,
    },
    scala: {
      starter: `import gates.gates.{GatesGrpc, GetVariantsReply, GetVariantsRequest}
import io.grpc.{ServerBuilder, Status}
import scala.concurrent.{ExecutionContext, Future}

import Gates.{getVariant, snapshot, startLoader} // built in step 2: snapshot is the live Snapshot(version, gates), replaced whole by the loader

/** Gates.GetVariants: every gate a desktop or mobile build asks about, answered in one call from the snapshot. */
object GateService extends GatesGrpc.Gates {
  override def getVariants(request: GetVariantsRequest): Future[GetVariantsReply] = {
    // TODO: an empty request.userId → Status.INVALID_ARGUMENT with a message naming the field
    // TODO: read snapshot once; attrs = the request's attrs map plus user_id
    // TODO: features = request.features, or every gate name in the snapshot when empty
    // TODO: GetVariantsReply(variants = features.map(f => f -> getVariant(f, attrs)).toMap, version = the snapshot's)
    Future.failed(Status.UNIMPLEMENTED.withDescription("not implemented").asRuntimeException())
  }

  def main(args: Array[String]): Unit = {
    startLoader() // step 2's loader beside the server: one load now, then every PollIntervalSeconds in the background
    ServerBuilder.forPort(9000).addService(GatesGrpc.bindService(this, ExecutionContext.global)).build().start().awaitTermination()
  }
}
`,
      solution: `import gates.gates.{GatesGrpc, GetVariantsReply, GetVariantsRequest}
import io.grpc.{ServerBuilder, Status}
import scala.concurrent.{ExecutionContext, Future}

import Gates.{getVariant, snapshot, startLoader} // built in step 2: snapshot is the live Snapshot(version, gates), replaced whole by the loader

/** Gates.GetVariants: every gate a desktop or mobile build asks about, answered in one call from the snapshot. */
object GateService extends GatesGrpc.Gates {
  override def getVariants(request: GetVariantsRequest): Future[GetVariantsReply] = {
    if (request.userId.isEmpty)
      return Future.failed(Status.INVALID_ARGUMENT.withDescription("user_id is required").asRuntimeException())
    val current = snapshot // read once: the names and the version come from the same snapshot
    val attrs = request.attrs + ("user_id" -> request.userId)
    val features = if (request.features.nonEmpty) request.features else current.gates.keys.toSeq
    Future.successful(GetVariantsReply(variants = features.map(feature => feature -> getVariant(feature, attrs)).toMap, version = current.version))
  }

  def main(args: Array[String]): Unit = {
    startLoader() // step 2's loader beside the server: one load now, then every PollIntervalSeconds in the background
    ServerBuilder.forPort(9000).addService(GatesGrpc.bindService(this, ExecutionContext.global)).build().start().awaitTermination()
  }
}
`,
    },
    cpp: {
      starter: `// Gates.GetVariants: every gate a desktop or mobile build asks about, answered in one call from the snapshot.
#include <grpcpp/grpcpp.h>

#include <atomic>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "gates.grpc.pb.h"
#include "gates.h"  // built in step 2: snapshot (std::shared_ptr<const Snapshot>, replaced whole by the loader), get_variant, start_loader

using gates::Gates;
using gates::GetVariantsReply;
using gates::GetVariantsRequest;

class GateService final : public Gates::Service {
 public:
  grpc::Status GetVariants(grpc::ServerContext*, const GetVariantsRequest* request, GetVariantsReply* reply) override {
    // TODO: an empty request->user_id() → StatusCode::INVALID_ARGUMENT with a message naming the field
    // TODO: std::atomic_load(&snapshot) once; attrs = the request's attrs map plus user_id
    // TODO: features = request->features(), or every gate name in the snapshot when empty
    // TODO: (*reply->mutable_variants())[feature] = get_variant(feature, attrs); reply->set_version(the snapshot's)
    (void)request;
    (void)reply;
    return grpc::Status(grpc::StatusCode::UNIMPLEMENTED, "not implemented");
  }
};

int main() {
  start_loader();  // step 2's loader beside the server: one load now, then every kPollInterval in the background
  GateService service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:9000", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}
`,
      solution: `// Gates.GetVariants: every gate a desktop or mobile build asks about, answered in one call from the snapshot.
#include <grpcpp/grpcpp.h>

#include <atomic>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "gates.grpc.pb.h"
#include "gates.h"  // built in step 2: snapshot (std::shared_ptr<const Snapshot>, replaced whole by the loader), get_variant, start_loader

using gates::Gates;
using gates::GetVariantsReply;
using gates::GetVariantsRequest;

class GateService final : public Gates::Service {
 public:
  grpc::Status GetVariants(grpc::ServerContext*, const GetVariantsRequest* request, GetVariantsReply* reply) override {
    if (request->user_id().empty()) {
      return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "user_id is required");
    }
    const auto current = std::atomic_load(&snapshot);  // read once: the names and the version come from the same snapshot
    std::map<std::string, std::string> attrs(request->attrs().begin(), request->attrs().end());
    attrs["user_id"] = request->user_id();
    std::vector<std::string> features(request->features().begin(), request->features().end());
    if (features.empty()) {
      for (const auto& [name, gate] : current->gates) features.push_back(name);
    }
    for (const auto& feature : features) {
      (*reply->mutable_variants())[feature] = get_variant(feature, attrs);
    }
    reply->set_version(current->version);
    return grpc::Status::OK;
  }
};

int main() {
  start_loader();  // step 2's loader beside the server: one load now, then every kPollInterval in the background
  GateService service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:9000", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}
`,
    },
  },
  harness: {
    python: `import asyncio
import hashlib
import json
import sys

import grpc

import gates_pb2
import gates_pb2_grpc

MIX = [{"variant": "RED_BUTTON", "pct": 33}, {"variant": "BLUE_BUTTON", "pct": 33}, {"variant": "CONTROL", "pct": 34}]
HALF = [{"variant": "ON", "pct": 50}, {"variant": "OFF", "pct": 50}]


def gate(name, populations, seed=None, default="OFF", overrides=(), version=1):
    return {"name": name, "seed": seed or name, "default": default, "populations": populations, "overrides": list(overrides), "version": version}


def everyone(variant):
    return [{"match": {}, "mix": [{"variant": variant, "pct": 100}]}]


def publish(ctx, gates, version):
    """What step 1 leaves behind: one field per gate in the hash, and the global version."""
    for g in gates:
        ctx.redis.hset("gates", g["name"], json.dumps(g))
    ctx.redis.set("gates:version", version)


def expected(seed, user_id, mix):
    """The spec, computed independently of the learner: sha256(seed:user)[:8] % 10000, cumulative edges."""
    b = int(hashlib.sha256(f"{seed}:{user_id}".encode()).hexdigest()[:8], 16) % 10000
    edge = 0
    for share in mix:
        edge += share["pct"] * 100
        if b < edge:
            return share["variant"]
    return mix[-1]["variant"]


def counting(ctx):
    """Every command any client in the runtime sends, by name — the learner's clients share ctx.redis's class."""
    calls = []
    cls = ctx.redis.__class__
    real = cls.execute_command

    def record(self, *args, **kw):
        calls.append(str(args[0]).upper())
        return real(self, *args, **kw)

    cls.execute_command = record
    return calls, lambda: setattr(cls, "execute_command", real)


async def start(ctx, gates, version):
    """Gates published, the learner's server up, and step 2's snapshot loaded once — the loader's first poll."""
    publish(ctx, gates, version)
    m = ctx.load("gate_service")
    asyncio.create_task(m.serve())
    await asyncio.sleep(0)
    assert ctx.grpc.find("/gates.Gates/GetVariants") is not None, "serve() registered no Gates.GetVariants handler"
    g = sys.modules.get("gates")
    assert g is not None, "gate_service must import step 2's gates module: the snapshot and get_variant live there"
    g.refresh()
    return m, g, gates_pb2_grpc.GatesStub(grpc.aio.insecure_channel("gates:9000"))


def req(user_id="ana", attrs=None, features=()):
    return gates_pb2.GetVariantsRequest(user_id=user_id, attrs=attrs or {}, features=list(features))


async def check_batch(ctx):
    gates = [
        gate("button_color", [{"match": {"locale": "de"}, "mix": MIX}, {"match": {}, "mix": [{"variant": "BLUE_BUTTON", "pct": 100}]}]),
        gate("dark_mode", [{"match": {"platform": "mac"}, "mix": [{"variant": "ON", "pct": 100}]}]),
        gate("new_sidebar", [{"match": {}, "mix": HALF}]),
    ]
    m, g, stub = await start(ctx, gates, 3)
    reply = await stub.GetVariants(req("ana", {"locale": "de", "platform": "mac"}, ["button_color", "dark_mode"]))
    got = dict(reply.variants)
    want = {"button_color": expected("button_color", "ana", MIX), "dark_mode": "ON"}
    assert got == want, f"GetVariants(ana, locale de + platform mac, [button_color, dark_mode]) answered {got}, expected {want}: one entry per requested feature, each get_variant(feature, attrs + user_id)"
    reply = await stub.GetVariants(req("ana", {"locale": "en", "platform": "windows"}, ["button_color", "dark_mode"]))
    got = dict(reply.variants)
    assert got == {"button_color": "BLUE_BUTTON", "dark_mode": "OFF"}, f"the attrs the client sent decide the population: an English Windows user gets BLUE_BUTTON (the catch-all) and dark_mode OFF (no population matches, so the default), got {got}"
    for u in [f"u{i}" for i in range(30)]:
        reply = await stub.GetVariants(req(u, {"locale": "de"}, ["button_color", "new_sidebar"]))
        want = {"button_color": expected("button_color", u, MIX), "new_sidebar": expected("new_sidebar", u, HALF)}
        assert dict(reply.variants) == want, f"user {u} was answered {dict(reply.variants)}, expected {want}: user_id must reach get_variant as attrs['user_id'] — it is what the hash is over"


async def check_unknown_off(ctx):
    m, g, stub = await start(ctx, [gate("button_color", [{"match": {}, "mix": MIX}])], 1)
    try:
        reply = await stub.GetVariants(req("ana", {}, ["button_color", "new_sidebar"]))
    except grpc.RpcError as e:
        raise AssertionError(f"asking about new_sidebar, a gate the snapshot does not know, failed with {e.code()}: an unknown gate answers OFF and the call succeeds — the build must still start")
    got = dict(reply.variants)
    assert got.get("new_sidebar") == "OFF", f"new_sidebar is not published: it must appear in variants as OFF, the reply was {got}"
    assert got.get("button_color") == expected("button_color", "ana", MIX), f"the known gate in the same request must still be evaluated, the reply was {got}"
    reply = await stub.GetVariants(req("ana", {}, ["ghost_a", "ghost_b"]))
    assert dict(reply.variants) == {"ghost_a": "OFF", "ghost_b": "OFF"}, f"a build asking only about gates that are not published yet gets OFF for each, got {dict(reply.variants)}"


async def check_invalid_argument(ctx):
    m, g, stub = await start(ctx, [gate("button_color", [{"match": {}, "mix": MIX}])], 1)
    for features in (["button_color"], []):
        try:
            reply = await stub.GetVariants(req("", {"locale": "de"}, features))
        except grpc.RpcError as e:
            assert e.code() == grpc.StatusCode.INVALID_ARGUMENT, f"an empty user_id must fail with INVALID_ARGUMENT, got {e.code()}"
            assert "user_id" in e.details(), f"the status message should name the field, it says {e.details()!r}"
        else:
            raise AssertionError(f"a request without user_id (features={features}) was answered {dict(reply.variants)} instead of failing with INVALID_ARGUMENT: there is nothing to hash")
    reply = await stub.GetVariants(req("ana", {}, ["button_color"]))
    assert dict(reply.variants) == {"button_color": expected("button_color", "ana", MIX)}, "a valid request after the rejected one must be answered as usual"


async def check_snapshot_served(ctx):
    gates = [gate("button_color", [{"match": {}, "mix": MIX}]), gate("dark_mode", everyone("ON"))]
    m, g, stub = await start(ctx, gates, 7)
    calls, restore = counting(ctx)
    try:
        for i in range(50):
            reply = await stub.GetVariants(req(f"u{i}", {"locale": "de"}, ["button_color", "dark_mode"]))
            assert reply.version == 7, f"version must be the snapshot's (7), the reply says {reply.version}"
        assert calls == [], f"50 GetVariants calls must not touch Redis: they sent {len(calls)} commands ({sorted(set(calls))}); the handler is a batch of pure decisions over the snapshot"
    finally:
        restore()
    reply = await stub.GetVariants(req("ana", {}, []))
    assert set(reply.variants) == {"button_color", "dark_mode"}, f"an empty features list asks for every gate in the snapshot: expected button_color and dark_mode, got {sorted(reply.variants)}"
    assert reply.variants["dark_mode"] == "ON", f"dark_mode is ON for everyone in this snapshot, the reply says {reply.variants['dark_mode']}"
    publish(ctx, [gate("dark_mode", everyone("OFF"), version=2), gate("new_sidebar", everyone("ON"))], 8)
    reply = await stub.GetVariants(req("ana", {}, []))
    assert reply.version == 7 and "new_sidebar" not in reply.variants, f"a publish the loader has not picked up is not visible yet: the handler serves the snapshot it has and never reloads per call, but the reply was version {reply.version} with {sorted(reply.variants)}"
    assert g.refresh() is True
    reply = await stub.GetVariants(req("ana", {}, []))
    assert reply.version == 8, f"after the loader refreshed, the reply must carry the new version (8), it says {reply.version}"
    want = {"button_color": expected("button_color", "ana", MIX), "dark_mode": "OFF", "new_sidebar": "ON"}
    assert dict(reply.variants) == want, f"after the refresh the reply must come from the new snapshot: expected {want}, got {dict(reply.variants)}"
`,
    typescript: `import {createHash} from 'node:crypto';
import {credentials, status} from '@grpc/grpc-js';

const MIX = [
  {variant: 'RED_BUTTON', pct: 33},
  {variant: 'BLUE_BUTTON', pct: 33},
  {variant: 'CONTROL', pct: 34},
];
const HALF = [
  {variant: 'ON', pct: 50},
  {variant: 'OFF', pct: 50},
];

type Share = {variant: string; pct: number};
type Population = {match: Record<string, string>; mix: Share[]};
type GateJson = {name: string; seed: string; default: string; populations: Population[]; overrides: unknown[]; version: number};

function gate(
  name: string,
  populations: Population[],
  options: {seed?: string; default?: string; overrides?: unknown[]; version?: number} = {},
): GateJson {
  return {
    name,
    seed: options.seed ?? name,
    default: options.default ?? 'OFF',
    populations,
    overrides: options.overrides ?? [],
    version: options.version ?? 1,
  };
}

const everyone = (variant: string): Population[] => [{match: {}, mix: [{variant, pct: 100}]}];

/** What step 1 leaves behind: one field per gate in the hash, and the global version. */
function publish(ctx, gates: GateJson[], version: number) {
  for (const g of gates) ctx.redis.hset('gates', g.name, JSON.stringify(g));
  ctx.redis.set('gates:version', version);
}

/** The spec, computed independently of the learner: sha256(seed:user)[:8] % 10000, cumulative edges. */
function expected(seed: string, userId: string, mix: Share[]): string {
  const b = parseInt(createHash('sha256').update(\`\${seed}:\${userId}\`).digest('hex').slice(0, 8), 16) % 10000;
  let edge = 0;
  for (const share of mix) {
    edge += share.pct * 100;
    if (b < edge) return share.variant;
  }
  return mix[mix.length - 1].variant;
}

interface Reply {
  variants: Record<string, string>;
  version: string;
}

/** Gates published, the learner's server up, and step 2's snapshot loaded once — the loader's first poll. */
async function start(ctx, gates: GateJson[], version: number) {
  publish(ctx, gates, version);
  const m = ctx.load('gate_service');
  m.serve();
  const g = ctx.load('gates');
  await g.refresh();
  const stub = new (ctx.proto('gates.proto').gates.Gates)('gates:9000', credentials.createInsecure());
  return {m, g, stub};
}

function req(user_id = 'ana', attrs: Record<string, string> = {}, features: string[] = []) {
  return {user_id, attrs, features};
}

const sorted = (reply: Reply) => Object.keys(reply.variants).sort();

export async function check_batch(ctx) {
  const gates = [
    gate('button_color', [{match: {locale: 'de'}, mix: MIX}, {match: {}, mix: [{variant: 'BLUE_BUTTON', pct: 100}]}]),
    gate('dark_mode', [{match: {platform: 'mac'}, mix: [{variant: 'ON', pct: 100}]}]),
    gate('new_sidebar', [{match: {}, mix: HALF}]),
  ];
  const {stub} = await start(ctx, gates, 3);
  let reply: Reply = await stub.GetVariants(req('ana', {locale: 'de', platform: 'mac'}, ['button_color', 'dark_mode']));
  let want: Record<string, string> = {button_color: expected('button_color', 'ana', MIX), dark_mode: 'ON'};
  assert.deepEqual(reply.variants, want, \`GetVariants(ana, locale de + platform mac, [button_color, dark_mode]) answered \${JSON.stringify(reply.variants)}, expected \${JSON.stringify(want)}: one entry per requested feature, each getVariant(feature, attrs + user_id)\`);
  reply = await stub.GetVariants(req('ana', {locale: 'en', platform: 'windows'}, ['button_color', 'dark_mode']));
  assert.deepEqual(reply.variants, {button_color: 'BLUE_BUTTON', dark_mode: 'OFF'}, \`the attrs the client sent decide the population: an English Windows user gets BLUE_BUTTON (the catch-all) and dark_mode OFF (no population matches, so the default), got \${JSON.stringify(reply.variants)}\`);
  for (let i = 0; i < 30; i++) {
    const u = \`u\${i}\`;
    reply = await stub.GetVariants(req(u, {locale: 'de'}, ['button_color', 'new_sidebar']));
    want = {button_color: expected('button_color', u, MIX), new_sidebar: expected('new_sidebar', u, HALF)};
    assert.deepEqual(reply.variants, want, \`user \${u} was answered \${JSON.stringify(reply.variants)}, expected \${JSON.stringify(want)}: user_id must reach getVariant as attrs.user_id — it is what the hash is over\`);
  }
}

export async function check_unknown_off(ctx) {
  const {stub} = await start(ctx, [gate('button_color', [{match: {}, mix: MIX}])], 1);
  let reply: Reply;
  try {
    reply = await stub.GetVariants(req('ana', {}, ['button_color', 'new_sidebar']));
  } catch (e) {
    assert.fail(\`asking about new_sidebar, a gate the snapshot does not know, failed with \${(e as {code?: number}).code} (\${(e as Error).message}): an unknown gate answers OFF and the call succeeds — the build must still start\`);
  }
  assert.equal(reply.variants.new_sidebar, 'OFF', \`new_sidebar is not published: it must appear in variants as OFF, the reply was \${JSON.stringify(reply.variants)}\`);
  assert.equal(reply.variants.button_color, expected('button_color', 'ana', MIX), \`the known gate in the same request must still be evaluated, the reply was \${JSON.stringify(reply.variants)}\`);
  reply = await stub.GetVariants(req('ana', {}, ['ghost_a', 'ghost_b']));
  assert.deepEqual(reply.variants, {ghost_a: 'OFF', ghost_b: 'OFF'}, \`a build asking only about gates that are not published yet gets OFF for each, got \${JSON.stringify(reply.variants)}\`);
}

export async function check_invalid_argument(ctx) {
  const {stub} = await start(ctx, [gate('button_color', [{match: {}, mix: MIX}])], 1);
  for (const features of [['button_color'], []]) {
    let reply: Reply | undefined;
    try {
      reply = await stub.GetVariants(req('', {locale: 'de'}, features));
    } catch (e) {
      const {code, details} = e as {code?: number; details?: string};
      assert.equal(code, status.INVALID_ARGUMENT, \`an empty user_id must fail with INVALID_ARGUMENT, got code \${code}\`);
      assert.match(details ?? '', /user_id/, \`the status message should name the field, it says \${JSON.stringify(details)}\`);
    }
    assert(reply === undefined, \`a request without user_id (features=\${JSON.stringify(features)}) was answered \${JSON.stringify(reply?.variants)} instead of failing with INVALID_ARGUMENT: there is nothing to hash\`);
  }
  const reply: Reply = await stub.GetVariants(req('ana', {}, ['button_color']));
  assert.deepEqual(reply.variants, {button_color: expected('button_color', 'ana', MIX)}, 'a valid request after the rejected one must be answered as usual');
}

export async function check_snapshot_served(ctx) {
  const gates = [gate('button_color', [{match: {}, mix: MIX}]), gate('dark_mode', everyone('ON'))];
  const {g, stub} = await start(ctx, gates, 7);
  const before = ctx.redisRoundTrips().length;
  let reply: Reply;
  for (let i = 0; i < 50; i++) {
    reply = await stub.GetVariants(req(\`u\${i}\`, {locale: 'de'}, ['button_color', 'dark_mode']));
    assert.equal(Number(reply.version), 7, \`version must be the snapshot's (7), the reply says \${reply.version}\`);
  }
  const sent = ctx.redisRoundTrips().slice(before).flat();
  assert.equal(sent.length, 0, \`50 GetVariants calls must not touch Redis: they sent \${sent.length} commands (\${JSON.stringify([...new Set(sent)])}); the handler is a batch of pure decisions over the snapshot\`);
  reply = await stub.GetVariants(req('ana', {}, []));
  assert.deepEqual(sorted(reply), ['button_color', 'dark_mode'], \`an empty features list asks for every gate in the snapshot: expected button_color and dark_mode, got \${JSON.stringify(sorted(reply))}\`);
  assert.equal(reply.variants.dark_mode, 'ON', \`dark_mode is ON for everyone in this snapshot, the reply says \${reply.variants.dark_mode}\`);
  publish(ctx, [gate('dark_mode', everyone('OFF'), {version: 2}), gate('new_sidebar', everyone('ON'))], 8);
  reply = await stub.GetVariants(req('ana', {}, []));
  assert(Number(reply.version) === 7 && !('new_sidebar' in reply.variants), \`a publish the loader has not picked up is not visible yet: the handler serves the snapshot it has and never reloads per call, but the reply was version \${reply.version} with \${JSON.stringify(sorted(reply))}\`);
  assert.equal(await g.refresh(), true);
  reply = await stub.GetVariants(req('ana', {}, []));
  assert.equal(Number(reply.version), 8, \`after the loader refreshed, the reply must carry the new version (8), it says \${reply.version}\`);
  const want = {button_color: expected('button_color', 'ana', MIX), dark_mode: 'OFF', new_sidebar: 'ON'};
  assert.deepEqual(reply.variants, want, \`after the refresh the reply must come from the new snapshot: expected \${JSON.stringify(want)}, got \${JSON.stringify(reply.variants)}\`);
}
`,
  },
  debrief: `The batch endpoint is the client-side twin of the snapshot: the web servers hold all gates in memory, the clients hold all *variants* in memory, and both pay for configuration once per load rather than once per decision. Two details carry most of the value. Answering OFF for an unknown gate decouples client releases from gate publishing — the app ships with the check already in the code, and the gate is created later. Returning the snapshot version lets a client (and a support engineer reading its logs) say which edit produced the behaviour it shows, the same reason the exposure events of step 4 carry it.`,
};
