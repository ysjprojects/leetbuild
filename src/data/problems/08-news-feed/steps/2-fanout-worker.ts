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
  debrief: `Fan-out on write moves the cost from every read to the one write: a post costs one Redis command pair per follower, after which every follower's feed is a single \`LRANGE\`. The celebrity threshold is what keeps that bounded — one account with 50 million followers would otherwise turn a post into 50 million writes and a minutes-long delay for everyone else on the same partition. Pipelining matters as much as the threshold: 500 commands in one round trip versus 500 round trips is the difference between milliseconds and seconds. Real systems also skip inactive followers (they rebuild the timeline on their next login instead), shard timelines across Redis clusters, and run several worker groups so one hot author cannot stall the rest.`,
};
