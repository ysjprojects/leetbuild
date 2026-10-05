import type {Step} from '@/lib/types';

export const hydratePostsStep: Step = {
  id: 'hydrate-posts',
  title: 'Hydrate ids: MGET, then one batched RPC',
  concept: 'grpc',
  file: 'post_hydrator',
  focus: ['api', 'redis', 'postsvc'],
  task: `## Task

A timeline page is a list of ids; the client needs posts. The post service owns them:

\`\`\`proto
service PostService {
  rpc GetPosts(GetPostsRequest) returns (GetPostsReply);
}
message GetPostsRequest { repeated string ids = 1; }
message GetPostsReply   { repeated Post posts = 1; }
message Post { string id = 1; string author = 2; string text = 3; repeated string media_ids = 4; int64 created_at = 5; }
\`\`\`

Implement \`hydrate(ids)\` on top of the generated stub and a Redis cache:

- **Cache first**: one \`MGET post:{id} …\` for all ids. Posts are immutable once published, so a hit is
  always correct.
- **One RPC for the misses**: \`GetPosts\` with the list of ids that were not cached — never one call per
  id — with a **deadline of 800 ms**. If nothing missed, do not call at all.
- **Write back** every fetched post: \`SET post:{id} <json> EX 3600\`, all in one pipeline.
- A **deleted post** simply is not in the reply: skip it, it is not an error.
- Return the posts in the **order of the input ids** — the timeline decided the order, not the cache.

:::widget grpc-streams {"mode": "unary"}

:::widget deadline-retry {"base": 100, "deadline": 800, "attempts": 1}`,
  sequence: {
    participants: ['feed-api', 'Redis', 'PostService'],
    messages: [
      {from: 'feed-api', to: 'Redis', label: 'MGET post:a post:b post:c post:d', kind: 'sync'},
      {from: 'Redis', to: 'feed-api', label: '[json, nil, json, nil]', kind: 'reply'},
      {from: 'feed-api', to: 'PostService', label: 'GetPosts(ids=[b, d]) · deadline 800 ms', kind: 'sync'},
      {from: 'PostService', to: 'feed-api', label: 'GetPostsReply{posts=[b]} (d was deleted)', kind: 'reply'},
      {from: 'feed-api', to: 'Redis', label: 'pipeline: SET post:b <json> EX 3600', kind: 'sync'},
      {from: 'feed-api', to: 'feed-api', label: 'return [a, b, c] in input order', kind: 'sync'},
    ],
  },
  hints: [
    'Keep a map from id to post. Fill it from the MGET replies (they line up with the ids), collect the ids still missing, and only then talk to the stub.',
    'The request is one message with a repeated field — build it from the misses list; the deadline goes on the call (timeout argument, context, stub option, client context).',
    'The final answer is a walk over the *input* ids, picking from the map and skipping ids that are not in it; that gives both the ordering and the tolerance for deleted posts for free.',
  ],
  checks: [
    {
      id: 'mget-first',
      title: 'Reads the cache with one MGET before the RPC',
      detail: 'A single `MGET post:{id} …` for every id comes first; the post service is only asked afterwards.',
      match: {
        python: {all: [/f"post:\{/], order: [/\.mget\(/, /stub\.GetPosts\(/]},
        go: {all: [/"post:"\s*\+|"post:%s"/], order: [/\.MGet\(/, /stub\.GetPosts\(/]},
        scala: {all: [/s"post:\$/], order: [/\.mget\(/, /\.getPosts\(/]},
        cpp: {all: [/"post:"\s*\+/], order: [/\.mget\(/, /->GetPosts\(/]},
      },
    },
    {
      id: 'single-rpc',
      title: 'Fetches all misses in one GetPosts call',
      detail:
        'Build one `GetPostsRequest` whose `ids` are the cache misses; a call per id multiplies latency by the page size.',
      match: {
        python: {all: [/GetPostsRequest\(\s*ids\s*=\s*\w+/], none: [/for \w+ in \w+:\s*\n[^\n]*GetPosts\(/]},
        go: {all: [/GetPostsRequest\{\s*Ids:\s*\w+/], none: [/for [^\n]*\{\s*\n[^\n]*\.GetPosts\(/]},
        scala: {
          all: [/GetPostsRequest\(\s*(ids\s*=\s*)?\w+/],
          none: [/\.foreach\s*\{[^\n]*\n[^\n]*getPosts\(|for \([^\n]*\)\s*\{?\s*\n?[^\n]*getPosts\(/],
        },
        cpp: {all: [/add_ids\(|mutable_ids\(\)/], none: [/for \([^\n]*\)\s*\{?\s*\n?[^\n]*->GetPosts\(/]},
      },
    },
    {
      id: 'deadline',
      title: 'Sets an 800 ms deadline on the call',
      detail: 'The RPC carries a deadline so a slow post service cannot hold the feed request open.',
      match: {
        python: {all: [/GetPosts\([^\n]*timeout\s*=/]},
        go: {all: [/context\.WithTimeout\(/]},
        scala: {all: [/withDeadlineAfter\(/]},
        cpp: {all: [/set_deadline\(/]},
      },
    },
    {
      id: 'write-back',
      title: 'Caches fetched posts for an hour, pipelined',
      detail:
        'Every post the service returned is written with `SET post:{id} <json> EX 3600` through one pipeline so the next page does not miss again.',
      match: {
        python: {all: [/\.pipeline\(/, /\.set\([^\n]*ex\s*=\s*(TTL_S|3600)\s*\)|\.setex\([^\n]*(TTL_S|3600)/]},
        go: {all: [/\.Pipeline\(\)/, /\.Set\(\s*ctx\s*,[^\n]*,\s*(ttl|time\.Hour|3600\s*\*\s*time\.Second)\s*\)/]},
        scala: {all: [/\.pipelined\(\)/, /\.setex\([^\n]*(TtlSeconds|3600)/]},
        cpp: {all: [/\.pipeline\(/, /\.set\([^\n]*,\s*(kTtl|std::chrono::seconds[{(]\s*3600)/]},
      },
    },
    {
      id: 'order-kept',
      title: 'Keeps the input order and skips deleted posts',
      detail:
        'Walk the input `ids`, look each up in what was found, and skip the ones that are missing — the page order comes from the timeline, not from Redis or the RPC.',
      match: {
        python: {all: [/for \w+ in ids\b/, /if \w+ in \w+/]},
        go: {all: [/range ids\b/, /, ok :=\s*\w+\[\s*\w+\s*\];\s*ok\b/]},
        scala: {all: [/ids\.flatMap\(|ids\.collect\b/]},
        cpp: {all: [/:\s*ids\s*\)/, /\.find\(\s*\w+\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import grpc
import redis

import post_pb2
import post_pb2_grpc

DEADLINE_S = 0.8
TTL_S = 3600

r = redis.Redis(host="redis", port=6379, decode_responses=True)
channel = grpc.insecure_channel("post-service:9000")
stub = post_pb2_grpc.PostServiceStub(channel)


def to_dict(post: post_pb2.Post) -> dict:
    return {"id": post.id, "author": post.author, "text": post.text, "media_ids": list(post.media_ids), "created_at": post.created_at}


def hydrate(ids: list[str]) -> list[dict]:
    """Posts for the given ids, in the order given; ids of deleted posts are skipped."""
    if not ids:
        return []
    # TODO: MGET post:{id} for all ids; parse hits into a dict by id; collect the misses
    # TODO: one stub.GetPosts(GetPostsRequest(ids=misses), timeout=DEADLINE_S) when there are misses
    # TODO: pipeline SET post:{id} json EX TTL_S for every fetched post
    # TODO: return the found posts in the order of ids (skip missing)
    raise NotImplementedError
`,
      solution: `import json

import grpc
import redis

import post_pb2
import post_pb2_grpc

DEADLINE_S = 0.8
TTL_S = 3600

r = redis.Redis(host="redis", port=6379, decode_responses=True)
channel = grpc.insecure_channel("post-service:9000")
stub = post_pb2_grpc.PostServiceStub(channel)


def to_dict(post: post_pb2.Post) -> dict:
    return {"id": post.id, "author": post.author, "text": post.text, "media_ids": list(post.media_ids), "created_at": post.created_at}


def hydrate(ids: list[str]) -> list[dict]:
    """Posts for the given ids, in the order given; ids of deleted posts are skipped."""
    if not ids:
        return []
    cached = r.mget([f"post:{pid}" for pid in ids])
    found = {pid: json.loads(raw) for pid, raw in zip(ids, cached) if raw is not None}
    misses = [pid for pid in ids if pid not in found]
    if misses:
        reply = stub.GetPosts(post_pb2.GetPostsRequest(ids=misses), timeout=DEADLINE_S)
        pipe = r.pipeline(transaction=False)
        for post in reply.posts:
            found[post.id] = to_dict(post)
            pipe.set(f"post:{post.id}", json.dumps(found[post.id]), ex=TTL_S)
        pipe.execute()
    return [found[pid] for pid in ids if pid in found]
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

	pb "feed/gen/post"
)

const (
	deadline = 800 * time.Millisecond
	ttl      = time.Hour
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})
var conn, _ = grpc.NewClient("post-service:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewPostServiceClient(conn)

type Post struct {
	ID        string   \`json:"id"\`
	Author    string   \`json:"author"\`
	Text      string   \`json:"text"\`
	MediaIDs  []string \`json:"media_ids"\`
	CreatedAt int64    \`json:"created_at"\`
}

func fromProto(p *pb.Post) Post {
	return Post{ID: p.GetId(), Author: p.GetAuthor(), Text: p.GetText(), MediaIDs: p.GetMediaIds(), CreatedAt: p.GetCreatedAt()}
}

// Hydrate returns the posts for the given ids, in the order given; ids of deleted posts are skipped.
func Hydrate(ctx context.Context, ids []string) ([]Post, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	// TODO: MGet post:{id} for all ids; unmarshal hits into a map by id; collect the misses
	// TODO: one stub.GetPosts(&pb.GetPostsRequest{Ids: misses}) with a context that expires after \`deadline\`
	// TODO: pipeline Set post:{id} json ttl for every fetched post
	// TODO: return the found posts in the order of ids (skip missing)
	_ = json.Marshal
	_ = fromProto
	return nil, nil
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

	pb "feed/gen/post"
)

const (
	deadline = 800 * time.Millisecond
	ttl      = time.Hour
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})
var conn, _ = grpc.NewClient("post-service:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewPostServiceClient(conn)

type Post struct {
	ID        string   \`json:"id"\`
	Author    string   \`json:"author"\`
	Text      string   \`json:"text"\`
	MediaIDs  []string \`json:"media_ids"\`
	CreatedAt int64    \`json:"created_at"\`
}

func fromProto(p *pb.Post) Post {
	return Post{ID: p.GetId(), Author: p.GetAuthor(), Text: p.GetText(), MediaIDs: p.GetMediaIds(), CreatedAt: p.GetCreatedAt()}
}

// Hydrate returns the posts for the given ids, in the order given; ids of deleted posts are skipped.
func Hydrate(ctx context.Context, ids []string) ([]Post, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	keys := make([]string, len(ids))
	for i, id := range ids {
		keys[i] = "post:" + id
	}
	cached, err := rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	found := make(map[string]Post, len(ids))
	var misses []string
	for i, raw := range cached {
		var p Post
		if s, hit := raw.(string); hit && json.Unmarshal([]byte(s), &p) == nil {
			found[ids[i]] = p
		} else {
			misses = append(misses, ids[i])
		}
	}
	if len(misses) > 0 {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		defer cancel()
		reply, err := stub.GetPosts(callCtx, &pb.GetPostsRequest{Ids: misses})
		if err != nil {
			return nil, err
		}
		pipe := rdb.Pipeline()
		for _, p := range reply.GetPosts() {
			post := fromProto(p)
			found[post.ID] = post
			doc, _ := json.Marshal(post)
			pipe.Set(ctx, "post:"+post.ID, doc, ttl)
		}
		if _, err := pipe.Exec(ctx); err != nil {
			return nil, err
		}
	}
	out := make([]Post, 0, len(ids))
	for _, id := range ids {
		if p, ok := found[id]; ok {
			out = append(out, p)
		}
	}
	return out, nil
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder
import redis.clients.jedis.JedisPooled
import scala.collection.mutable
import scala.jdk.CollectionConverters._

import feed.post.{GetPostsRequest, Post, PostServiceGrpc}
import feed.json.PostJson // PostJson.encode(post): String, PostJson.decode(json): Option[Post] — provided

object PostHydrator {
  val DeadlineMillis = 800L
  val TtlSeconds = 3600L

  val jedis = new JedisPooled("redis", 6379)
  private val channel = ManagedChannelBuilder.forAddress("post-service", 9000).usePlaintext().build()
  private val stub = PostServiceGrpc.blockingStub(channel)

  /** Posts for the given ids, in the order given; ids of deleted posts are skipped. */
  def hydrate(ids: Seq[String]): Seq[Post] = {
    if (ids.isEmpty) return Nil
    val found = mutable.Map.empty[String, Post]
    // TODO: mget post:{id} for all ids; decode hits into found; collect the misses
    // TODO: one getPosts(GetPostsRequest(ids = misses)) with withDeadlineAfter(DeadlineMillis) when there are misses
    // TODO: pipeline setex post:{id} TtlSeconds json for every fetched post
    // TODO: return the found posts in the order of ids (skip missing)
    Nil
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder
import redis.clients.jedis.JedisPooled
import scala.collection.mutable
import scala.jdk.CollectionConverters._

import feed.post.{GetPostsRequest, Post, PostServiceGrpc}
import feed.json.PostJson // PostJson.encode(post): String, PostJson.decode(json): Option[Post] — provided

object PostHydrator {
  val DeadlineMillis = 800L
  val TtlSeconds = 3600L

  val jedis = new JedisPooled("redis", 6379)
  private val channel = ManagedChannelBuilder.forAddress("post-service", 9000).usePlaintext().build()
  private val stub = PostServiceGrpc.blockingStub(channel)

  /** Posts for the given ids, in the order given; ids of deleted posts are skipped. */
  def hydrate(ids: Seq[String]): Seq[Post] = {
    if (ids.isEmpty) return Nil
    val found = mutable.Map.empty[String, Post]
    val cached = jedis.mget(ids.map(id => s"post:$id"): _*).asScala
    ids.zip(cached).foreach { case (id, raw) =>
      Option(raw).flatMap(PostJson.decode).foreach(post => found(id) = post)
    }
    val misses = ids.filterNot(found.contains)
    if (misses.nonEmpty) {
      val reply = stub.withDeadlineAfter(DeadlineMillis, TimeUnit.MILLISECONDS).getPosts(GetPostsRequest(ids = misses))
      val p = jedis.pipelined()
      reply.posts.foreach { post =>
        found(post.id) = post
        p.setex(s"post:\${post.id}", TtlSeconds, PostJson.encode(post))
      }
      p.sync()
    }
    ids.flatMap(found.get)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include "post.grpc.pb.h"
#include "feed/post_json.h"  // post_json::encode(const feed::Post&) -> std::string, post_json::decode(json) -> std::optional<feed::Post> — provided

constexpr std::chrono::milliseconds kDeadline{800};
constexpr std::chrono::seconds kTtl{3600};

sw::redis::Redis redis("tcp://redis:6379");
auto channel = grpc::CreateChannel("post-service:9000", grpc::InsecureChannelCredentials());
auto stub = feed::PostService::NewStub(channel);

// Posts for the given ids, in the order given; ids of deleted posts are skipped.
std::vector<feed::Post> hydrate(const std::vector<std::string>& ids) {
  if (ids.empty()) return {};
  std::unordered_map<std::string, feed::Post> found;
  // TODO: mget post:{id} for all ids; decode hits into found; collect the misses
  // TODO: one stub->GetPosts with add_ids(miss) for every miss and a ClientContext deadline of now + kDeadline
  // TODO: pipeline set post:{id} json kTtl for every fetched post
  // TODO: return the found posts in the order of ids (skip missing)
  return {};
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include "post.grpc.pb.h"
#include "feed/post_json.h"  // post_json::encode(const feed::Post&) -> std::string, post_json::decode(json) -> std::optional<feed::Post> — provided

constexpr std::chrono::milliseconds kDeadline{800};
constexpr std::chrono::seconds kTtl{3600};

sw::redis::Redis redis("tcp://redis:6379");
auto channel = grpc::CreateChannel("post-service:9000", grpc::InsecureChannelCredentials());
auto stub = feed::PostService::NewStub(channel);

// Posts for the given ids, in the order given; ids of deleted posts are skipped.
std::vector<feed::Post> hydrate(const std::vector<std::string>& ids) {
  if (ids.empty()) return {};
  std::unordered_map<std::string, feed::Post> found;
  std::vector<std::string> keys;
  for (const auto& id : ids) keys.push_back("post:" + id);
  std::vector<std::optional<std::string>> cached;
  redis.mget(keys.begin(), keys.end(), std::back_inserter(cached));
  std::vector<std::string> misses;
  for (std::size_t i = 0; i < ids.size(); ++i) {
    const auto post = cached[i] ? post_json::decode(*cached[i]) : std::nullopt;
    if (post) found[ids[i]] = *post;
    else misses.push_back(ids[i]);
  }
  if (!misses.empty()) {
    feed::GetPostsRequest request;
    for (const auto& id : misses) request.add_ids(id);
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    feed::GetPostsReply reply;
    const grpc::Status status = stub->GetPosts(&ctx, request, &reply);
    if (!status.ok()) throw std::runtime_error("post-service: " + status.error_message());
    auto pipe = redis.pipeline(false);
    for (const auto& post : reply.posts()) {
      found[post.id()] = post;
      pipe.set("post:" + post.id(), post_json::encode(post), kTtl);
    }
    pipe.exec();
  }
  std::vector<feed::Post> out;
  for (const auto& id : ids) {
    const auto it = found.find(id);
    if (it != found.end()) out.push_back(it->second);
  }
  return out;
}
`,
    },
  },
  debrief: `Hydration is where a feed's latency budget is really spent, and two decisions keep it flat: the cache is read with one \`MGET\` instead of N \`GET\`s, and the misses are fetched with one RPC instead of N. The write-back makes the cache fill itself from the long tail of pages, and the TTL bounds memory for posts nobody will ask for again. Returning in input order with missing ids skipped is what lets the timeline keep ids of deleted posts for a while without the client ever seeing a hole. Real hydrators add a per-request dedupe (the same id on two pages), negative caching for ids that keep missing, and a hedge: if the RPC exceeds a soft deadline, serve the page with the cached posts only.`,
};
