/**
 * Provided runtime modules the news-feed starters import but no step builds: the follow graph,
 * the post store, the `posts` topic publisher and the id ↔ timestamp helper.
 */
export const supportModules: Record<string, string> = {
  'feed/graph.py': `"""The follow graph (provided). In-memory tables the harness and your own experiments can fill."""

FOLLOWERS: dict[str, list[str]] = {}
CELEBRITIES_FOLLOWED: dict[str, list[str]] = {}


def followers(author_id: str) -> list[str]:
    """Ids of every user following author_id."""
    return list(FOLLOWERS.get(author_id, []))


def celebrities_followed(user_id: str) -> list[str]:
    """Ids of the celebrity accounts user_id follows (their posts are pulled, not pushed)."""
    return list(CELEBRITIES_FOLLOWED.get(user_id, []))
`,
  'feed/ids.py': `"""Post ids carry their creation time: '<created_at ms>-<suffix>'."""
import uuid


def new_id(created_at_ms: int) -> str:
    return f"{int(created_at_ms)}-{uuid.uuid4().hex[:8]}"


def created_at(post_id: str) -> int:
    """Milliseconds since the epoch encoded in the id."""
    return int(str(post_id).split("-", 1)[0])
`,
  'feed/events.py': `"""Publisher of the 'posts' topic (provided): one record per new post, keyed by the author id."""
import json

from confluent_kafka import Producer

TOPIC = "posts"
producer = Producer({"bootstrap.servers": "kafka:9092", "linger.ms": 5})


def publish(post: dict) -> None:
    producer.produce(TOPIC, key=post["author"], value=json.dumps(post))
    producer.poll(0)
`,
  'feed/store.py': `"""The post store (provided): posts in Redis, the posts:{author} index, and the timeline facade."""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

POST_TTL_S = 3600
IDEMPOTENCY_TTL_S = 24 * 3600


class _Posts:
    def save(self, post: dict) -> dict:
        """Store the post; a post with an already-used idempotency key is the earlier post (the dict is updated in place)."""
        author = post["author"]
        key = post.get("idempotency_key")
        idem = f"idem:{author}:{key}" if key else None
        if idem:
            existing = r.get(idem)
            if existing:
                post.update(json.loads(existing))
                return post
        r.set(f"post:{post['post_id']}", json.dumps(post), ex=POST_TTL_S)
        r.zadd(f"posts:{author}", {post["post_id"]: post["created_at"]})
        if idem:
            r.set(idem, json.dumps(post), ex=IDEMPOTENCY_TTL_S)
        return post

    def get(self, post_id: str) -> dict | None:
        raw = r.get(f"post:{post_id}")
        return json.loads(raw) if raw else None


class _Timeline:
    def read(self, user_id: str, cursor: int | None, limit: int) -> tuple[list[str], int | None]:
        """Delegates to the timeline module of step 3 when it exists; an empty page until then."""
        try:
            import timeline
        except ImportError:
            return [], None
        return timeline.read(user_id, cursor, limit)


posts = _Posts()
timeline = _Timeline()
`,
};

