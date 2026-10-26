import type {Step} from '@/lib/types';

export const countServiceStep: Step = {
  id: 'count-service',
  title: 'CounterService.GetCount over gRPC, from a 2-second cache',
  concept: 'grpc',
  file: 'count_service',
  focus: ['internal', 'svc', 'redis'],
  task: `## Task

The rest of the company does not call the HTTPS API; it calls the counter service over gRPC.
Implement the **server** side of:

\`\`\`proto
service CounterService {
  rpc GetCount(GetCountRequest) returns (GetCountReply);
}
message GetCountRequest { string namespace = 1; string name = 2; }
message GetCountReply   { int64 count = 1; int64 as_of = 2; }
\`\`\`

\`NAMESPACES\` and \`NAME_RE\` are the ones from step 1; \`get_best_effort\` (step 2's read) and
\`get_rolled_up\` (step 4's sum over the buckets) are the functions those steps built, available to this file.

- An unknown namespace ends the call with **\`NOT_FOUND\`**, a name that does not match \`NAME_RE\` with
  **\`INVALID_ARGUMENT\`** — the gRPC spellings of the API's 404 and 400.
- A best-effort namespace answers straight from \`get_best_effort\`, with \`as_of\` = now.
- An eventually-consistent namespace is read **cache-aside** through \`total:{ns}:{name}\`: on a hit
  return the cached \`count\` and \`as_of\`; on a miss call \`get_rolled_up\`, \`SET\` the pair as JSON with
  **\`EX 2\`** (\`CACHE_TTL_S\`), and return it. Summing a hash on every read of a hot counter would make
  Redis the bottleneck; two seconds of staleness on a number that is already eventually consistent
  costs nothing.
- \`as_of\` is the Unix second the count was computed — the cached one on a hit, not the current time.
  It is how a caller tells a fresh number from a cached one.

:::widget grpc-streams {"mode": "unary"}

:::widget cache-aside {}`,
  sequence: {
    participants: ['Other service', 'CounterService', 'Redis'],
    messages: [
      {from: 'Other service', to: 'CounterService', label: 'GetCount(plays, stranger-things)', kind: 'sync'},
      {from: 'CounterService', to: 'Redis', label: 'GET total:plays:stranger-things', kind: 'sync'},
      {from: 'Redis', to: 'CounterService', label: '(nil)', kind: 'reply'},
      {from: 'CounterService', to: 'Redis', label: 'HVALS rollup:plays:stranger-things → sum 1207', kind: 'sync'},
      {
        from: 'CounterService',
        to: 'Redis',
        label: 'SET total:plays:stranger-things {count: 1207, as_of: 1760616030} EX 2',
        kind: 'sync',
      },
      {
        from: 'CounterService',
        to: 'Other service',
        label: 'GetCountReply{count 1207, as_of 1760616030}',
        kind: 'reply',
      },
      {
        from: 'Other service',
        to: 'CounterService',
        label: 'GetCount(plays, stranger-things) · 1 s later',
        kind: 'sync',
      },
      {from: 'CounterService', to: 'Redis', label: 'GET total:plays:stranger-things → hit', kind: 'sync'},
      {
        from: 'CounterService',
        to: 'Other service',
        label: 'GetCountReply{count 1207, as_of 1760616030}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'The two validations map one-to-one onto the API’s: `NAMESPACES.get` is None → `context.abort(NOT_FOUND, …)`; `NAME_RE.fullmatch` fails → `context.abort(INVALID_ARGUMENT, …)`. Abort before touching Redis.',
    'Keep the cache logic in one helper that returns `(count, as_of)`: `GET` the key, parse the JSON on a hit; on a miss compute both, `SET … ex=CACHE_TTL_S`, return them. The servicer only builds the reply.',
    'Only the eventually-consistent branch goes through the cache; a best-effort counter is already one `GET` away and caching it would just add staleness.',
  ],
  checks: [
    {
      id: 'not-found',
      title: 'Aborts with NOT_FOUND for an unknown namespace',
      detail: 'Look the namespace up in `NAMESPACES` and end the call with `NOT_FOUND` when it is not configured.',
      match: {
        python: {all: [/NAMESPACES\.get\(|in NAMESPACES/, /StatusCode\.NOT_FOUND/]},
        typescript: {all: [/NAMESPACES\[/, /status\.NOT_FOUND/]},
        go: {all: [/namespaces\[/, /codes\.NotFound/]},
        scala: {all: [/Namespaces\.get\(|Namespaces\.contains\(/, /Status\.NOT_FOUND/]},
        cpp: {all: [/kNamespaces\.find\(|kNamespaces\.count\(/, /StatusCode::NOT_FOUND/]},
      },
    },
    {
      id: 'invalid-argument',
      title: 'Aborts with INVALID_ARGUMENT for a bad counter name',
      detail:
        'A name that does not match `NAME_RE` ends the call with `INVALID_ARGUMENT`; no store is consulted for it.',
      match: {
        python: {all: [/NAME_RE\.(fullmatch|match)\(/, /StatusCode\.INVALID_ARGUMENT/]},
        typescript: {all: [/NAME_RE\.test\(/, /status\.INVALID_ARGUMENT/]},
        go: {all: [/nameRe\.MatchString\(/, /codes\.InvalidArgument/]},
        scala: {all: [/NameRe\.(matches|findFirstIn|unapplySeq)\(|matches\(\s*NameRe/, /Status\.INVALID_ARGUMENT/]},
        cpp: {all: [/std::regex_match\([^\n]*kNameRe/, /StatusCode::INVALID_ARGUMENT/]},
      },
    },
    {
      id: 'cache-key-ttl',
      title: 'Caches the rolled-up total under total:{ns}:{name} for 2 s',
      detail: 'The computed `{count, as_of}` is stored as JSON under `total:{ns}:{name}` with `EX CACHE_TTL_S` (2 s).',
      match: {
        python: {all: [/f["']total:\{ns\}:\{name\}["']/, /\.set\([^\n]*ex\s*=\s*CACHE_TTL_S/, /json\.dumps\(/]},
        typescript: {
          all: [/`total:\$\{ns\}:\$\{name\}`/, /\.set\([^\n]*['"]EX['"]\s*,\s*CACHE_TTL_S/, /JSON\.stringify\(/],
        },
        go: {
          all: [
            /"total:"\s*\+\s*ns\s*\+\s*":"\s*\+\s*name|"total:%s:%s"/,
            /rdb\.Set\([^\n]*,\s*cacheTTL\s*\)/,
            /json\.Marshal\(/,
          ],
        },
        scala: {
          all: [
            /s"total:\$ns:\$name"|s"total:\$\{ns\}:\$\{name\}"/,
            /jedis\.setex\([^\n]*CacheTtlSeconds/,
            /compactPrint/,
          ],
        },
        cpp: {all: [/"total:"\s*\+\s*ns\s*\+\s*":"\s*\+\s*name/, /redis\.set\([^\n]*kCacheTtl\s*\)/, /\.dump\(\)/]},
      },
    },
    {
      id: 'cache-aside',
      title: 'Reads the cache first and only sums the buckets on a miss',
      detail:
        'Cache-aside: `GET` first; `get_rolled_up` runs only when the key is missing, and its result is what gets cached.',
      match: {
        python: {order: [/\br\.get\(/, /(?<!def )get_rolled_up\(/, /\br\.set\(/]},
        typescript: {order: [/\bredis\.get\(/, /(?<!as )getRolledUp\(/, /\bredis\.set\(/]},
        go: {order: [/rdb\.Get\(/, /(?<!func )getRolledUp\(/, /rdb\.Set\(/]},
        scala: {order: [/jedis\.get\(/, /(?<!def )getRolledUp\(/, /jedis\.setex\(/]},
        cpp: {order: [/redis\.get\(/, /(?<!long )get_rolled_up\(/, /redis\.set\(/]},
      },
    },
    {
      id: 'reply',
      title: 'Answers count and as_of, best-effort straight from the counter',
      detail:
        'The reply carries `count` and `as_of`; a best-effort namespace reads `get_best_effort` with `as_of` = now, an eventually-consistent one returns the cached pair.',
      match: {
        python: {all: [/GetCountReply\(\s*count\s*=/, /as_of\s*=/, /(?<!def )get_best_effort\(/]},
        typescript: {all: [/count:/, /as_of:/, /(?<!as )getBestEffort\(/]},
        go: {all: [/&pb\.GetCountReply\{\s*Count:/, /AsOf:/, /(?<!func )getBestEffort\(/]},
        scala: {all: [/GetCountReply\(\s*count\s*=/, /asOf\s*=/, /(?<!def )getBestEffort\(/]},
        cpp: {all: [/reply->set_count\(/, /reply->set_as_of\(/, /(?<!long )get_best_effort\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import re
import time
from concurrent import futures

import grpc
import redis

import counters_pb2
import counters_pb2_grpc
from best_effort import get_count as get_best_effort  # built in step 2: the cached counter, 0 when missing
from rollup import get_count as get_rolled_up  # built in step 4: the sum over the minute buckets

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# The namespaces of step 1 (provided).
NAMESPACES = {
    "views": "best_effort",
    "plays": "eventually_consistent",
}
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
CACHE_TTL_S = 2


def cached_total(ns: str, name: str) -> tuple[int, int]:
    """(count, as_of) for an eventually-consistent counter, cache-aside through total:{ns}:{name}."""
    # TODO: GET total:{ns}:{name}; a hit is the cached (count, as_of)
    # TODO: miss → get_rolled_up, as_of = now; SET the pair as JSON with ex=CACHE_TTL_S; return it
    raise NotImplementedError


class CounterService(counters_pb2_grpc.CounterServiceServicer):
    def GetCount(self, request, context: grpc.ServicerContext):
        # TODO: unknown namespace → abort NOT_FOUND; name not matching NAME_RE → abort INVALID_ARGUMENT
        # TODO: best_effort → GetCountReply(count=get_best_effort(...), as_of=now)
        # TODO: eventually_consistent → GetCountReply from cached_total
        context.abort(grpc.StatusCode.UNIMPLEMENTED, "not implemented")


def serve() -> None:
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=16))
    counters_pb2_grpc.add_CounterServiceServicer_to_server(CounterService(), server)
    server.add_insecure_port("[::]:9000")
    server.start()
    server.wait_for_termination()


if __name__ == "__main__":
    serve()
`,
      solution: `import json
import re
import time
from concurrent import futures

import grpc
import redis

import counters_pb2
import counters_pb2_grpc
from best_effort import get_count as get_best_effort  # built in step 2: the cached counter, 0 when missing
from rollup import get_count as get_rolled_up  # built in step 4: the sum over the minute buckets

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# The namespaces of step 1 (provided).
NAMESPACES = {
    "views": "best_effort",
    "plays": "eventually_consistent",
}
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
CACHE_TTL_S = 2


def cached_total(ns: str, name: str) -> tuple[int, int]:
    """(count, as_of) for an eventually-consistent counter, cache-aside through total:{ns}:{name}."""
    key = f"total:{ns}:{name}"
    cached = r.get(key)
    if cached is not None:
        doc = json.loads(cached)
        return int(doc["count"]), int(doc["as_of"])
    count, as_of = get_rolled_up(ns, name), int(time.time())
    r.set(key, json.dumps({"count": count, "as_of": as_of}), ex=CACHE_TTL_S)
    return count, as_of


class CounterService(counters_pb2_grpc.CounterServiceServicer):
    def GetCount(self, request, context: grpc.ServicerContext):
        kind = NAMESPACES.get(request.namespace)
        if kind is None:
            context.abort(grpc.StatusCode.NOT_FOUND, f"unknown namespace {request.namespace!r}")
        if not NAME_RE.fullmatch(request.name):
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "name must match [A-Za-z0-9_-]{1,64}")
        if kind == "best_effort":
            return counters_pb2.GetCountReply(count=get_best_effort(request.namespace, request.name), as_of=int(time.time()))
        count, as_of = cached_total(request.namespace, request.name)
        return counters_pb2.GetCountReply(count=count, as_of=as_of)


def serve() -> None:
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=16))
    counters_pb2_grpc.add_CounterServiceServicer_to_server(CounterService(), server)
    server.add_insecure_port("[::]:9000")
    server.start()
    server.wait_for_termination()


if __name__ == "__main__":
    serve()
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {getCount as getBestEffort} from './best_effort'; // built in step 2: the cached counter, 0 when missing
import {getCount as getRolledUp} from './rollup'; // built in step 4: the sum over the minute buckets

const redis = new Redis({host: 'redis', port: 6379});

// The namespaces of step 1 (provided).
export const NAMESPACES: Record<string, 'best_effort' | 'eventually_consistent'> = {
  views: 'best_effort',
  plays: 'eventually_consistent',
};
export const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const CACHE_TTL_S = 2;

interface GetCountRequest {
  namespace: string;
  name: string;
}

interface GetCountReply {
  count: number;
  as_of: number;
}

/** [count, as_of] for an eventually-consistent counter, cache-aside through total:{ns}:{name}. */
export async function cachedTotal(ns: string, name: string): Promise<[number, number]> {
  // TODO: GET total:{ns}:{name}; a hit is the cached [count, as_of]
  // TODO: miss → getRolledUp, as_of = now; SET the pair as JSON with EX CACHE_TTL_S; return it
  throw new Error('not implemented');
}

const counters = grpc.loadPackageDefinition(protoLoader.loadSync('counters.proto', {keepCase: true})).counters as grpc.GrpcObject;
const CounterService = counters.CounterService as grpc.ServiceClientConstructor;

export const server = new grpc.Server();
server.addService(CounterService.service, {
  GetCount: async (
    call: grpc.ServerUnaryCall<GetCountRequest, GetCountReply>,
    callback: grpc.sendUnaryData<GetCountReply>,
  ): Promise<void> => {
    // TODO: unknown namespace → NOT_FOUND; name not matching NAME_RE → INVALID_ARGUMENT
    // TODO: best_effort → {count: await getBestEffort(...), as_of: now}
    // TODO: eventually_consistent → {count, as_of} from cachedTotal
    callback({code: grpc.status.UNIMPLEMENTED, details: 'not implemented'});
  },
});
server.bindAsync('0.0.0.0:9000', grpc.ServerCredentials.createInsecure(), () => server.start());
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {getCount as getBestEffort} from './best_effort'; // built in step 2: the cached counter, 0 when missing
import {getCount as getRolledUp} from './rollup'; // built in step 4: the sum over the minute buckets

const redis = new Redis({host: 'redis', port: 6379});

// The namespaces of step 1 (provided).
export const NAMESPACES: Record<string, 'best_effort' | 'eventually_consistent'> = {
  views: 'best_effort',
  plays: 'eventually_consistent',
};
export const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const CACHE_TTL_S = 2;

interface GetCountRequest {
  namespace: string;
  name: string;
}

interface GetCountReply {
  count: number;
  as_of: number;
}

/** [count, as_of] for an eventually-consistent counter, cache-aside through total:{ns}:{name}. */
export async function cachedTotal(ns: string, name: string): Promise<[number, number]> {
  const key = \`total:\${ns}:\${name}\`;
  const cached = await redis.get(key);
  if (cached !== null) {
    const doc = JSON.parse(cached) as GetCountReply;
    return [Number(doc.count), Number(doc.as_of)];
  }
  const count = await getRolledUp(ns, name);
  const asOf = Math.floor(Date.now() / 1000);
  await redis.set(key, JSON.stringify({count, as_of: asOf}), 'EX', CACHE_TTL_S);
  return [count, asOf];
}

const counters = grpc.loadPackageDefinition(protoLoader.loadSync('counters.proto', {keepCase: true})).counters as grpc.GrpcObject;
const CounterService = counters.CounterService as grpc.ServiceClientConstructor;

export const server = new grpc.Server();
server.addService(CounterService.service, {
  GetCount: async (
    call: grpc.ServerUnaryCall<GetCountRequest, GetCountReply>,
    callback: grpc.sendUnaryData<GetCountReply>,
  ): Promise<void> => {
    const {namespace, name} = call.request;
    const kind = NAMESPACES[namespace];
    if (kind === undefined) {
      callback({code: grpc.status.NOT_FOUND, details: \`unknown namespace \${JSON.stringify(namespace)}\`});
      return;
    }
    if (!NAME_RE.test(name)) {
      callback({code: grpc.status.INVALID_ARGUMENT, details: 'name must match [A-Za-z0-9_-]{1,64}'});
      return;
    }
    if (kind === 'best_effort') {
      callback(null, {count: await getBestEffort(namespace, name), as_of: Math.floor(Date.now() / 1000)});
      return;
    }
    const [count, asOf] = await cachedTotal(namespace, name);
    callback(null, {count, as_of: asOf});
  },
});
server.bindAsync('0.0.0.0:9000', grpc.ServerCredentials.createInsecure(), () => server.start());
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"regexp"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "counters/gen/counters"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// The namespaces of step 1 (provided).
var namespaces = map[string]string{
	"views": "best_effort",
	"plays": "eventually_consistent",
}

var nameRe = regexp.MustCompile(\`^[A-Za-z0-9_-]{1,64}$\`)

const cacheTTL = 2 * time.Second

// Provided: step 2's getCount and step 4's getCount (the sum over the minute buckets).
var getBestEffort = func(ctx context.Context, ns, name string) (int64, error) { panic("not implemented") }
var getRolledUp = func(ctx context.Context, ns, name string) (int64, error) { panic("not implemented") }

type total struct {
	Count int64 \`json:"count"\`
	AsOf  int64 \`json:"as_of"\`
}

// cachedTotal is (count, as_of) for an eventually-consistent counter, cache-aside through total:{ns}:{name}.
func cachedTotal(ctx context.Context, ns, name string) (total, error) {
	// TODO: Get total:{ns}:{name}; a hit is the cached total
	// TODO: redis.Nil → getRolledUp, AsOf = now; Set the JSON with cacheTTL; return it
	_ = json.Marshal
	return total{}, status.Error(codes.Unimplemented, "not implemented")
}

type counterServer struct {
	pb.UnimplementedCounterServiceServer
}

func (s *counterServer) GetCount(ctx context.Context, req *pb.GetCountRequest) (*pb.GetCountReply, error) {
	// TODO: unknown namespace → codes.NotFound; name not matching nameRe → codes.InvalidArgument
	// TODO: best_effort → &pb.GetCountReply{Count: getBestEffort(...), AsOf: now}
	// TODO: eventually_consistent → the reply from cachedTotal
	return nil, status.Error(codes.Unimplemented, "not implemented")
}

func main() {
	lis, err := net.Listen("tcp", ":9000")
	if err != nil {
		log.Fatal(err)
	}
	srv := grpc.NewServer()
	pb.RegisterCounterServiceServer(srv, &counterServer{})
	log.Fatal(srv.Serve(lis))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"regexp"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "counters/gen/counters"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// The namespaces of step 1 (provided).
var namespaces = map[string]string{
	"views": "best_effort",
	"plays": "eventually_consistent",
}

var nameRe = regexp.MustCompile(\`^[A-Za-z0-9_-]{1,64}$\`)

const cacheTTL = 2 * time.Second

// Provided: step 2's getCount and step 4's getCount (the sum over the minute buckets).
var getBestEffort = func(ctx context.Context, ns, name string) (int64, error) { panic("not implemented") }
var getRolledUp = func(ctx context.Context, ns, name string) (int64, error) { panic("not implemented") }

type total struct {
	Count int64 \`json:"count"\`
	AsOf  int64 \`json:"as_of"\`
}

// cachedTotal is (count, as_of) for an eventually-consistent counter, cache-aside through total:{ns}:{name}.
func cachedTotal(ctx context.Context, ns, name string) (total, error) {
	key := "total:" + ns + ":" + name
	var t total
	cached, err := rdb.Get(ctx, key).Result()
	if err == nil {
		return t, json.Unmarshal([]byte(cached), &t)
	}
	if !errors.Is(err, redis.Nil) {
		return t, err
	}
	count, err := getRolledUp(ctx, ns, name)
	if err != nil {
		return t, err
	}
	t = total{Count: count, AsOf: time.Now().Unix()}
	doc, _ := json.Marshal(t)
	if err := rdb.Set(ctx, key, doc, cacheTTL).Err(); err != nil {
		return t, err
	}
	return t, nil
}

type counterServer struct {
	pb.UnimplementedCounterServiceServer
}

func (s *counterServer) GetCount(ctx context.Context, req *pb.GetCountRequest) (*pb.GetCountReply, error) {
	kind, ok := namespaces[req.GetNamespace()]
	if !ok {
		return nil, status.Errorf(codes.NotFound, "unknown namespace %q", req.GetNamespace())
	}
	if !nameRe.MatchString(req.GetName()) {
		return nil, status.Error(codes.InvalidArgument, "name must match [A-Za-z0-9_-]{1,64}")
	}
	if kind == "best_effort" {
		count, err := getBestEffort(ctx, req.GetNamespace(), req.GetName())
		if err != nil {
			return nil, status.Error(codes.Unavailable, err.Error())
		}
		return &pb.GetCountReply{Count: count, AsOf: time.Now().Unix()}, nil
	}
	t, err := cachedTotal(ctx, req.GetNamespace(), req.GetName())
	if err != nil {
		return nil, status.Error(codes.Unavailable, err.Error())
	}
	return &pb.GetCountReply{Count: t.Count, AsOf: t.AsOf}, nil
}

func main() {
	lis, err := net.Listen("tcp", ":9000")
	if err != nil {
		log.Fatal(err)
	}
	srv := grpc.NewServer()
	pb.RegisterCounterServiceServer(srv, &counterServer{})
	log.Fatal(srv.Serve(lis))
}
`,
    },
    scala: {
      starter: `import counters.counters.{CounterServiceGrpc, GetCountReply, GetCountRequest}
import io.grpc.{ServerBuilder, Status}
import redis.clients.jedis.JedisPooled
import scala.concurrent.{ExecutionContext, Future}
import spray.json._

object CountService extends CounterServiceGrpc.CounterService {
  val jedis = new JedisPooled("redis", 6379)

  /** The namespaces of step 1 (provided). */
  val Namespaces = Map("views" -> "best_effort", "plays" -> "eventually_consistent")
  val NameRe = "^[A-Za-z0-9_-]{1,64}$".r
  val CacheTtlSeconds = 2L

  /** Provided: step 2's getCount and step 4's getCount (the sum over the minute buckets). */
  def getBestEffort(ns: String, name: String): Long = ???
  def getRolledUp(ns: String, name: String): Long = ???

  /** (count, asOf) for an eventually-consistent counter, cache-aside through total:{ns}:{name}. */
  def cachedTotal(ns: String, name: String): (Long, Long) = {
    // TODO: GET total:{ns}:{name}; a hit is the cached (count, asOf)
    // TODO: miss → getRolledUp, asOf = now; SETEX the pair as JSON with CacheTtlSeconds; return it
    ???
  }

  override def getCount(req: GetCountRequest): Future[GetCountReply] = {
    // TODO: unknown namespace → Status.NOT_FOUND; name not matching NameRe → Status.INVALID_ARGUMENT
    // TODO: best_effort → GetCountReply(count = getBestEffort(...), asOf = now)
    // TODO: eventually_consistent → the reply from cachedTotal
    Future.failed(Status.UNIMPLEMENTED.asRuntimeException())
  }

  def main(args: Array[String]): Unit =
    ServerBuilder.forPort(9000).addService(CounterServiceGrpc.bindService(this, ExecutionContext.global)).build().start().awaitTermination()
}
`,
      solution: `import counters.counters.{CounterServiceGrpc, GetCountReply, GetCountRequest}
import io.grpc.{ServerBuilder, Status}
import redis.clients.jedis.JedisPooled
import scala.concurrent.{ExecutionContext, Future}
import spray.json._

object CountService extends CounterServiceGrpc.CounterService {
  val jedis = new JedisPooled("redis", 6379)

  /** The namespaces of step 1 (provided). */
  val Namespaces = Map("views" -> "best_effort", "plays" -> "eventually_consistent")
  val NameRe = "^[A-Za-z0-9_-]{1,64}$".r
  val CacheTtlSeconds = 2L

  /** Provided: step 2's getCount and step 4's getCount (the sum over the minute buckets). */
  def getBestEffort(ns: String, name: String): Long = ???
  def getRolledUp(ns: String, name: String): Long = ???

  /** (count, asOf) for an eventually-consistent counter, cache-aside through total:{ns}:{name}. */
  def cachedTotal(ns: String, name: String): (Long, Long) = {
    val key = s"total:$ns:$name"
    Option(jedis.get(key)) match {
      case Some(cached) =>
        val fields = cached.parseJson.asJsObject.fields
        (fields("count").convertTo[Long], fields("as_of").convertTo[Long])
      case None =>
        val count = getRolledUp(ns, name)
        val asOf = System.currentTimeMillis() / 1000
        jedis.setex(key, CacheTtlSeconds, JsObject("count" -> JsNumber(count), "as_of" -> JsNumber(asOf)).compactPrint)
        (count, asOf)
    }
  }

  override def getCount(req: GetCountRequest): Future[GetCountReply] =
    Namespaces.get(req.namespace) match {
      case None =>
        Future.failed(Status.NOT_FOUND.withDescription(s"unknown namespace \${req.namespace}").asRuntimeException())
      case Some(_) if !NameRe.matches(req.name) =>
        Future.failed(Status.INVALID_ARGUMENT.withDescription("name must match [A-Za-z0-9_-]{1,64}").asRuntimeException())
      case Some("best_effort") =>
        Future.successful(GetCountReply(count = getBestEffort(req.namespace, req.name), asOf = System.currentTimeMillis() / 1000))
      case Some(_) =>
        val (count, asOf) = cachedTotal(req.namespace, req.name)
        Future.successful(GetCountReply(count = count, asOf = asOf))
    }

  def main(args: Array[String]): Unit =
    ServerBuilder.forPort(9000).addService(CounterServiceGrpc.bindService(this, ExecutionContext.global)).build().start().awaitTermination()
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <ctime>
#include <map>
#include <regex>
#include <string>
#include <utility>

#include "counters.grpc.pb.h"

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

// The namespaces of step 1 (provided).
const std::map<std::string, std::string> kNamespaces = {
    {"views", "best_effort"},
    {"plays", "eventually_consistent"},
};
const std::regex kNameRe(R"(^[A-Za-z0-9_-]{1,64}$)");
constexpr std::chrono::seconds kCacheTtl{2};

// Provided: step 2's get_count and step 4's get_count (the sum over the minute buckets).
long long get_best_effort(const std::string& ns, const std::string& name);
long long get_rolled_up(const std::string& ns, const std::string& name);

// (count, as_of) for an eventually-consistent counter, cache-aside through total:{ns}:{name}.
std::pair<long long, long long> cached_total(const std::string& ns, const std::string& name) {
  // TODO: get total:{ns}:{name}; a hit is the cached {count, as_of}
  // TODO: miss → get_rolled_up, as_of = now; set the JSON with kCacheTtl; return it
  return {0, 0};
}

class CounterService final : public counters::CounterService::Service {
 public:
  grpc::Status GetCount(grpc::ServerContext*, const counters::GetCountRequest* req, counters::GetCountReply* reply) override {
    // TODO: unknown namespace → NOT_FOUND; name not matching kNameRe → INVALID_ARGUMENT
    // TODO: best_effort → reply->set_count(get_best_effort(...)), reply->set_as_of(now)
    // TODO: eventually_consistent → the pair from cached_total
    return grpc::Status(grpc::StatusCode::UNIMPLEMENTED, "not implemented");
  }
};

int main() {
  CounterService service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:9000", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <ctime>
#include <map>
#include <regex>
#include <string>
#include <utility>

#include "counters.grpc.pb.h"

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

// The namespaces of step 1 (provided).
const std::map<std::string, std::string> kNamespaces = {
    {"views", "best_effort"},
    {"plays", "eventually_consistent"},
};
const std::regex kNameRe(R"(^[A-Za-z0-9_-]{1,64}$)");
constexpr std::chrono::seconds kCacheTtl{2};

// Provided: step 2's get_count and step 4's get_count (the sum over the minute buckets).
long long get_best_effort(const std::string& ns, const std::string& name);
long long get_rolled_up(const std::string& ns, const std::string& name);

// (count, as_of) for an eventually-consistent counter, cache-aside through total:{ns}:{name}.
std::pair<long long, long long> cached_total(const std::string& ns, const std::string& name) {
  const std::string key = "total:" + ns + ":" + name;
  if (const auto cached = redis.get(key)) {
    const json doc = json::parse(*cached);
    return {doc["count"].get<long long>(), doc["as_of"].get<long long>()};
  }
  const long long count = get_rolled_up(ns, name);
  const long long as_of = static_cast<long long>(std::time(nullptr));
  redis.set(key, json{{"count", count}, {"as_of", as_of}}.dump(), kCacheTtl);
  return {count, as_of};
}

class CounterService final : public counters::CounterService::Service {
 public:
  grpc::Status GetCount(grpc::ServerContext*, const counters::GetCountRequest* req, counters::GetCountReply* reply) override {
    const auto it = kNamespaces.find(req->namespace_());
    if (it == kNamespaces.end()) return grpc::Status(grpc::StatusCode::NOT_FOUND, "unknown namespace " + req->namespace_());
    if (!std::regex_match(req->name(), kNameRe))
      return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "name must match [A-Za-z0-9_-]{1,64}");
    if (it->second == "best_effort") {
      reply->set_count(get_best_effort(req->namespace_(), req->name()));
      reply->set_as_of(static_cast<long long>(std::time(nullptr)));
      return grpc::Status::OK;
    }
    const auto [count, as_of] = cached_total(req->namespace_(), req->name());
    reply->set_count(count);
    reply->set_as_of(as_of);
    return grpc::Status::OK;
  }
};

int main() {
  CounterService service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:9000", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}
`,
    },
  },
  harness: {
    python: `import json
import time

import grpc

import counters_pb2
import counters_pb2_grpc

KEY = "total:plays:stranger-things"


def _service(ctx):
    """The learner's servicer served as CounterService, a client stub on it, and the real steps behind it."""
    m = ctx.load("count_service")
    import best_effort  # step 2: the best-effort counters GetCount reads
    import count_events  # step 3: how eventually-consistent adds become events
    import rollup  # step 4: the worker that folds them into the buckets GetCount sums

    ctx.grpc.serve(counters_pb2_grpc.add_CounterServiceServicer_to_server, m.CounterService())
    stub = counters_pb2_grpc.CounterServiceStub(grpc.insecure_channel("counters:9000"))
    return stub, best_effort, count_events, rollup


def _plays(ctx, count_events, rollup, *adds):
    """Eventually-consistent adds to plays/stranger-things as production makes them: logged, then rolled up."""
    for token, delta in adds:
        count_events.append_event("plays", "stranger-things", delta, token)
    ctx.drain(rollup.run)


def _get(stub, ns, name):
    return stub.GetCount(counters_pb2.GetCountRequest(namespace=ns, name=name), timeout=1.0)


def _fails_with(stub, ns, name, code):
    try:
        reply = _get(stub, ns, name)
    except grpc.RpcError as e:
        assert e.code() == code, f"GetCount({ns!r}, {name!r}) failed with {e.code()}, expected {code}"
        return
    raise AssertionError(f"GetCount({ns!r}, {name!r}) answered {reply.count} instead of failing with {code}")


def check_not_found(ctx):
    stub, best_effort, count_events, rollup = _service(ctx)
    _fails_with(stub, "likes", "stranger-things", grpc.StatusCode.NOT_FOUND)
    _fails_with(stub, "", "stranger-things", grpc.StatusCode.NOT_FOUND)
    assert ctx.redis.keys() == [], f"an unknown namespace must not leave anything in the cache, Redis holds {ctx.redis.keys()}"


def check_invalid_argument(ctx):
    stub, best_effort, count_events, rollup = _service(ctx)
    for bad in ("bad name", "", "a" * 65, "dots.are.out"):
        _fails_with(stub, "plays", bad, grpc.StatusCode.INVALID_ARGUMENT)
        _fails_with(stub, "views", bad, grpc.StatusCode.INVALID_ARGUMENT)
    assert ctx.redis.keys() == [], f"a bad name must be refused before any store is consulted, yet Redis holds {ctx.redis.keys()}"
    _fails_with(stub, "likes", "bad name", grpc.StatusCode.NOT_FOUND)  # the namespace is checked first


def check_cache_key_ttl(ctx):
    stub, best_effort, count_events, rollup = _service(ctx)
    _plays(ctx, count_events, rollup, ("t-1", 1200), ("t-2", 7))
    reply = _get(stub, "plays", "stranger-things")
    assert reply.count == 1207, f"GetCount answered {reply.count}, expected the rolled-up 1207"
    cached = ctx.redis.get(KEY)
    assert cached is not None, f"the total must be cached under {KEY}, keys are {ctx.redis.keys()}"
    doc = json.loads(cached)
    assert doc.get("count") == 1207 and doc.get("as_of") == reply.as_of, f"{KEY} must hold JSON {{count, as_of}} matching the reply, got {cached!r}"
    ttl = ctx.redis.ttl(KEY)
    assert 1 <= ttl <= 2, f"{KEY} expires in {ttl} s, expected CACHE_TTL_S (2)"
    ctx.clock.advance(3)
    assert ctx.redis.exists(KEY) == 0, f"{KEY} must be gone after 2 s"


def check_cache_aside(ctx):
    stub, best_effort, count_events, rollup = _service(ctx)
    _plays(ctx, count_events, rollup, ("t-1", 1200), ("t-2", 7))
    first = _get(stub, "plays", "stranger-things")
    assert first.count == 1207, f"GetCount answered {first.count}, expected the rolled-up 1207"
    _plays(ctx, count_events, rollup, ("t-3", 93))  # the buckets move on to 1300
    ctx.clock.advance(1)
    second = _get(stub, "plays", "stranger-things")
    assert (second.count, second.as_of) == (first.count, first.as_of), f"1 s after the first read the buckets moved to 1300, but a read within CACHE_TTL_S is served from {KEY}: expected the cached pair {(first.count, first.as_of)}, got {(second.count, second.as_of)}"
    ctx.clock.advance(1.5)
    third = _get(stub, "plays", "stranger-things")
    assert third.count == 1300, f"2.5 s after the total was cached the entry has expired and the next read must sum the buckets again: expected the new total 1300, got {third.count}"
    assert third.as_of >= first.as_of + 2, f"as_of must be the time of the recomputation ({first.as_of + 2} or later), got {third.as_of}"


def check_reply(ctx):
    stub, best_effort, count_events, rollup = _service(ctx)
    best_effort.add_count("views", "trailer-7", 42)
    reply = _get(stub, "views", "trailer-7")
    assert reply.count == 42, f"a best-effort namespace answers the counter's 42, got {reply.count}"
    assert abs(reply.as_of - int(time.time())) <= 1, f"a best-effort reply's as_of is now ({int(time.time())}), got {reply.as_of}"
    assert ctx.redis.exists("total:views:trailer-7") == 0, "best-effort counters are not cached: they are already one GET away"
    best_effort.add_count("views", "trailer-7", 8)
    reply = _get(stub, "views", "trailer-7")
    assert reply.count == 50, f"a best-effort read goes straight to the counter: right after another add of 8 GetCount must answer 50, got {reply.count}"
    _plays(ctx, count_events, rollup, ("t-1", 1200), ("t-2", 7))
    reply = _get(stub, "plays", "stranger-things")
    assert reply.count == 1207 and abs(reply.as_of - int(time.time())) <= 1, f"an eventually-consistent reply carries the rolled-up 1207 and a current as_of, got {(reply.count, reply.as_of)}"
`,
    typescript: `const KEY = 'total:plays:stranger-things';

/** The learner's CounterService (its handlers are live once the module loaded), a client on it, and the real steps behind it. */
function service(ctx) {
  ctx.load('count_service');
  const bestEffort = ctx.load('best_effort'); // step 2: the best-effort counters GetCount reads
  const countEvents = ctx.load('count_events'); // step 3: how eventually-consistent adds become events
  const rollup = ctx.load('rollup'); // step 4: the worker that folds them into the buckets GetCount sums
  const stub = new (ctx.proto('counters.proto').counters.CounterService)('counters:9000', null);
  return {stub, bestEffort, countEvents, rollup};
}

/** Eventually-consistent adds to plays/stranger-things as production makes them: logged, then rolled up. */
async function plays(ctx, countEvents, rollup, ...adds: [string, number][]) {
  for (const [token, delta] of adds) await countEvents.appendEvent('plays', 'stranger-things', delta, token);
  await ctx.drain(rollup.run());
}

/** The reply as numbers (int64 crosses the wire as decimal strings). */
async function get(stub, ns, name): Promise<{count: number; as_of: number}> {
  const reply = await stub.GetCount({namespace: ns, name}, {deadline: Date.now() + 1000});
  return {count: Number(reply.count), as_of: Number(reply.as_of)};
}

async function failsWith(ctx, stub, ns, name, code) {
  const nameOf = c => Object.keys(ctx.grpc.status).find(k => ctx.grpc.status[k] === c) ?? String(c);
  let reply;
  try {
    reply = await get(stub, ns, name);
  } catch (e) {
    assert.equal(e.code, code, \`GetCount(\${JSON.stringify(ns)}, \${JSON.stringify(name)}) failed with \${nameOf(e.code)}, expected \${nameOf(code)}\`);
    return;
  }
  assert.fail(\`GetCount(\${JSON.stringify(ns)}, \${JSON.stringify(name)}) answered \${reply.count} instead of failing with \${nameOf(code)}\`);
}

export async function check_not_found(ctx) {
  const {stub} = service(ctx);
  await failsWith(ctx, stub, 'likes', 'stranger-things', ctx.grpc.status.NOT_FOUND);
  await failsWith(ctx, stub, '', 'stranger-things', ctx.grpc.status.NOT_FOUND);
  assert.deepEqual(ctx.redis.keys('*'), [], \`an unknown namespace must not leave anything in the cache, Redis holds \${JSON.stringify(ctx.redis.keys('*'))}\`);
}

export async function check_invalid_argument(ctx) {
  const {stub} = service(ctx);
  for (const bad of ['bad name', '', 'a'.repeat(65), 'dots.are.out']) {
    await failsWith(ctx, stub, 'plays', bad, ctx.grpc.status.INVALID_ARGUMENT);
    await failsWith(ctx, stub, 'views', bad, ctx.grpc.status.INVALID_ARGUMENT);
  }
  assert.deepEqual(ctx.redis.keys('*'), [], \`a bad name must be refused before any store is consulted, yet Redis holds \${JSON.stringify(ctx.redis.keys('*'))}\`);
  await failsWith(ctx, stub, 'likes', 'bad name', ctx.grpc.status.NOT_FOUND); // the namespace is checked first
}

export async function check_cache_key_ttl(ctx) {
  const {stub, countEvents, rollup} = service(ctx);
  await plays(ctx, countEvents, rollup, ['t-1', 1200], ['t-2', 7]);
  const reply = await get(stub, 'plays', 'stranger-things');
  assert.equal(reply.count, 1207, \`GetCount answered \${reply.count}, expected the rolled-up 1207\`);
  const cached = ctx.redis.get(KEY);
  assert(cached !== null, \`the total must be cached under \${KEY}, keys are \${JSON.stringify(ctx.redis.keys('*'))}\`);
  const doc = JSON.parse(cached);
  assert(Number(doc.count) === 1207 && Number(doc.as_of) === reply.as_of, \`\${KEY} must hold JSON {count, as_of} matching the reply, got \${JSON.stringify(cached)}\`);
  const ttl = ctx.redis.ttl(KEY);
  assert(1 <= ttl && ttl <= 2, \`\${KEY} expires in \${ttl} s, expected CACHE_TTL_S (2)\`);
  ctx.clock.advance(3);
  assert.equal(ctx.redis.exists(KEY), 0, \`\${KEY} must be gone after 2 s\`);
}

export async function check_cache_aside(ctx) {
  const {stub, countEvents, rollup} = service(ctx);
  await plays(ctx, countEvents, rollup, ['t-1', 1200], ['t-2', 7]);
  const first = await get(stub, 'plays', 'stranger-things');
  assert.equal(first.count, 1207, \`GetCount answered \${first.count}, expected the rolled-up 1207\`);
  await plays(ctx, countEvents, rollup, ['t-3', 93]); // the buckets move on to 1300
  ctx.clock.advance(1);
  const second = await get(stub, 'plays', 'stranger-things');
  assert.deepEqual([second.count, second.as_of], [first.count, first.as_of], \`1 s after the first read the buckets moved to 1300, but a read within CACHE_TTL_S is served from \${KEY}: expected the cached pair [\${first.count}, \${first.as_of}], got [\${second.count}, \${second.as_of}]\`);
  ctx.clock.advance(1.5);
  const third = await get(stub, 'plays', 'stranger-things');
  assert.equal(third.count, 1300, \`2.5 s after the total was cached the entry has expired and the next read must sum the buckets again: expected the new total 1300, got \${third.count}\`);
  assert(third.as_of >= first.as_of + 2, \`as_of must be the time of the recomputation (\${first.as_of + 2} or later), got \${third.as_of}\`);
}

export async function check_reply(ctx) {
  const {stub, bestEffort, countEvents, rollup} = service(ctx);
  await bestEffort.addCount('views', 'trailer-7', 42);
  let reply = await get(stub, 'views', 'trailer-7');
  assert.equal(reply.count, 42, \`a best-effort namespace answers the counter's 42, got \${reply.count}\`);
  let now = Math.floor(Date.now() / 1000);
  assert(Math.abs(reply.as_of - now) <= 1, \`a best-effort reply's as_of is now (\${now}), got \${reply.as_of}\`);
  assert.equal(ctx.redis.exists('total:views:trailer-7'), 0, 'best-effort counters are not cached: they are already one GET away');
  await bestEffort.addCount('views', 'trailer-7', 8);
  reply = await get(stub, 'views', 'trailer-7');
  assert.equal(reply.count, 50, \`a best-effort read goes straight to the counter: right after another add of 8 GetCount must answer 50, got \${reply.count}\`);
  await plays(ctx, countEvents, rollup, ['t-1', 1200], ['t-2', 7]);
  reply = await get(stub, 'plays', 'stranger-things');
  now = Math.floor(Date.now() / 1000);
  assert(reply.count === 1207 && Math.abs(reply.as_of - now) <= 1, \`an eventually-consistent reply carries the rolled-up 1207 and a current as_of, got [\${reply.count}, \${reply.as_of}]\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"leetbuild/harness"

	pb "counters/gen/counters"
)

const csKey = "total:plays:stranger-things"

// csService runs the learner's CounterService on the real stores of steps 2 and 4 (the best-effort
// counter counter:{ns}:{name}, the minute buckets of rollup:{ns}:{name}) and returns a client on it.
func csService(ctx *harness.Ctx) pb.CounterServiceClient {
	getBestEffort = func(_ context.Context, ns, name string) (int64, error) {
		v, ok := ctx.Redis.Get("counter:" + ns + ":" + name)
		if !ok {
			return 0, nil
		}
		return strconv.ParseInt(v, 10, 64)
	}
	getRolledUp = func(_ context.Context, ns, name string) (int64, error) {
		return csSum(ctx, "rollup:"+ns+":"+name), nil
	}
	ctx.Main(main)
	return pb.NewCounterServiceClient(ctx.GRPC.Dial("counters:9000"))
}

func csSum(ctx *harness.Ctx, key string) int64 {
	var sum int64
	for _, v := range ctx.Redis.HGetAll(key) {
		n, _ := strconv.ParseInt(v, 10, 64)
		sum += n
	}
	return sum
}

// csAddBestEffort is step 2's addCount: SET NX with the hour's TTL, then INCRBY.
func csAddBestEffort(ctx *harness.Ctx, ns, name string, delta int64) {
	key := "counter:" + ns + ":" + name
	ctx.Redis.Set(key, 0, "NX", "EX", 3600)
	ctx.Redis.Do("INCRBY", key, delta)
}

// csPlays makes eventually-consistent adds to plays/stranger-things as production does: each event is
// claimed under seen:{token} and folded into its minute bucket (steps 3 and 4).
func csPlays(ctx *harness.Ctx, adds ...csAdd) {
	bucket := strconv.FormatInt(ctx.Clock.Now()/1000/60*60, 10)
	for _, a := range adds {
		if ctx.Redis.Set("seen:"+a.token, 1, "NX", "EX", 86400) {
			ctx.Redis.Do("HINCRBY", "rollup:plays:stranger-things", bucket, a.delta)
		}
	}
}

type csAdd struct {
	token string
	delta int64
}

func csGet(stub pb.CounterServiceClient, ns, name string) (*pb.GetCountReply, error) {
	callCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	return stub.GetCount(callCtx, &pb.GetCountRequest{Namespace: ns, Name: name})
}

func csMustGet(ctx *harness.Ctx, stub pb.CounterServiceClient, ns, name string) *pb.GetCountReply {
	reply, err := csGet(stub, ns, name)
	ctx.NoError(err, "GetCount(%q, %q) failed", ns, name)
	return reply
}

func csFailsWith(ctx *harness.Ctx, stub pb.CounterServiceClient, ns, name string, code codes.Code) {
	reply, err := csGet(stub, ns, name)
	if err != nil {
		ctx.Equal(status.Code(err).String(), code.String(), "GetCount(%q, %q) failed with the wrong code", ns, name)
		return
	}
	ctx.Fatalf("GetCount(%q, %q) answered %d instead of failing with %s", ns, name, reply.GetCount(), code)
}

func CheckNotFound(ctx *harness.Ctx) {
	stub := csService(ctx)
	csFailsWith(ctx, stub, "likes", "stranger-things", codes.NotFound)
	csFailsWith(ctx, stub, "", "stranger-things", codes.NotFound)
	keys := ctx.Redis.Keys("*")
	ctx.Assert(len(keys) == 0, "an unknown namespace must not leave anything in the cache, Redis holds %q", keys)
}

func CheckInvalidArgument(ctx *harness.Ctx) {
	stub := csService(ctx)
	for _, bad := range []string{"bad name", "", strings.Repeat("a", 65), "dots.are.out"} {
		csFailsWith(ctx, stub, "plays", bad, codes.InvalidArgument)
		csFailsWith(ctx, stub, "views", bad, codes.InvalidArgument)
	}
	keys := ctx.Redis.Keys("*")
	ctx.Assert(len(keys) == 0, "a bad name must be refused before any store is consulted, yet Redis holds %q", keys)
	csFailsWith(ctx, stub, "likes", "bad name", codes.NotFound) // the namespace is checked first
}

func CheckCacheKeyTtl(ctx *harness.Ctx) {
	stub := csService(ctx)
	csPlays(ctx, csAdd{"t-1", 1200}, csAdd{"t-2", 7})
	reply := csMustGet(ctx, stub, "plays", "stranger-things")
	ctx.Equal(reply.GetCount(), 1207, "GetCount must answer the rolled-up total")
	cached, ok := ctx.Redis.Get(csKey)
	ctx.Assert(ok, "the total must be cached under %s, keys are %q", csKey, ctx.Redis.Keys("*"))
	var doc map[string]any
	json.Unmarshal([]byte(cached), &doc)
	ctx.Assert(doc["count"] == 1207.0 && doc["as_of"] == float64(reply.GetAsOf()), "%s must hold JSON {count, as_of} matching the reply, got %s", csKey, cached)
	ttl := ctx.Redis.TTL(csKey)
	ctx.Assert(1 <= ttl && ttl <= 2, "%s expires in %d s, expected cacheTTL (2 s)", csKey, ttl)
	ctx.Clock.Advance(3)
	ctx.Equal(ctx.Redis.Exists(csKey), 0, "%s must be gone after 2 s: EXISTS", csKey)
}

func CheckCacheAside(ctx *harness.Ctx) {
	stub := csService(ctx)
	csPlays(ctx, csAdd{"t-1", 1200}, csAdd{"t-2", 7})
	first := csMustGet(ctx, stub, "plays", "stranger-things")
	ctx.Equal(first.GetCount(), 1207, "GetCount must answer the rolled-up total")
	csPlays(ctx, csAdd{"t-3", 93}) // the buckets move on to 1300
	ctx.Clock.Advance(1)
	second := csMustGet(ctx, stub, "plays", "stranger-things")
	ctx.Equal([]int64{second.GetCount(), second.GetAsOf()}, []int64{first.GetCount(), first.GetAsOf()}, "1 s after the first read the buckets moved to 1300, but a read within cacheTTL is served from %s: [count, as_of]", csKey)
	ctx.Clock.Advance(1.5)
	third := csMustGet(ctx, stub, "plays", "stranger-things")
	ctx.Equal(third.GetCount(), 1300, "2.5 s after the total was cached the entry has expired and the next read must sum the buckets again")
	ctx.Assert(third.GetAsOf() >= first.GetAsOf()+2, "as_of must be the time of the recomputation (%d or later), got %d", first.GetAsOf()+2, third.GetAsOf())
}

func CheckReply(ctx *harness.Ctx) {
	stub := csService(ctx)
	csAddBestEffort(ctx, "views", "trailer-7", 42)
	reply := csMustGet(ctx, stub, "views", "trailer-7")
	ctx.Equal(reply.GetCount(), 42, "a best-effort namespace answers the counter's count")
	now := ctx.Clock.Now() / 1000
	ctx.Assert(reply.GetAsOf()-now <= 1 && now-reply.GetAsOf() <= 1, "a best-effort reply's as_of is now (%d), got %d", now, reply.GetAsOf())
	ctx.Equal(ctx.Redis.Exists("total:views:trailer-7"), 0, "best-effort counters are not cached (they are already one GET away): EXISTS total:views:trailer-7")
	csAddBestEffort(ctx, "views", "trailer-7", 8)
	reply = csMustGet(ctx, stub, "views", "trailer-7")
	ctx.Equal(reply.GetCount(), 50, "a best-effort read goes straight to the counter: right after another add of 8 GetCount must answer 50")
	csPlays(ctx, csAdd{"t-1", 1200}, csAdd{"t-2", 7})
	reply = csMustGet(ctx, stub, "plays", "stranger-things")
	now = ctx.Clock.Now() / 1000
	ctx.Assert(reply.GetCount() == 1207 && reply.GetAsOf()-now <= 1 && now-reply.GetAsOf() <= 1, "an eventually-consistent reply carries the rolled-up 1207 and a current as_of, got [%d, %d]", reply.GetCount(), reply.GetAsOf())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

namespace {

const std::string csKey = "total:plays:stranger-things";

harness::Ctx* csCtx = nullptr;

long long csSum(harness::Ctx& ctx, const std::string& key) {
  long long sum = 0;
  for (const auto& [field, v] : ctx.Redis.HGetAll(key)) sum += std::atoll(v.c_str());
  return sum;
}

// csService runs the learner's CounterService on the real stores of steps 2 and 4 (the best-effort
// counter counter:{ns}:{name}, the minute buckets of rollup:{ns}:{name}) and returns a client on it.
std::unique_ptr<counters::CounterService::Stub> csService(harness::Ctx& ctx) {
  csCtx = &ctx;
  ctx.Main();
  return counters::CounterService::NewStub(ctx.GRPC.Dial("counters:9000"));
}

// csAddBestEffort is step 2's add_count: SET NX with the hour's TTL, then INCRBY.
void csAddBestEffort(harness::Ctx& ctx, const std::string& ns, const std::string& name, long long delta) {
  const std::string key = "counter:" + ns + ":" + name;
  ctx.Redis.Set(key, 0, "NX", "EX", 3600);
  ctx.Redis.Do("INCRBY", key, delta);
}

struct csAdd {
  std::string token;
  long long delta;
};

// csPlays makes eventually-consistent adds to plays/stranger-things as production does: each event is
// claimed under seen:{token} and folded into its minute bucket (steps 3 and 4).
void csPlays(harness::Ctx& ctx, const std::vector<csAdd>& adds) {
  const std::string bucket = std::to_string(ctx.Clock.Now() / 1000 / 60 * 60);
  for (const auto& a : adds) {
    if (ctx.Redis.Set("seen:" + a.token, 1, "NX", "EX", 86400)) ctx.Redis.Do("HINCRBY", "rollup:plays:stranger-things", bucket, a.delta);
  }
}

std::pair<grpc::Status, counters::GetCountReply> csGet(counters::CounterService::Stub& stub, const std::string& ns, const std::string& name) {
  grpc::ClientContext call;
  call.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(1));
  counters::GetCountRequest req;
  req.set_namespace_(ns);
  req.set_name(name);
  counters::GetCountReply reply;
  const grpc::Status st = stub.GetCount(&call, req, &reply);
  return {st, reply};
}

counters::GetCountReply csMustGet(harness::Ctx& ctx, counters::CounterService::Stub& stub, const std::string& ns, const std::string& name) {
  const auto [st, reply] = csGet(stub, ns, name);
  if (!st.ok()) ctx.Fatalf("GetCount(%q, %q) failed: %v: %s", ns, name, st.error_code(), st.error_message());
  return reply;
}

void csFailsWith(harness::Ctx& ctx, counters::CounterService::Stub& stub, const std::string& ns, const std::string& name, grpc::StatusCode code) {
  const auto [st, reply] = csGet(stub, ns, name);
  if (!st.ok()) {
    ctx.Equal(st.error_code(), code, "GetCount(%q, %q) failed with the wrong code", ns, name);
    return;
  }
  ctx.Fatalf("GetCount(%q, %q) answered %d instead of failing with %v", ns, name, reply.count(), code);
}

}  // namespace

// The stand-ins for steps 2 and 4, as the Go harness swaps in its function variables.
long long get_best_effort(const std::string& ns, const std::string& name) {
  const auto v = csCtx->Redis.Get("counter:" + ns + ":" + name);
  return v ? std::stoll(*v) : 0;
}

long long get_rolled_up(const std::string& ns, const std::string& name) { return csSum(*csCtx, "rollup:" + ns + ":" + name); }

void CheckNotFound(harness::Ctx& ctx) {
  auto stub = csService(ctx);
  csFailsWith(ctx, *stub, "likes", "stranger-things", grpc::StatusCode::NOT_FOUND);
  csFailsWith(ctx, *stub, "", "stranger-things", grpc::StatusCode::NOT_FOUND);
  const auto keys = ctx.Redis.Keys("*");
  ctx.Assert(keys.empty(), "an unknown namespace must not leave anything in the cache, Redis holds %q", keys);
}

void CheckInvalidArgument(harness::Ctx& ctx) {
  auto stub = csService(ctx);
  for (const std::string bad : {std::string("bad name"), std::string(""), std::string(65, 'a'), std::string("dots.are.out")}) {
    csFailsWith(ctx, *stub, "plays", bad, grpc::StatusCode::INVALID_ARGUMENT);
    csFailsWith(ctx, *stub, "views", bad, grpc::StatusCode::INVALID_ARGUMENT);
  }
  const auto keys = ctx.Redis.Keys("*");
  ctx.Assert(keys.empty(), "a bad name must be refused before any store is consulted, yet Redis holds %q", keys);
  csFailsWith(ctx, *stub, "likes", "bad name", grpc::StatusCode::NOT_FOUND);  // the namespace is checked first
}

void CheckCacheKeyTtl(harness::Ctx& ctx) {
  auto stub = csService(ctx);
  csPlays(ctx, {{"t-1", 1200}, {"t-2", 7}});
  const auto reply = csMustGet(ctx, *stub, "plays", "stranger-things");
  ctx.Equal(reply.count(), 1207, "GetCount must answer the rolled-up total");
  const auto cached = ctx.Redis.Get(csKey);
  ctx.Assert(cached.has_value(), "the total must be cached under %s, keys are %q", csKey, ctx.Redis.Keys("*"));
  const auto doc = nlohmann::json::parse(*cached, nullptr, false);
  ctx.Assert(doc.is_object() && doc.value("count", nlohmann::json()) == 1207 && doc.value("as_of", nlohmann::json()) == reply.as_of(), "%s must hold JSON {count, as_of} matching the reply, got %s", csKey, *cached);
  const long long ttl = ctx.Redis.TTL(csKey);
  ctx.Assert(1 <= ttl && ttl <= 2, "%s expires in %d s, expected kCacheTtl (2 s)", csKey, ttl);
  ctx.Clock.Advance(3);
  ctx.Equal(ctx.Redis.Exists(csKey), 0, "%s must be gone after 2 s: EXISTS", csKey);
}

void CheckCacheAside(harness::Ctx& ctx) {
  auto stub = csService(ctx);
  csPlays(ctx, {{"t-1", 1200}, {"t-2", 7}});
  const auto first = csMustGet(ctx, *stub, "plays", "stranger-things");
  ctx.Equal(first.count(), 1207, "GetCount must answer the rolled-up total");
  csPlays(ctx, {{"t-3", 93}});  // the buckets move on to 1300
  ctx.Clock.Advance(1);
  const auto second = csMustGet(ctx, *stub, "plays", "stranger-things");
  ctx.Equal(std::vector<int64_t>{second.count(), second.as_of()}, std::vector<int64_t>{first.count(), first.as_of()}, "1 s after the first read the buckets moved to 1300, but a read within kCacheTtl is served from %s: [count, as_of]", csKey);
  ctx.Clock.Advance(1.5);
  const auto third = csMustGet(ctx, *stub, "plays", "stranger-things");
  ctx.Equal(third.count(), 1300, "2.5 s after the total was cached the entry has expired and the next read must sum the buckets again");
  ctx.Assert(third.as_of() >= first.as_of() + 2, "as_of must be the time of the recomputation (%d or later), got %d", first.as_of() + 2, third.as_of());
}

void CheckReply(harness::Ctx& ctx) {
  auto stub = csService(ctx);
  csAddBestEffort(ctx, "views", "trailer-7", 42);
  auto reply = csMustGet(ctx, *stub, "views", "trailer-7");
  ctx.Equal(reply.count(), 42, "a best-effort namespace answers the counter's count");
  int64_t now = ctx.Clock.Now() / 1000;
  ctx.Assert(reply.as_of() - now <= 1 && now - reply.as_of() <= 1, "a best-effort reply's as_of is now (%d), got %d", now, reply.as_of());
  ctx.Equal(ctx.Redis.Exists("total:views:trailer-7"), 0, "best-effort counters are not cached (they are already one GET away): EXISTS total:views:trailer-7");
  csAddBestEffort(ctx, "views", "trailer-7", 8);
  reply = csMustGet(ctx, *stub, "views", "trailer-7");
  ctx.Equal(reply.count(), 50, "a best-effort read goes straight to the counter: right after another add of 8 GetCount must answer 50");
  csPlays(ctx, {{"t-1", 1200}, {"t-2", 7}});
  reply = csMustGet(ctx, *stub, "plays", "stranger-things");
  now = ctx.Clock.Now() / 1000;
  ctx.Assert(reply.count() == 1207 && reply.as_of() - now <= 1 && now - reply.as_of() <= 1, "an eventually-consistent reply carries the rolled-up 1207 and a current as_of, got [%d, %d]", reply.count(), reply.as_of());
}
`,
  },
  debrief: `GetCount is the read side of the abstraction, and it is served from a cache for the same reason the write side is a log: a popular counter is read far more often than its total changes, and summing buckets on every read would make the rollup store the hot spot. Two seconds of TTL is nothing on a number that is already eventually consistent, and as_of makes the staleness honest — a caller can see exactly how old the figure is instead of guessing. The status codes mirror the API's: NOT_FOUND and INVALID_ARGUMENT are the same two failures in gRPC's vocabulary, which is what lets one abstraction serve HTTPS clients and internal services alike. Netflix caches rolled-up values in EVCache in front of its rollup store and, for the counters that must be exact, offers a read that waits for the rollup instead of reading the cache.`,
};
