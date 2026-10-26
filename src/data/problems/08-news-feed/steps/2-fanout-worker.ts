import type {Step} from '@/lib/types';

export const fanoutWorkerStep: Step = {
  id: 'fanout-worker',
  title: 'Fan out on write, except for celebrities',
  concept: 'kafka',
  file: 'fanout_worker',
  focus: ['posts', 'fanout', 'redis'],
  task: `## Task

Implement the fan-out worker: a member of consumer group **\`fanout\`** reading the \`posts\` topic (keyed
by author id, so one author's posts arrive in order) and pushing each new post id to the head of every
follower's timeline. \`graph.followers(author)\` is provided and returns the follower ids.

- Disable auto-commit: an offset acknowledged before the pushes happened is a post that silently never
  reaches anyone.
- If the author has more than **\`CELEBRITY_FOLLOWERS\`** (10 000) followers, **skip the fan-out**: a post
  by a celebrity would mean millions of writes; their posts are pulled at read time instead (step 3; the
  \`posts:{author}\` sorted set is maintained by \`posts.save\`).
- Otherwise, for every follower: \`LPUSH timeline:{follower} <post_id>\` and \`LTRIM timeline:{follower} 0 999\`
  so no timeline grows past **1000** entries. Send them through **one pipeline per batch of 500** followers —
  two round trips per follower would make a 5 000-follower post take seconds.
- Commit the offset only after the last pipeline has executed.

:::widget consumer-groups {"partitions": 8}

:::widget delivery-semantics {}`,
  sequence: {
    participants: ['Kafka', 'fanout', 'graph', 'Redis'],
    messages: [
      {from: 'Kafka', to: 'fanout', label: 'poll → post {post_id, author} (partition 3)', kind: 'reply'},
      {from: 'fanout', to: 'graph', label: 'followers(author)', kind: 'sync'},
      {from: 'graph', to: 'fanout', label: '1 240 follower ids', kind: 'reply'},
      {from: 'fanout', to: 'Redis', label: 'pipeline ×500: LPUSH timeline:{f} id · LTRIM 0 999', kind: 'sync'},
      {from: 'fanout', to: 'Redis', label: 'pipeline ×500 · pipeline ×240', kind: 'sync'},
      {from: 'fanout', to: 'Kafka', label: 'commit offset (partition 3)', kind: 'sync'},
    ],
  },
  hints: [
    'The celebrity test is one comparison on the length of the follower list, before any Redis call. Skipping is a normal outcome: the offset is still committed.',
    'Slice the follower list in chunks of 500; each chunk gets a fresh pipeline with two commands per follower, then one execute. The LTRIM bound is `TIMELINE_LEN - 1` because ranges are inclusive.',
    'Commit once per record, after the loop over chunks — a crash halfway re-runs the whole fan-out, which is harmless: LPUSH of an id already present only duplicates it, and LTRIM caps the damage.',
  ],
  checks: [
    {
      id: 'group',
      title: 'Joins consumer group fanout on topic posts',
      detail: 'The consumer must use `group.id` `fanout` and subscribe to `posts`.',
      match: {
        python: {all: [/"group\.id"\s*:\s*"fanout"/, /subscribe\(\s*\[\s*"posts"\s*\]\s*\)/]},
        typescript: {
          all: [
            /groupId:\s*['"]fanout['"]/,
            /subscribe\(\s*\{[^\n]*(topic:\s*['"]posts['"]|topics:\s*\[[^\n]*['"]posts['"])/,
          ],
        },
        go: {all: [/GroupID:\s*"fanout"/, /Topic:\s*"posts"/]},
        scala: {all: [/"group\.id"\s*,\s*"fanout"|GROUP_ID_CONFIG\s*,\s*"fanout"/, /subscribe\([^\n]*"posts"/]},
        cpp: {all: [/"group\.id"\s*,\s*"fanout"/, /subscribe\([^\n]*"posts"/]},
      },
    },
    {
      id: 'manual-commit',
      title: 'Disables auto-commit',
      detail: 'Offsets must be committed explicitly after the pushes — not on a timer, before you know they happened.',
      match: {
        python: {all: [/"enable\.auto\.commit"\s*:\s*False/]},
        typescript: {all: [/autoCommit:\s*false/]},
        go: {all: [/reader\.FetchMessage\(/], none: [/ReadMessage\(/]},
        scala: {all: [/"enable\.auto\.commit"\s*,\s*"false"|ENABLE_AUTO_COMMIT_CONFIG\s*,\s*"false"/]},
        cpp: {all: [/"enable\.auto\.commit"\s*,\s*"false"/]},
      },
    },
    {
      id: 'celebrity',
      title: 'Skips fan-out for celebrity authors',
      detail:
        'Fetch the followers with `graph.followers` and do nothing when there are more than `CELEBRITY_FOLLOWERS` of them — those posts are pulled at read time.',
      match: {
        python: {all: [/graph\.followers\(/, /len\(\s*\w+\s*\)\s*>=?\s*(CELEBRITY_FOLLOWERS|10_?000)/]},
        typescript: {all: [/graph\.followers\(/, /\.length\s*>=?\s*(CELEBRITY_FOLLOWERS|10_?000)/]},
        go: {all: [/graph\.Followers\(/, /len\(\s*\w+\s*\)\s*>=?\s*(celebrityFollowers|10000)/]},
        scala: {all: [/Graph\.followers\(/, /\.(size|length)\s*>=?\s*(CelebrityFollowers|10000)/]},
        cpp: {all: [/graph::followers\(/, /\.size\(\)\s*>=?\s*(kCelebrityFollowers|10000)/]},
      },
    },
    {
      id: 'push-trim',
      title: 'Pushes the id and trims every timeline to 1000',
      detail:
        '`LPUSH timeline:{follower} post_id` followed by `LTRIM timeline:{follower} 0 999` keeps timelines newest-first and bounded.',
      match: {
        python: {all: [/\.lpush\(/, /f"timeline:\{/, /\.ltrim\([^\n]*,\s*0\s*,\s*(TIMELINE_LEN\s*-\s*1|999)\s*\)/]},
        typescript: {
          all: [/\.lpush\(/, /`timeline:\$\{/, /\.ltrim\([^\n]*,\s*0\s*,\s*(TIMELINE_LEN\s*-\s*1|999)\s*\)/],
        },
        go: {
          all: [
            /\.LPush\(/,
            /"timeline:"\s*\+|"timeline:%s"/,
            /\.LTrim\([^\n]*,\s*0\s*,\s*(timelineLen\s*-\s*1|999)\s*\)/,
          ],
        },
        scala: {all: [/\.lpush\(/, /s"timeline:\$/, /\.ltrim\([^\n]*,\s*0\s*,\s*(TimelineLen\s*-\s*1|999L?)\s*\)/]},
        cpp: {all: [/\.lpush\(/, /"timeline:"\s*\+/, /\.ltrim\([^\n]*,\s*0\s*,\s*(kTimelineLen\s*-\s*1|999)\s*\)/]},
      },
    },
    {
      id: 'batched-commit',
      title: 'Pipelines per 500 followers, commits after',
      detail:
        'Walk the followers in chunks of `BATCH` (500), execute one pipeline per chunk, and commit the offset only once every pipeline has run.',
      match: {
        python: {
          all: [/range\(\s*0\s*,\s*len\([^\n]*,\s*(BATCH|500)\s*\)/],
          order: [/\.execute\(\)/, /consumer\.commit\(/],
        },
        typescript: {
          all: [/\+=\s*(BATCH|500)\b/, /\.slice\(\s*\w+\s*,\s*\w+\s*\+\s*(BATCH|500)\s*\)/],
          order: [/\.exec\(\)/, /commitOffsets\(/],
        },
        go: {all: [/\+=\s*(batch|500)\b/], order: [/\.Exec\(\s*ctx\s*\)/, /reader\.CommitMessages\(/]},
        scala: {all: [/\.grouped\(\s*(Batch|500)\s*\)/], order: [/\.sync\(\)/, /consumer\.commitSync\(/]},
        cpp: {all: [/\+=\s*(kBatch|500)\b/], order: [/\.exec\(\)/, /consumer->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer

from feed import graph  # provided: graph.followers(author_id) -> list[str]

log = logging.getLogger("fanout")
r = redis.Redis(host="redis", port=6379)

CELEBRITY_FOLLOWERS = 10_000
TIMELINE_LEN = 1000
BATCH = 500

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "fanout",
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit
    }
)
consumer.subscribe(["posts"])


def fan_out(post_id: str, author: str) -> None:
    # TODO: graph.followers(author); more than CELEBRITY_FOLLOWERS → return (pulled at read time)
    # TODO: per BATCH followers: one pipeline of LPUSH timeline:{f} post_id + LTRIM timeline:{f} 0 TIMELINE_LEN-1
    raise NotImplementedError


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        post = json.loads(msg.value())
        # TODO: fan_out(post_id, author), then commit this message's offset
        raise NotImplementedError
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer

from feed import graph  # provided: graph.followers(author_id) -> list[str]

log = logging.getLogger("fanout")
r = redis.Redis(host="redis", port=6379)

CELEBRITY_FOLLOWERS = 10_000
TIMELINE_LEN = 1000
BATCH = 500

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "fanout",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe(["posts"])


def fan_out(post_id: str, author: str) -> None:
    fans = graph.followers(author)
    if len(fans) > CELEBRITY_FOLLOWERS:
        return  # celebrity: followers pull posts:{author} at read time (step 3)
    for i in range(0, len(fans), BATCH):
        pipe = r.pipeline(transaction=False)
        for follower in fans[i : i + BATCH]:
            key = f"timeline:{follower}"
            pipe.lpush(key, post_id)
            pipe.ltrim(key, 0, TIMELINE_LEN - 1)
        pipe.execute()


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        post = json.loads(msg.value())
        fan_out(post["post_id"], post["author"])
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {graph} from 'feed/graph'; // provided: graph.followers(authorId) → string[]

const redis = new Redis({host: 'redis', port: 6379});

export const CELEBRITY_FOLLOWERS = 10_000;
export const TIMELINE_LEN = 1000;
export const BATCH = 500;

const kafka = new Kafka({clientId: 'fanout', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'fanout'});

interface PostRecord {
  post_id: string;
  author: string;
}

export async function fanOut(postId: string, author: string): Promise<void> {
  // TODO: graph.followers(author); more than CELEBRITY_FOLLOWERS → return (pulled at read time)
  // TODO: per BATCH followers: one pipeline of LPUSH timeline:{f} postId + LTRIM timeline:{f} 0 TIMELINE_LEN-1
  throw new Error('not implemented');
}

export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'posts', fromBeginning: true});
  await consumer.run({
    // TODO: disable auto-commit
    eachMessage: async ({topic, partition, message}) => {
      const post = JSON.parse(message.value?.toString() ?? '') as PostRecord;
      // TODO: fanOut(post.post_id, post.author), then commit this message's offset
      throw new Error('not implemented');
    },
  });
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {graph} from 'feed/graph'; // provided: graph.followers(authorId) → string[]

const redis = new Redis({host: 'redis', port: 6379});

export const CELEBRITY_FOLLOWERS = 10_000;
export const TIMELINE_LEN = 1000;
export const BATCH = 500;

const kafka = new Kafka({clientId: 'fanout', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'fanout'});

interface PostRecord {
  post_id: string;
  author: string;
}

export async function fanOut(postId: string, author: string): Promise<void> {
  const fans = graph.followers(author);
  if (fans.length > CELEBRITY_FOLLOWERS) return; // celebrity: followers pull posts:{author} at read time (step 3)
  for (let i = 0; i < fans.length; i += BATCH) {
    const pipe = redis.pipeline();
    for (const follower of fans.slice(i, i + BATCH)) {
      const key = \`timeline:\${follower}\`;
      pipe.lpush(key, postId);
      pipe.ltrim(key, 0, TIMELINE_LEN - 1);
    }
    await pipe.exec();
  }
}

export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'posts', fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const post = JSON.parse(message.value?.toString() ?? '') as PostRecord;
      await fanOut(post.post_id, post.author);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"feed/graph" // graph.Followers(ctx, authorID) ([]string, error) — provided
)

const (
	celebrityFollowers = 10000
	timelineLen        = 1000
	batch              = 500
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "fanout",
	Topic:   "posts",
})

type postEvent struct {
	PostID string \`json:"post_id"\`
	Author string \`json:"author"\`
}

func fanOut(ctx context.Context, post postEvent) error {
	// TODO: graph.Followers; more than celebrityFollowers → return nil (pulled at read time)
	// TODO: per batch followers: one pipeline of LPush timeline:{f} post id + LTrim timeline:{f} 0 timelineLen-1
	return nil
}

func run(ctx context.Context) error {
	for {
		// TODO: FetchMessage (ReadMessage commits automatically — not what we want)
		// TODO: unmarshal postEvent, fanOut, then CommitMessages for this message
		_ = json.Unmarshal
		_ = graph.Followers
		log.Println("not implemented")
		return nil
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"feed/graph" // graph.Followers(ctx, authorID) ([]string, error) — provided
)

const (
	celebrityFollowers = 10000
	timelineLen        = 1000
	batch              = 500
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "fanout",
	Topic:   "posts",
})

type postEvent struct {
	PostID string \`json:"post_id"\`
	Author string \`json:"author"\`
}

func fanOut(ctx context.Context, post postEvent) error {
	followers, err := graph.Followers(ctx, post.Author)
	if err != nil {
		return err
	}
	if len(followers) > celebrityFollowers {
		return nil // celebrity: followers pull posts:{author} at read time (step 3)
	}
	for i := 0; i < len(followers); i += batch {
		pipe := rdb.Pipeline()
		for _, follower := range followers[i:min(i+batch, len(followers))] {
			key := "timeline:" + follower
			pipe.LPush(ctx, key, post.PostID)
			pipe.LTrim(ctx, key, 0, timelineLen-1)
		}
		if _, err := pipe.Exec(ctx); err != nil {
			return err
		}
	}
	return nil
}

func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var post postEvent
		if err := json.Unmarshal(msg.Value, &post); err != nil || post.PostID == "" {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			reader.CommitMessages(ctx, msg)
			continue
		}
		if err := fanOut(ctx, post); err != nil {
			return err // not committed: redelivered after restart
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.serialization.StringDeserializer
import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._

import feed.graph.Graph // Graph.followers(authorId): Seq[String] — provided
import feed.json.PostEvent // PostEvent.parse(json): Option[PostEvent] with postId, author — provided

object FanoutWorker {
  val CelebrityFollowers = 10000
  val TimelineLen = 1000L
  val Batch = 500

  val jedis = new JedisPooled("redis", 6379)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "fanout")
  props.put("auto.offset.reset", "earliest")
  // TODO: disable auto-commit
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("posts").asJava)

  def fanOut(postId: String, author: String): Unit = {
    // TODO: Graph.followers; more than CelebrityFollowers → return (pulled at read time)
    // TODO: per Batch followers: one pipeline of lpush timeline:{f} postId + ltrim timeline:{f} 0 TimelineLen-1
  }

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        // TODO: parse the record (skip malformed ones) and fanOut
      }
      // TODO: commit synchronously after the batch is fanned out
    }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.serialization.StringDeserializer
import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._

import feed.graph.Graph // Graph.followers(authorId): Seq[String] — provided
import feed.json.PostEvent // PostEvent.parse(json): Option[PostEvent] with postId, author — provided

object FanoutWorker {
  val CelebrityFollowers = 10000
  val TimelineLen = 1000L
  val Batch = 500

  val jedis = new JedisPooled("redis", 6379)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "fanout")
  props.put("auto.offset.reset", "earliest")
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("posts").asJava)

  def fanOut(postId: String, author: String): Unit = {
    val followers = Graph.followers(author)
    if (followers.size > CelebrityFollowers) return // celebrity: followers pull posts:{author} at read time (step 3)
    followers.grouped(Batch).foreach { chunk =>
      val p = jedis.pipelined()
      chunk.foreach { follower =>
        val key = s"timeline:$follower"
        p.lpush(key, postId)
        p.ltrim(key, 0, TimelineLen - 1)
      }
      p.sync()
    }
  }

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        PostEvent.parse(record.value()) match {
          case Some(post) => fanOut(post.postId, post.author)
          case None => System.err.println(s"skipping malformed record at offset \${record.offset()}")
        }
      }
      consumer.commitSync() // after every post of the batch has been fanned out
    }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "feed/graph.h"  // graph::followers(author) -> std::vector<std::string> — provided

constexpr std::size_t kCelebrityFollowers = 10000;
constexpr long long kTimelineLen = 1000;
constexpr std::size_t kBatch = 500;

sw::redis::Redis redis("tcp://redis:6379");

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "fanout", err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"posts"});
  return consumer;
}

auto consumer = make_consumer();

void fan_out(const std::string& post_id, const std::string& author) {
  // TODO: graph::followers; more than kCelebrityFollowers → return (pulled at read time)
  // TODO: per kBatch followers: one pipeline of lpush timeline:{f} post_id + ltrim timeline:{f} 0 kTimelineLen-1
}

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const auto post = nlohmann::json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    // TODO: skip (and commit) malformed records; fan_out(post_id, author); then commitSync this message
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "feed/graph.h"  // graph::followers(author) -> std::vector<std::string> — provided

constexpr std::size_t kCelebrityFollowers = 10000;
constexpr long long kTimelineLen = 1000;
constexpr std::size_t kBatch = 500;

sw::redis::Redis redis("tcp://redis:6379");

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "fanout", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"posts"});
  return consumer;
}

auto consumer = make_consumer();

void fan_out(const std::string& post_id, const std::string& author) {
  const std::vector<std::string> followers = graph::followers(author);
  if (followers.size() > kCelebrityFollowers) return;  // celebrity: followers pull posts:{author} at read time (step 3)
  for (std::size_t i = 0; i < followers.size(); i += kBatch) {
    auto pipe = redis.pipeline(false);
    const std::size_t end = std::min(i + kBatch, followers.size());
    for (std::size_t j = i; j < end; ++j) {
      const std::string key = "timeline:" + followers[j];
      pipe.lpush(key, post_id).ltrim(key, 0, kTimelineLen - 1);
    }
    pipe.exec();
  }
}

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const auto post = nlohmann::json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (post.is_discarded() || !post.contains("post_id") || !post.contains("author")) {
      std::cerr << "skipping malformed record at offset " << msg->offset() << "\\n";
      consumer->commitSync(msg.get());
      continue;
    }
    fan_out(post["post_id"], post["author"]);
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import json


def _post(ctx, post_id, author):
    post = {"post_id": post_id, "author": author, "text": "hi", "media_ids": [], "created_at": 1700000000000}
    ctx.kafka.seed("posts", key=author, value=json.dumps(post))


def _worker(ctx, followers):
    m = ctx.load("fanout_worker")
    m.graph.followers = lambda author: list(followers.get(author, []))
    return m


def _spy(r):
    """Round trips the learner's client makes: direct command names, and the size of every executed pipeline."""
    trips = {"direct": [], "pipelines": []}
    real_pipeline, real_execute = r.pipeline, r.execute_command

    def pipeline(*args, **kwargs):
        pipe = real_pipeline(*args, **kwargs)
        real_pipe_execute = pipe.execute

        def execute(*a, **k):
            trips["pipelines"].append(len(pipe.command_stack))
            return real_pipe_execute(*a, **k)

        pipe.execute = execute
        return pipe

    def execute_command(*args, **kwargs):
        trips["direct"].append(str(args[0]).lower())
        return real_execute(*args, **kwargs)

    r.pipeline = pipeline
    r.execute_command = execute_command
    return trips


def check_group(ctx):
    _post(ctx, "p1", "ann")
    m = _worker(ctx, {"ann": ["bob"]})
    subscriptions = [e for e in ctx.kafka.events if e[0] == "subscribe"]
    assert subscriptions, "the consumer must subscribe to a topic"
    group, topics = subscriptions[-1][1], subscriptions[-1][2]
    assert group == "fanout", f"group.id must be fanout, got {group!r}"
    assert "posts" in topics, f"the consumer must subscribe to posts, got {topics}"
    ctx.drain(m.run)
    assert ctx.redis.lrange("timeline:bob", 0, -1) == ["p1"], f"after consuming p1 by ann, timeline:bob is {ctx.redis.lrange('timeline:bob', 0, -1)}, expected ['p1']"


def check_manual_commit(ctx):
    _post(ctx, "p1", "ann")
    _post(ctx, "p2", "ann")
    m = _worker(ctx, {"ann": ["bob", "cat"]})
    ctx.drain(m.run)
    assert ctx.kafka.consumers[-1].auto_commit is False, "enable.auto.commit must be False: offsets would be committed on a timer, before the pushes"
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "auto-commit is on: offsets were committed on a timer, before processing"
    assert any(e[0] == "manual-commit" for e in ctx.kafka.events), "no explicit commit happened"
    assert ctx.kafka.lag("fanout", "posts") == 0, "every processed record must be committed"


def check_celebrity(ctx):
    _post(ctx, "p1", "taylor")
    _post(ctx, "p2", "ann")
    fans = {"taylor": [f"fan{i}" for i in range(10_001)], "ann": ["bob", "cat"]}
    m = _worker(ctx, fans)
    ctx.drain(m.run)
    assert ctx.redis.lrange("timeline:bob", 0, -1) == ["p2"], f"ann has 2 followers: her post must be pushed, timeline:bob is {ctx.redis.lrange('timeline:bob', 0, -1)}"
    pushed = [k for k in ctx.redis.keys("timeline:*") if k.startswith("timeline:fan")]
    assert not pushed, f"taylor has 10 001 followers: her post must not be fanned out, but {len(pushed)} fan timelines were written"
    assert ctx.kafka.lag("fanout", "posts") == 0, "a skipped celebrity post must still have its offset committed"


def check_push_trim(ctx):
    ctx.redis.rpush("timeline:bob", *[f"old{i}" for i in range(1000)])
    _post(ctx, "p1", "ann")
    _post(ctx, "p2", "ann")
    m = _worker(ctx, {"ann": ["bob", "cat"]})
    ctx.drain(m.run)
    bob = ctx.redis.lrange("timeline:bob", 0, -1)
    assert bob[:2] == ["p2", "p1"], f"timeline:bob must start with the newest post (LPUSH), got {bob[:3]}"
    assert len(bob) == 1000, f"timeline:bob has {len(bob)} entries, expected it trimmed to 1000"
    assert bob[-1] == "old997", f"LTRIM must drop the oldest entries: the tail is {bob[-1]!r}, expected 'old997'"
    assert ctx.redis.lrange("timeline:cat", 0, -1) == ["p2", "p1"], f"timeline:cat is {ctx.redis.lrange('timeline:cat', 0, -1)}, expected ['p2', 'p1']"


def check_batched_commit(ctx):
    fans = [f"f{i}" for i in range(1240)]
    _post(ctx, "p1", "ann")
    m = _worker(ctx, {"ann": fans})
    trips = _spy(m.r)
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append((len(trips["pipelines"]), ctx.redis.llen("timeline:f1239"))))
    ctx.drain(m.run)
    assert ctx.redis.lrange("timeline:f1239", 0, -1) == ["p1"], "every one of the 1240 followers must receive the post"
    writes = [c for c in trips["direct"] if c in ("lpush", "ltrim")]
    assert not writes, f"{len(writes)} LPUSH/LTRIM were sent one by one: queue them on a pipeline per batch of 500 followers"
    sizes = trips["pipelines"]
    assert len(sizes) == 3, f"1240 followers must take 3 pipelines (500, 500, 240 followers), observed {len(sizes)} pipeline execute(s)"
    assert max(sizes) <= 1000 and sum(sizes) == 2480, f"each pipeline carries LPUSH + LTRIM for at most 500 followers, observed command counts {sizes}"
    assert at_commit, "the offset was never committed"
    assert at_commit[0] == (3, 1), f"the commit must come after the last pipeline executed: at commit time {at_commit[0][0]} pipeline(s) had run and timeline:f1239 had {at_commit[0][1]} entries"
`,
    typescript: `import {FOLLOWERS} from 'feed/graph';

function post(ctx, postId: string, author: string) {
  const value = {post_id: postId, author, text: 'hi', media_ids: [], created_at: 1700000000000};
  ctx.kafka.seed('posts', {key: author, value: JSON.stringify(value)});
}

function worker(ctx, followers: Record<string, string[]>) {
  const m = ctx.load('fanout_worker');
  Object.assign(FOLLOWERS, followers);
  return m;
}

export async function check_group(ctx) {
  post(ctx, 'p1', 'ann');
  const m = worker(ctx, {ann: ['bob']});
  await ctx.drain(m.run());
  const subscriptions = ctx.kafka.events.filter(e => e[0] === 'subscribe');
  assert(subscriptions.length > 0, 'the consumer must subscribe to a topic');
  const [, group, topics] = subscriptions[subscriptions.length - 1];
  assert.equal(group, 'fanout', \`groupId must be fanout, got \${JSON.stringify(group)}\`);
  assert(topics.includes('posts'), \`the consumer must subscribe to posts, got \${JSON.stringify(topics)}\`);
  assert.deepEqual(ctx.redis.lrange('timeline:bob', 0, -1), ['p1'], \`after consuming p1 by ann, timeline:bob is \${JSON.stringify(ctx.redis.lrange('timeline:bob', 0, -1))}, expected ['p1']\`);
}

export async function check_manual_commit(ctx) {
  post(ctx, 'p1', 'ann');
  post(ctx, 'p2', 'ann');
  const m = worker(ctx, {ann: ['bob', 'cat']});
  await ctx.drain(m.run());
  const consumer = ctx.kafka.consumers[ctx.kafka.consumers.length - 1];
  assert(consumer !== undefined && consumer.autoCommit === false, 'autoCommit must be false: offsets would be committed on a timer, before the pushes');
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'auto-commit is on: offsets were committed on a timer, before processing');
  assert(ctx.kafka.events.some(e => e[0] === 'manual-commit'), 'no explicit commit happened');
  assert.equal(ctx.kafka.lag('fanout', 'posts'), 0, 'every processed record must be committed');
}

export async function check_celebrity(ctx) {
  post(ctx, 'p1', 'taylor');
  post(ctx, 'p2', 'ann');
  const m = worker(ctx, {taylor: Array.from({length: 10_001}, (_, i) => \`fan\${i}\`), ann: ['bob', 'cat']});
  await ctx.drain(m.run());
  assert.deepEqual(ctx.redis.lrange('timeline:bob', 0, -1), ['p2'], \`ann has 2 followers: her post must be pushed, timeline:bob is \${JSON.stringify(ctx.redis.lrange('timeline:bob', 0, -1))}\`);
  const pushed = ctx.redis.keys('timeline:fan*');
  assert.equal(pushed.length, 0, \`taylor has 10 001 followers: her post must not be fanned out, but \${pushed.length} fan timelines were written\`);
  assert.equal(ctx.kafka.lag('fanout', 'posts'), 0, 'a skipped celebrity post must still have its offset committed');
}

export async function check_push_trim(ctx) {
  ctx.redis.rpush('timeline:bob', ...Array.from({length: 1000}, (_, i) => \`old\${i}\`));
  post(ctx, 'p1', 'ann');
  post(ctx, 'p2', 'ann');
  const m = worker(ctx, {ann: ['bob', 'cat']});
  await ctx.drain(m.run());
  const bob = ctx.redis.lrange('timeline:bob', 0, -1);
  assert.deepEqual(bob.slice(0, 2), ['p2', 'p1'], \`timeline:bob must start with the newest post (LPUSH), got \${JSON.stringify(bob.slice(0, 3))}\`);
  assert.equal(bob.length, 1000, \`timeline:bob has \${bob.length} entries, expected it trimmed to 1000\`);
  assert.equal(bob[bob.length - 1], 'old997', \`LTRIM must drop the oldest entries: the tail is \${JSON.stringify(bob[bob.length - 1])}, expected 'old997'\`);
  assert.deepEqual(ctx.redis.lrange('timeline:cat', 0, -1), ['p2', 'p1'], \`timeline:cat is \${JSON.stringify(ctx.redis.lrange('timeline:cat', 0, -1))}, expected ['p2', 'p1']\`);
}

export async function check_batched_commit(ctx) {
  const fans = Array.from({length: 1240}, (_, i) => \`f\${i}\`);
  post(ctx, 'p1', 'ann');
  const m = worker(ctx, {ann: fans});
  const pipelines = () => ctx.redisRoundTrips().filter(t => t.length > 1);
  const atCommit: [number, number][] = [];
  ctx.kafka.onCommit(() => atCommit.push([pipelines().length, ctx.redis.llen('timeline:f1239')]));
  await ctx.drain(m.run());
  assert.deepEqual(ctx.redis.lrange('timeline:f1239', 0, -1), ['p1'], 'every one of the 1240 followers must receive the post');
  const writes = ctx.redisRoundTrips().filter(t => t.length === 1 && (t[0] === 'LPUSH' || t[0] === 'LTRIM'));
  assert.equal(writes.length, 0, \`\${writes.length} LPUSH/LTRIM were sent one by one: queue them on a pipeline per batch of 500 followers\`);
  const sizes = pipelines().map(t => t.length);
  assert.equal(sizes.length, 3, \`1240 followers must take 3 pipelines (500, 500, 240 followers), observed \${sizes.length} pipeline exec(s)\`);
  assert(Math.max(...sizes) <= 1000 && sizes.reduce((a, b) => a + b, 0) === 2480, \`each pipeline carries LPUSH + LTRIM for at most 500 followers, observed command counts \${JSON.stringify(sizes)}\`);
  assert(atCommit.length > 0, 'the offset was never committed');
  assert.deepStrictEqual(atCommit[0], [3, 1], \`the commit must come after the last pipeline executed: at commit time \${atCommit[0][0]} pipeline(s) had run and timeline:f1239 had \${atCommit[0][1]} entries\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"leetbuild/harness"

	"feed/graph"
)

func seedPost(ctx *harness.Ctx, postID, author string) {
	value, _ := json.Marshal(map[string]any{"post_id": postID, "author": author, "text": "hi", "media_ids": []string{}, "created_at": 1700000000000})
	ctx.Kafka.Seed("posts", author, value)
}

// drainWorker fills the follow graph, then runs the learner's loop until it waits for records.
func drainWorker(ctx *harness.Ctx, followers map[string][]string) {
	for author, ids := range followers {
		graph.FollowersOf[author] = ids
	}
	ctx.Drain(func() { run(context.Background()) })
}

// fanoutPipelines are the learner's round trips that carried more than one command.
func fanoutPipelines(ctx *harness.Ctx) [][]string {
	var out [][]string
	for _, trip := range ctx.Redis.RoundTrips() {
		if len(trip) > 1 {
			out = append(out, trip)
		}
	}
	return out
}

func CheckGroup(ctx *harness.Ctx) {
	seedPost(ctx, "p1", "ann")
	drainWorker(ctx, map[string][]string{"ann": {"bob"}})
	subscriptions := ctx.Kafka.EventsOf("subscribe")
	ctx.Assert(len(subscriptions) > 0, "the consumer must subscribe to a topic")
	last := subscriptions[len(subscriptions)-1]
	ctx.Equal(last.Group, "fanout", "GroupID must be fanout")
	subscribed := false
	for _, topic := range last.Topics {
		subscribed = subscribed || topic == "posts"
	}
	ctx.Assert(subscribed, "the consumer must subscribe to posts, got %q", last.Topics)
	ctx.Equal(ctx.Redis.LRange("timeline:bob", 0, -1), []string{"p1"}, "after consuming p1 by ann, timeline:bob")
}

func CheckManualCommit(ctx *harness.Ctx) {
	seedPost(ctx, "p1", "ann")
	seedPost(ctx, "p2", "ann")
	drainWorker(ctx, map[string][]string{"ann": {"bob", "cat"}})
	consumers := ctx.Kafka.Consumers()
	ctx.Assert(len(consumers) > 0 && !consumers[len(consumers)-1].AutoCommit, "the reader must not commit by itself (no CommitInterval, no ReadMessage): offsets would be committed on a timer, before the pushes")
	ctx.Assert(len(ctx.Kafka.EventsOf("auto-commit")) == 0, "auto-commit is on: offsets were committed on a timer, before processing")
	ctx.Assert(len(ctx.Kafka.EventsOf("manual-commit")) > 0, "no explicit commit happened")
	ctx.Equal(ctx.Kafka.Lag("fanout", "posts"), 0, "every processed record must be committed")
}

func CheckCelebrity(ctx *harness.Ctx) {
	seedPost(ctx, "p1", "taylor")
	seedPost(ctx, "p2", "ann")
	taylorFans := make([]string, 10_001)
	for i := range taylorFans {
		taylorFans[i] = fmt.Sprintf("fan%d", i)
	}
	drainWorker(ctx, map[string][]string{"taylor": taylorFans, "ann": {"bob", "cat"}})
	ctx.Equal(ctx.Redis.LRange("timeline:bob", 0, -1), []string{"p2"}, "ann has 2 followers: her post must be pushed, timeline:bob")
	pushed := ctx.Redis.Keys("timeline:fan*")
	ctx.Equal(len(pushed), 0, "taylor has 10 001 followers: her post must not be fanned out, but fan timelines were written")
	ctx.Equal(ctx.Kafka.Lag("fanout", "posts"), 0, "a skipped celebrity post must still have its offset committed")
}

func CheckPushTrim(ctx *harness.Ctx) {
	old := []any{"RPUSH", "timeline:bob"}
	for i := range 1000 {
		old = append(old, fmt.Sprintf("old%d", i))
	}
	ctx.Redis.Do(old...)
	seedPost(ctx, "p1", "ann")
	seedPost(ctx, "p2", "ann")
	drainWorker(ctx, map[string][]string{"ann": {"bob", "cat"}})
	bob := ctx.Redis.LRange("timeline:bob", 0, -1)
	ctx.Assert(len(bob) >= 2 && bob[0] == "p2" && bob[1] == "p1", "timeline:bob must start with the newest post (LPUSH), got %q", bob[:min(3, len(bob))])
	ctx.Equal(len(bob), 1000, "timeline:bob must be trimmed to 1000 entries")
	ctx.Equal(bob[len(bob)-1], "old997", "LTRIM must drop the oldest entries: the tail of timeline:bob")
	ctx.Equal(ctx.Redis.LRange("timeline:cat", 0, -1), []string{"p2", "p1"}, "timeline:cat")
}

func CheckBatchedCommit(ctx *harness.Ctx) {
	fans := make([]string, 1240)
	for i := range fans {
		fans[i] = fmt.Sprintf("f%d", i)
	}
	seedPost(ctx, "p1", "ann")
	var atCommit [][2]int
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) {
		atCommit = append(atCommit, [2]int{len(fanoutPipelines(ctx)), int(ctx.Redis.LLen("timeline:f1239"))})
	})
	drainWorker(ctx, map[string][]string{"ann": fans})
	ctx.Equal(ctx.Redis.LRange("timeline:f1239", 0, -1), []string{"p1"}, "every one of the 1240 followers must receive the post: timeline:f1239")
	writes := 0
	for _, trip := range ctx.Redis.RoundTrips() {
		if len(trip) == 1 && (trip[0] == "LPUSH" || trip[0] == "LTRIM") {
			writes++
		}
	}
	ctx.Assert(writes == 0, "%d LPUSH/LTRIM were sent one by one: queue them on a pipeline per batch of 500 followers", writes)
	var sizes []int
	largest, total := 0, 0
	for _, trip := range fanoutPipelines(ctx) {
		sizes = append(sizes, len(trip))
		largest = max(largest, len(trip))
		total += len(trip)
	}
	ctx.Equal(len(sizes), 3, "1240 followers must take 3 pipelines (500, 500, 240 followers): pipeline Execs observed")
	ctx.Assert(largest <= 1000 && total == 2480, "each pipeline carries LPush + LTrim for at most 500 followers, observed command counts %v", sizes)
	ctx.Assert(len(atCommit) > 0, "the offset was never committed")
	ctx.Assert(atCommit[0] == [2]int{3, 1}, "the commit must come after the last pipeline executed: at commit time %d pipeline(s) had run and timeline:f1239 had %d entries", atCommit[0][0], atCommit[0][1])
}
`,
    cpp: `#include <leetbuild/harness.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <string>
#include <utility>
#include <vector>

namespace {

void seedPost(harness::Ctx& ctx, const std::string& postID, const std::string& author) {
  const nlohmann::json value = {{"post_id", postID}, {"author", author}, {"text", "hi"}, {"media_ids", nlohmann::json::array()}, {"created_at", 1700000000000}};
  ctx.Kafka.Seed("posts", author, value);
}

// drainWorker fills the follow graph, then runs the learner's loop until it waits for records.
void drainWorker(harness::Ctx& ctx, const std::map<std::string, std::vector<std::string>>& followers) {
  for (const auto& [author, ids] : followers) graph::followers_of[author] = ids;
  ctx.Drain([] { run(); });
}

// fanoutPipelines are the learner's round trips that carried more than one command.
std::vector<std::vector<std::string>> fanoutPipelines(harness::Ctx& ctx) {
  std::vector<std::vector<std::string>> out;
  for (const auto& trip : ctx.Redis.RoundTrips())
    if (trip.size() > 1) out.push_back(trip);
  return out;
}

std::vector<std::string> numbered(const std::string& prefix, int n) {
  std::vector<std::string> out;
  for (int i = 0; i < n; i++) out.push_back(prefix + std::to_string(i));
  return out;
}

}  // namespace

void CheckGroup(harness::Ctx& ctx) {
  seedPost(ctx, "p1", "ann");
  drainWorker(ctx, {{"ann", {"bob"}}});
  const auto subscriptions = ctx.Kafka.EventsOf("subscribe");
  ctx.Assert(!subscriptions.empty(), "the consumer must subscribe to a topic");
  const auto& last = subscriptions.back();
  ctx.Equal(last.Group, "fanout", "group.id must be fanout");
  const bool subscribed = std::find(last.Topics.begin(), last.Topics.end(), "posts") != last.Topics.end();
  ctx.Assert(subscribed, "the consumer must subscribe to posts, got %q", last.Topics);
  ctx.Equal(ctx.Redis.LRange("timeline:bob", 0, -1), {"p1"}, "after consuming p1 by ann, timeline:bob");
}

void CheckManualCommit(harness::Ctx& ctx) {
  seedPost(ctx, "p1", "ann");
  seedPost(ctx, "p2", "ann");
  drainWorker(ctx, {{"ann", {"bob", "cat"}}});
  const auto consumers = ctx.Kafka.Consumers();
  ctx.Assert(!consumers.empty() && !consumers.back().AutoCommit, "the consumer must not commit by itself (enable.auto.commit=false): offsets would be committed on a timer, before the pushes");
  ctx.Assert(ctx.Kafka.EventsOf("auto-commit").empty(), "auto-commit is on: offsets were committed on a timer, before processing");
  ctx.Assert(!ctx.Kafka.EventsOf("manual-commit").empty(), "no explicit commit happened");
  ctx.Equal(ctx.Kafka.Lag("fanout", "posts"), 0, "every processed record must be committed");
}

void CheckCelebrity(harness::Ctx& ctx) {
  seedPost(ctx, "p1", "taylor");
  seedPost(ctx, "p2", "ann");
  drainWorker(ctx, {{"taylor", numbered("fan", 10001)}, {"ann", {"bob", "cat"}}});
  ctx.Equal(ctx.Redis.LRange("timeline:bob", 0, -1), {"p2"}, "ann has 2 followers: her post must be pushed, timeline:bob");
  const auto pushed = ctx.Redis.Keys("timeline:fan*");
  ctx.Equal(pushed.size(), 0, "taylor has 10 001 followers: her post must not be fanned out, but fan timelines were written");
  ctx.Equal(ctx.Kafka.Lag("fanout", "posts"), 0, "a skipped celebrity post must still have its offset committed");
}

void CheckPushTrim(harness::Ctx& ctx) {
  std::vector<std::string> old = {"RPUSH", "timeline:bob"};
  for (const auto& id : numbered("old", 1000)) old.push_back(id);
  ctx.Redis.Must(old);
  seedPost(ctx, "p1", "ann");
  seedPost(ctx, "p2", "ann");
  drainWorker(ctx, {{"ann", {"bob", "cat"}}});
  const auto bob = ctx.Redis.LRange("timeline:bob", 0, -1);
  ctx.Assert(bob.size() >= 2 && bob[0] == "p2" && bob[1] == "p1", "timeline:bob must start with the newest post (LPUSH), got %q",
             std::vector<std::string>(bob.begin(), bob.begin() + std::min<size_t>(3, bob.size())));
  ctx.Equal(bob.size(), 1000, "timeline:bob must be trimmed to 1000 entries");
  ctx.Equal(bob.back(), "old997", "LTRIM must drop the oldest entries: the tail of timeline:bob");
  ctx.Equal(ctx.Redis.LRange("timeline:cat", 0, -1), {"p2", "p1"}, "timeline:cat");
}

void CheckBatchedCommit(harness::Ctx& ctx) {
  seedPost(ctx, "p1", "ann");
  std::vector<std::pair<int, int>> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) {
    atCommit.emplace_back(static_cast<int>(fanoutPipelines(ctx).size()), static_cast<int>(ctx.Redis.LLen("timeline:f1239")));
  });
  drainWorker(ctx, {{"ann", numbered("f", 1240)}});
  ctx.Equal(ctx.Redis.LRange("timeline:f1239", 0, -1), {"p1"}, "every one of the 1240 followers must receive the post: timeline:f1239");
  int writes = 0;
  for (const auto& trip : ctx.Redis.RoundTrips())
    if (trip.size() == 1 && (trip[0] == "LPUSH" || trip[0] == "LTRIM")) writes++;
  ctx.Assert(writes == 0, "%d LPUSH/LTRIM were sent one by one: queue them on a pipeline per batch of 500 followers", writes);
  std::vector<int> sizes;
  int largest = 0, total = 0;
  for (const auto& trip : fanoutPipelines(ctx)) {
    const int n = static_cast<int>(trip.size());
    sizes.push_back(n);
    largest = std::max(largest, n);
    total += n;
  }
  ctx.Equal(sizes.size(), 3, "1240 followers must take 3 pipelines (500, 500, 240 followers): pipeline execs observed");
  ctx.Assert(largest <= 1000 && total == 2480, "each pipeline carries lpush + ltrim for at most 500 followers, observed command counts %v", sizes);
  ctx.Assert(!atCommit.empty(), "the offset was never committed");
  ctx.Assert(atCommit[0] == std::pair<int, int>{3, 1}, "the commit must come after the last pipeline executed: at commit time %d pipeline(s) had run and timeline:f1239 had %d entries", atCommit[0].first, atCommit[0].second);
}
`,
  },
  debrief: `Fan-out on write moves the cost from every read to the one write: a post costs one Redis command pair per follower, after which every follower's feed is a single \`LRANGE\`. The celebrity threshold is what keeps that bounded — one account with 50 million followers would otherwise turn a post into 50 million writes and a minutes-long delay for everyone else on the same partition. Pipelining matters as much as the threshold: 500 commands in one round trip versus 500 round trips is the difference between milliseconds and seconds. Real systems also skip inactive followers (they rebuild the timeline on their next login instead), shard timelines across Redis clusters, and run several worker groups so one hot author cannot stall the rest.`,
};