/** The same provided modules for the TypeScript runtime, imported by bare path (`import {posts} from 'feed/store'`). */
export const supportModulesTs: Record<string, string> = {
  'feed/graph.ts': `/** The follow graph (provided). In-memory tables the harness and your own experiments can fill. */

export const FOLLOWERS: Record<string, string[]> = {};
export const CELEBRITIES_FOLLOWED: Record<string, string[]> = {};

/** The follow graph: \`followers(author)\` and \`celebritiesFollowed(user)\`. */
export const graph = {
  /** Ids of every user following authorId. */
  followers(authorId: string): string[] {
    return [...(FOLLOWERS[authorId] ?? [])];
  },
  /** Ids of the celebrity accounts userId follows (their posts are pulled, not pushed). */
  celebritiesFollowed(userId: string): string[] {
    return [...(CELEBRITIES_FOLLOWED[userId] ?? [])];
  },
};
`,
  'feed/ids.ts': `/** Post ids carry their creation time: '<created_at ms>-<suffix>'. */
import {randomUUID} from 'node:crypto';

export function newId(createdAtMs: number): string {
  return \`\${Math.trunc(createdAtMs)}-\${randomUUID().replace(/-/g, '').slice(0, 8)}\`;
}

/** Milliseconds since the epoch encoded in the id. */
export function createdAt(postId: string): number {
  return Number(String(postId).split('-', 1)[0]);
}
`,
  'feed/events.ts': `/** Publisher of the 'posts' topic (provided): one record per new post, keyed by the author id. */
import {Kafka} from 'kafkajs';

export const TOPIC = 'posts';
const producer = new Kafka({clientId: 'feed-api', brokers: ['kafka:9092']}).producer();
const connected = producer.connect();

export interface Post {
  post_id: string;
  author: string;
  text: string;
  media_ids: string[];
  created_at: number;
  idempotency_key?: string;
}

export async function publish(post: Post): Promise<void> {
  await connected;
  await producer.send({topic: TOPIC, messages: [{key: post.author, value: JSON.stringify(post)}]});
}
`,
  'feed/store.ts': `/** The post store (provided): posts in Redis, the posts:{author} index, and the timeline facade. */
import Redis from 'ioredis';

import type {Post} from 'feed/events';
import * as timelineModule from 'timeline';

const redis = new Redis({host: 'redis', port: 6379});

export const POST_TTL_S = 3600;
export const IDEMPOTENCY_TTL_S = 24 * 3600;

export const posts = {
  /** Store the post; a post with an already-used idempotency key is the earlier post (the object is updated in place). */
  async save(post: Post): Promise<Post> {
    const key = post.idempotency_key;
    const idem = key ? \`idem:\${post.author}:\${key}\` : null;
    if (idem !== null) {
      const existing = await redis.get(idem);
      if (existing !== null) return Object.assign(post, JSON.parse(existing) as Post);
    }
    await redis.set(\`post:\${post.post_id}\`, JSON.stringify(post), 'EX', POST_TTL_S);
    await redis.zadd(\`posts:\${post.author}\`, post.created_at, post.post_id);
    if (idem !== null) await redis.set(idem, JSON.stringify(post), 'EX', IDEMPOTENCY_TTL_S);
    return post;
  },

  async get(postId: string): Promise<Post | null> {
    const raw = await redis.get(\`post:\${postId}\`);
    return raw === null ? null : (JSON.parse(raw) as Post);
  },
};

export const timeline = {
  /** Delegates to the timeline module of step 3. */
  read(userId: string, cursor: number | null, limit: number): Promise<[string[], number | null]> {
    return timelineModule.read(userId, cursor, limit);
  },
};
`,
};

/**
 * The same provided packages for the Go runtime, imported as `feed/graph`, `feed/ids`, `feed/posts`,
 * `feed/events` and `feed/timeline`.
 */
