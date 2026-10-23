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
