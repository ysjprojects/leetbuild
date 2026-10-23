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
        typescript: {all: [/`post:\$\{/], order: [/\.mget\(/, /\.GetPosts\(/]},
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
        typescript: {
          all: [/GetPosts\(\s*\{\s*ids:\s*\w+/],
          none: [/for \([^\n]*\)\s*\{?\s*\n?[^\n]*\.GetPosts\(/],
        },
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
        typescript: {all: [/\bdeadline:\s*|\{\s*deadline\s*\}/]},
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
        typescript: {
          all: [/\.pipeline\(/, /\.set\([^\n]*['"]EX['"]\s*,\s*(TTL_S|3600)\s*\)|\.setex\([^\n]*(TTL_S|3600)/],
        },
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
        typescript: {all: [/ids\.(filter|flatMap|map)\(|for \(const \w+ of ids\)/, /\w+ in \w+|\.has\(\s*\w+\s*\)/]},
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
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

export const DEADLINE_MS = 800;
export const TTL_S = 3600;

const redis = new Redis({host: 'redis', port: 6379});

export interface Post {
  id: string;
  author: string;
  text: string;
  media_ids: string[];
  created_at: number;
}

/** A Post as it arrives over the wire: int64 created_at is a decimal string. */
interface WirePost {
  id: string;
  author: string;
  text: string;
  media_ids: string[];
  created_at: string;
}

interface PostServiceClient {
  GetPosts(request: {ids: string[]}, options: {deadline: number}): Promise<{posts: WirePost[]}>;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('post.proto')) as unknown as {
  feed: {PostService: new (target: string, credentials: grpc.ChannelCredentials) => PostServiceClient};
};
const stub = new pkg.feed.PostService('post-service:9000', grpc.credentials.createInsecure());

export function toPost(post: WirePost): Post {
  return {id: post.id, author: post.author, text: post.text, media_ids: [...post.media_ids], created_at: Number(post.created_at)};
}

/** Posts for the given ids, in the order given; ids of deleted posts are skipped. */
export async function hydrate(ids: string[]): Promise<Post[]> {
  if (ids.length === 0) return [];
  // TODO: MGET post:{id} for all ids; parse hits into a map by id; collect the misses
  // TODO: one stub.GetPosts({ids: misses}, {deadline: Date.now() + DEADLINE_MS}) when there are misses
  // TODO: pipeline SET post:{id} json EX TTL_S for every fetched post
  // TODO: return the found posts in the order of ids (skip missing)
  throw new Error('not implemented');
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

export const DEADLINE_MS = 800;
export const TTL_S = 3600;

const redis = new Redis({host: 'redis', port: 6379});

export interface Post {
  id: string;
  author: string;
  text: string;
  media_ids: string[];
  created_at: number;
}

/** A Post as it arrives over the wire: int64 created_at is a decimal string. */
interface WirePost {
  id: string;
  author: string;
  text: string;
  media_ids: string[];
  created_at: string;
}

interface PostServiceClient {
  GetPosts(request: {ids: string[]}, options: {deadline: number}): Promise<{posts: WirePost[]}>;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('post.proto')) as unknown as {
  feed: {PostService: new (target: string, credentials: grpc.ChannelCredentials) => PostServiceClient};
};
const stub = new pkg.feed.PostService('post-service:9000', grpc.credentials.createInsecure());

export function toPost(post: WirePost): Post {
  return {id: post.id, author: post.author, text: post.text, media_ids: [...post.media_ids], created_at: Number(post.created_at)};
}

/** Posts for the given ids, in the order given; ids of deleted posts are skipped. */
export async function hydrate(ids: string[]): Promise<Post[]> {
  if (ids.length === 0) return [];
  const cached = await redis.mget(ids.map(id => \`post:\${id}\`));
  const found: Record<string, Post> = {};
  cached.forEach((raw, i) => {
    if (raw !== null) found[ids[i]] = JSON.parse(raw) as Post;
  });
  const misses = ids.filter(id => !(id in found));
  if (misses.length > 0) {
    const reply = await stub.GetPosts({ids: misses}, {deadline: Date.now() + DEADLINE_MS});
    const pipe = redis.pipeline();
    for (const post of reply.posts) {
      found[post.id] = toPost(post);
      pipe.set(\`post:\${post.id}\`, JSON.stringify(found[post.id]), 'EX', TTL_S);
    }
    await pipe.exec();
  }
  return ids.filter(id => id in found).map(id => found[id]);
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
  harness: {
    python: `import json

import grpc

import post_pb2
import post_pb2_grpc


def _post(pid):
    return {"id": pid, "author": "ann", "text": f"post {pid}", "media_ids": [f"m-{pid}"], "created_at": 1700000000000 + ord(pid)}


class FakePostService(post_pb2_grpc.PostServiceServicer):
    def __init__(self, served):
        self.posts = {pid: _post(pid) for pid in served}
        self.events = []  # ("rpc", ids) from here; ("direct", command) and ("pipeline", size) from the Redis spy

    def GetPosts(self, request, context):
        self.events.append(("rpc", list(request.ids)))
        found = [post_pb2.Post(**self.posts[pid]) for pid in request.ids if pid in self.posts]
        return post_pb2.GetPostsReply(posts=found)

    @property
    def calls(self):
        return [ids for kind, ids in self.events if kind == "rpc"]


def _hydrator(ctx, *served):
    peer = FakePostService(served)
    ctx.grpc.serve(post_pb2_grpc.add_PostServiceServicer_to_server, peer)
    m = ctx.load("post_hydrator")
    _spy(m.r, peer.events)
    return m, peer


def _cache(ctx, *ids):
    for pid in ids:
        ctx.redis.set(f"post:{pid}", json.dumps(_post(pid)))


def _spy(r, events):
    """Logs the learner's Redis round trips: direct command names and the size of every executed pipeline."""
    real_pipeline, real_execute = r.pipeline, r.execute_command

    def pipeline(*args, **kwargs):
        pipe = real_pipeline(*args, **kwargs)
        real_pipe_execute = pipe.execute

        def execute(*a, **k):
            events.append(("pipeline", len(pipe.command_stack)))
            return real_pipe_execute(*a, **k)

        pipe.execute = execute
        return pipe

    def execute_command(*args, **kwargs):
        events.append(("direct", str(args[0]).lower()))
        return real_execute(*args, **kwargs)

    r.pipeline = pipeline
    r.execute_command = execute_command


def _direct(peer, *names):
    return [c for kind, c in peer.events if kind == "direct" and c in names]


def check_mget_first(ctx):
    m, peer = _hydrator(ctx, "a", "b")
    _cache(ctx, "a")
    posts = m.hydrate(["a", "b"])
    assert posts == [_post("a"), _post("b")], f"hydrate must return the cached post a and the fetched post b, got {posts}"
    assert peer.calls == [["b"]], f"the cached post a must not be requested from the post service: GetPosts was asked for {peer.calls}"
    kinds = [(kind, c) for kind, c in peer.events if kind == "rpc" or c == "mget"]
    assert kinds and kinds[0][0] == "direct", "the cache must be read with one MGET before GetPosts is called"
    assert not _direct(peer, "get"), f"read the cache with one MGET, not {len(_direct(peer, 'get'))} GETs"
    posts = m.hydrate(["a"])
    assert posts == [_post("a")] and len(peer.calls) == 1, "when every id is cached GetPosts must not be called at all"


def check_single_rpc(ctx):
    m, peer = _hydrator(ctx, "b", "c", "d")
    posts = m.hydrate(["b", "c", "d"])
    assert posts == [_post("b"), _post("c"), _post("d")], f"unexpected posts {posts}"
    calls = ctx.grpc.calls_to("GetPosts")
    assert len(calls) == 1, f"3 cache misses must be fetched with one GetPosts call, observed {len(calls)}"
    assert list(calls[0].request.ids) == ["b", "c", "d"], f"the request must carry every missed id, got {list(calls[0].request.ids)}"


def check_deadline(ctx):
    m, peer = _hydrator(ctx, "b", "c")
    assert m.hydrate(["b"]) == [_post("b")]
    call = ctx.grpc.calls_to("GetPosts")[-1]
    assert call.timeout is not None, "the RPC carries no deadline"
    assert 0.5 <= call.timeout <= 1.0, f"the deadline must be about 800 ms, got {call.timeout} s"
    ctx.grpc.set_latency("GetPosts", 3.0)
    try:
        m.hydrate(["c"])
        raise AssertionError("a post service slower than the deadline must surface DEADLINE_EXCEEDED")
    except grpc.RpcError as e:
        assert e.code() == grpc.StatusCode.DEADLINE_EXCEEDED, f"a slow post service raised {e.code()}, expected DEADLINE_EXCEEDED"


def check_write_back(ctx):
    m, peer = _hydrator(ctx, "b", "c")
    m.hydrate(["b", "c"])
    for pid in ("b", "c"):
        raw = ctx.redis.get(f"post:{pid}")
        assert raw is not None, f"post:{pid} must be cached after it was fetched"
        assert json.loads(raw) == _post(pid), f"post:{pid} must hold the post as JSON, got {raw!r}"
        ttl = ctx.redis.ttl(f"post:{pid}")
        assert 3000 < ttl <= 3600, f"post:{pid} must expire after an hour (EX 3600), its TTL is {ttl}"
    sets = _direct(peer, "set", "setex")
    assert not sets, f"{len(sets)} SET(s) were sent one by one: write the fetched posts back through one pipeline"
    sizes = [n for kind, n in peer.events if kind == "pipeline"]
    assert sizes == [2], f"expected one pipeline carrying the 2 SETs, observed pipeline command counts {sizes}"
    m.hydrate(["b", "c"])
    assert len(peer.calls) == 1, "once written back, the next hydration of the same ids must not call GetPosts"
    ctx.clock.advance(3601)
    assert ctx.redis.get("post:b") is None, "the cache entry must be gone an hour later"


def check_order_kept(ctx):
    m, peer = _hydrator(ctx, "b")
    _cache(ctx, "a", "c")
    posts = m.hydrate(["d", "c", "b", "a"])
    ids = [p.get("id") for p in posts]
    assert ids == ["c", "b", "a"], f"posts must come back in the input order with the deleted post d skipped, got {ids}"
    assert m.hydrate(["d"]) == [], "a page of only deleted posts is an empty list, not an error"
    assert m.hydrate([]) == [] and len(peer.calls) == 2, "an empty id list must not call the post service"
`,
    typescript: `interface Post {
  id: string;
  author: string;
  text: string;
  media_ids: string[];
  created_at: number;
}

function post(id: string): Post {
  return {id, author: 'ann', text: \`post \${id}\`, media_ids: [\`m-\${id}\`], created_at: 1700000000000 + id.charCodeAt(0)};
}

/** The post service: knows \`served\`, records the ids of every request; \`onCall\` runs as a request arrives. */
function hydrator(ctx, served: string[], onCall: () => void = () => undefined) {
  const known: Record<string, Post> = {};
  for (const id of served) known[id] = post(id);
  const calls: string[][] = [];
  ctx.grpc.serve(ctx.proto('post.proto').feed.PostService.service, {
    GetPosts(call, callback) {
      const ids: string[] = [...call.request.ids];
      calls.push(ids);
      onCall();
      callback(null, {posts: ids.filter(id => id in known).map(id => known[id])});
    },
  });
  const m = ctx.load('post_hydrator');
  return {m, calls};
}

function cache(ctx, ...ids: string[]) {
  for (const id of ids) ctx.redis.set(\`post:\${id}\`, JSON.stringify(post(id)));
}

export async function check_mget_first(ctx) {
  let tripsAtRpc: string[][] | null = null;
  const {m, calls} = hydrator(ctx, ['a', 'b'], () => {
    tripsAtRpc ??= ctx.redisRoundTrips();
  });
  cache(ctx, 'a');
  let posts = await m.hydrate(['a', 'b']);
  assert.deepStrictEqual(posts, [post('a'), post('b')], \`hydrate must return the cached post a and the fetched post b, got \${JSON.stringify(posts)}\`);
  assert.deepStrictEqual(calls, [['b']], \`the cached post a must not be requested from the post service: GetPosts was asked for \${JSON.stringify(calls)}\`);
  assert(tripsAtRpc !== null && tripsAtRpc.some(t => t.includes('MGET')), 'the cache must be read with one MGET before GetPosts is called');
  const gets = ctx.redisRoundTrips().filter(t => t.includes('GET'));
  assert.equal(gets.length, 0, \`read the cache with one MGET, not \${gets.length} GETs\`);
  posts = await m.hydrate(['a']);
  assert(JSON.stringify(posts) === JSON.stringify([post('a')]) && calls.length === 1, 'when every id is cached GetPosts must not be called at all');
}

export async function check_single_rpc(ctx) {
  const {m} = hydrator(ctx, ['b', 'c', 'd']);
  const posts = await m.hydrate(['b', 'c', 'd']);
  assert.deepStrictEqual(posts, [post('b'), post('c'), post('d')], \`unexpected posts \${JSON.stringify(posts)}\`);
  const calls = ctx.grpc.callsTo('GetPosts');
  assert.equal(calls.length, 1, \`3 cache misses must be fetched with one GetPosts call, observed \${calls.length}\`);
  assert.deepStrictEqual([...calls[0].request.ids], ['b', 'c', 'd'], \`the request must carry every missed id, got \${JSON.stringify(calls[0].request.ids)}\`);
}

export async function check_deadline(ctx) {
  const {m} = hydrator(ctx, ['b', 'c']);
  assert.deepStrictEqual(await m.hydrate(['b']), [post('b')]);
  const calls = ctx.grpc.callsTo('GetPosts');
  const call = calls[calls.length - 1];
  assert(call.timeout !== null, 'the RPC carries no deadline');
  assert(0.5 <= call.timeout && call.timeout <= 1.0, \`the deadline must be about 800 ms, got \${call.timeout} s\`);
  ctx.grpc.setLatency('GetPosts', 3.0);
  let error: {code?: number; message?: string} | null = null;
  try {
    await m.hydrate(['c']);
  } catch (e) {
    error = e;
  }
  assert(error !== null, 'a post service slower than the deadline must surface DEADLINE_EXCEEDED');
  assert.equal(error.code, ctx.grpc.status.DEADLINE_EXCEEDED, \`a slow post service raised \${error.code ?? error.message}, expected DEADLINE_EXCEEDED\`);
}

export async function check_write_back(ctx) {
  const {m, calls} = hydrator(ctx, ['b', 'c']);
  await m.hydrate(['b', 'c']);
  for (const id of ['b', 'c']) {
    const raw = ctx.redis.get(\`post:\${id}\`);
    assert(raw !== null, \`post:\${id} must be cached after it was fetched\`);
    assert.deepStrictEqual(JSON.parse(raw), post(id), \`post:\${id} must hold the post as JSON, got \${JSON.stringify(raw)}\`);
    const ttl = ctx.redis.ttl(\`post:\${id}\`);
    assert(3000 < ttl && ttl <= 3600, \`post:\${id} must expire after an hour (EX 3600), its TTL is \${ttl}\`);
  }
  const trips = ctx.redisRoundTrips();
  const sets = trips.filter(t => t.length === 1 && (t[0] === 'SET' || t[0] === 'SETEX'));
  assert.equal(sets.length, 0, \`\${sets.length} SET(s) were sent one by one: write the fetched posts back through one pipeline\`);
  const sizes = trips.filter(t => t.length > 1).map(t => t.length);
  assert.deepStrictEqual(sizes, [2], \`expected one pipeline carrying the 2 SETs, observed pipeline command counts \${JSON.stringify(sizes)}\`);
  await m.hydrate(['b', 'c']);
  assert.equal(calls.length, 1, 'once written back, the next hydration of the same ids must not call GetPosts');
  ctx.clock.advance(3601);
  assert.equal(ctx.redis.get('post:b'), null, 'the cache entry must be gone an hour later');
}

export async function check_order_kept(ctx) {
  const {m, calls} = hydrator(ctx, ['b']);
  cache(ctx, 'a', 'c');
  const posts = await m.hydrate(['d', 'c', 'b', 'a']);
  const ids = posts.map(p => p.id);
  assert.deepStrictEqual(ids, ['c', 'b', 'a'], \`posts must come back in the input order with the deleted post d skipped, got \${JSON.stringify(ids)}\`);
  assert.deepStrictEqual(await m.hydrate(['d']), [], 'a page of only deleted posts is an empty list, not an error');
  assert(JSON.stringify(await m.hydrate([])) === '[]' && calls.length === 2, 'an empty id list must not call the post service');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"reflect"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"leetbuild/harness"

	pb "feed/gen/post"
)

func samplePost(id string) Post {
	return Post{ID: id, Author: "ann", Text: "post " + id, MediaIDs: []string{"m-" + id}, CreatedAt: 1700000000000 + int64(id[0])}
}

// postPeer is the post service: knows its posts, records the ids of every request; onCall runs as a request arrives.
type postPeer struct {
	pb.UnimplementedPostServiceServer
	known  map[string]bool
	calls  [][]string
	onCall func()
}

func (p *postPeer) GetPosts(_ context.Context, req *pb.GetPostsRequest) (*pb.GetPostsReply, error) {
	ids := append([]string{}, req.GetIds()...)
	p.calls = append(p.calls, ids)
	if p.onCall != nil {
		p.onCall()
	}
	reply := &pb.GetPostsReply{}
	for _, id := range ids {
		if p.known[id] {
			s := samplePost(id)
			reply.Posts = append(reply.Posts, &pb.Post{Id: s.ID, Author: s.Author, Text: s.Text, MediaIds: s.MediaIDs, CreatedAt: s.CreatedAt})
		}
	}
	return reply, nil
}

func servePosts(ctx *harness.Ctx, served ...string) *postPeer {
	peer := &postPeer{known: map[string]bool{}}
	for _, id := range served {
		peer.known[id] = true
	}
	pb.RegisterPostServiceServer(ctx.GRPC.Server(""), peer)
	return peer
}

func cacheIDs(ctx *harness.Ctx, ids ...string) {
	for _, id := range ids {
		doc, _ := json.Marshal(samplePost(id))
		ctx.Redis.Set("post:"+id, string(doc))
	}
}

func hydrateIDs(ctx *harness.Ctx, ids ...string) []Post {
	posts, err := Hydrate(context.Background(), append([]string{}, ids...))
	ctx.NoError(err, "Hydrate(%q) returned an error", ids)
	return posts
}

func CheckMgetFirst(ctx *harness.Ctx) {
	var tripsAtRPC [][]string
	rpcSeen := false
	peer := servePosts(ctx, "a", "b")
	peer.onCall = func() {
		if !rpcSeen {
			rpcSeen = true
			tripsAtRPC = ctx.Redis.RoundTrips()
		}
	}
	cacheIDs(ctx, "a")
	posts := hydrateIDs(ctx, "a", "b")
	ctx.Equal(posts, []Post{samplePost("a"), samplePost("b")}, "Hydrate must return the cached post a and the fetched post b")
	ctx.Equal(peer.calls, [][]string{{"b"}}, "the cached post a must not be requested from the post service: GetPosts requests")
	mget := false
	for _, trip := range tripsAtRPC {
		for _, command := range trip {
			mget = mget || command == "MGET"
		}
	}
	ctx.Assert(rpcSeen && mget, "the cache must be read with one MGet before GetPosts is called")
	gets := 0
	for _, trip := range ctx.Redis.RoundTrips() {
		for _, command := range trip {
			if command == "GET" {
				gets++
				break
			}
		}
	}
	ctx.Assert(gets == 0, "read the cache with one MGet, not %d GETs", gets)
	posts = hydrateIDs(ctx, "a")
	ctx.Assert(reflect.DeepEqual(posts, []Post{samplePost("a")}) && len(peer.calls) == 1, "when every id is cached GetPosts must not be called at all")
}

func CheckSingleRpc(ctx *harness.Ctx) {
	servePosts(ctx, "b", "c", "d")
	posts := hydrateIDs(ctx, "b", "c", "d")
	ctx.Equal(posts, []Post{samplePost("b"), samplePost("c"), samplePost("d")}, "unexpected posts")
	calls := ctx.GRPC.CallsTo("GetPosts", "")
	ctx.Equal(len(calls), 1, "3 cache misses must be fetched with one GetPosts call")
	req, _ := calls[0].Request.(*pb.GetPostsRequest)
	ctx.Equal(req.GetIds(), []string{"b", "c", "d"}, "the request must carry every missed id")
}

func CheckDeadline(ctx *harness.Ctx) {
	servePosts(ctx, "b", "c")
	ctx.Equal(hydrateIDs(ctx, "b"), []Post{samplePost("b")}, "Hydrate([b])")
	calls := ctx.GRPC.CallsTo("GetPosts", "")
	call := calls[len(calls)-1]
	ctx.Assert(call.HasDeadline(), "the RPC carries no deadline")
	ctx.Assert(0.5 <= call.Timeout.Seconds() && call.Timeout.Seconds() <= 1.0, "the deadline must be about 800 ms, got %v", call.Timeout)
	ctx.GRPC.SetLatency("GetPosts", 3.0, "")
	_, err := Hydrate(context.Background(), []string{"c"})
	ctx.Assert(err != nil, "a post service slower than the deadline must surface DEADLINE_EXCEEDED")
	ctx.Equal(status.Code(err), codes.DeadlineExceeded, "a slow post service raised %v", err)
}

func CheckWriteBack(ctx *harness.Ctx) {
	peer := servePosts(ctx, "b", "c")
	hydrateIDs(ctx, "b", "c")
	for _, id := range []string{"b", "c"} {
		raw, ok := ctx.Redis.Get("post:" + id)
		ctx.Assert(ok, "post:%s must be cached after it was fetched", id)
		var cached, want map[string]any
		doc, _ := json.Marshal(samplePost(id))
		json.Unmarshal(doc, &want)
		ctx.NoError(json.Unmarshal([]byte(raw), &cached), "post:%s must hold the post as JSON, got %q", id, raw)
		ctx.Equal(cached, want, "post:%s must hold the post as JSON", id)
		ttl := ctx.Redis.TTL("post:" + id)
		ctx.Assert(3000 < ttl && ttl <= 3600, "post:%s must expire after an hour (EX 3600), its TTL is %d", id, ttl)
	}
	sets := 0
	var sizes []int
	for _, trip := range ctx.Redis.RoundTrips() {
		if len(trip) == 1 && (trip[0] == "SET" || trip[0] == "SETEX") {
			sets++
		} else if len(trip) > 1 {
			sizes = append(sizes, len(trip))
		}
	}
	ctx.Assert(sets == 0, "%d SET(s) were sent one by one: write the fetched posts back through one pipeline", sets)
	ctx.Equal(sizes, []int{2}, "expected one pipeline carrying the 2 SETs: pipeline command counts")
	hydrateIDs(ctx, "b", "c")
	ctx.Equal(len(peer.calls), 1, "once written back, the next hydration of the same ids must not call GetPosts")
	ctx.Clock.Advance(3601)
	_, cached := ctx.Redis.Get("post:b")
	ctx.Assert(!cached, "the cache entry must be gone an hour later")
}

func CheckOrderKept(ctx *harness.Ctx) {
	peer := servePosts(ctx, "b")
	cacheIDs(ctx, "a", "c")
	var ids []string
	for _, p := range hydrateIDs(ctx, "d", "c", "b", "a") {
		ids = append(ids, p.ID)
	}
	ctx.Equal(ids, []string{"c", "b", "a"}, "posts must come back in the input order with the deleted post d skipped")
	ctx.Assert(len(hydrateIDs(ctx, "d")) == 0, "a page of only deleted posts is an empty list, not an error")
	ctx.Assert(len(hydrateIDs(ctx)) == 0 && len(peer.calls) == 2, "an empty id list must not call the post service")
}
`,
  },
  debrief: `Hydration is where a feed's latency budget is really spent, and two decisions keep it flat: the cache is read with one \`MGET\` instead of N \`GET\`s, and the misses are fetched with one RPC instead of N. The write-back makes the cache fill itself from the long tail of pages, and the TTL bounds memory for posts nobody will ask for again. Returning in input order with missing ids skipped is what lets the timeline keep ids of deleted posts for a while without the client ever seeing a hole. Real hydrators add a per-request dedupe (the same id on two pages), negative caching for ids that keep missing, and a hedge: if the RPC exceeds a soft deadline, serve the page with the cached posts only.`,
};