export const supportModulesGo: Record<string, string> = {
  'feed/graph/graph.go': `// Package graph is the follow graph (provided): in-memory tables the harness and your own
// experiments fill.
package graph

import "context"

// FollowersOf maps an author id to the ids of every user following them.
var FollowersOf = map[string][]string{}

// CelebritiesFollowedBy maps a user id to the celebrity accounts they follow.
var CelebritiesFollowedBy = map[string][]string{}

// Followers returns the ids of every user following authorID.
func Followers(ctx context.Context, authorID string) ([]string, error) {
	return append([]string(nil), FollowersOf[authorID]...), nil
}

// CelebritiesFollowed returns the ids of the celebrity accounts userID follows (their posts are
// pulled at read time, not pushed).
func CelebritiesFollowed(ctx context.Context, userID string) ([]string, error) {
	return append([]string(nil), CelebritiesFollowedBy[userID]...), nil
}
`,
  'feed/ids/ids.go': `// Package ids: post ids carry their creation time, "<created_at ms>-<suffix>".
package ids

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

// NewID returns a fresh id for a post created at createdAtMs.
func NewID(createdAtMs int64) string {
	return fmt.Sprintf("%d-%s", createdAtMs, strings.ReplaceAll(uuid.NewString(), "-", "")[:8])
}

// CreatedAt is the milliseconds since the epoch encoded in postID.
func CreatedAt(postID string) int64 {
	prefix, _, _ := strings.Cut(postID, "-")
	ms, _ := strconv.ParseInt(prefix, 10, 64)
	return ms
}
`,
  'feed/posts/posts.go': `// Package posts is the post store (provided): each post as JSON at post:{id}, the posts:{author}
// index scored by created_at, and the Idempotency-Key dedupe.
package posts

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	PostTTL        = time.Hour
	IdempotencyTTL = 24 * time.Hour
)

// Post is a post as it is stored and published.
type Post struct {
	ID             string   \`json:"post_id"\`
	Author         string   \`json:"author"\`
	Text           string   \`json:"text"\`
	MediaIDs       []string \`json:"media_ids"\`
	CreatedAt      int64    \`json:"created_at"\`
	IdempotencyKey string   \`json:"idempotency_key,omitempty"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Save stores the post and indexes it under its author. A post whose idempotency key its author
// already used is that earlier post: *post is overwritten with it, and nothing new is stored.
func Save(ctx context.Context, post *Post) error {
	idem := ""
	if post.IdempotencyKey != "" {
		idem = "idem:" + post.Author + ":" + post.IdempotencyKey
		existing, err := rdb.Get(ctx, idem).Bytes()
		if err == nil {
			return json.Unmarshal(existing, post)
		}
		if !errors.Is(err, redis.Nil) {
			return err
		}
	}
	doc, err := json.Marshal(post)
	if err != nil {
		return err
	}
	if err := rdb.Set(ctx, "post:"+post.ID, doc, PostTTL).Err(); err != nil {
		return err
	}
	if err := rdb.ZAdd(ctx, "posts:"+post.Author, redis.Z{Score: float64(post.CreatedAt), Member: post.ID}).Err(); err != nil {
		return err
	}
	if idem != "" {
		return rdb.Set(ctx, idem, doc, IdempotencyTTL).Err()
	}
	return nil
}

// Get returns the post postID, nil when there is none.
func Get(ctx context.Context, postID string) (*Post, error) {
	raw, err := rdb.Get(ctx, "post:"+postID).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var post Post
	if err := json.Unmarshal(raw, &post); err != nil {
		return nil, err
	}
	return &post, nil
}
`,
  'feed/events/events.go': `// Package events is the publisher of the "posts" topic (provided): one record per new post, keyed
// by the author id.
package events

import (
	"context"
	"encoding/json"
	"time"

	"github.com/segmentio/kafka-go"

	"feed/posts"
)

const Topic = "posts"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        Topic,
	Balancer:     &kafka.Hash{},
	BatchTimeout: 5 * time.Millisecond,
}

// Publish produces post to Topic and returns once the broker acknowledged it.
func Publish(ctx context.Context, post posts.Post) error {
	value, err := json.Marshal(post)
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(post.Author), Value: value})
}
`,
  'feed/timeline/timeline.go': `// Package timeline is the home-timeline read (provided as a facade): step 3 builds the real one.
package timeline

import "context"

// Read returns a page of post ids for userID's home timeline, newest first, created before cursor
// (nil: from the newest), and the cursor of the next page (nil after the last). It is a variable so
// the read of step 3 can be plugged in; until then every page is empty.
var Read = func(ctx context.Context, userID string, cursor *int64, limit int) ([]string, *int64, error) {
	return []string{}, nil, nil
}
`,
};

/**
 * The same provided modules for the C++ runtime, as headers (`#include "feed/store.h"`): header-only,
 * since a program compiles only its step's file.
 */
