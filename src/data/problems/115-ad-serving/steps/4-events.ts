import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Impression events keyed by campaign, counted at render',
  concept: 'kafka',
  file: 'events',
  focus: ['server', 'kafka', 'counter', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the impression pipeline: it
builds a producer, serializes a payload and publishes to \`ads.impression\`. It hides three
production flaws, all of which inflate the numbers an advertiser is billed for. Review it like the
service owner, fix it, and prove the fix with the checks below.

Implement the pipeline the render beacon calls after an ad has actually been displayed.

- Impressions are counted and published **at render**, never when the ad is served: only
  \`handle_render_beacon\` (the beacon handler) produces to \`ads.impression\`. A serve response that
  was never displayed produces no impression and no event.
- The event is keyed by **campaign id** (\`key = campaign_id\`), so one campaign's delivery stream
  stays in one partition and stays ordered. Keying by user scatters a single campaign across every
  partition, and per-campaign ordering is lost.
- Each beacon carries a \`beacon_id\`; the pipeline **dedupes** on it with a \`SET ... NX EX\` write
  (\`DEDUPE_TTL_S\`) before it counts anything, so a retried or replayed beacon is counted once. The
  event carries the \`beacon_id\` and its \`dedupe_key\`.
- The pacing counter for the campaign **commits before the event is produced**: count first, publish
  second. If the broker rejects the produce, write an **outbox** row for the payload instead of
  dropping it, and configure the producer for \`acks = all\` (and idempotence) so a retried produce
  cannot double-publish.

**Failure mode the checks target.** The draft publishes from the serve path, so it bills impressions
for ads that never rendered — the same ad fifty times, the advertiser paying for all of them. It
keys by user, so a campaign's events land in every partition and a consumer sees them out of order.
And it acknowledges the produce before the counter is updated: a crash between the two loses the
count while the event survives, so events and counters disagree forever.`,
  sequence: {
    participants: ['Client', 'Ad Server', 'ads.impression', 'pacing counters'],
    messages: [
      {from: 'Client', to: 'Ad Server', label: 'render beacon · beacon_id · campaign_id', kind: 'sync'},
      {from: 'Ad Server', to: 'pacing counters', label: 'SET beacon:{id} NX EX dedupe window', kind: 'sync'},
      {from: 'pacing counters', to: 'Ad Server', label: 'first delivery / duplicate', kind: 'reply'},
      {from: 'Ad Server', to: 'pacing counters', label: 'INCR render counter (before the event)', kind: 'sync'},
      {
        from: 'Ad Server',
        to: 'ads.impression',
        label: 'produce · key = campaign_id · beacon_id · dedupe_key',
        kind: 'async',
      },
      {from: 'ads.impression', to: 'Ad Server', label: 'ack (acks = all)', kind: 'reply'},
      {from: 'Ad Server', to: 'Ad Server', label: 'on rejection: write an outbox row', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'topic',
      title: 'Publishes to ads.impression',
      detail:
        'The topic is `ads.impression`. The draft publishes there too — what is wrong is when it publishes, what it keys on and what it waits for.',
      match: {
        python: {all: [/TOPIC\s*=\s*"ads\.impression"/]},
        typescript: {all: [/IMPRESSION_TOPIC\s*=\s*'ads\.impression'/]},
        go: {all: [/impressionTopic\s*=\s*"ads\.impression"/]},
        scala: {all: [/ImpressionTopic\s*=\s*"ads\.impression"/]},
        cpp: {all: [/kImpressionTopic\s*=\s*"ads\.impression"/]},
      },
    },
    {
      id: 'key-campaign',
      title: 'Keys the event by campaign so its stream stays ordered',
      detail:
        'The produce call uses the campaign id as the message key, so every event for one campaign shares a partition and consumers see them in order. The draft keys by user, which scatters one campaign across partitions.',
      match: {
        python: {all: [/key=campaign_id/]},
        typescript: {all: [/key:\s*campaignId/]},
        go: {all: [/Key:\s*\[\]byte\(campaignID\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(ImpressionTopic, campaignId/]},
        cpp: {all: [/produce\(\s*kImpressionTopic[\s\S]{0,200}campaign_id\.c_str\(\)/]},
      },
    },
    {
      id: 'render-only',
      title: 'Publishes only for rendered beacons',
      detail:
        'The event is produced from the render-beacon handler, not from the serve path. Counting at serve time publishes impressions for ads that were never displayed — the mistake that makes an advertiser’s bill disagree with reality.',
      match: {
        python: {all: [/handle_render_beacon\(/, /\bTOPIC\b/]},
        typescript: {all: [/handleRenderBeacon\(/, /IMPRESSION_TOPIC/]},
        go: {all: [/HandleRenderBeacon\(/, /impressionTopic/]},
        scala: {all: [/handleRenderBeacon\(/, /ImpressionTopic/]},
        cpp: {all: [/HandleRenderBeacon\(/, /kImpressionTopic/]},
      },
    },
    {
      id: 'dedupe',
      title: 'Dedupes the beacon before it counts',
      detail:
        'The beacon id is claimed with a set-if-absent write that expires (`DEDUPE_TTL_S`), and only the first delivery reaches the counter or the producer. The draft dedupes nothing, so a retried beacon is counted twice.',
      match: {
        python: {all: [/DEDUPE_TTL_S/, /BEACON_KEY_PREFIX/], order: [/nx=True/, /producer\.produce\(/]},
        typescript: {all: [/DEDUPE_TTL_S/, /BEACON_KEY_PREFIX/], order: [/'NX'/, /producer\.send\(/]},
        go: {all: [/dedupeTtlS/, /beaconKeyPrefix/], order: [/SetNX\(/, /WriteMessages\(/]},
        scala: {all: [/DedupeTtlS/, /BeaconKeyPrefix/], order: [/\.nx\(\)/, /producer\.send\(/]},
        cpp: {all: [/kDedupeTtlS/, /kBeaconKeyPrefix/], order: [/NOT_EXIST/, /producer_->produce\(/]},
      },
    },
    {
      id: 'commit-before-publish',
      title: 'Commits the counter, then publishes, with an outbox on rejection',
      detail:
        'The render count is committed to the counters **before** the produce, the producer is configured with `acks = all`, and a rejected produce writes an outbox row instead of losing the event. The draft flushes first and increments afterwards, so a crash leaves the event without its count.',
      match: {
        python: {
          all: [/acks":\s*"all"/, /outbox/],
          order: [/commit_render_impression\(campaign_id,/, /producer\.produce\(/],
        },
        typescript: {all: [/acks:\s*-1/, /outbox/], order: [/commitRenderImpression\(campaignId,/, /producer\.send\(/]},
        go: {
          all: [/RequiredAcks:\s*kafka\.RequireAll/, /outbox/],
          order: [/CommitRenderImpression\(ctx, campaignID,/, /WriteMessages\(/],
        },
        scala: {all: [/acks", "all"/, /outbox/], order: [/commitRenderImpression\(campaignId,/, /producer\.send\(/]},
        cpp: {
          all: [/"acks", "all"/, /outbox/],
          order: [/CommitRenderImpression\(campaign_id,/, /producer_->produce\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import KafkaProducer  # confluent-kafka

logger = logging.getLogger("adserver.events")

TOPIC = "ads.impression"


def render_counter_key(campaign_id: str) -> str:
    return f"render:{campaign_id}"


def make_producer(bootstrap: str) -> KafkaProducer:
    return KafkaProducer({"bootstrap.servers": bootstrap, "acks": "1"})


def publish_impression_at_serve(producer, redis_client, campaign_id: str, user_hash: str, price_micros: int) -> None:
    # TODO: this draft publishes when the ad is served rather than when it renders, keys the
    # event by user so one campaign's stream scatters, dedupes nothing, and acknowledges before
    # the pacing counter is updated. Review all four flaws.
    payload = json.dumps({"campaign_id": campaign_id, "user_hash": user_hash, "price_micros": price_micros})
    producer.produce(TOPIC, key=user_hash, value=payload)
    producer.flush()
    redis_client.incr(render_counter_key(campaign_id))
    logger.info("impression published campaign=%s", campaign_id)
`,
      solution: `import json
import logging

from confluent_kafka import KafkaError, KafkaProducer  # confluent-kafka

logger = logging.getLogger("adserver.events")

TOPIC = "ads.impression"
BEACON_KEY_PREFIX = "beacon:"
DEDUPE_TTL_S = 86400
SOURCE = "render"


def beacon_key(beacon_id: str) -> str:
    return f"{BEACON_KEY_PREFIX}{beacon_id}"


def render_counter_key(campaign_id: str) -> str:
    return f"render:{campaign_id}"


def make_producer(bootstrap: str) -> KafkaProducer:
    """acks=all and idempotence: a retried produce must not publish a second impression."""
    return KafkaProducer(
        {"bootstrap.servers": bootstrap, "acks": "all", "enable.idempotence": True}
    )


class ImpressionPipeline:
    """Count at render, publish after the count, and keep a rejected event in the outbox."""

    def __init__(self, producer, redis_client, outbox) -> None:
        self._producer = producer
        self._redis = redis_client
        self._outbox = outbox

    def commit_render_impression(self, campaign_id: str, beacon_id: str) -> int:
        """Writes the counters the serve path reads; runs before the event leaves the process."""
        counted = int(self._redis.incr(render_counter_key(campaign_id)))
        self._redis.hset(f"render:{campaign_id}:beacons", beacon_id, counted)
        return counted

    def handle_render_beacon(self, beacon: dict) -> None:
        beacon_id = beacon["beacon_id"]
        campaign_id = beacon["campaign_id"]
        first_delivery = self._redis.set(beacon_key(beacon_id), "1", nx=True, ex=DEDUPE_TTL_S)
        if not first_delivery:
            logger.info("duplicate beacon ignored campaign=%s", campaign_id)
            return
        counted = self.commit_render_impression(campaign_id, beacon_id)
        payload = json.dumps(
            {
                "beacon_id": beacon_id,
                "dedupe_key": beacon_key(beacon_id),
                "campaign_id": campaign_id,
                "counted_impressions": counted,
                "source": SOURCE,
            }
        )
        try:
            self._producer.produce(TOPIC, key=campaign_id, value=payload)
            self._producer.flush()
        except KafkaError as err:
            logger.warning("produce rejected, writing outbox: %s", err)
            self._outbox.put(campaign_id, payload)
`,
    },
    typescript: {
      starter: `/** Impression events: a model-generated draft that publishes at serve time. */
import {Kafka, type Producer} from 'kafkajs';

export const IMPRESSION_TOPIC = 'ads.impression';

export const renderCounterKey = (campaignId: string): string => \`render:\${campaignId}\`;

export function makeProducer(kafka: Kafka): Producer {
  return kafka.producer({acks: 1});
}

export async function publishImpressionAtServe(
  producer: Producer,
  redis: {incr(key: string): Promise<number>},
  campaignId: string,
  userHash: string,
  priceMicros: number,
): Promise<void> {
  // TODO: this draft publishes when the ad is served rather than when it renders, keys the
  // event by user so one campaign's stream scatters, dedupes nothing, and acknowledges before
  // the pacing counter is updated. Review all four flaws.
  const payload = JSON.stringify({campaign_id: campaignId, user_hash: userHash, price_micros: priceMicros});
  await producer.send({topic: IMPRESSION_TOPIC, messages: [{key: userHash, value: payload}]});
  await redis.incr(renderCounterKey(campaignId));
}
`,
      solution: `/** Impression events: counted at render, keyed by campaign, outboxed when rejected. */
import {Kafka, type Producer} from 'kafkajs';

export const IMPRESSION_TOPIC = 'ads.impression';
export const BEACON_KEY_PREFIX = 'beacon:';
export const DEDUPE_TTL_S = 86400;
export const SOURCE = 'render';

export interface Beacon {
  beacon_id: string;
  campaign_id: string;
}

export interface Outbox {
  put(campaignId: string, payload: string): Promise<void>;
}

export interface BeaconRedis {
  set(key: string, value: string, mode: 'EX', ttl: number, nx: 'NX'): Promise<string | null>;
  incr(key: string): Promise<number>;
  hset(key: string, value: Record<string, string>): Promise<number>;
}

export const beaconKey = (beaconId: string): string => \`\${BEACON_KEY_PREFIX}\${beaconId}\`;

export const renderCounterKey = (campaignId: string): string => \`render:\${campaignId}\`;

export function makeProducer(kafka: Kafka): Producer {
  return kafka.producer({idempotent: true, acks: -1});
}

export class ImpressionPipeline {
  private readonly producer: Producer;

  constructor(
    kafka: Kafka,
    private readonly redis: BeaconRedis,
    private readonly outbox: Outbox,
  ) {
    this.producer = makeProducer(kafka);
  }

  async commitRenderImpression(campaignId: string, beaconId: string): Promise<number> {
    const counted = await this.redis.incr(renderCounterKey(campaignId));
    await this.redis.hset(\`render:\${campaignId}:beacons\`, {[beaconId]: String(counted)});
    return counted;
  }

  async handleRenderBeacon(beacon: Beacon): Promise<void> {
    const {beacon_id: beaconId, campaign_id: campaignId} = beacon;
    const firstDelivery = await this.redis.set(beaconKey(beaconId), '1', 'EX', DEDUPE_TTL_S, 'NX');
    if (firstDelivery === null) return;
    const counted = await this.commitRenderImpression(campaignId, beaconId);
    const payload = JSON.stringify({
      beacon_id: beaconId,
      dedupe_key: beaconKey(beaconId),
      campaign_id: campaignId,
      counted_impressions: counted,
      source: SOURCE,
    });
    try {
      await this.producer.send({
        topic: IMPRESSION_TOPIC,
        acks: -1,
        messages: [{key: campaignId, value: payload}],
      });
    } catch (error) {
      await this.outbox.put(campaignId, payload);
      throw error;
    }
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"

	kafka "github.com/segmentio/kafka-go"
	"github.com/redis/go-redis/v9"
)

const impressionTopic = "ads.impression"

type Beacon struct {
	BeaconID   string \`json:"beacon_id"\`
	CampaignID string \`json:"campaign_id"\`
	UserHash   string \`json:"user_hash"\`
}

func renderCounterKey(campaignID string) string { return "render:" + campaignID }

func PublishImpressionAtServe(ctx context.Context, writer *kafka.Writer, rdb *redis.Client, beacon Beacon, priceMicros int64) error {
	// TODO: this draft publishes when the ad is served rather than when it renders, keys the
	// event by user so one campaign's stream scatters, dedupes nothing, and acknowledges before
	// the pacing counter is updated. Review all four flaws.
	payload, err := json.Marshal(map[string]any{
		"campaign_id":  beacon.CampaignID,
		"user_hash":    beacon.UserHash,
		"price_micros": priceMicros,
	})
	if err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{
		Topic: impressionTopic,
		Key:   []byte(beacon.UserHash),
		Value: payload,
	}); err != nil {
		return err
	}
	rdb.Incr(ctx, renderCounterKey(beacon.CampaignID))
	log.Printf("impression published campaign=%s", beacon.CampaignID)
	return nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	kafka "github.com/segmentio/kafka-go"
	"github.com/redis/go-redis/v9"
)

const (
	impressionTopic = "ads.impression"
	beaconKeyPrefix = "beacon:"
	dedupeTtlS      = 86400
)

type Beacon struct {
	BeaconID   string \`json:"beacon_id"\`
	CampaignID string \`json:"campaign_id"\`
}

type Outbox interface {
	Put(ctx context.Context, campaignID, payload string) error
}

func beaconKey(beaconID string) string { return beaconKeyPrefix + beaconID }

func renderCounterKey(campaignID string) string { return "render:" + campaignID }

// ImpressionPipeline counts at render, publishes after the count, and keeps a rejected event.
type ImpressionPipeline struct {
	writer *kafka.Writer
	redis  *redis.Client
	outbox Outbox
}

func NewImpressionPipeline(brokers []string, rdb *redis.Client, outbox Outbox) *ImpressionPipeline {
	return &ImpressionPipeline{
		writer: &kafka.Writer{
			Addr:         kafka.TCP(brokers...),
			Topic:        impressionTopic,
			RequiredAcks: kafka.RequireAll,
			Balancer:     &kafka.Hash{},
		},
		redis:  rdb,
		outbox: outbox,
	}
}

func (p *ImpressionPipeline) CommitRenderImpression(ctx context.Context, campaignID, beaconID string) (int64, error) {
	counted, err := p.redis.Incr(ctx, renderCounterKey(campaignID)).Result()
	if err != nil {
		return 0, err
	}
	if err := p.redis.HSet(ctx, "render:"+campaignID+":beacons", beaconID, counted).Err(); err != nil {
		return 0, err
	}
	return counted, nil
}

func (p *ImpressionPipeline) HandleRenderBeacon(ctx context.Context, campaignID string, beacon Beacon) error {
	first, err := p.redis.SetNX(ctx, beaconKey(beacon.BeaconID), "1", dedupeTtlS*time.Second).Result()
	if err != nil {
		return err
	}
	if !first {
		log.Printf("duplicate beacon ignored campaign=%s", campaignID)
		return nil
	}
	counted, err := p.CommitRenderImpression(ctx, campaignID, beacon.BeaconID)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(map[string]any{
		"beacon_id":           beacon.BeaconID,
		"dedupe_key":          beaconKey(beacon.BeaconID),
		"campaign_id":         campaignID,
		"counted_impressions": counted,
		"source":              "render",
	})
	if err != nil {
		return err
	}
	message := kafka.Message{Topic: impressionTopic, Key: []byte(campaignID), Value: payload}
	if err := p.writer.WriteMessages(ctx, message); err != nil {
		log.Printf("produce rejected, writing outbox: %v", err)
		return p.outbox.Put(ctx, campaignID, string(payload))
	}
	return nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import redis.clients.jedis.Jedis

object ImpressionEvents {
  val ImpressionTopic = "ads.impression"

  def renderCounterKey(campaignId: String): String = s"render:$campaignId"

  def producerConfig(bootstrap: String): Properties = {
    val props = new Properties()
    props.put("bootstrap.servers", bootstrap)
    props.put("acks", "1")
    props
  }
}

final case class Beacon(beacon_id: String, campaign_id: String, user_hash: String)

class ImpressionPipeline(producer: KafkaProducer[String, String], redis: Jedis) {
  import ImpressionEvents._

  def publishImpressionAtServe(beacon: Beacon, priceMicros: Long): Unit = {
    // TODO: this draft publishes when the ad is served rather than when it renders, keys the
    // event by user so one campaign's stream scatters, dedupes nothing, and acknowledges before
    // the pacing counter is updated. Review all four flaws.
    val payload = s"""{"campaign_id":"\${beacon.campaign_id}","price_micros":$priceMicros}"""
    producer.send(new ProducerRecord[String, String](ImpressionTopic, beacon.user_hash, payload)).get()
    redis.incr(renderCounterKey(beacon.campaign_id))
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams

object ImpressionEvents {
  val ImpressionTopic = "ads.impression"
  val BeaconKeyPrefix = "beacon:"
  val DedupeTtlS = 86400

  def beaconKey(beaconId: String): String = s"$BeaconKeyPrefix$beaconId"

  def renderCounterKey(campaignId: String): String = s"render:$campaignId"

  def producerConfig(bootstrap: String): Properties = {
    val props = new Properties()
    props.put("bootstrap.servers", bootstrap)
    props.put("acks", "all")
    props.put("enable.idempotence", "true")
    props
  }
}

final case class Beacon(beacon_id: String, campaign_id: String)

trait Outbox {
  def put(campaignId: String, payload: String): Unit
}

/** Count at render, publish after the count, and keep a rejected event in the outbox. */
class ImpressionPipeline(producer: KafkaProducer[String, String], redis: Jedis, outbox: Outbox) {
  import ImpressionEvents._

  def commitRenderImpression(campaignId: String, beaconId: String): Long = {
    val counted = redis.incr(renderCounterKey(campaignId))
    redis.hset(s"render:$campaignId:beacons", beaconId, counted.toString)
    counted
  }

  def handleRenderBeacon(beacon: Beacon): Unit = {
    val Beacon(beaconId, campaignId) = beacon
    val first = redis.set(beaconKey(beaconId), "1", SetParams.setParams().nx().ex(DedupeTtlS))
    if (first != "OK") return
    val counted = commitRenderImpression(campaignId, beaconId)
    val payload =
      s"""{"beacon_id":"\${beaconId}","dedupe_key":"\${beaconKey(beaconId)}",""" +
        s""""campaign_id":"\${campaignId}","counted_impressions":$counted,"source":"render"}"""
    try {
      producer.send(new ProducerRecord[String, String](ImpressionTopic, campaignId, payload)).get()
      ()
    } catch {
      case _: Exception => outbox.put(campaignId, payload)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <string>

const std::string kImpressionTopic = "ads.impression";

std::string renderCounterKey(const std::string& campaignId) { return "render:" + campaignId; }

class ImpressionPipeline {
 public:
  ImpressionPipeline(RdKafka::Producer* producer, sw::redis::Redis& redis) : producer_(producer), redis_(redis) {}

  void PublishImpressionAtServe(const std::string& campaignId, const std::string& userHash, long priceMicros) {
    // TODO: this draft publishes when the ad is served rather than when it renders, keys the
    // event by user so one campaign's stream scatters, dedupes nothing, and acknowledges before
    // the pacing counter is updated. Review all four flaws.
    const std::string payload = "{\\"campaign_id\\":\\"" + campaignId + "\\",\\"price_micros\\":" +
                                std::to_string(priceMicros) + "}";
    producer_->produce(kImpressionTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                       const_cast<char*>(payload.data()), payload.size(), userHash.c_str(), userHash.size(), 0,
                       nullptr);
    producer_->flush(1000);
    redis_.incr(renderCounterKey(campaignId));
  }

 private:
  RdKafka::Producer* producer_;
  sw::redis::Redis& redis_;
};

int main() { std::cout << "ad server ready\\n"; }
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <string>

const std::string kImpressionTopic = "ads.impression";
const std::string kBeaconKeyPrefix = "beacon:";
constexpr long kDedupeTtlS = 86400;

std::string beaconKey(const std::string& beaconId) { return kBeaconKeyPrefix + beaconId; }

std::string renderCounterKey(const std::string& campaignId) { return "render:" + campaignId; }

RdKafka::Conf* producerConfig(const std::string& bootstrap) {
  RdKafka::Conf* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  conf->set("bootstrap.servers", bootstrap, *new std::string());
  conf->set("acks", "all", *new std::string());
  conf->set("enable.idempotence", "true", *new std::string());
  return conf;
}

struct Outbox {
  void put(const std::string& campaignId, const std::string& payload);
};

/** Count at render, publish after the count, keep a rejected event in the outbox. */
class ImpressionPipeline {
 public:
  ImpressionPipeline(RdKafka::Producer* producer, sw::redis::Redis& redis, Outbox& outbox)
      : producer_(producer), redis_(redis), outbox_(outbox) {}

  long CommitRenderImpression(const std::string& campaignId, const std::string& beaconId) {
    const long counted = redis_.incr(renderCounterKey(campaignId));
    redis_.hset("render:" + campaignId + ":beacons", beaconId, std::to_string(counted));
    return counted;
  }

  void HandleRenderBeacon(const std::string& campaign_id, const std::string& beacon_id) {
    const bool first = redis_.set(beaconKey(beacon_id), "1", std::chrono::seconds(kDedupeTtlS),
                                  sw::redis::UpdateType::NOT_EXIST);
    if (!first) {
      std::cerr << "duplicate beacon ignored campaign=" << campaign_id << "\\n";
      return;
    }
    const long counted = CommitRenderImpression(campaign_id, beacon_id);
    const std::string payload = "{\\"beacon_id\\":\\"" + beacon_id + "\\",\\"campaign_id\\":\\"" + campaign_id +
                                "\\",\\"counted_impressions\\":" + std::to_string(counted) + "}";
    const auto error = producer_->produce(kImpressionTopic, RdKafka::Topic::PARTITION_UA,
                                          RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
                                          payload.size(), campaign_id.c_str(), campaign_id.size(), 0, nullptr);
    producer_->flush(1000);
    if (error != RdKafka::ERR_NO_ERROR) {
      std::cerr << "produce rejected, writing outbox\\n";
      outbox_.put(campaign_id, payload);
    }
  }

 private:
  RdKafka::Producer* producer_;
  sw::redis::Redis& redis_;
  Outbox& outbox_;
};
`,
    },
  },
  hints: [
    'Move the produce call to the beacon handler and leave the serve path alone. An impression is a fact about a display, and the only place that knows a display happened is the render beacon — anything else is a guess about intent.',
    'Claim the beacon id first: `SET beacon:{beacon_id} 1 NX EX 86400`. If the write returns nothing, the beacon was already counted, so return before you touch the counter or the producer. Expire the key, or a long-lived page retried next week is silently dropped.',
    'Order the two writes: count (Redis, the same counters the serve path reads) then publish (Kafka, keyed by campaign id). If the produce throws, hand the payload to the outbox and let a replay publish it later — the count is already committed, so a replay must not count again.',
  ],
  debrief: `The interviewer is testing whether your event pipeline measures the product or the intent. The draft is what you get from writing the publisher where the data is convenient: the serve path has the campaign, the price and the user, so it publishes there — and every ad that is chosen but blocked, throttled or never rendered is billed. Keying by user is the second flaw and the subtler one: it looks harmless in a small topic, but it spreads one campaign's events over every partition, so a consumer that counts per campaign sees a shuffled stream. The third flaw is ordering: acknowledgement before the counter commit means a crash desynchronizes events and counters, and the reconciliation job you write next quarter will never agree with either. Real systems add a schema registry with a content contract (ids only), consumer-side idempotence keyed by beacon id, a lag alert on the impression topic, and an outbox replay that is itself deduped by the same key.`,
};
