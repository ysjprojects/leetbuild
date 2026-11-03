import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Page events keyed by host, carrying references, after the index write',
  concept: 'kafka',
  file: 'events',
  focus: ['crawler', 'index', 'kafka', 'indexer', 'store'],
  task: `## Task

**Starting point.** The starter is \`index_page(job_id, url, page)\`, which the worker calls once a
page is fetched (\`page\` is \`{status, content_hash, body_ref, body}\`): it produces a \`crawl.page\`
event carrying the page, marks it indexed with \`records.mark_indexed\`, writes the search index
with \`search.put(url, content_hash, body)\` and answers the event. Every page shows up on the
topic, and it hides four flaws.

**Failure mode the checks target.** A host's pages and their re-crawls land on any partition, so
an indexer can apply an old crawl over a new one; every page's markup is copied into a retained,
replicated topic; a consumer reads an event before the entry it points at exists, and a page the
index refused is announced and counted; a leader failover loses events only the leader had.

- The record key is the URL's **host** (\`web.split_url\`).
- The payload is \`{job_id, url, host, status, content_hash, body_ref}\`: references, no body.
- \`search.put\` first, then \`records.mark_indexed\`, then produce. A page \`search.put\` refuses (an
  empty body raises) is neither marked nor announced.
- The producer waits for every in-sync replica: \`acks=all\` (kafkajs \`acks: -1\`, kafka-go
  \`RequireAll\`).`,
  sequence: {
    participants: ['Crawl worker', 'Search index', 'Redis records', 'crawl.page', 'Indexer'],
    messages: [
      {from: 'Crawl worker', to: 'Search index', label: 'search.put(url, content_hash, body)', kind: 'sync'},
      {from: 'Crawl worker', to: 'Redis records', label: 'mark_indexed(job_id, url)', kind: 'sync'},
      {from: 'Crawl worker', to: 'crawl.page', label: 'produce · key = host · acks = all', kind: 'sync'},
      {from: 'crawl.page', to: 'Crawl worker', label: 'ack from every in-sync replica', kind: 'reply'},
      {from: 'crawl.page', to: 'Indexer', label: 'consume · {url, host, content_hash, body_ref}', kind: 'async'},
      {from: 'Indexer', to: 'Search index', label: 'the entry the event points at exists', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'host-key',
      title: 'Keyed by host',
      detail:
        "Every record's key is the URL's host, so a host's pages and their re-crawls stay on one partition in the order they were produced. The starter sends no key.",
      match: {
        python: {all: [/key\s*=\s*host\b/]},
        typescript: {all: [/key:\s*host\b/]},
        go: {all: [/Key:\s*\[\]byte\(host\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(Topic,\s*host\b/]},
        cpp: {all: [/host\.c_str\(\),\s*host\.(size|length)\(\)/]},
      },
    },
    {
      id: 'references-only',
      title: 'Carries references, never the page',
      detail:
        'The payload is `{job_id, url, host, status, content_hash, body_ref}`: the page stays in the page store, and the topic, which is retained and replicated, carries where to find it. The starter copies the body into every event.',
      match: {
        python: {all: [/["']body_ref["']\s*:/, /["']host["']\s*:/], none: [/["'](content|body|html)["']\s*:/]},
        typescript: {all: [/body_ref:/], none: [/\b(content|body|html):\s*page\.body/]},
        go: {all: [/"body_ref":/, /"host":/], none: [/"(content|body|html)":\s*page\.Body/]},
        scala: {all: [/"body_ref"\s*->/, /"host"\s*->/], none: [/"(content|body|html)"\s*->/]},
        cpp: {all: [/\{"body_ref",/, /\{"host",/], none: [/\{"(content|body|html)",/]},
      },
    },
    {
      id: 'index-before-announce',
      title: 'Writes the index and the record before producing',
      detail:
        '`search.put`, then `mark_indexed`, then the produce: a consumer that reads the event finds the entry it points at, and a page the index refuses is neither counted nor announced. The starter produces first.',
      match: {
        python: {order: [/search\.put\(/, /records\.mark_indexed\(/, /producer\.produce\(/]},
        typescript: {order: [/(?<![.\w])put\(|search\.put\(/, /markIndexed\(/, /producer\.send\(/]},
        go: {order: [/search\.Put\(/, /records\.MarkIndexed\(/, /\.WriteMessages\(/]},
        scala: {order: [/Search\.put\(/, /Records\.markIndexed\(/, /producer\.send\(/]},
        cpp: {order: [/search::put\(/, /records::markIndexed\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'acks-all',
      title: 'Waits for every in-sync replica',
      detail:
        "The producer uses `acks=all` (kafkajs `acks: -1`, kafka-go `RequireAll`), so an acknowledged event survives a leader failover. The starter's `acks=1` is acknowledged by the leader alone.",
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/]},
        typescript: {all: [/acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/"acks",\s*"(all|-1)"/]},
        cpp: {all: [/"acks",\s*"(all|-1)"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

from crawl import records, search, web  # search.put; records.mark_indexed; web.split_url

TOPIC = "crawl.page"
log = logging.getLogger("events")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("crawl.page event not delivered: %s", err)


def index_page(job_id: str, url: str, page: dict) -> dict:
    """Index a fetched page ({status, content_hash, body_ref, body}) and announce it on crawl.page."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    event = {
        "job_id": job_id,
        "url": url,
        "status": page["status"],
        "content_hash": page["content_hash"],
        "content": page["body"],  # the indexer gets the page without a second read
    }
    producer.produce(TOPIC, value=json.dumps(event), on_delivery=on_delivery)
    producer.flush(5.0)
    records.mark_indexed(job_id, url)
    search.put(url, page["content_hash"], page["body"])
    return event
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from crawl import records, search, web  # search.put; records.mark_indexed; web.split_url

TOPIC = "crawl.page"
log = logging.getLogger("events")

# acks=all: an acknowledged event is on every in-sync replica and survives a leader failover.
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("crawl.page event not delivered: %s", err)


def index_page(job_id: str, url: str, page: dict) -> dict:
    """Index a fetched page ({status, content_hash, body_ref, body}) and announce it on crawl.page."""
    host = web.split_url(url)["host"]
    # The index entry and the record exist before anyone can read about them; a refused page raises here.
    search.put(url, page["content_hash"], page["body"])
    records.mark_indexed(job_id, url)
    event = {
        "job_id": job_id,
        "url": url,
        "host": host,
        "status": page["status"],
        "content_hash": page["content_hash"],
        "body_ref": page["body_ref"],
    }
    producer.produce(TOPIC, key=host, value=json.dumps(event), on_delivery=on_delivery)
    producer.flush(5.0)
    return event
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {markIndexed} from 'crawl/records';
import {put} from 'crawl/search';
import {splitUrl} from 'crawl/web';

export const TOPIC = 'crawl.page';

export interface FetchedPage {
  status: number;
  content_hash: string;
  body_ref: string;
  body: string;
}

const kafka = new Kafka({clientId: 'crawld', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Index a fetched page and announce it on crawl.page. */
export async function indexPage(jobId: string, url: string, page: FetchedPage): Promise<Record<string, unknown>> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const event = {
    job_id: jobId,
    url,
    status: page.status,
    content_hash: page.content_hash,
    content: page.body, // the indexer gets the page without a second read
  };
  await producer.send({topic: TOPIC, messages: [{value: JSON.stringify(event)}], acks: 1});
  await markIndexed(jobId, url);
  await put(url, page.content_hash, page.body);
  return event;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {markIndexed} from 'crawl/records';
import {put} from 'crawl/search';
import {splitUrl} from 'crawl/web';

export const TOPIC = 'crawl.page';

export interface FetchedPage {
  status: number;
  content_hash: string;
  body_ref: string;
  body: string;
}

const kafka = new Kafka({clientId: 'crawld', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Index a fetched page and announce it on crawl.page. */
export async function indexPage(jobId: string, url: string, page: FetchedPage): Promise<Record<string, unknown>> {
  const host = splitUrl(url)?.host ?? '';
  // The index entry and the record exist before anyone can read about them; a refused page throws here.
  await put(url, page.content_hash, page.body);
  await markIndexed(jobId, url);
  const event = {job_id: jobId, url, host, status: page.status, content_hash: page.content_hash, body_ref: page.body_ref};
  // acks -1 (all): an acknowledged event is on every in-sync replica and survives a leader failover.
  await producer.send({topic: TOPIC, messages: [{key: host, value: JSON.stringify(event)}], acks: -1});
  return event;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/segmentio/kafka-go"

	"crawl/records" // records.MarkIndexed
	"crawl/search"  // search.Put
)

const topic = "crawl.page"

// FetchedPage is what the worker holds once a page is fetched.
type FetchedPage struct {
	Status      int
	ContentHash string
	BodyRef     string
	Body        string
}

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
}

// indexPage indexes a fetched page and announces it on crawl.page.
func indexPage(ctx context.Context, jobID, url string, page FetchedPage) (map[string]any, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	event := map[string]any{
		"job_id":       jobID,
		"url":          url,
		"status":       page.Status,
		"content_hash": page.ContentHash,
		"content":      page.Body, // the indexer gets the page without a second read
	}
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Value: value}); err != nil {
		return nil, err
	}
	records.MarkIndexed(ctx, jobID, url)
	return event, search.Put(ctx, url, page.ContentHash, page.Body)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/segmentio/kafka-go"

	"crawl/records" // records.MarkIndexed
	"crawl/search"  // search.Put
	"crawl/web"     // web.SplitURL
)

const topic = "crawl.page"

// FetchedPage is what the worker holds once a page is fetched.
type FetchedPage struct {
	Status      int
	ContentHash string
	BodyRef     string
	Body        string
}

// RequireAll: an acknowledged event is on every in-sync replica and survives a leader failover.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

// indexPage indexes a fetched page and announces it on crawl.page.
func indexPage(ctx context.Context, jobID, url string, page FetchedPage) (map[string]any, error) {
	host := ""
	if parts := web.SplitURL(url); parts != nil {
		host = parts.Host
	}
	// The index entry and the record exist before anyone can read about them; a refused page stops here.
	if err := search.Put(ctx, url, page.ContentHash, page.Body); err != nil {
		return nil, err
	}
	records.MarkIndexed(ctx, jobID, url)
	event := map[string]any{
		"job_id":       jobID,
		"url":          url,
		"host":         host,
		"status":       page.Status,
		"content_hash": page.ContentHash,
		"body_ref":     page.BodyRef,
	}
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(host), Value: value}); err != nil {
		return nil, err
	}
	return event, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import crawl.{Records, Search, Web} // Search.put; Records.markIndexed; Web.splitUrl

/** What the worker holds once a page is fetched. */
final case class FetchedPage(status: Int, contentHash: String, bodyRef: String, body: String)

object Events {
  val Topic = "crawl.page"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"crawl.page event not delivered: \${exception.getMessage}")
  }

  /** Index a fetched page and announce it on crawl.page. */
  def indexPage(jobId: String, url: String, page: FetchedPage): JsObject = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val event = JsObject(
      "job_id" -> JsString(jobId),
      "url" -> JsString(url),
      "status" -> JsNumber(page.status),
      "content_hash" -> JsString(page.contentHash),
      "content" -> JsString(page.body)) // the indexer gets the page without a second read
    producer.send(new ProducerRecord[String, String](Topic, event.compactPrint), onDelivery).get()
    Records.markIndexed(jobId, url)
    Search.put(url, page.contentHash, page.body)
    event
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import crawl.{Records, Search, Web} // Search.put; Records.markIndexed; Web.splitUrl

/** What the worker holds once a page is fetched. */
final case class FetchedPage(status: Int, contentHash: String, bodyRef: String, body: String)

object Events {
  val Topic = "crawl.page"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  // acks=all: an acknowledged event is on every in-sync replica and survives a leader failover.
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"crawl.page event not delivered: \${exception.getMessage}")
  }

  /** Index a fetched page and announce it on crawl.page. */
  def indexPage(jobId: String, url: String, page: FetchedPage): JsObject = {
    val host = Web.splitUrl(url).map(_.host).getOrElse("")
    // The index entry and the record exist before anyone can read about them; a refused page throws here.
    Search.put(url, page.contentHash, page.body)
    Records.markIndexed(jobId, url)
    val event = JsObject(
      "job_id" -> JsString(jobId),
      "url" -> JsString(url),
      "host" -> JsString(host),
      "status" -> JsNumber(page.status),
      "content_hash" -> JsString(page.contentHash),
      "body_ref" -> JsString(page.bodyRef))
    producer.send(new ProducerRecord[String, String](Topic, host, event.compactPrint), onDelivery).get()
    event
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "crawl/records.h"  // records::markIndexed
#include "crawl/search.h"   // search::put
#include "crawl/web.h"      // web::splitUrl

using json = nlohmann::json;

const std::string kTopic = "crawl.page";

// What the worker holds once a page is fetched.
struct FetchedPage {
  int status = 0;
  std::string content_hash;
  std::string body_ref;
  std::string body;
};

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "crawl.page event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Index a fetched page and announce it on crawl.page.
json indexPage(const std::string& job_id, const std::string& url, const FetchedPage& page) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json event = {{"job_id", job_id},
                      {"url", url},
                      {"status", page.status},
                      {"content_hash", page.content_hash},
                      {"content", page.body}};  // the indexer gets the page without a second read
  const std::string value = event.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), nullptr, 0, 0, nullptr);
  producer->flush(5000);
  records::markIndexed(job_id, url);
  search::put(url, page.content_hash, page.body);
  return event;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "crawl/records.h"  // records::markIndexed
#include "crawl/search.h"   // search::put
#include "crawl/web.h"      // web::splitUrl

using json = nlohmann::json;

const std::string kTopic = "crawl.page";

// What the worker holds once a page is fetched.
struct FetchedPage {
  int status = 0;
  std::string content_hash;
  std::string body_ref;
  std::string body;
};

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "crawl.page event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // acks=all: an acknowledged event is on every in-sync replica and survives a leader failover.
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Index a fetched page and announce it on crawl.page.
json indexPage(const std::string& job_id, const std::string& url, const FetchedPage& page) {
  const auto parts = web::splitUrl(url);
  const std::string host = parts ? parts->host : "";
  // The index entry and the record exist before anyone can read about them; a refused page throws here.
  search::put(url, page.content_hash, page.body);
  records::markIndexed(job_id, url);
  const json event = {{"job_id", job_id},           {"url", url},
                      {"host", host},               {"status", page.status},
                      {"content_hash", page.content_hash}, {"body_ref", page.body_ref}};
  const std::string value = event.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), host.c_str(), host.size(), 0, nullptr);
  producer->flush(5000);
  return event;
}
`,
    },
  },
  harness: {
    python: `import json

from crawl import records, search

TOPIC = "crawl.page"
JOB = "nightly"
BLOG = "blog.example.com"
DOCS = "docs.example.com"
BODY = "<html><body>How to descale a kettle</body></html>"


def _url(host, path):
    return f"https://{host}{path}"


def _page(path, body=BODY):
    return {"status": 200, "content_hash": f"sha256:{path}", "body_ref": f"pages{path}", "body": body}


def _index(m, host, path, body=BODY):
    url = _url(host, path)
    records.mark_fetched(JOB, url, f"sha256:{path}", f"pages{path}")
    return m.index_page(JOB, url, _page(path, body))


def _payload(record):
    try:
        return json.loads(record.value)
    except Exception as exc:
        raise AssertionError(f"the record's value is not JSON: {record.value!r} ({exc})")


def check_host_key(ctx):
    m = ctx.load("events")
    _index(m, BLOG, "/posts/1")
    _index(m, BLOG, "/posts/2")
    _index(m, DOCS, "/guide")
    _index(m, BLOG, "/posts/1")
    recs = ctx.kafka.records(TOPIC)
    assert len(recs) == 4, f"four indexed pages left {len(recs)} records on {TOPIC}"
    keys = [r.key for r in recs]
    assert keys == [BLOG.encode(), BLOG.encode(), DOCS.encode(), BLOG.encode()], f"records must be keyed by the URL's host, got {keys}"
    partitions = {r.partition for r in recs if r.key == BLOG.encode()}
    assert len(partitions) == 1, f"{BLOG}'s pages landed on partitions {sorted(partitions)}: a host's pages and their re-crawls must stay on one partition, in order"


def check_references_only(ctx):
    m = ctx.load("events")
    _index(m, BLOG, "/posts/1")
    record = ctx.kafka.records(TOPIC)[0]
    payload = _payload(record)
    for name in ("content", "body", "html"):
        assert name not in payload, f"the event carries the page as {name!r}: {sorted(payload)}. The topic is retained and replicated; carry body_ref, not the body"
    assert "descale" not in str(record.value), f"the event carries the page's text: {record.value!r}"
    expected = {"job_id": JOB, "url": _url(BLOG, "/posts/1"), "host": BLOG, "status": 200, "content_hash": "sha256:/posts/1", "body_ref": "pages/posts/1"}
    missing = {k: v for k, v in expected.items() if payload.get(k) != v}
    assert not missing, f"the event must carry {expected}; it has {payload}"


def check_index_before_announce(ctx):
    m = ctx.load("events")
    url = _url(BLOG, "/posts/1")
    records.mark_fetched(JOB, url, "sha256:/posts/1", "pages/posts/1")
    at_index = ctx.redis_after(f"index:{url}", lambda: len(ctx.kafka.records(TOPIC)))
    at_mark = ctx.redis_after(f"page:{JOB}:{url}", lambda: len(ctx.kafka.records(TOPIC)))
    m.index_page(JOB, url, _page("/posts/1"))
    assert at_index.fired, f"index_page never wrote index:{url}"
    assert at_index.result == 0, f"when the index entry was written the topic already held {at_index.result} record(s): a consumer could read the event before the entry it points at exists. Write the index, then produce"
    assert at_mark.fired and at_mark.result == 0, f"when the page was marked indexed the topic already held {at_mark.result} record(s): mark it, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1 and search.get(url) is not None, "after index_page the page must be in the index and announced once"
    empty = _url(BLOG, "/empty")
    records.mark_fetched(JOB, empty, "sha256:/empty", "pages/empty")
    try:
        m.index_page(JOB, empty, _page("/empty", body=""))
    except Exception:
        pass
    assert len(ctx.kafka.records(TOPIC)) == 1, "a page the index refused (empty body) was announced on crawl.page"
    status = records.page_of(JOB, empty)["status"]
    assert status == "fetched", f"a page the index refused is recorded as {status!r}: it was never indexed"


def check_acks_all(ctx):
    m = ctx.load("events")
    _index(m, BLOG, "/posts/1")
    _index(m, BLOG, "/posts/2")
    ctx.kafka.failover(TOPIC)
    kept = len(ctx.kafka.records(TOPIC))
    assert kept == 2, f"after a leader failover {TOPIC} holds {kept} of 2 acknowledged events: with acks=1 the leader alone had them. Use acks=all"
`,
    typescript: `const TOPIC = 'crawl.page';
const JOB = 'nightly';
const BLOG = 'blog.example.com';
const DOCS = 'docs.example.com';
const BODY = '<html><body>How to descale a kettle</body></html>';

const url = (host: string, path: string): string => \`https://\${host}\${path}\`;
const page = (path: string, body = BODY) => ({status: 200, content_hash: \`sha256:\${path}\`, body_ref: \`pages\${path}\`, body});

function events(ctx) {
  return {m: ctx.load('events'), records: ctx.load('/support/crawl/records.ts'), search: ctx.load('/support/crawl/search.ts')};
}

async function index(world, host: string, path: string, body = BODY) {
  await world.records.markFetched(JOB, url(host, path), \`sha256:\${path}\`, \`pages\${path}\`);
  return world.m.indexPage(JOB, url(host, path), page(path, body));
}

function payload(record) {
  try {
    return JSON.parse(record.value.toString());
  } catch (e) {
    assert.fail(\`the record's value is not JSON: \${record.value} (\${e})\`);
  }
}

export async function check_host_key(ctx) {
  const world = events(ctx);
  await index(world, BLOG, '/posts/1');
  await index(world, BLOG, '/posts/2');
  await index(world, DOCS, '/guide');
  await index(world, BLOG, '/posts/1');
  const recs = ctx.kafka.records(TOPIC);
  assert.equal(recs.length, 4, \`four indexed pages left \${recs.length} records on \${TOPIC}\`);
  const keys = recs.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, [BLOG, BLOG, DOCS, BLOG], \`records must be keyed by the URL's host, got \${JSON.stringify(keys)}\`);
  const partitions = [...new Set(recs.filter(r => r.key?.toString() === BLOG).map(r => r.partition))];
  assert.equal(partitions.length, 1, \`\${BLOG}'s pages landed on partitions \${JSON.stringify(partitions)}: a host's pages and their re-crawls must stay on one partition, in order\`);
}

export async function check_references_only(ctx) {
  const world = events(ctx);
  await index(world, BLOG, '/posts/1');
  const record = ctx.kafka.records(TOPIC)[0];
  const p = payload(record);
  for (const name of ['content', 'body', 'html']) {
    assert(!(name in p), \`the event carries the page as \${name}: \${JSON.stringify(Object.keys(p))}. The topic is retained and replicated; carry body_ref, not the body\`);
  }
  assert(!record.value.toString().includes('descale'), \`the event carries the page's text: \${record.value}\`);
  const expected = {job_id: JOB, url: url(BLOG, '/posts/1'), host: BLOG, status: 200, content_hash: 'sha256:/posts/1', body_ref: 'pages/posts/1'};
  for (const [k, v] of Object.entries(expected)) assert.equal(p[k], v, \`the event must carry \${JSON.stringify(expected)}; it has \${JSON.stringify(p)}\`);
}

export async function check_index_before_announce(ctx) {
  const world = events(ctx);
  const target = url(BLOG, '/posts/1');
  await world.records.markFetched(JOB, target, 'sha256:/posts/1', 'pages/posts/1');
  const atIndex = ctx.redisAfter(\`index:\${target}\`, () => ctx.kafka.records(TOPIC).length);
  const atMark = ctx.redisAfter(\`page:\${JOB}:\${target}\`, () => ctx.kafka.records(TOPIC).length);
  await world.m.indexPage(JOB, target, page('/posts/1'));
  assert(atIndex.fired, \`indexPage never wrote index:\${target}\`);
  assert.equal(atIndex.result, 0, \`when the index entry was written the topic already held \${atIndex.result} record(s): a consumer could read the event before the entry it points at exists. Write the index, then produce\`);
  assert(atMark.fired && atMark.result === 0, \`when the page was marked indexed the topic already held \${atMark.result} record(s): mark it, then produce\`);
  assert(ctx.kafka.records(TOPIC).length === 1 && (await world.search.get(target)) !== null, 'after indexPage the page must be in the index and announced once');
  const empty = url(BLOG, '/empty');
  await world.records.markFetched(JOB, empty, 'sha256:/empty', 'pages/empty');
  try {
    await world.m.indexPage(JOB, empty, page('/empty', ''));
  } catch {
    // the index refused the page
  }
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'a page the index refused (empty body) was announced on crawl.page');
  const status = (await world.records.pageOf(JOB, empty)).status;
  assert.equal(status, 'fetched', \`a page the index refused is recorded as \${status}: it was never indexed\`);
}

export async function check_acks_all(ctx) {
  const world = events(ctx);
  await index(world, BLOG, '/posts/1');
  await index(world, BLOG, '/posts/2');
  ctx.kafka.failover(TOPIC);
  const kept = ctx.kafka.records(TOPIC).length;
  assert.equal(kept, 2, \`after a leader failover \${TOPIC} holds \${kept} of 2 acknowledged events: with acks 1 the leader alone had them. Use acks -1 (all)\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"crawl/records"
	"crawl/search"

	"leetbuild/harness"
)

const (
	eventsJob = "nightly"
	eventBlog = "blog.example.com"
	eventDocs = "docs.example.com"
	pageBody  = "<html><body>How to descale a kettle</body></html>"
)

var eventsBg = context.Background()

func pageAt(host, path string) string { return "https://" + host + path }

func fetchedPage(path, body string) FetchedPage {
	return FetchedPage{Status: 200, ContentHash: "sha256:" + path, BodyRef: "pages" + path, Body: body}
}

func mustIndex(ctx *harness.Ctx, host, path string) map[string]any {
	url := pageAt(host, path)
	records.MarkFetched(eventsBg, eventsJob, url, "sha256:"+path, "pages"+path)
	event, err := indexPage(eventsBg, eventsJob, url, fetchedPage(path, pageBody))
	ctx.NoError(err, "indexPage(%s) failed", url)
	return event
}

func payloadOf(ctx *harness.Ctx, value []byte) map[string]any {
	var p map[string]any
	ctx.Assert(json.Unmarshal(value, &p) == nil, "the record's value is not JSON: %s", value)
	return p
}

func CheckHostKey(ctx *harness.Ctx) {
	mustIndex(ctx, eventBlog, "/posts/1")
	mustIndex(ctx, eventBlog, "/posts/2")
	mustIndex(ctx, eventDocs, "/guide")
	mustIndex(ctx, eventBlog, "/posts/1")
	recs := ctx.Kafka.Records(topic)
	ctx.Equal(len(recs), 4, "four indexed pages; the records on %s", topic)
	keys := ctx.Kafka.Keys(topic)
	sort.Strings(keys)
	ctx.Equal(keys, []string{eventBlog, eventBlog, eventBlog, eventDocs}, "records must be keyed by the URL's host; the keys")
	partitions := map[int]bool{}
	for _, r := range recs {
		if string(r.Key) == eventBlog {
			partitions[r.Partition] = true
		}
	}
	ctx.Equal(len(partitions), 1, "a host's pages and their re-crawls must stay on one partition, in order; the partitions %s's pages landed on", eventBlog)
}

func CheckReferencesOnly(ctx *harness.Ctx) {
	mustIndex(ctx, eventBlog, "/posts/1")
	value := ctx.Kafka.Records(topic)[0].Value
	p := payloadOf(ctx, value)
	for _, name := range []string{"content", "body", "html"} {
		_, present := p[name]
		ctx.Assert(!present, "the event carries the page as %q: %v. The topic is retained and replicated; carry body_ref, not the body", name, p)
	}
	ctx.Assert(!strings.Contains(string(value), "descale"), "the event carries the page's text: %s", value)
	expected := map[string]any{"job_id": eventsJob, "url": pageAt(eventBlog, "/posts/1"), "host": eventBlog, "status": 200, "content_hash": "sha256:/posts/1", "body_ref": "pages/posts/1"}
	for k, v := range expected {
		ctx.Equal(p[k], v, "the event must carry %v; it has %v; its %s", expected, p, k)
	}
}

func CheckIndexBeforeAnnounce(ctx *harness.Ctx) {
	url := pageAt(eventBlog, "/posts/1")
	records.MarkFetched(eventsBg, eventsJob, url, "sha256:/posts/1", "pages/posts/1")
	atIndex := ctx.Redis.After("index:"+url, func() any { return len(ctx.Kafka.Records(topic)) })
	atMark := ctx.Redis.After("page:"+eventsJob+":"+url, func() any { return len(ctx.Kafka.Records(topic)) })
	_, err := indexPage(eventsBg, eventsJob, url, fetchedPage("/posts/1", pageBody))
	ctx.NoError(err, "indexPage failed")
	ctx.Assert(atIndex.Fired, "indexPage never wrote index:%s", url)
	ctx.Equal(atIndex.Result, 0, "when the index entry was written the topic already held records: a consumer could read the event before the entry it points at exists. Write the index, then produce; the records at the index write")
	ctx.Assert(atMark.Fired, "indexPage never marked the page indexed")
	ctx.Equal(atMark.Result, 0, "when the page was marked indexed the topic already held records: mark it, then produce; the records at the mark")
	ctx.Assert(len(ctx.Kafka.Records(topic)) == 1 && search.Get(eventsBg, url) != nil, "after indexPage the page must be in the index and announced once")
	empty := pageAt(eventBlog, "/empty")
	records.MarkFetched(eventsBg, eventsJob, empty, "sha256:/empty", "pages/empty")
	indexPage(eventsBg, eventsJob, empty, fetchedPage("/empty", ""))
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "a page the index refused (empty body) must not be announced; the records")
	ctx.Equal(records.PageOf(eventsBg, eventsJob, empty)["status"], "fetched", "a page the index refused was never indexed; its record")
}

func CheckAcksAll(ctx *harness.Ctx) {
	mustIndex(ctx, eventBlog, "/posts/1")
	mustIndex(ctx, eventBlog, "/posts/2")
	lost := ctx.Kafka.Failover(topic)
	ctx.Equal(len(ctx.Kafka.Records(topic)), 2, "after a leader failover %d acknowledged event(s) were lost: with RequireOne the leader alone had them. Use RequireAll; the records", lost)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <memory>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

namespace {

const std::string kJob = "nightly";
const std::string kBlog = "blog.example.com";
const std::string kDocs = "docs.example.com";
const std::string kBody = "<html><body>How to descale a kettle</body></html>";

std::string pageAt(const std::string& host, const std::string& path) { return "https://" + host + path; }

FetchedPage fetchedPage(const std::string& path, const std::string& body) { return FetchedPage{200, "sha256:" + path, "pages" + path, body}; }

json mustIndex(harness::Ctx& ctx, const std::string& host, const std::string& path) {
  const std::string url = pageAt(host, path);
  records::markFetched(kJob, url, "sha256:" + path, "pages" + path);
  try {
    return indexPage(kJob, url, fetchedPage(path, kBody));
  } catch (const std::exception& e) {
    ctx.Fatalf("indexPage(%s) threw %s: %s", url, harness::CurrentExceptionType(), e.what());
  }
}

json payloadOf(harness::Ctx& ctx, const harness::KafkaRecord& record) {
  try {
    return json::parse(record.Value.value_or(""));
  } catch (const std::exception& e) {
    ctx.Fatalf("the record's value is not JSON: %s (%s)", record.Value.value_or(""), e.what());
  }
}

}  // namespace

void CheckHostKey(harness::Ctx& ctx) {
  mustIndex(ctx, kBlog, "/posts/1");
  mustIndex(ctx, kBlog, "/posts/2");
  mustIndex(ctx, kDocs, "/guide");
  mustIndex(ctx, kBlog, "/posts/1");
  const auto recs = ctx.Kafka.Records(kTopic);
  ctx.Equal(recs.size(), 4, "four indexed pages; the records on %s", kTopic);
  ctx.Equal(ctx.Kafka.Keys(kTopic), {kBlog, kBlog, kDocs, kBlog}, "records must be keyed by the URL's host; the keys");
  std::set<int> partitions;
  for (const auto& r : recs) {
    if (r.Key && *r.Key == kBlog) partitions.insert(r.Partition);
  }
  ctx.Equal(partitions.size(), 1, "a host's pages and their re-crawls must stay on one partition, in order; the partitions %s's pages landed on", kBlog);
}

void CheckReferencesOnly(harness::Ctx& ctx) {
  mustIndex(ctx, kBlog, "/posts/1");
  const auto record = ctx.Kafka.Records(kTopic).at(0);
  const json p = payloadOf(ctx, record);
  for (const std::string name : {"content", "body", "html"}) {
    ctx.Assert(!p.contains(name), "the event carries the page as %q: %s. The topic is retained and replicated; carry body_ref, not the body", name, p.dump());
  }
  ctx.Assert(record.Value.value_or("").find("descale") == std::string::npos, "the event carries the page's text: %s", record.Value.value_or(""));
  const json expected = {{"job_id", kJob}, {"url", pageAt(kBlog, "/posts/1")}, {"host", kBlog}, {"status", 200}, {"content_hash", "sha256:/posts/1"}, {"body_ref", "pages/posts/1"}};
  for (const auto& [k, v] : expected.items()) {
    ctx.Assert(p.contains(k) && p[k] == v, "the event must carry %s; it has %s", expected.dump(), p.dump());
  }
}

void CheckIndexBeforeAnnounce(harness::Ctx& ctx) {
  const std::string url = pageAt(kBlog, "/posts/1");
  records::markFetched(kJob, url, "sha256:/posts/1", "pages/posts/1");
  auto atIndex = std::make_shared<int>(-1);
  auto atMark = std::make_shared<int>(-1);
  ctx.Redis.After("index:" + url, [&ctx, atIndex] { *atIndex = static_cast<int>(ctx.Kafka.Records(kTopic).size()); });
  ctx.Redis.After("page:" + kJob + ":" + url, [&ctx, atMark] { *atMark = static_cast<int>(ctx.Kafka.Records(kTopic).size()); });
  try {
    indexPage(kJob, url, fetchedPage("/posts/1", kBody));
  } catch (const std::exception& e) {
    ctx.Fatalf("indexPage threw %s: %s", harness::CurrentExceptionType(), e.what());
  }
  ctx.Assert(*atIndex >= 0, "indexPage never wrote index:%s", url);
  ctx.Equal(*atIndex, 0, "when the index entry was written the topic already held records: a consumer could read the event before the entry it points at exists. Write the index, then produce; the records at the index write");
  ctx.Assert(*atMark >= 0, "indexPage never marked the page indexed");
  ctx.Equal(*atMark, 0, "when the page was marked indexed the topic already held records: mark it, then produce; the records at the mark");
  ctx.Assert(ctx.Kafka.Records(kTopic).size() == 1 && search::get(url).has_value(), "after indexPage the page must be in the index and announced once");
  const std::string empty = pageAt(kBlog, "/empty");
  records::markFetched(kJob, empty, "sha256:/empty", "pages/empty");
  try {
    indexPage(kJob, empty, fetchedPage("/empty", ""));
  } catch (const std::exception&) {
    // the index refused the page
  }
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "a page the index refused (empty body) must not be announced; the records");
  ctx.Equal(records::pageOf(kJob, empty)->at("status"), "fetched", "a page the index refused was never indexed; its record");
}

void CheckAcksAll(harness::Ctx& ctx) {
  mustIndex(ctx, kBlog, "/posts/1");
  mustIndex(ctx, kBlog, "/posts/2");
  const int lost = ctx.Kafka.Failover(kTopic);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "after a leader failover %d acknowledged event(s) were lost: with acks=1 the leader alone had them. Use acks=all; the records", lost);
}
`,
  },
  hints: [
    "Index three pages of one host and look at the partitions: they spread out, and every record carries the page's HTML. Index a page with an empty body: it is announced and counted, then the index refuses it.",
    'The produce has no key, so the partitioner picks any partition, and the payload is built from the page, body included. The produce runs first, `mark_indexed` second and `search.put` last, so a refusal leaves the event and the count behind. Acks are 1.',
    'Key the record by `web.split_url(url)["host"]`, send `job_id, url, host, status, content_hash, body_ref`, call `search.put`, then `records.mark_indexed`, then produce, and set `acks` to `all`.',
  ],
  debrief: `An event is a claim that something already happened, so it is produced after the writes it describes: the index entry and the page's status exist before any consumer can read about them, and a write that fails leaves nothing to retract. Keying by host keeps a host's pages, and every re-crawl of them, on one partition in the order they were produced, which is what lets an indexer apply the newest crawl last. The body stays in the page store because the topic is retained and replicated: a reference costs a few bytes and points at one copy with its own retention. Production pipelines also make the producer idempotent, keep an outbox so an event whose delivery failed is sent again, and version the payload schema.`,
};