export const supportModulesCpp: Record<string, string> = {
  'feed/graph.h': `// The follow graph (provided): in-memory tables the harness and your own experiments fill.
#pragma once

#include <map>
#include <string>
#include <vector>

namespace graph {

// followers_of maps an author id to the ids of every user following them.
inline std::map<std::string, std::vector<std::string>> followers_of;

// celebrities_followed_by maps a user id to the celebrity accounts they follow.
inline std::map<std::string, std::vector<std::string>> celebrities_followed_by;

// The ids of every user following author.
inline std::vector<std::string> followers(const std::string& author) {
  const auto it = followers_of.find(author);
  return it == followers_of.end() ? std::vector<std::string>{} : it->second;
}

// The ids of the celebrity accounts user follows (their posts are pulled at read time, not pushed).
inline std::vector<std::string> celebrities_followed(const std::string& user) {
  const auto it = celebrities_followed_by.find(user);
  return it == celebrities_followed_by.end() ? std::vector<std::string>{} : it->second;
}

}  // namespace graph
`,
  'feed/ids.h': `// Post ids carry their creation time: "<created_at ms>-<suffix>".
#pragma once

#include <cstdint>
#include <cstdlib>
#include <string>

#include "feed/uuid.h"

namespace ids {

// A fresh id for a post created at created_at_ms.
inline std::string new_id(int64_t created_at_ms) {
  std::string suffix;
  for (char c : uuid4())
    if (c != '-' && suffix.size() < 8) suffix += c;
  return std::to_string(created_at_ms) + "-" + suffix;
}

// The milliseconds since the epoch encoded in post_id (0 when it has no numeric prefix).
inline int64_t created_at(const std::string& post_id) {
  return std::strtoll(post_id.substr(0, post_id.find('-')).c_str(), nullptr, 10);
}

}  // namespace ids
`,
  'feed/uuid.h': `// uuid4() is a random (version 4) UUID, "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".
#pragma once

#include <random>
#include <string>

inline std::string uuid4() {
  static std::mt19937_64 rng{std::random_device{}()};
  static const char* hex = "0123456789abcdef";
  std::uniform_int_distribution<int> nibble(0, 15);
  std::string out;
  for (int i = 0; i < 32; i++) {
    if (i == 8 || i == 12 || i == 16 || i == 20) out += '-';
    int n = nibble(rng);
    if (i == 12) n = 4;            // version 4
    if (i == 16) n = 8 | (n & 3);  // variant 10xx
    out += hex[n];
  }
  return out;
}
`,
  'feed/store.h': `// The post store (provided): each post as JSON at post:{id}, the posts:{author} index scored by
// created_at, the Idempotency-Key dedupe, and the home-timeline facade.
#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

// A post as it is stored and published.
struct Post {
  std::string id;
  std::string author;
  std::string text;
  std::vector<std::string> media_ids;
  int64_t created_at = 0;
  std::string idempotency_key;
};

// The JSON of a post: {"post_id", "author", "text", "media_ids", "created_at"[, "idempotency_key"]}.
inline void to_json(nlohmann::json& j, const Post& p) {
  j = {{"post_id", p.id}, {"author", p.author}, {"text", p.text}, {"media_ids", p.media_ids}, {"created_at", p.created_at}};
  if (!p.idempotency_key.empty()) j["idempotency_key"] = p.idempotency_key;
}

inline void from_json(const nlohmann::json& j, Post& p) {
  p.id = j.value("post_id", "");
  p.author = j.value("author", "");
  p.text = j.value("text", "");
  p.media_ids = j.contains("media_ids") && j["media_ids"].is_array() ? j["media_ids"].get<std::vector<std::string>>()
                                                                       : std::vector<std::string>{};
  p.created_at = j.value("created_at", int64_t{0});
  p.idempotency_key = j.value("idempotency_key", "");
}

namespace posts {

inline constexpr std::chrono::seconds kPostTtl{3600};
inline constexpr std::chrono::seconds kIdempotencyTtl{24 * 3600};

inline sw::redis::Redis& store() {
  static sw::redis::Redis redis("tcp://redis:6379");
  return redis;
}

// Store the post and index it under its author. A post whose idempotency key its author already
// used is that earlier post: post is overwritten with it, and nothing new is stored.
inline void save(Post& post) {
  std::string idem;
  if (!post.idempotency_key.empty()) {
    idem = "idem:" + post.author + ":" + post.idempotency_key;
    if (const auto existing = store().get(idem)) {
      post = nlohmann::json::parse(*existing).get<Post>();
      return;
    }
  }
  const std::string doc = nlohmann::json(post).dump();
  store().set("post:" + post.id, doc, kPostTtl);
  store().zadd("posts:" + post.author, post.id, static_cast<double>(post.created_at));
  if (!idem.empty()) store().set(idem, doc, kIdempotencyTtl);
}

// The post post_id, nullopt when there is none.
inline std::optional<Post> get(const std::string& post_id) {
  const auto raw = store().get("post:" + post_id);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw).get<Post>();
}

}  // namespace posts

namespace timeline {

// A page of post ids, newest first, and the cursor of the next page (nullopt after the last).
struct Page {
  std::vector<std::string> items;
  std::optional<int64_t> next_cursor;
};

// A page of user's home timeline created before cursor (nullopt: from the newest). A variable so
// the read of step 3 can be plugged in; until then every page is empty.
inline std::function<Page(const std::string& user, std::optional<int64_t> cursor, int limit)> read =
    [](const std::string&, std::optional<int64_t>, int) { return Page{}; };

}  // namespace timeline
`,
  'feed/events.h': `// Publisher of the "posts" topic (provided): one record per new post, keyed by the author id.
#pragma once

#include <memory>
#include <stdexcept>
#include <string>

#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include "feed/store.h"

namespace events {

inline const std::string kTopic = "posts";

inline RdKafka::Producer& producer() {
  static const std::unique_ptr<RdKafka::Producer> producer = [] {
    std::string err;
    const std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
    conf->set("bootstrap.servers", "kafka:9092", err);
    conf->set("linger.ms", "5", err);
    return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
  }();
  return *producer;
}

// Produce post to kTopic and return once the broker acknowledged it.
inline void publish(const Post& post) {
  const std::string value = nlohmann::json(post).dump();
  const RdKafka::ErrorCode err =
      producer().produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, value.data(),
                         value.size(), post.author.data(), post.author.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) throw std::runtime_error("publish: " + RdKafka::err2str(err));
  producer().flush(10000);
}

}  // namespace events
`,
  'feed/post_json.h': `// A feed::Post as the JSON cached at post:{id}: {"id", "author", "text", "media_ids", "created_at"}.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "post.pb.h"

namespace post_json {

inline std::string encode(const feed::Post& post) {
  return nlohmann::json{{"id", post.id()},
                        {"author", post.author()},
                        {"text", post.text()},
                        {"media_ids", std::vector<std::string>(post.media_ids().begin(), post.media_ids().end())},
                        {"created_at", post.created_at()}}
      .dump();
}

// The post the JSON holds, nullopt when it is not a post.
inline std::optional<feed::Post> decode(const std::string& text) {
  const auto j = nlohmann::json::parse(text, nullptr, false);
  if (!j.is_object() || !j.contains("id") || !j["id"].is_string()) return std::nullopt;
  feed::Post post;
  post.set_id(j["id"].get<std::string>());
  post.set_author(j.value("author", ""));
  post.set_text(j.value("text", ""));
  if (j.contains("media_ids") && j["media_ids"].is_array())
    for (const auto& m : j["media_ids"])
      if (m.is_string()) post.add_media_ids(m.get<std::string>());
  post.set_created_at(j.value("created_at", int64_t{0}));
  return post;
}

}  // namespace post_json
`,
};
