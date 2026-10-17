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
\`get_rolled_up\` (step 4's sum over the buckets) are provided.

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

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# The namespaces of step 1 (provided).
NAMESPACES = {
    "views": "best_effort",
    "plays": "eventually_consistent",
}
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
CACHE_TTL_S = 2


def get_best_effort(ns: str, name: str) -> int:
    """Step 2's get_count (provided)."""
    raise NotImplementedError


def get_rolled_up(ns: str, name: str) -> int:
    """Step 4's get_count: the sum over the minute buckets (provided)."""
    raise NotImplementedError


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

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# The namespaces of step 1 (provided).
NAMESPACES = {
    "views": "best_effort",
    "plays": "eventually_consistent",
}
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
CACHE_TTL_S = 2


def get_best_effort(ns: str, name: str) -> int:
    """Step 2's get_count (provided)."""
    raise NotImplementedError


def get_rolled_up(ns: str, name: str) -> int:
    """Step 4's get_count: the sum over the minute buckets (provided)."""
    raise NotImplementedError


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
func getBestEffort(ctx context.Context, ns, name string) (int64, error) { panic("not implemented") }
func getRolledUp(ctx context.Context, ns, name string) (int64, error)   { panic("not implemented") }

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
func getBestEffort(ctx context.Context, ns, name string) (int64, error) { panic("not implemented") }
func getRolledUp(ctx context.Context, ns, name string) (int64, error)   { panic("not implemented") }

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
    const auto it = kNamespaces.find(req->name_space());
    if (it == kNamespaces.end()) return grpc::Status(grpc::StatusCode::NOT_FOUND, "unknown namespace " + req->name_space());
    if (!std::regex_match(req->name(), kNameRe))
      return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "name must match [A-Za-z0-9_-]{1,64}");
    if (it->second == "best_effort") {
      reply->set_count(get_best_effort(req->name_space(), req->name()));
      reply->set_as_of(static_cast<long long>(std::time(nullptr)));
      return grpc::Status::OK;
    }
    const auto [count, as_of] = cached_total(req->name_space(), req->name());
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
    """The learner's servicer installed as the peer, a stub on it, and the fakes behind it."""
    m = ctx.load("count_service")
    reads = {"best": [], "rolled": []}
    totals = {"plays:stranger-things": 1207}
    best = {"views:trailer-7": 42}

    def get_best_effort(ns, name):
        reads["best"].append((ns, name))
        return best.get(f"{ns}:{name}", 0)

    def get_rolled_up(ns, name):
        reads["rolled"].append((ns, name))
        return totals.get(f"{ns}:{name}", 0)

    m.get_best_effort = get_best_effort
    m.get_rolled_up = get_rolled_up
    ctx.grpc.serve(counters_pb2_grpc.add_CounterServiceServicer_to_server, m.CounterService())
    stub = counters_pb2_grpc.CounterServiceStub(grpc.insecure_channel("counters:9000"))
    return m, stub, reads, totals


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
    m, stub, reads, totals = _service(ctx)
    _fails_with(stub, "likes", "stranger-things", grpc.StatusCode.NOT_FOUND)
    _fails_with(stub, "", "stranger-things", grpc.StatusCode.NOT_FOUND)
    assert reads == {"best": [], "rolled": []}, f"an unknown namespace must be refused before any store is read, reads: {reads}"
    assert ctx.redis.keys() == [], "an unknown namespace must not leave anything in the cache"


def check_invalid_argument(ctx):
    m, stub, reads, totals = _service(ctx)
    for bad in ("bad name", "", "a" * 65, "dots.are.out"):
        _fails_with(stub, "plays", bad, grpc.StatusCode.INVALID_ARGUMENT)
        _fails_with(stub, "views", bad, grpc.StatusCode.INVALID_ARGUMENT)
    assert reads == {"best": [], "rolled": []}, f"a bad name must be refused before any store is read, reads: {reads}"
    _fails_with(stub, "likes", "bad name", grpc.StatusCode.NOT_FOUND)  # the namespace is checked first


def check_cache_key_ttl(ctx):
    m, stub, reads, totals = _service(ctx)
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
    m, stub, reads, totals = _service(ctx)
    first = _get(stub, "plays", "stranger-things")
    assert len(reads["rolled"]) == 1, f"a miss sums the buckets once, saw {len(reads['rolled'])} get_rolled_up calls"
    second = _get(stub, "plays", "stranger-things")
    assert len(reads["rolled"]) == 1, "the second read within 2 s must be served from the cache, not from the buckets again"
    assert (second.count, second.as_of) == (first.count, first.as_of), f"a cache hit returns the cached pair {(first.count, first.as_of)}, got {(second.count, second.as_of)}"
    totals["plays:stranger-things"] = 1300
    ctx.clock.advance(1)
    assert _get(stub, "plays", "stranger-things").count == 1207, "within the TTL the cached total is what callers see, even though the buckets moved"
    ctx.clock.advance(2)
    third = _get(stub, "plays", "stranger-things")
    assert len(reads["rolled"]) == 2, "after the TTL the next read must go back to the buckets"
    assert third.count == 1300, f"after the TTL the reply carries the new total 1300, got {third.count}"
    assert third.as_of >= first.as_of + 3, f"as_of must be the time of the recomputation ({first.as_of + 3} or later), got {third.as_of}"
    ctx.redis.set(KEY, json.dumps({"count": 5, "as_of": 1700000000}))
    hit = _get(stub, "plays", "stranger-things")
    assert (hit.count, hit.as_of) == (5, 1700000000), f"whatever is in {KEY} is the answer while it lives, got {(hit.count, hit.as_of)}"


def check_reply(ctx):
    m, stub, reads, totals = _service(ctx)
    reply = _get(stub, "views", "trailer-7")
    assert reply.count == 42, f"a best-effort namespace answers get_best_effort's 42, got {reply.count}"
    assert abs(reply.as_of - int(time.time())) <= 1, f"a best-effort reply's as_of is now ({int(time.time())}), got {reply.as_of}"
    assert reads == {"best": [("views", "trailer-7")], "rolled": []}, f"a best-effort read goes to get_best_effort only, reads: {reads}"
    assert ctx.redis.exists("total:views:trailer-7") == 0, "best-effort counters are not cached: they are already one GET away"
    reply = _get(stub, "plays", "stranger-things")
    assert reply.count == 1207 and abs(reply.as_of - int(time.time())) <= 1, f"an eventually-consistent reply carries the rolled-up 1207 and a current as_of, got {(reply.count, reply.as_of)}"
    assert reads["rolled"] == [("plays", "stranger-things")], f"an eventually-consistent read goes to get_rolled_up, reads: {reads}"
`,
  },
  debrief: `GetCount is the read side of the abstraction, and it is served from a cache for the same reason the write side is a log: a popular counter is read far more often than its total changes, and summing buckets on every read would make the rollup store the hot spot. Two seconds of TTL is nothing on a number that is already eventually consistent, and as_of makes the staleness honest — a caller can see exactly how old the figure is instead of guessing. The status codes mirror the API's: NOT_FOUND and INVALID_ARGUMENT are the same two failures in gRPC's vocabulary, which is what lets one abstraction serve HTTPS clients and internal services alike. Netflix caches rolled-up values in EVCache in front of its rollup store and, for the counters that must be exact, offers a read that waits for the rollup instead of reading the cache.`,
};
