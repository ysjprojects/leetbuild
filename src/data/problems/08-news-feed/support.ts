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
