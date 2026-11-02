import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Page events keyed by host, content only by reference',
  concept: 'kafka',
  file: 'events',
  focus: ['crawler', 'kafka', 'indexer', 'index', 'store'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/crawl/pages\`, the endpoint a crawl worker calls
once it has fetched and stored a page, with body
\`{"url": "https://blog.example.com/posts", "status": 200, "content_hash": "sha256:…", "body_ref": "s3://pages/…"}\`.
It produces one \`crawl.page\` event, marks the page indexed, writes the index entry and answers
\`{"accepted": true}\`. In the demo the indexer picks the event up and pages appear in search. It
serves the demo and hides five flaws.

**Failure mode the checks target.** Each flaw is invisible while one worker crawls one host and the
index never fails: a key that does not preserve per-host order, a payload that turns the topic into
a copy of the crawl, and an announcement made before the index has confirmed the write.

- Publish **exactly one** \`crawl.page\` event per page with the **host** as the message key, so a
  host's history stays on one partition and a re-crawl does not interleave with the first crawl.
- The payload carries **references, not the page**: \`url\`, \`host\`, \`status\`,
  \`content_hash\` and \`body_ref\` (where the stored page lives). No markup and no \`content\`
  field.
- **The index write confirms before the event is announced.** \`index.put\` first, then
  \`mark_indexed\`, then publish; a consumer that reads an event must find the entry it points at,
  and a failed write must not leave the page looking indexed.`,
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
    'Run two workers against one host and the indexer sees a re-crawl interleaved with the first crawl. The topic grows at the size of the pages, and a page whose index write failed looks indexed.',
    'The handler keys the produce with `worker_id`, puts `body.html` into the event as `content` with no hash or reference, and calls `records.mark_indexed` and `index.put` only after the produce has flushed.',
    'Key `producer.produce` by the host from `urlsplit(body.url).hostname`; send `url`, `host`, `status`, `content_hash`, `body_ref` and nothing else; call `index.put` first, then `records.mark_indexed`, then produce.',
  ],
  checks: [
    {
      id: 'host-key',
      title: 'Publishes crawl.page keyed by host',
      detail:
        'The event goes to `crawl.page` with the **host** as the message key, so one host’s pages stay ordered on one partition. The starter keys by worker id.',
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
        'Neither the fetched markup nor a `content` field appears in the event: the topic carries references. The starter inlines the page body, so the topic retains a copy of every crawled byte.',
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
        'The payload has `content_hash` and `body_ref` so the consumer can verify which revision it is and fetch the bytes itself. The starter sends neither a hash nor a reference.',
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
        'The index write happens before the event is published, so a consumer can never read an entry the index does not have. The starter publishes first and writes afterwards.',
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
        '`mark_indexed` runs after `index.put` returns, not before: a write that fails must not leave the page looking indexed. The starter marks it indexed first.',
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
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
      starter: `/** Page events: flawed code that ships the page inside the event. */
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
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
  debrief: `The event is keyed by host, carries references, and goes out after the index confirms, because the property being protected is that a consumer can trust what it reads: the partition key is the per-host ordering guarantee, a reference points at bytes with their own retention and access control, and an announcement made after the write is a fact rather than a promise. The order of two statements matters for the same reason: a page marked indexed before \`index.put\` returns is a lie the next step's report will repeat. Production publish paths add an outbox row when the broker rejects the produce, a schema registry so a later producer cannot smuggle page content in, idempotent producers, and a compacted topic keeping the latest hash per URL.`,
};
