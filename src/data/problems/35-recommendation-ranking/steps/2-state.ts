import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis feature cache with a single-flight refresh',
  concept: 'redis',
  guides: ['keys-and-expiry', 'leases', 'failing-dependencies'],
  file: 'state',
  focus: ['api', 'redis', 'features'],
  task: `## Task

**Starting point.** The starter is \`load_features(tenant, user_id)\`, the feature read the ranking
client (step 3) makes before every call to the model: it GETs \`features:{user_id}\`, answers a hit as
\`{values, stale: false}\`, and on a miss calls \`FeatureService.UserFeatures\` over gRPC and SETs the
vector back. It serves the demo and hides four flaws.

**Failure mode the checks target.** Two tenants' users with the same id share one vector; a cached
vector never expires; a cold user requested twice at once costs two feature-service calls, so every
expiry of a busy user's vector becomes a herd; and while the feature service restarts, ranking gets
no features at all.

- Key the vector by tenant and user, \`features:{tenant}:{user_id}\`, written with \`EX 300\`
  (\`FEATURES_TTL_S\`).
- Refresh a miss only under \`SET lock:features:{tenant}:{user_id} 1 NX EX 5\` (\`LOCK_TTL_S\`). A
  caller that finds the lock taken does not call the feature service: it answers the stale copy, or
  nothing (\`None\`, \`null\`, \`nil\`). Release the lock in \`finally\` (\`defer\`, a scope guard), on
  the failure path too.
- Every refresh also writes \`features:stale:{tenant}:{user_id}\` with \`EX 86400\` (\`STALE_TTL_S\`);
  when the feature service fails, answer that copy as \`{values, stale: true}\`.`,
  sequence: {
    participants: ['Ranking client', 'Concurrent request', 'Redis', 'Feature service'],
    messages: [
      {from: 'Ranking client', to: 'Redis', label: 'GET features:t1:u-1 → (nil)', kind: 'sync'},
      {from: 'Ranking client', to: 'Redis', label: 'SET lock:features:t1:u-1 1 NX EX 5 → OK', kind: 'sync'},
      {from: 'Concurrent request', to: 'Redis', label: 'SET lock:features:t1:u-1 NX → (nil)', kind: 'sync'},
      {from: 'Redis', to: 'Concurrent request', label: 'stale copy, or nothing: no second refresh', kind: 'reply'},
      {from: 'Ranking client', to: 'Feature service', label: 'UserFeatures(t1, u-1)', kind: 'sync'},
      {from: 'Feature service', to: 'Ranking client', label: 'vector · or UNAVAILABLE → stale copy', kind: 'reply'},
      {
        from: 'Ranking client',
        to: 'Redis',
        label: 'SET features:t1:u-1 EX 300 · SET features:stale:t1:u-1 EX 86400 · DEL lock',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'tenant-key',
      title: 'Keys the vector by tenant and user',
      detail:
        'The cache key is `features:{tenant}:{user_id}`: a user id is unique only inside its tenant, and the starter keys by the user id alone, so two tenants share one vector.',
      match: {
        python: {all: [/f"features:\{tenant\}:\{user_id\}"/], none: [/f"features:\{user_id\}"/]},
        typescript: {all: [/`features:\$\{tenant\}:\$\{userId\}`/], none: [/`features:\$\{userId\}`/]},
        go: {all: [/"features:"\s*\+\s*tenant\s*\+\s*":"\s*\+\s*userID/], none: [/"features:"\s*\+\s*userID/]},
        scala: {all: [/s"features:\$tenant:\$userId"/], none: [/s"features:\$userId"/]},
        cpp: {all: [/"features:"\s*\+\s*tenant\s*\+\s*":"\s*\+\s*user_id/], none: [/"features:"\s*\+\s*user_id/]},
      },
    },
    {
      id: 'ttl',
      title: 'Caches the vector for 300 seconds',
      detail:
        'The vector is written with `FEATURES_TTL_S` = 300 as its expiry, so a user whose behaviour changed is re-read within five minutes; the starter writes it with no expiry.',
      match: {
        python: {all: [/FEATURES_TTL_S\s*=\s*300\b/, /ex=FEATURES_TTL_S/]},
        typescript: {all: [/FEATURES_TTL_S\s*=\s*300\b/, /'EX',\s*FEATURES_TTL_S/]},
        go: {all: [/featuresTTL\s*=\s*300\s*\*\s*time\.Second/, /\.Set\([^\n]*featuresTTL\)/]},
        scala: {all: [/FeaturesTtlSeconds\s*=\s*300L?\b/, /\.ex\(\s*FeaturesTtlSeconds\s*\)/]},
        cpp: {all: [/kFeaturesTtl\{300\}/, /\.set\([^\n]*kFeaturesTtl\)/]},
      },
    },
    {
      id: 'single-flight',
      title: 'One refresh per miss, under a lock released on every path',
      detail:
        'A miss takes `lock:features:{tenant}:{user_id}` with `NX` and a 5-second expiry before it calls the feature service; a caller that finds it taken answers the stale copy instead of calling too; the lock is released in `finally`/`defer`/a scope guard.',
      match: {
        python: {
          all: [/lock:features:/, /nx=True/, /finally:/, /\.delete\(\s*lock/],
          order: [/nx=True/, /\.UserFeatures\(/],
        },
        typescript: {
          all: [/lock:features:/, /'NX'/, /finally\s*\{/, /\.del\(\s*lock/],
          order: [/'NX'/, /\.UserFeatures\(/],
        },
        go: {
          all: [/lock:features:/, /\.SetNX\(/, /defer rdb\.Del\(/],
          order: [/\.SetNX\(/, /\.UserFeatures\(/],
        },
        scala: {
          all: [/lock:features:/, /\.nx\(\)/, /finally/, /\.del\(\s*lock/],
          order: [/\.nx\(\)/, /\.userFeatures\(/],
        },
        cpp: {
          all: [/lock:features:/, /UpdateType::NOT_EXIST/, /~\w+\(\)\s*\{[^}]*\.del\(/],
          order: [/UpdateType::NOT_EXIST/, /->UserFeatures\(/],
        },
      },
    },
    {
      id: 'stale-fallback',
      title: 'Answers the stale copy when the feature service fails',
      detail:
        'Every refresh writes `features:stale:{tenant}:{user_id}` for a day; a failed `UserFeatures` call answers that copy marked `stale`, where the starter lets the error through and ranking gets no features.',
      match: {
        python: {all: [/features:stale:/, /ex=STALE_TTL_S/, /except grpc\.RpcError/, /"stale":\s*True/]},
        typescript: {all: [/features:stale:/, /'EX',\s*STALE_TTL_S/, /catch/, /stale:\s*true/]},
        go: {all: [/features:stale:/, /staleTTL\)/, /Stale:\s*true/]},
        scala: {
          all: [/features:stale:/, /\.ex\(\s*StaleTtlSeconds\s*\)/, /StatusRuntimeException/, /stale\s*=\s*true/],
        },
        cpp: {all: [/features:stale:/, /kStaleTtl\)/, /\.ok\(\)/, /\btrue\}/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import grpc
import redis

import ranking_pb2
import ranking_pb2_grpc

FEATURES_DEADLINE_S = 0.3

r = redis.Redis(host="redis", port=6379, decode_responses=True)
features = ranking_pb2_grpc.FeatureServiceStub(grpc.insecure_channel("features:9000"))


def load_features(tenant: str, user_id: str) -> dict | None:
    """The user's feature vector for ranking, {values, stale}, or None when there is none to give."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    key = f"features:{user_id}"
    cached = r.get(key)
    if cached is not None:
        return {"values": json.loads(cached), "stale": False}
    vector = features.UserFeatures(ranking_pb2.FeaturesRequest(tenant=tenant, user_id=user_id), timeout=FEATURES_DEADLINE_S)
    values = list(vector.values)
    r.set(key, json.dumps(values))
    return {"values": values, "stale": False}
`,
      solution: `import json

import grpc
import redis

import ranking_pb2
import ranking_pb2_grpc

FEATURES_DEADLINE_S = 0.3
FEATURES_TTL_S = 300
STALE_TTL_S = 86_400
LOCK_TTL_S = 5

r = redis.Redis(host="redis", port=6379, decode_responses=True)
features = ranking_pb2_grpc.FeatureServiceStub(grpc.insecure_channel("features:9000"))


def stale_copy(tenant: str, user_id: str) -> dict | None:
    """The vector the last good refresh kept, marked stale, or None."""
    raw = r.get(f"features:stale:{tenant}:{user_id}")
    return {"values": json.loads(raw), "stale": True} if raw is not None else None


def load_features(tenant: str, user_id: str) -> dict | None:
    """The user's feature vector for ranking, {values, stale}, or None when there is none to give."""
    key = f"features:{tenant}:{user_id}"
    cached = r.get(key)
    if cached is not None:
        return {"values": json.loads(cached), "stale": False}
    lock = f"lock:features:{tenant}:{user_id}"
    if not r.set(lock, "1", nx=True, ex=LOCK_TTL_S):
        return stale_copy(tenant, user_id)  # another request is refreshing: one miss, one call
    try:
        try:
            vector = features.UserFeatures(ranking_pb2.FeaturesRequest(tenant=tenant, user_id=user_id), timeout=FEATURES_DEADLINE_S)
        except grpc.RpcError:
            return stale_copy(tenant, user_id)
        values = list(vector.values)
        r.set(key, json.dumps(values), ex=FEATURES_TTL_S)
        r.set(f"features:stale:{tenant}:{user_id}", json.dumps(values), ex=STALE_TTL_S)
        return {"values": values, "stale": False}
    finally:
        r.delete(lock)  # on the failure path too, or nobody refreshes this user for LOCK_TTL_S
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import type {Features} from 'recs/types';

export const FEATURES_DEADLINE_MS = 300;

const redis = new Redis({host: 'redis', port: 6379});

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('ranking.proto')) as unknown as {
  recsys: {FeatureService: grpc.ServiceClientConstructor};
};
const features = new pkg.recsys.FeatureService('features:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  UserFeatures(request: {tenant: string; user_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{values: number[]}>;
};

/** The user's feature vector for ranking, or null when there is none to give. */
export async function loadFeatures(tenant: string, userId: string): Promise<Features | null> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const key = \`features:\${userId}\`;
  const cached = await redis.get(key);
  if (cached !== null) return {values: JSON.parse(cached) as number[], stale: false};
  const vector = await features.UserFeatures({tenant, user_id: userId}, new grpc.Metadata(), {deadline: Date.now() + FEATURES_DEADLINE_MS});
  const values = [...vector.values];
  await redis.set(key, JSON.stringify(values));
  return {values, stale: false};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import type {Features} from 'recs/types';

export const FEATURES_DEADLINE_MS = 300;
export const FEATURES_TTL_S = 300;
export const STALE_TTL_S = 86_400;
export const LOCK_TTL_S = 5;

const redis = new Redis({host: 'redis', port: 6379});

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('ranking.proto')) as unknown as {
  recsys: {FeatureService: grpc.ServiceClientConstructor};
};
const features = new pkg.recsys.FeatureService('features:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  UserFeatures(request: {tenant: string; user_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{values: number[]}>;
};

/** The vector the last good refresh kept, marked stale, or null. */
async function staleCopy(tenant: string, userId: string): Promise<Features | null> {
  const raw = await redis.get(\`features:stale:\${tenant}:\${userId}\`);
  return raw === null ? null : {values: JSON.parse(raw) as number[], stale: true};
}

/** The user's feature vector for ranking, or null when there is none to give. */
export async function loadFeatures(tenant: string, userId: string): Promise<Features | null> {
  const key = \`features:\${tenant}:\${userId}\`;
  const cached = await redis.get(key);
  if (cached !== null) return {values: JSON.parse(cached) as number[], stale: false};
  const lock = \`lock:features:\${tenant}:\${userId}\`;
  // Another request is refreshing: one miss, one call.
  if ((await redis.set(lock, '1', 'EX', LOCK_TTL_S, 'NX')) === null) return staleCopy(tenant, userId);
  try {
    let vector: {values: number[]};
    try {
      vector = await features.UserFeatures({tenant, user_id: userId}, new grpc.Metadata(), {deadline: Date.now() + FEATURES_DEADLINE_MS});
    } catch {
      return await staleCopy(tenant, userId);
    }
    const values = [...vector.values];
    await redis.set(key, JSON.stringify(values), 'EX', FEATURES_TTL_S);
    await redis.set(\`features:stale:\${tenant}:\${userId}\`, JSON.stringify(values), 'EX', STALE_TTL_S);
    return {values, stale: false};
  } finally {
    await redis.del(lock); // on the failure path too, or nobody refreshes this user for LOCK_TTL_S
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "recs/gen/ranking"
	"recs/types"
)

const featuresDeadline = 300 * time.Millisecond

var (
	rdb             = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	featuresConn, _ = grpc.NewClient("features:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	featureService  = pb.NewFeatureServiceClient(featuresConn)
)

// loadFeatures is the user's feature vector for ranking, or nil when there is none to give.
func loadFeatures(ctx context.Context, tenant, userID string) *types.Features {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	key := "features:" + userID
	if cached, err := rdb.Get(ctx, key).Result(); err == nil {
		var values []float64
		json.Unmarshal([]byte(cached), &values)
		return &types.Features{Values: values}
	}
	callCtx, cancel := context.WithTimeout(ctx, featuresDeadline)
	defer cancel()
	vector, err := featureService.UserFeatures(callCtx, &pb.FeaturesRequest{Tenant: tenant, UserId: userID})
	if err != nil {
		return nil
	}
	raw, _ := json.Marshal(vector.GetValues())
	rdb.Set(ctx, key, raw, 0)
	return &types.Features{Values: vector.GetValues()}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "recs/gen/ranking"
	"recs/types"
)

const (
	featuresDeadline = 300 * time.Millisecond
	featuresTTL      = 300 * time.Second
	staleTTL         = 24 * time.Hour
	lockTTL          = 5 * time.Second
)

var (
	rdb             = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	featuresConn, _ = grpc.NewClient("features:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	featureService  = pb.NewFeatureServiceClient(featuresConn)
)

// staleCopy is the vector the last good refresh kept, marked stale, or nil.
func staleCopy(ctx context.Context, tenant, userID string) *types.Features {
	raw, err := rdb.Get(ctx, "features:stale:"+tenant+":"+userID).Result()
	if err != nil {
		return nil
	}
	var values []float64
	json.Unmarshal([]byte(raw), &values)
	return &types.Features{Values: values, Stale: true}
}

// loadFeatures is the user's feature vector for ranking, or nil when there is none to give.
func loadFeatures(ctx context.Context, tenant, userID string) *types.Features {
	key := "features:" + tenant + ":" + userID
	if cached, err := rdb.Get(ctx, key).Result(); err == nil {
		var values []float64
		json.Unmarshal([]byte(cached), &values)
		return &types.Features{Values: values}
	}
	lock := "lock:features:" + tenant + ":" + userID
	if taken, _ := rdb.SetNX(ctx, lock, "1", lockTTL).Result(); !taken {
		return staleCopy(ctx, tenant, userID) // another request is refreshing: one miss, one call
	}
	defer rdb.Del(ctx, lock) // on the failure path too, or nobody refreshes this user for lockTTL
	callCtx, cancel := context.WithTimeout(ctx, featuresDeadline)
	defer cancel()
	vector, err := featureService.UserFeatures(callCtx, &pb.FeaturesRequest{Tenant: tenant, UserId: userID})
	if err != nil {
		return staleCopy(ctx, tenant, userID)
	}
	raw, _ := json.Marshal(vector.GetValues())
	rdb.Set(ctx, key, raw, featuresTTL)
	rdb.Set(ctx, "features:stale:"+tenant+":"+userID, raw, staleTTL)
	return &types.Features{Values: vector.GetValues()}
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder
import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import recs.Features
import recsys.ranking.{FeatureServiceGrpc, FeaturesRequest}

object State {
  val FeaturesDeadlineMs = 300L

  private val jedis = new JedisPooled("redis", 6379)
  private val featureService = FeatureServiceGrpc.blockingStub(ManagedChannelBuilder.forAddress("features", 9000).usePlaintext().build())

  /** The user's feature vector for ranking, or None when there is none to give. */
  def loadFeatures(tenant: String, userId: String): Option[Features] = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val key = s"features:$userId"
    Option(jedis.get(key)) match {
      case Some(cached) => Some(Features(cached.parseJson.convertTo[Vector[Double]], stale = false))
      case None =>
        val vector = featureService.withDeadlineAfter(FeaturesDeadlineMs, TimeUnit.MILLISECONDS).userFeatures(FeaturesRequest(tenant, userId))
        jedis.set(key, vector.values.toVector.toJson.compactPrint)
        Some(Features(vector.values, stale = false))
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._
import spray.json.DefaultJsonProtocol._

import recs.Features
import recsys.ranking.{FeatureServiceGrpc, FeaturesRequest}

object State {
  val FeaturesDeadlineMs = 300L
  val FeaturesTtlSeconds = 300L
  val StaleTtlSeconds = 86400L
  val LockTtlSeconds = 5L

  private val jedis = new JedisPooled("redis", 6379)
  private val featureService = FeatureServiceGrpc.blockingStub(ManagedChannelBuilder.forAddress("features", 9000).usePlaintext().build())

  /** The vector the last good refresh kept, marked stale, if any. */
  def staleCopy(tenant: String, userId: String): Option[Features] =
    Option(jedis.get(s"features:stale:$tenant:$userId")).map(raw => Features(raw.parseJson.convertTo[Vector[Double]], stale = true))

  /** The user's feature vector for ranking, or None when there is none to give. */
  def loadFeatures(tenant: String, userId: String): Option[Features] = {
    val key = s"features:$tenant:$userId"
    Option(jedis.get(key)) match {
      case Some(cached) => Some(Features(cached.parseJson.convertTo[Vector[Double]], stale = false))
      case None =>
        val lock = s"lock:features:$tenant:$userId"
        // Another request is refreshing: one miss, one call.
        if (jedis.set(lock, "1", SetParams.setParams().nx().ex(LockTtlSeconds)) == null) staleCopy(tenant, userId)
        else
          try {
            val vector = featureService.withDeadlineAfter(FeaturesDeadlineMs, TimeUnit.MILLISECONDS).userFeatures(FeaturesRequest(tenant, userId))
            val raw = vector.values.toVector.toJson.compactPrint
            jedis.set(key, raw, SetParams.setParams().ex(FeaturesTtlSeconds))
            jedis.set(s"features:stale:$tenant:$userId", raw, SetParams.setParams().ex(StaleTtlSeconds))
            Some(Features(vector.values, stale = false))
          } catch {
            case _: StatusRuntimeException => staleCopy(tenant, userId)
          } finally {
            jedis.del(lock) // on the failure path too, or nobody refreshes this user for LockTtlSeconds
          }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <vector>

#include "ranking.grpc.pb.h"
#include "recs/types.h"

using json = nlohmann::json;

constexpr std::chrono::milliseconds kFeaturesDeadline{300};

sw::redis::Redis redis("tcp://redis:6379");
auto featureService = recsys::FeatureService::NewStub(grpc::CreateChannel("features:9000", grpc::InsecureChannelCredentials()));

// The user's feature vector for ranking, or nothing when there is none to give.
std::optional<recs::Features> loadFeatures(const std::string& tenant, const std::string& user_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string key = "features:" + user_id;
  if (const auto cached = redis.get(key)) return recs::Features{json::parse(*cached).get<std::vector<double>>(), false};
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kFeaturesDeadline);
  recsys::FeaturesRequest request;
  request.set_tenant(tenant);
  request.set_user_id(user_id);
  recsys::FeatureVector vector;
  if (!featureService->UserFeatures(&ctx, request, &vector).ok()) return std::nullopt;
  const std::vector<double> values(vector.values().begin(), vector.values().end());
  redis.set(key, json(values).dump());
  return recs::Features{values, false};
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <vector>

#include "ranking.grpc.pb.h"
#include "recs/types.h"

using json = nlohmann::json;

constexpr std::chrono::milliseconds kFeaturesDeadline{300};
constexpr std::chrono::seconds kFeaturesTtl{300};
constexpr std::chrono::seconds kStaleTtl{86400};
constexpr std::chrono::seconds kLockTtl{5};

sw::redis::Redis redis("tcp://redis:6379");
auto featureService = recsys::FeatureService::NewStub(grpc::CreateChannel("features:9000", grpc::InsecureChannelCredentials()));

// Releases the refresh lock when the refresh ends, on the failure path too.
struct LockRelease {
  std::string key;
  ~LockRelease() { redis.del(key); }
};

// The vector the last good refresh kept, marked stale, or nothing.
std::optional<recs::Features> staleCopy(const std::string& tenant, const std::string& user_id) {
  const auto raw = redis.get("features:stale:" + tenant + ":" + user_id);
  if (!raw) return std::nullopt;
  return recs::Features{json::parse(*raw).get<std::vector<double>>(), true};
}

// The user's feature vector for ranking, or nothing when there is none to give.
std::optional<recs::Features> loadFeatures(const std::string& tenant, const std::string& user_id) {
  const std::string key = "features:" + tenant + ":" + user_id;
  if (const auto cached = redis.get(key)) return recs::Features{json::parse(*cached).get<std::vector<double>>(), false};
  const std::string lock = "lock:features:" + tenant + ":" + user_id;
  if (!redis.set(lock, "1", kLockTtl, sw::redis::UpdateType::NOT_EXIST)) {
    return staleCopy(tenant, user_id);  // another request is refreshing: one miss, one call
  }
  const LockRelease release{lock};
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kFeaturesDeadline);
  recsys::FeaturesRequest request;
  request.set_tenant(tenant);
  request.set_user_id(user_id);
  recsys::FeatureVector vector;
  if (!featureService->UserFeatures(&ctx, request, &vector).ok()) return staleCopy(tenant, user_id);
  const std::vector<double> values(vector.values().begin(), vector.values().end());
  redis.set(key, json(values).dump(), kFeaturesTtl);
  redis.set("features:stale:" + tenant + ":" + user_id, json(values).dump(), kStaleTtl);
  return recs::Features{values, false};
}
`,
    },
  },
  harness: {
    python: `import grpc

import ranking_pb2
import ranking_pb2_grpc

T1 = [0.25, 0.375]  # every user of tenant t1
T2 = [0.75, 0.875]  # every user of tenant t2


class FeatureService(ranking_pb2_grpc.FeatureServiceServicer):
    def UserFeatures(self, request, context):
        base = 0.25 if request.tenant == "t1" else 0.75
        return ranking_pb2.FeatureVector(values=[base, base + 0.125])


def _state(ctx):
    ctx.grpc.serve(ranking_pb2_grpc.add_FeatureServiceServicer_to_server, FeatureService())
    return ctx.load("state")


def _calls(ctx):
    return len(ctx.grpc.calls_to("UserFeatures"))


def _cached_keys(ctx):
    return sorted(k for k in ctx.redis.keys("features:*") if not k.startswith("features:stale:"))


def check_tenant_key(ctx):
    m = _state(ctx)
    first = m.load_features("t1", "u-1")
    assert first == {"values": T1, "stale": False}, f"load_features('t1', 'u-1') gave {first}, expected {{'values': {T1}, 'stale': False}}"
    other = m.load_features("t2", "u-1")
    assert other is not None and other["values"] == T2, f"user u-1 of tenant t2 got {other}: tenant t1's vector, cached under a key without the tenant. Key the cache by (tenant, user)"
    assert _calls(ctx) == 2, f"two users of two tenants made {_calls(ctx)} feature-service calls, expected 2"
    assert _cached_keys(ctx) == ["features:t1:u-1", "features:t2:u-1"], f"the cache holds {_cached_keys(ctx)}, expected features:{{tenant}}:{{user_id}}"
    again = m.load_features("t1", "u-1")
    assert again == first and _calls(ctx) == 2, f"a second read of t1/u-1 must be a cache hit, got {again} after {_calls(ctx)} calls"


def check_ttl(ctx):
    m = _state(ctx)
    m.load_features("t1", "u-1")
    keys = _cached_keys(ctx)
    assert keys, "load_features cached nothing under features:*"
    ttl = ctx.redis.ttl(keys[0])
    assert 0 < ttl <= 300, f"{keys[0]} has TTL {ttl}: a vector cached without an expiry is served long after the user's behaviour changed. Write it with EX 300"
    ctx.clock.advance(301)
    m.load_features("t1", "u-1")
    assert _calls(ctx) == 2, f"301 s after the refresh the vector was served from the cache ({_calls(ctx)} feature-service call): it must have expired and been refreshed"


def check_single_flight(ctx):
    m = _state(ctx)
    # A second request for the same cold user lands right after this one took the refresh lock.
    rival = ctx.redis_after("lock:features:t1:u-1", lambda: m.load_features("t1", "u-1"))
    first = m.load_features("t1", "u-1")
    assert rival.fired, "nothing took lock:features:t1:u-1: every request that misses calls the feature service. Take SET lock:features:{tenant}:{user_id} 1 NX EX 5 before refreshing"
    if rival.error is not None:
        raise rival.error
    assert _calls(ctx) == 1, f"two requests for one cold user made {_calls(ctx)} feature-service calls: the one that finds the lock taken must not refresh too"
    assert rival.result is None, f"the request that found the lock taken answered {rival.result}: with no stale copy yet it has nothing to give"
    assert first == {"values": T1, "stale": False}, f"the request holding the lock answered {first}"
    assert ctx.redis.exists("lock:features:t1:u-1") == 0, "the lock outlived the refresh: release it once the vector is written"
    # A refresh that fails releases the lock, so the next request refreshes instead of waiting out its TTL.
    ctx.grpc.fail("UserFeatures", grpc.StatusCode.UNAVAILABLE, "restarting")
    try:
        m.load_features("t1", "u-2")
    except grpc.RpcError:
        pass
    assert ctx.redis.exists("lock:features:t1:u-2") == 0, "a refresh that failed left lock:features:t1:u-2 behind: for 5 s nobody may refresh u-2. Release the lock in finally"
    got = m.load_features("t1", "u-2")
    assert got == {"values": T1, "stale": False}, f"once the feature service answered again, u-2 got {got}"


def check_stale_fallback(ctx):
    m = _state(ctx)
    m.load_features("t1", "u-1")
    stale_ttl = ctx.redis.ttl("features:stale:t1:u-1")
    assert stale_ttl != -2, "the refresh kept no copy at features:stale:t1:u-1: when the feature service is down there is nothing to fall back to"
    assert stale_ttl > 300, f"features:stale:t1:u-1 has TTL {stale_ttl}: the stale copy must outlive the cached vector (EX 86400)"
    ctx.clock.advance(301)  # the cached vector expired
    ctx.grpc.fail("UserFeatures", grpc.StatusCode.UNAVAILABLE, "restarting")
    try:
        got = m.load_features("t1", "u-1")
    except Exception as exc:
        raise AssertionError(f"with the feature service down load_features raised {type(exc).__name__}: {exc}. Answer the stale copy instead")
    assert got == {"values": T1, "stale": True}, f"with the feature service down load_features answered {got}, expected the stale copy {{'values': {T1}, 'stale': True}}"
`,
    typescript: `const T1 = [0.25, 0.375]; // every user of tenant t1
const T2 = [0.75, 0.875]; // every user of tenant t2

function state(ctx) {
  const pkg = ctx.proto('ranking.proto');
  ctx.grpc.serve(pkg.recsys.FeatureService.service, {
    UserFeatures(call, callback) {
      const base = call.request.tenant === 't1' ? 0.25 : 0.75;
      callback(null, {values: [base, base + 0.125]});
    },
  });
  return ctx.load('state');
}

const calls = (ctx): number => ctx.grpc.callsTo('UserFeatures').length;
const cachedKeys = (ctx): string[] => (ctx.redis.keys('features:*') as string[]).filter(k => !k.startsWith('features:stale:')).sort();
const show = (value): string => JSON.stringify(value);

export async function check_tenant_key(ctx) {
  const m = state(ctx);
  const first = await m.loadFeatures('t1', 'u-1');
  assert.deepStrictEqual(first, {values: T1, stale: false}, \`loadFeatures('t1', 'u-1') gave \${show(first)}\`);
  const other = await m.loadFeatures('t2', 'u-1');
  assert(other !== null && show(other.values) === show(T2), \`user u-1 of tenant t2 got \${show(other)}: tenant t1's vector, cached under a key without the tenant. Key the cache by (tenant, user)\`);
  assert.equal(calls(ctx), 2, \`two users of two tenants made \${calls(ctx)} feature-service calls, expected 2\`);
  assert.deepStrictEqual(cachedKeys(ctx), ['features:t1:u-1', 'features:t2:u-1'], \`the cache holds \${show(cachedKeys(ctx))}, expected features:{tenant}:{user_id}\`);
  const again = await m.loadFeatures('t1', 'u-1');
  assert(show(again) === show(first) && calls(ctx) === 2, \`a second read of t1/u-1 must be a cache hit, got \${show(again)} after \${calls(ctx)} calls\`);
}

export async function check_ttl(ctx) {
  const m = state(ctx);
  await m.loadFeatures('t1', 'u-1');
  const keys = cachedKeys(ctx);
  assert(keys.length > 0, 'loadFeatures cached nothing under features:*');
  const ttl = Number(ctx.redis.ttl(keys[0]));
  assert(ttl > 0 && ttl <= 300, \`\${keys[0]} has TTL \${ttl}: a vector cached without an expiry is served long after the user's behaviour changed. Write it with EX 300\`);
  ctx.clock.advance(301);
  await m.loadFeatures('t1', 'u-1');
  assert.equal(calls(ctx), 2, \`301 s after the refresh the vector was served from the cache (\${calls(ctx)} feature-service call): it must have expired and been refreshed\`);
}

export async function check_single_flight(ctx) {
  const m = state(ctx);
  // A second request for the same cold user lands right after this one took the refresh lock.
  const rival = ctx.redisAfter('lock:features:t1:u-1', () => m.loadFeatures('t1', 'u-1'));
  const first = await m.loadFeatures('t1', 'u-1');
  assert(rival.fired, 'nothing took lock:features:t1:u-1: every request that misses calls the feature service. Take SET lock:features:{tenant}:{user_id} 1 NX EX 5 before refreshing');
  if (rival.error !== undefined) throw rival.error;
  const rivalResult = await rival.result;
  assert.equal(calls(ctx), 1, \`two requests for one cold user made \${calls(ctx)} feature-service calls: the one that finds the lock taken must not refresh too\`);
  assert.equal(rivalResult, null, \`the request that found the lock taken answered \${show(rivalResult)}: with no stale copy yet it has nothing to give\`);
  assert.deepStrictEqual(first, {values: T1, stale: false}, \`the request holding the lock answered \${show(first)}\`);
  assert.equal(ctx.redis.exists('lock:features:t1:u-1'), 0, 'the lock outlived the refresh: release it once the vector is written');
  // A refresh that fails releases the lock, so the next request refreshes instead of waiting out its TTL.
  ctx.grpc.fail('UserFeatures', ctx.grpc.status.UNAVAILABLE, 'restarting');
  await m.loadFeatures('t1', 'u-2').catch(() => null);
  assert.equal(ctx.redis.exists('lock:features:t1:u-2'), 0, 'a refresh that failed left lock:features:t1:u-2 behind: for 5 s nobody may refresh u-2. Release the lock in finally');
  const got = await m.loadFeatures('t1', 'u-2');
  assert.deepStrictEqual(got, {values: T1, stale: false}, \`once the feature service answered again, u-2 got \${show(got)}\`);
}

export async function check_stale_fallback(ctx) {
  const m = state(ctx);
  await m.loadFeatures('t1', 'u-1');
  const staleTtl = Number(ctx.redis.ttl('features:stale:t1:u-1'));
  assert(staleTtl !== -2, 'the refresh kept no copy at features:stale:t1:u-1: when the feature service is down there is nothing to fall back to');
  assert(staleTtl > 300, \`features:stale:t1:u-1 has TTL \${staleTtl}: the stale copy must outlive the cached vector (EX 86400)\`);
  ctx.clock.advance(301); // the cached vector expired
  ctx.grpc.fail('UserFeatures', ctx.grpc.status.UNAVAILABLE, 'restarting');
  let got;
  try {
    got = await m.loadFeatures('t1', 'u-1');
  } catch (e) {
    assert.fail(\`with the feature service down loadFeatures threw \${(e as Error).message}. Answer the stale copy instead\`);
  }
  assert.deepStrictEqual(got, {values: T1, stale: true}, \`with the feature service down loadFeatures answered \${show(got)}, expected the stale copy\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"strings"

	"google.golang.org/grpc/codes"

	pb "recs/gen/ranking"
	"recs/types"

	"leetbuild/harness"
)

var (
	stateBg = context.Background()
	t1      = []float64{0.25, 0.375} // every user of tenant t1
	t2      = []float64{0.75, 0.875} // every user of tenant t2
)

type featurePeer struct {
	pb.UnimplementedFeatureServiceServer
}

func (featurePeer) UserFeatures(_ context.Context, req *pb.FeaturesRequest) (*pb.FeatureVector, error) {
	base := 0.75
	if req.GetTenant() == "t1" {
		base = 0.25
	}
	return &pb.FeatureVector{Values: []float64{base, base + 0.125}}, nil
}

func serveFeatures(ctx *harness.Ctx) {
	pb.RegisterFeatureServiceServer(ctx.GRPC.Server(""), featurePeer{})
}

func featureCalls(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("UserFeatures", "")) }

func cachedKeys(ctx *harness.Ctx) []string {
	out := []string{}
	for _, k := range ctx.Redis.Keys("features:*") {
		if !strings.HasPrefix(k, "features:stale:") {
			out = append(out, k)
		}
	}
	return out
}

func show(f *types.Features) string {
	if f == nil {
		return "nil"
	}
	return fmt.Sprintf("{values %v, stale %t}", f.Values, f.Stale)
}

func sameValues(f *types.Features, values []float64, stale bool) bool {
	return f != nil && fmt.Sprint(f.Values) == fmt.Sprint(values) && f.Stale == stale
}

func CheckTenantKey(ctx *harness.Ctx) {
	serveFeatures(ctx)
	first := loadFeatures(stateBg, "t1", "u-1")
	ctx.Assert(sameValues(first, t1, false), "loadFeatures(t1, u-1) gave %s, expected {values %v, stale false}", show(first), t1)
	other := loadFeatures(stateBg, "t2", "u-1")
	ctx.Assert(other != nil && fmt.Sprint(other.Values) == fmt.Sprint(t2), "user u-1 of tenant t2 got %s: tenant t1's vector, cached under a key without the tenant. Key the cache by (tenant, user)", show(other))
	ctx.Equal(featureCalls(ctx), 2, "two users of two tenants must make two feature-service calls; the calls")
	ctx.Equal(cachedKeys(ctx), []string{"features:t1:u-1", "features:t2:u-1"}, "the cache must hold features:{tenant}:{user_id}; it holds")
	again := loadFeatures(stateBg, "t1", "u-1")
	ctx.Assert(sameValues(again, t1, false) && featureCalls(ctx) == 2, "a second read of t1/u-1 must be a cache hit, got %s after %d calls", show(again), featureCalls(ctx))
}

func CheckTtl(ctx *harness.Ctx) {
	serveFeatures(ctx)
	loadFeatures(stateBg, "t1", "u-1")
	keys := cachedKeys(ctx)
	ctx.Assert(len(keys) > 0, "loadFeatures cached nothing under features:*")
	ttl := ctx.Redis.TTL(keys[0])
	ctx.Assert(ttl > 0 && ttl <= 300, "%s has TTL %d: a vector cached without an expiry is served long after the user's behaviour changed. Write it with EX 300", keys[0], ttl)
	ctx.Clock.Advance(301)
	loadFeatures(stateBg, "t1", "u-1")
	ctx.Equal(featureCalls(ctx), 2, "301 s after the refresh the vector must have expired and been refreshed; the feature-service calls")
}

func CheckSingleFlight(ctx *harness.Ctx) {
	serveFeatures(ctx)
	// A second request for the same cold user lands right after this one took the refresh lock.
	rival := ctx.Redis.After("lock:features:t1:u-1", func() any { return loadFeatures(stateBg, "t1", "u-1") })
	first := loadFeatures(stateBg, "t1", "u-1")
	ctx.Assert(rival.Fired, "nothing took lock:features:t1:u-1: every request that misses calls the feature service. Take SET lock:features:{tenant}:{user_id} 1 NX EX 5 before refreshing")
	ctx.Assert(rival.Err == nil, "the concurrent request failed: %v", rival.Err)
	ctx.Equal(featureCalls(ctx), 1, "two requests for one cold user: the one that finds the lock taken must not refresh too; the feature-service calls")
	rivalFeatures, _ := rival.Result.(*types.Features)
	ctx.Assert(rivalFeatures == nil, "the request that found the lock taken answered %s: with no stale copy yet it has nothing to give", show(rivalFeatures))
	ctx.Assert(sameValues(first, t1, false), "the request holding the lock answered %s", show(first))
	ctx.Equal(ctx.Redis.Exists("lock:features:t1:u-1"), int64(0), "the lock outlived the refresh: release it once the vector is written; the lock keys")
	// A refresh that fails releases the lock, so the next request refreshes instead of waiting out its TTL.
	ctx.GRPC.Fail("UserFeatures", codes.Unavailable, "restarting", 1, "")
	loadFeatures(stateBg, "t1", "u-2")
	ctx.Equal(ctx.Redis.Exists("lock:features:t1:u-2"), int64(0), "a refresh that failed left lock:features:t1:u-2 behind: for 5 s nobody may refresh u-2. Release the lock with defer; the lock keys")
	got := loadFeatures(stateBg, "t1", "u-2")
	ctx.Assert(sameValues(got, t1, false), "once the feature service answered again, u-2 got %s", show(got))
}

func CheckStaleFallback(ctx *harness.Ctx) {
	serveFeatures(ctx)
	loadFeatures(stateBg, "t1", "u-1")
	staleTTL := ctx.Redis.TTL("features:stale:t1:u-1")
	ctx.Assert(staleTTL != -2, "the refresh kept no copy at features:stale:t1:u-1: when the feature service is down there is nothing to fall back to")
	ctx.Assert(staleTTL > 300, "features:stale:t1:u-1 has TTL %d: the stale copy must outlive the cached vector (EX 86400)", staleTTL)
	ctx.Clock.Advance(301) // the cached vector expired
	ctx.GRPC.Fail("UserFeatures", codes.Unavailable, "restarting", 1, "")
	got := loadFeatures(stateBg, "t1", "u-1")
	ctx.Assert(sameValues(got, t1, true), "with the feature service down loadFeatures answered %s, expected the stale copy {values %v, stale true}", show(got), t1)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

namespace {

const std::vector<double> kT1{0.25, 0.375};  // every user of tenant t1
const std::vector<double> kT2{0.75, 0.875};  // every user of tenant t2

class FeaturePeer final : public recsys::FeatureService::Service {
 public:
  grpc::Status UserFeatures(grpc::ServerContext*, const recsys::FeaturesRequest* req, recsys::FeatureVector* out) override {
    const double base = req->tenant() == "t1" ? 0.25 : 0.75;
    out->add_values(base);
    out->add_values(base + 0.125);
    return grpc::Status::OK;
  }
};

void serveFeatures(harness::Ctx& ctx) {
  static FeaturePeer* peer = nullptr;
  delete peer;
  peer = new FeaturePeer;
  ctx.GRPC.Server("")->RegisterService(peer);
}

size_t featureCalls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("UserFeatures").size(); }

std::vector<std::string> cachedKeys(harness::Ctx& ctx) {
  std::vector<std::string> out;
  for (const auto& k : ctx.Redis.Keys("features:*")) {
    if (k.rfind("features:stale:", 0) != 0) out.push_back(k);
  }
  return out;
}

std::string show(const std::optional<recs::Features>& f) {
  if (!f) return "nothing";
  std::ostringstream out;
  out << "{values [";
  for (size_t i = 0; i < f->values.size(); i++) out << (i ? " " : "") << f->values[i];
  out << "], stale " << (f->stale ? "true" : "false") << "}";
  return out.str();
}

bool same(const std::optional<recs::Features>& f, const std::vector<double>& values, bool stale) {
  return f && f->values == values && f->stale == stale;
}

}  // namespace

void CheckTenantKey(harness::Ctx& ctx) {
  serveFeatures(ctx);
  const auto first = loadFeatures("t1", "u-1");
  ctx.Assert(same(first, kT1, false), "loadFeatures(t1, u-1) gave %s, expected {values [0.25 0.375], stale false}", show(first));
  const auto other = loadFeatures("t2", "u-1");
  ctx.Assert(other && other->values == kT2, "user u-1 of tenant t2 got %s: tenant t1's vector, cached under a key without the tenant. Key the cache by (tenant, user)", show(other));
  ctx.Equal(featureCalls(ctx), 2, "two users of two tenants must make two feature-service calls; the calls");
  ctx.Equal(cachedKeys(ctx), {"features:t1:u-1", "features:t2:u-1"}, "the cache must hold features:{tenant}:{user_id}; it holds");
  const auto again = loadFeatures("t1", "u-1");
  ctx.Assert(same(again, kT1, false) && featureCalls(ctx) == 2, "a second read of t1/u-1 must be a cache hit, got %s after %d calls", show(again), featureCalls(ctx));
}

void CheckTtl(harness::Ctx& ctx) {
  serveFeatures(ctx);
  loadFeatures("t1", "u-1");
  const auto keys = cachedKeys(ctx);
  ctx.Assert(!keys.empty(), "loadFeatures cached nothing under features:*");
  const long long ttl = ctx.Redis.TTL(keys[0]);
  ctx.Assert(ttl > 0 && ttl <= 300, "%s has TTL %d: a vector cached without an expiry is served long after the user's behaviour changed. Write it with EX 300", keys[0], ttl);
  ctx.Clock.Advance(301);
  loadFeatures("t1", "u-1");
  ctx.Equal(featureCalls(ctx), 2, "301 s after the refresh the vector must have expired and been refreshed; the feature-service calls");
}

void CheckSingleFlight(harness::Ctx& ctx) {
  serveFeatures(ctx);
  // A second request for the same cold user lands right after this one took the refresh lock.
  auto fired = std::make_shared<bool>(false);
  auto seen = std::make_shared<std::optional<recs::Features>>();
  auto err = std::make_shared<std::string>();
  ctx.Redis.After("lock:features:t1:u-1", [fired, seen, err] {
    *fired = true;
    try {
      *seen = loadFeatures("t1", "u-1");
    } catch (const std::exception& e) {
      *err = e.what();
    }
  });
  const auto first = loadFeatures("t1", "u-1");
  ctx.Assert(*fired, "nothing took lock:features:t1:u-1: every request that misses calls the feature service. Take SET lock:features:{tenant}:{user_id} 1 NX EX 5 before refreshing");
  ctx.Assert(err->empty(), "the concurrent request failed: %s", *err);
  ctx.Equal(featureCalls(ctx), 1, "two requests for one cold user: the one that finds the lock taken must not refresh too; the feature-service calls");
  ctx.Assert(!seen->has_value(), "the request that found the lock taken answered %s: with no stale copy yet it has nothing to give", show(*seen));
  ctx.Assert(same(first, kT1, false), "the request holding the lock answered %s", show(first));
  ctx.Equal(ctx.Redis.Exists("lock:features:t1:u-1"), 0, "the lock outlived the refresh: release it once the vector is written; the lock keys");
  // A refresh that fails releases the lock, so the next request refreshes instead of waiting out its TTL.
  ctx.GRPC.Fail("UserFeatures", grpc::StatusCode::UNAVAILABLE, "restarting");
  loadFeatures("t1", "u-2");
  ctx.Equal(ctx.Redis.Exists("lock:features:t1:u-2"), 0, "a refresh that failed left lock:features:t1:u-2 behind: for 5 s nobody may refresh u-2. Release the lock in a scope guard; the lock keys");
  const auto got = loadFeatures("t1", "u-2");
  ctx.Assert(same(got, kT1, false), "once the feature service answered again, u-2 got %s", show(got));
}

void CheckStaleFallback(harness::Ctx& ctx) {
  serveFeatures(ctx);
  loadFeatures("t1", "u-1");
  const long long staleTtl = ctx.Redis.TTL("features:stale:t1:u-1");
  ctx.Assert(staleTtl != -2, "the refresh kept no copy at features:stale:t1:u-1: when the feature service is down there is nothing to fall back to");
  ctx.Assert(staleTtl > 300, "features:stale:t1:u-1 has TTL %d: the stale copy must outlive the cached vector (EX 86400)", staleTtl);
  ctx.Clock.Advance(301);  // the cached vector expired
  ctx.GRPC.Fail("UserFeatures", grpc::StatusCode::UNAVAILABLE, "restarting");
  const auto got = loadFeatures("t1", "u-1");
  ctx.Assert(same(got, kT1, true), "with the feature service down loadFeatures answered %s, expected the stale copy {values [0.25 0.375], stale true}", show(got));
}
`,
  },
  hints: [
    "Ask for user u-1 of tenant t2 right after u-1 of tenant t1: the second tenant gets the first one's vector. Restart the feature service and every ranking runs without features.",
    'The key carries only the user id and the SET has no expiry. A miss goes straight to the feature service with nothing stopping a second request doing the same, and its error has nowhere to fall back to.',
    'Key `features:{tenant}:{user_id}` with `EX 300`; before calling, `SET lock:… 1 NX EX 5` and answer the stale copy when it fails; write `features:stale:…` with `EX 86400`; catch the RPC error into that copy; delete the lock in `finally`.',
  ],
  debrief: `The cache key is the tenant boundary, which is why the tenant goes into it rather than into a check after the read. The lock is the whole single-flight mechanism: \`NX\` makes one request the refresher, the expiry bounds how long a crashed refresher can block the user, and releasing it on every path keeps a failed refresh from blocking for that long. The stale copy is what makes the failure mode ranking with old features rather than with none, and the flag lets the impression say so. Production feature stores refresh ahead of expiry so a busy key never goes cold, add jitter to TTLs so a bulk write does not expire all at once, and let a waiting request poll briefly before giving up.`,
};
