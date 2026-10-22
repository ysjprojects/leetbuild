import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Page events keyed by host, content only by reference',
  concept: 'kafka',
  file: 'events',
  focus: ['crawler', 'kafka', 'indexer', 'index', 'store'],
  task: `## Task

The starter is a plausible model-generated draft: it publishes an event per crawled page and the
indexer picks it up, so the demo shows pages appearing in search. Three contracts are broken. Find
them, fix them, and prove the fix.

Implement \`POST /v1/crawl/pages\` — the endpoint a crawl worker calls once it has fetched and stored
a page — with body
\`{"url": "https://blog.example.com/posts", "status": 200, "content_hash": "sha256:…", "body_ref": "s3://pages/…"}\`.

- Publish **exactly one** \`crawl.page\` event per page with the **host** as the message key.
  Partitioning by host is what keeps a host's history ordered: keyed by worker id, the same host's
  pages arrive on different partitions and a re-crawl interleaves with the first crawl.
- The payload carries **references, never the page**: \`url\`, \`host\`, \`status\`,
  \`content_hash\` and \`body_ref\` (where the stored page lives). The draft inlines the fetched
  markup “for convenience”, which copies every page into a retained, replicated topic.
- **The index write confirms before the event is announced.** Write the entry first, then mark the
  page indexed, then publish; a consumer that reads an event must always find the entry it points
  at. The draft publishes first and marks the page indexed before the write returns, so a consumer
  can read an index entry that is not there yet and a failed write still looks indexed.

**Failure mode the checks target.** Worker-keyed events lose per-host order; an inlined body turns
the topic into a copy of the crawl (and of every tenant's content); and announcing before the write
confirms means the event is a promise the index has not made yet. Each of those is invisible in a
demo where one worker crawls one host and the index never fails.`,
  sequence: {
    participants: ['Crawl worker', 'Search index', 'crawl.page', 'Indexer'],
    messages: [
      {from: 'Crawl worker', to: 'Search index', label: 'put(url, content_hash, body_ref)', kind: 'sync'},
      {from: 'Search index', to: 'Crawl worker', label: 'indexed — the write is confirmed', kind: 'reply'},
      {from: 'Crawl worker', to: 'Crawl worker', label: 'mark the page indexed only now', kind: 'sync'},
      {from: 'Crawl worker', to: 'crawl.page', label: 'produce · key = host · refs only, no markup', kind: 'async'},
      {from: 'crawl.page', to: 'Crawl worker', label: 'ack', kind: 'reply'},
      {from: 'crawl.page', to: 'Indexer', label: 'consume · group crawl-index', kind: 'async'},
      {from: 'Indexer', to: 'Search index', label: 'read the entry the event points at', kind: 'sync'},
    ],
  },
  hints: [
    'The message key is the partition key. Take the host out of the URL once (`urlsplit(...).hostname`, `new URL(url).hostname`, `url.Parse(...).Hostname()`, `new URI(url).getHost`) and use it for both the event and the key — the key and the payload must not disagree about which host this page belongs to.',
    'A reference is a pointer the consumer can resolve later: the URL, the content hash that proves which revision it is, and where the bytes live. Anything the consumer can derive by fetching the reference does not belong in the topic, which is why the draft’s inlined markup is both a leak and a retention cost.',
    'Order the write and the announcement: `index.put(...)` first, then mark the page indexed, then `publish(...)`. If the publish fails after the write, the page is indexed but unannounced — recoverable by a sweep. If the publish happens first, the event is a promise the index has not made yet, and the consumer reads nothing.',
  ],
  checks: [
    {
      id: 'host-key',
      title: 'Publishes crawl.page keyed by host',
      detail:
        'The event goes to `crawl.page` with the **host** as the message key, so one host’s pages stay ordered on one partition. The draft keys by worker id.',
      match: {
        python: {all: [/crawl\.page/, /key=host/]},
        typescript: {all: [/crawl\.page/, /key:\s*host/]},
        go: {all: [/crawl\.page/, /Key:\s*\[\]byte\(host\)/]},
        scala: {all: [/crawl\.page/, /\("crawl\.page", host/]},
        cpp: {all: [/"crawl\.page"/, /key\.data\(\)/]},
      },
    },
    {
      id: 'no-content',
      title: 'The payload carries no page content',
      detail:
        'Neither the fetched markup nor a `content` field appears in the event: the topic carries references. The draft inlines the page body, so the topic retains a copy of every crawled byte.',
      match: {
        python: {none: [/\bcontent\b/, /\bhtml\b/]},
        typescript: {none: [/\bcontent\b/, /\bhtml\b/]},
        go: {none: [/\bcontent\b/, /\bhtml\b/]},
        scala: {none: [/\bcontent\b/, /\bhtml\b/]},
        cpp: {none: [/\bcontent\b/, /\bhtml\b/]},
      },
    },
    {
      id: 'page-ref',
      title: 'The event carries the content hash and the body reference',
      detail:
        'The payload has `content_hash` and `body_ref` so the consumer can verify which revision it is and fetch the bytes itself. The draft sends neither a hash nor a reference.',
      match: {
        python: {all: [/content_hash/, /body_ref/]},
        typescript: {all: [/content_hash/, /body_ref/]},
        go: {all: [/ContentHash/, /BodyRef/]},
        scala: {all: [/contentHash/, /bodyRef/]},
        cpp: {all: [/content_hash/, /body_ref/]},
      },
    },
    {
      id: 'index-before-announce',
      title: 'Indexes before announcing',
      detail:
        'The index write happens before the event is published, so a consumer can never read an entry the index does not have. The draft publishes first and writes afterwards.',
      match: {
        python: {order: [/index\.put\(/, /producer\.produce\(/]},
        typescript: {order: [/index\.put\(/, /publish\(/]},
        go: {order: [/index\.Put\(/, /publish\(/]},
        scala: {order: [/index\.put\(/, /publish\(/]},
        cpp: {order: [/index\.put\(/, /publish\(/]},
      },
    },
    {
      id: 'indexed-confirmed',
      title: 'Marks the page indexed only after the write confirmed',
      detail:
        '`mark_indexed` runs after `index.put` returns, not before: a write that fails must not leave the page looking indexed. The draft marks it indexed first.',
      match: {
        python: {order: [/index\.put\(/, /records\.mark_indexed\(/]},
        typescript: {order: [/index\.put\(/, /records\.markIndexed\(/]},
        go: {order: [/index\.Put\(/, /records\.MarkIndexed\(/]},
        scala: {order: [/index\.put\(/, /records\.markIndexed\(/]},
        cpp: {order: [/index\.put\(/, /records\.markIndexed\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()

producer = Producer({"bootstrap.servers": "kafka:9092"})


class PageRequest(BaseModel):
    url: str
    status: int
    html: str
    content_hash: str


@app.post("/v1/crawl/pages")
def page(
    body: PageRequest,
    worker_id: str = Header(alias="X-Worker-Id"),
    tenant: str = Header(alias="X-Tenant-Id"),
) -> dict:
    # TODO: this draft keys the event by worker so one host's history scatters across partitions,
    # inlines the fetched markup for convenience, and marks the page indexed before the index
    # write confirms. Key by host, keep the payload to references, and index before you announce.
    event = {"url": body.url, "status": body.status, "content": body.html}
    producer.produce("crawl.page", key=worker_id, value=json.dumps(event))
    producer.flush()
    records.mark_indexed(body.url)
    index.put(body.url, body.content_hash)
    return {"accepted": True}
`,
      solution: `import json
from urllib.parse import urlsplit

from confluent_kafka import Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()

PAGE_TOPIC = "crawl.page"

producer = Producer({"bootstrap.servers": "kafka:9092"})


class PageRequest(BaseModel):
    url: str
    status: int
    content_hash: str
    body_ref: str


@app.post("/v1/crawl/pages")
def page(
    body: PageRequest,
    worker_id: str = Header(alias="X-Worker-Id"),
    tenant: str = Header(alias="X-Tenant-Id"),
) -> dict:
    """Index a fetched page, then announce it keyed by host so its history stays ordered."""
    host = urlsplit(body.url).hostname or ""
    index.put(body.url, body.content_hash)
    records.mark_indexed(body.url)
    event = {
        "url": body.url,
        "host": host,
        "status": body.status,
        "content_hash": body.content_hash,
        "body_ref": body.body_ref,
    }
    producer.produce(PAGE_TOPIC, key=host, value=json.dumps(event))
    producer.flush()
    return {"accepted": True}
`,
    },
    typescript: {
      starter: `/** Page events: a model-generated draft that ships the page inside the event. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();

const PAGE_TOPIC = 'crawl.page';

const producer = new Kafka({brokers: ['kafka:9092']}).producer();

interface PageBody {
  url: string;
  status: number;
  html: string;
  content_hash: string;
}

interface PageEvent {
  url: string;
  status: number;
  content: string;
}

async function publish(workerId: string, event: PageEvent): Promise<void> {
  await producer.send({topic: PAGE_TOPIC, messages: [{key: workerId, value: JSON.stringify(event)}]});
}

app.post('/v1/crawl/pages', async (request, reply) => {
  // TODO: this draft keys the event by worker so one host's history scatters across partitions,
  // inlines the fetched markup for convenience, and marks the page indexed before the index
  // write confirms. Key by host, keep the payload to references, and index before you announce.
  const body = request.body as PageBody;
  const workerId = request.headers['x-worker-id'] as string;
  const event: PageEvent = {url: body.url, status: body.status, content: body.html};
  await publish(workerId, event);
  await records.markIndexed(body.url);
  await index.put(body.url, body.content_hash);
  return reply.code(202).send({accepted: true});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Page events: keyed by host, references only, announced after the index confirms. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();

const PAGE_TOPIC = 'crawl.page';

const producer = new Kafka({brokers: ['kafka:9092']}).producer();

interface PageBody {
  url: string;
  status: number;
  content_hash: string;
  body_ref: string;
}

interface PageEvent {
  url: string;
  host: string;
  status: number;
  content_hash: string;
  body_ref: string;
}

async function publish(host: string, event: PageEvent): Promise<void> {
  await producer.send({topic: PAGE_TOPIC, messages: [{key: host, value: JSON.stringify(event)}]});
}

app.post('/v1/crawl/pages', async (request, reply) => {
  const body = request.body as PageBody;
  const host = new URL(body.url).hostname;
  await index.put(body.url, body.content_hash);
  await records.markIndexed(body.url);
  await publish(host, {
    url: body.url,
    host,
    status: body.status,
    content_hash: body.content_hash,
    body_ref: body.body_ref,
  });
  return reply.code(202).send({accepted: true});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package pageevents

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const pageTopic = "crawl.page"

var producer = &kafka.Writer{Addr: kafka.TCP("kafka:9092")}

type PageRequest struct {
	URL         string \`json:"url"\`
	Status      int    \`json:"status"\`
	HTML        string \`json:"html"\`
	ContentHash string \`json:"content_hash"\`
}

type PageEvent struct {
	URL     string \`json:"url"\`
	Status  int    \`json:"status"\`
	Content string \`json:"content"\`
}

func publish(ctx context.Context, workerID string, event PageEvent) error {
	value, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return producer.WriteMessages(ctx, kafka.Message{Topic: pageTopic, Key: []byte(workerID), Value: value})
}

func RecordPage(ctx context.Context, body PageRequest, workerID string) error {
	// TODO: this draft keys the event by worker so one host's history scatters across partitions,
	// inlines the fetched markup for convenience, and marks the page indexed before the index
	// write confirms. Key by host, keep the payload to references, and index before you announce.
	if err := publish(ctx, workerID, PageEvent{URL: body.URL, Status: body.Status, Content: body.HTML}); err != nil {
		return err
	}
	if err := records.MarkIndexed(ctx, body.URL); err != nil {
		return err
	}
	return index.Put(ctx, body.URL, body.ContentHash)
}
`,
      solution: `package pageevents

import (
	"context"
	"encoding/json"
	"net/url"

	"github.com/segmentio/kafka-go"
)

const pageTopic = "crawl.page"

var producer = &kafka.Writer{Addr: kafka.TCP("kafka:9092")}

type PageRequest struct {
	URL         string \`json:"url"\`
	Status      int    \`json:"status"\`
	ContentHash string \`json:"content_hash"\`
	BodyRef     string \`json:"body_ref"\`
}

type PageEvent struct {
	URL         string \`json:"url"\`
	Host        string \`json:"host"\`
	Status      int    \`json:"status"\`
	ContentHash string \`json:"content_hash"\`
	BodyRef     string \`json:"body_ref"\`
}

func publish(ctx context.Context, host string, event PageEvent) error {
	value, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return producer.WriteMessages(ctx, kafka.Message{Topic: pageTopic, Key: []byte(host), Value: value})
}

func RecordPage(ctx context.Context, body PageRequest, workerID string) error {
	parsed, err := url.Parse(body.URL)
	if err != nil {
		return err
	}
	host := parsed.Hostname()
	if err := index.Put(ctx, body.URL, body.ContentHash); err != nil {
		return err
	}
	if err := records.MarkIndexed(ctx, body.URL); err != nil {
		return err
	}
	return publish(ctx, host, PageEvent{
		URL:         body.URL,
		Host:        host,
		Status:      body.Status,
		ContentHash: body.ContentHash,
		BodyRef:     body.BodyRef,
	})
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object PageEvents {
  val PageTopic = "crawl.page"

  val producer = new KafkaProducer[String, String](new Properties())

  final case class PageRequest(url: String, status: Int, html: String, contentHash: String)
  final case class PageEvent(url: String, status: Int, content: String)

  def publish(workerId: String, event: PageEvent): Unit =
    producer.send(new ProducerRecord[String, String](PageTopic, workerId, event.toString))

  def recordPage(body: PageRequest, workerId: String): Unit = {
    // TODO: this draft keys the event by worker so one host's history scatters across partitions,
    // inlines the fetched markup for convenience, and marks the page indexed before the index
    // write confirms. Key by host, keep the payload to references, and index before you announce.
    publish(workerId, PageEvent(body.url, body.status, body.html))
    records.markIndexed(body.url)
    index.put(body.url, body.contentHash)
  }
}
`,
      solution: `import java.net.URI
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json.DefaultJsonProtocol._
import spray.json._

object PageEvents {
  val PageTopic = "crawl.page"

  val producer = new KafkaProducer[String, String](new Properties())

  final case class PageRequest(url: String, status: Int, contentHash: String, bodyRef: String)
  final case class PageEvent(url: String, host: String, status: Int, contentHash: String, bodyRef: String)

  implicit val eventFormat: RootJsonFormat[PageEvent] = jsonFormat5(PageEvent)

  def publish(host: String, event: PageEvent): Unit =
    producer.send(new ProducerRecord[String, String]("crawl.page", host, event.toJson.compactPrint))

  def recordPage(body: PageRequest, workerId: String): Unit = {
    val host = Option(new URI(body.url).getHost).getOrElse("")
    index.put(body.url, body.contentHash)
    records.markIndexed(body.url)
    publish(
      host,
      PageEvent(body.url, host, body.status, body.contentHash, body.bodyRef)
    )
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

using json = nlohmann::json;

std::unique_ptr<RdKafka::Producer> producer(RdKafka::Producer::create(nullptr, nullptr));

void publish(const std::string& workerId, const std::string& payload) {
  producer->produce("crawl.page", RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), workerId.data(), workerId.size(), 0, nullptr);
  producer->poll(0);
}

void recordPage(const std::string& url, int status, const std::string& contentHash, const std::string& markup) {
  // TODO: this draft keys the event by worker so one host's history scatters across partitions,
  // inlines the fetched markup for convenience, and marks the page indexed before the index
  // write confirms. Key by host, keep the payload to references, and index before you announce.
  const json event = {{"url", url}, {"status", status}, {"content", markup}};
  publish(workerId, event.dump());
  records.markIndexed(url);
  index.put(url, contentHash);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

using json = nlohmann::json;

std::unique_ptr<RdKafka::Producer> producer(RdKafka::Producer::create(nullptr, nullptr));

void publish(const std::string& host, const std::string& payload) {
  const std::string key = host;
  producer->produce("crawl.page", RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), key.data(), key.size(), 0, nullptr);
  producer->poll(0);
}

std::string hostOf(const std::string& url) {
  const auto schemeEnd = url.find("://");
  const auto hostStart = schemeEnd == std::string::npos ? 0 : schemeEnd + 3;
  const auto hostEnd = url.find('/', hostStart);
  return url.substr(hostStart, hostEnd == std::string::npos ? std::string::npos : hostEnd - hostStart);
}

void recordPage(const std::string& url, int status, const std::string& content_hash, const std::string& body_ref) {
  const std::string host = hostOf(url);
  index.put(url, content_hash);
  records.markIndexed(url);
  const json event = {
      {"url", url},
      {"host", host},
      {"status", status},
      {"content_hash", content_hash},
      {"body_ref", body_ref},
  };
  publish(host, event.dump());
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a publish path for ordering, leakage and honesty. The draft works in the demo because one worker crawls one host and the index never fails: the key looks arbitrary, the payload looks convenient, and the order of two statements looks irrelevant. Each is a production contract: the partition key is the ordering guarantee, the topic is a retention surface that must not hold tenant bytes, and the announcement is only true after the index has confirmed the write. Real crawlers go further: an outbox row when the broker rejects the produce, a schema registry so a future producer cannot smuggle page content into the event, and a compaction policy that keeps the latest hash per URL.`,
};
