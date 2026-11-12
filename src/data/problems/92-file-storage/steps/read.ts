import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/files/{id}: a tenant-scoped link that expires and names who asked',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'reader', 'redis', 'audit'],
  task: `## Task

**Starting point.** The starter registers \`GET /v1/files/{file_id}\`: it requires \`X-Tenant-Id\`,
looks the file up with \`store.find_file\`, answers \`{file_id, url}\` with the CDN path
\`{CDN}/f/{file_id}\`, and produces a \`download_issued\` record (file id and tenant) to \`file.audit\`
before answering. It serves the demo and hides three flaws.

**Failure mode the checks target.** A tenant who guesses an id downloads another tenant's file, or one
that was deleted; the link works for whoever holds it, a browser history or a proxy log included, with
no end; and the audit trail says which tenant asked but not who.

- The file must belong to the caller's tenant and be \`committed\`; anything else is **404**, the same
  answer as a missing id, so the endpoint does not confirm that an id exists.
- The URL is \`store.sign_url(file_id, tenant, expires_at)\` with \`expires_at\` = now +
  \`URL_TTL_S\` (600 s); the response carries \`expires_at\`.
- \`X-User-Id\` is required (**401** without it), and the audit record carries it as \`user\`, with
  \`expires_at\`, delivered before the URL is returned.`,
  sequence: {
    participants: ['Client', 'Download API', 'Redis', 'file.audit', 'CDN'],
    messages: [
      {from: 'Client', to: 'Download API', label: 'GET /v1/files/{id} · X-Tenant-Id · X-User-Id', kind: 'sync'},
      {from: 'Download API', to: 'Redis', label: 'find_file(id) → tenant, state', kind: 'sync'},
      {from: 'Download API', to: 'Download API', label: 'foreign or not committed → 404', kind: 'sync'},
      {
        from: 'Download API',
        to: 'file.audit',
        label: 'download_issued · file · tenant · user · expires_at',
        kind: 'sync',
      },
      {from: 'Download API', to: 'Client', label: '200 {url signed until now + 600 s, expires_at}', kind: 'reply'},
      {from: 'Client', to: 'CDN', label: 'GET signed url · CDN checks signature and expiry', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/files/{id}',
      detail: 'Register `GET /v1/files/{file_id}` answering the file id and a download URL.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/files\/\{file_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/files\/:fileId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/files\/\{id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"files"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/files\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Serves only the caller's committed files, 404 otherwise",
      detail:
        "The file's tenant is compared with `X-Tenant-Id` and its state with `committed`; a foreign or deleted file answers the same **404** as a missing one, so the endpoint never confirms an id exists.",
      match: {
        python: {
          all: [/record\[["']tenant["']\]\s*!=\s*tenant/, /record\[["']state["']\]\s*!=\s*["']committed["']/],
          none: [/status_code\s*=\s*403/],
        },
        typescript: {
          all: [/record\.tenant\s*!==?\s*tenant/, /record\.state\s*!==?\s*['"]committed['"]/],
          none: [/code\(\s*403\s*\)/],
        },
        go: {all: [/record\.Tenant\s*!=\s*tenant/, /record\.State\s*!=\s*"committed"/], none: [/StatusForbidden/]},
        scala: {all: [/\.tenant\s*==\s*tenant/, /\.state\s*==\s*"committed"/], none: [/StatusCodes\.Forbidden/]},
        cpp: {all: [/record->tenant\s*!=\s*tenant/, /record->state\s*!=\s*"committed"/], none: [/\b403\b/]},
      },
    },
    {
      id: 'signed-expiry',
      title: 'Answers a signed URL that expires in 10 minutes',
      detail:
        'The URL comes from `sign_url` with an expiry of now + `URL_TTL_S` (600 s), so the CDN refuses it afterwards and for any other tenant; a bare CDN path is a capability with no end.',
      match: {
        python: {all: [/URL_TTL_S\s*=\s*600\b/, /store\.sign_url\(/], none: [/store\.CDN/]},
        typescript: {all: [/URL_TTL_S\s*=\s*600\b/, /store\.signUrl\(/], none: [/store\.CDN/]},
        go: {all: [/urlTTL\s*=\s*600\s*\*\s*time\.Second/, /store\.SignURL\(/], none: [/store\.CDN/]},
        scala: {all: [/UrlTtlSeconds\s*=\s*600L?\b/, /Store\.signUrl\(/], none: [/Store\.Cdn/]},
        cpp: {all: [/kUrlTtl\{600\}/, /store::signUrl\(/], none: [/store::kCdn/]},
      },
    },
    {
      id: 'audit-requester',
      title: 'Audits who asked for the link',
      detail:
        '`X-User-Id` is required (**401** without it) and the `download_issued` record carries it as `user`; a trail that names only the tenant cannot say which person a leaked link was issued to.',
      match: {
        python: {all: [/x-user-id/i, /["']user["']\s*:\s*user\b/]},
        typescript: {all: [/x-user-id/i, /\buser(\s*:\s*user)?\s*[,}]/]},
        go: {all: [/X-User-Id/i, /"user":\s*user\b/]},
        scala: {all: [/X-User-Id/i, /"user"\s*->\s*JsString\(\s*user\s*\)/]},
        cpp: {all: [/X-User-Id/i, /\{"user",\s*user\}/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer
from fastapi import FastAPI, HTTPException, Request

from files import store  # store.find_file, sign_url, CDN

AUDIT_TOPIC = "file.audit"
log = logging.getLogger("read")

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})
app = FastAPI()


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("audit record not delivered: %s", err)


@app.get("/v1/files/{file_id}")
async def download_link(file_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    record = store.find_file(file_id)
    if record is None:
        raise HTTPException(status_code=404, detail="no such file")
    url = f"{store.CDN}/f/{file_id}"
    audit = {"event": "download_issued", "file_id": file_id, "tenant": tenant}
    producer.produce(AUDIT_TOPIC, key=file_id, value=json.dumps(audit), on_delivery=on_delivery)
    producer.flush(5.0)
    return {"file_id": file_id, "url": url}
`,
      solution: `import json
import logging
import time

from confluent_kafka import Producer
from fastapi import FastAPI, HTTPException, Request

from files import store  # store.find_file, sign_url, CDN

AUDIT_TOPIC = "file.audit"
URL_TTL_S = 600
log = logging.getLogger("read")

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})
app = FastAPI()


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("audit record not delivered: %s", err)


@app.get("/v1/files/{file_id}")
async def download_link(file_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    user = request.headers.get("x-user-id", "")
    if not tenant or not user:
        raise HTTPException(status_code=401, detail="X-Tenant-Id and X-User-Id are required")
    record = store.find_file(file_id)
    # Another tenant's file, or one not committed, gets the answer a missing id gets.
    if record is None or record["tenant"] != tenant or record["state"] != "committed":
        raise HTTPException(status_code=404, detail="no such file")
    expires_at = int(time.time()) + URL_TTL_S
    url = store.sign_url(file_id, tenant, expires_at)
    audit = {"event": "download_issued", "file_id": file_id, "tenant": tenant, "user": user, "expires_at": expires_at}
    producer.produce(AUDIT_TOPIC, key=file_id, value=json.dumps(audit), on_delivery=on_delivery)
    producer.flush(5.0)  # the issuance is on the trail before the link leaves
    return {"file_id": file_id, "url": url, "expires_at": expires_at}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

import * as store from 'files/store'; // findFile, signUrl, CDN

export const AUDIT_TOPIC = 'file.audit';

const kafka = new Kafka({clientId: 'stored-read', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true});
void producer.connect();

export const app = Fastify();

app.get('/v1/files/:fileId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const {fileId} = request.params as {fileId: string};
  const record = await store.findFile(fileId);
  if (record === null) return reply.code(404).send({error: 'no such file'});
  const url = \`\${store.CDN}/f/\${fileId}\`;
  const audit = {event: 'download_issued', file_id: fileId, tenant};
  await producer.send({topic: AUDIT_TOPIC, messages: [{key: fileId, value: JSON.stringify(audit)}], acks: -1});
  return {file_id: fileId, url};
});
`,
      solution: `import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

import * as store from 'files/store'; // findFile, signUrl, CDN

export const AUDIT_TOPIC = 'file.audit';
export const URL_TTL_S = 600;

const kafka = new Kafka({clientId: 'stored-read', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true});
void producer.connect();

export const app = Fastify();

app.get('/v1/files/:fileId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  const user = request.headers['x-user-id'];
  if (typeof tenant !== 'string' || tenant === '' || typeof user !== 'string' || user === '') {
    return reply.code(401).send({error: 'X-Tenant-Id and X-User-Id are required'});
  }
  const {fileId} = request.params as {fileId: string};
  const record = await store.findFile(fileId);
  // Another tenant's file, or one not committed, gets the answer a missing id gets.
  if (record === null || record.tenant !== tenant || record.state !== 'committed') return reply.code(404).send({error: 'no such file'});
  const expiresAt = Math.floor(Date.now() / 1000) + URL_TTL_S;
  const url = store.signUrl(fileId, tenant, expiresAt);
  const audit = {event: 'download_issued', file_id: fileId, tenant, user, expires_at: expiresAt};
  // The issuance is on the trail before the link leaves.
  await producer.send({topic: AUDIT_TOPIC, messages: [{key: fileId, value: JSON.stringify(audit)}], acks: -1});
  return {file_id: fileId, url, expires_at: expiresAt};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/segmentio/kafka-go"

	"files/store" // store.FindFile, SignURL, CDN
)

const auditTopic = "file.audit"

var auditWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        auditTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

func downloadLink(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	fileID := r.PathValue("id")
	record := store.FindFile(r.Context(), fileID)
	if record == nil {
		http.Error(rw, "no such file", http.StatusNotFound)
		return
	}
	url := store.CDN + "/f/" + fileID
	audit, _ := json.Marshal(map[string]any{"event": "download_issued", "file_id": fileID, "tenant": tenant})
	if err := auditWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(fileID), Value: audit}); err != nil {
		http.Error(rw, "the issuance could not be audited", http.StatusServiceUnavailable)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{"file_id": fileID, "url": url})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/files/{id}", downloadLink)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/segmentio/kafka-go"

	"files/store" // store.FindFile, SignURL, CDN
)

const (
	auditTopic = "file.audit"
	urlTTL     = 600 * time.Second
)

var auditWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        auditTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

func downloadLink(rw http.ResponseWriter, r *http.Request) {
	tenant, user := r.Header.Get("X-Tenant-Id"), r.Header.Get("X-User-Id")
	if tenant == "" || user == "" {
		http.Error(rw, "X-Tenant-Id and X-User-Id are required", http.StatusUnauthorized)
		return
	}
	fileID := r.PathValue("id")
	record := store.FindFile(r.Context(), fileID)
	// Another tenant's file, or one not committed, gets the answer a missing id gets.
	if record == nil || record.Tenant != tenant || record.State != "committed" {
		http.Error(rw, "no such file", http.StatusNotFound)
		return
	}
	expiresAt := time.Now().Add(urlTTL).Unix()
	url := store.SignURL(fileID, tenant, expiresAt)
	audit, _ := json.Marshal(map[string]any{"event": "download_issued", "file_id": fileID, "tenant": tenant, "user": user, "expires_at": expiresAt})
	// The issuance is on the trail before the link leaves.
	if err := auditWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(fileID), Value: audit}); err != nil {
		http.Error(rw, "the issuance could not be audited", http.StatusServiceUnavailable)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{"file_id": fileID, "url": url, "expires_at": expiresAt})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/files/{id}", downloadLink)
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import files.Store // Store.findFile, signUrl, Cdn

object Read {
  val AuditTopic = "file.audit"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  val route: Route =
    path("v1" / "files" / Segment) { fileId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(tenant) =>
            // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
            Store.findFile(fileId) match {
              case None => complete(StatusCodes.NotFound -> "no such file")
              case Some(_) =>
                val url = s"\${Store.Cdn}/f/$fileId"
                val audit = JsObject("event" -> JsString("download_issued"), "file_id" -> JsString(fileId), "tenant" -> JsString(tenant))
                producer.send(new ProducerRecord[String, String](AuditTopic, fileId, audit.compactPrint)).get()
                val body = JsObject("file_id" -> JsString(fileId), "url" -> JsString(url))
                complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
            }
        }
      }
    }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import files.Store // Store.findFile, signUrl, Cdn

object Read {
  val AuditTopic = "file.audit"
  val UrlTtlSeconds = 600L

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  val route: Route =
    path("v1" / "files" / Segment) { fileId =>
      get {
        (optionalHeaderValueByName("X-Tenant-Id") & optionalHeaderValueByName("X-User-Id")) {
          case (Some(tenant), Some(user)) if tenant.nonEmpty && user.nonEmpty =>
            // Another tenant's file, or one not committed, gets the answer a missing id gets.
            Store.findFile(fileId).filter(record => record.tenant == tenant && record.state == "committed") match {
              case None => complete(StatusCodes.NotFound -> "no such file")
              case Some(_) =>
                val expiresAt = System.currentTimeMillis() / 1000 + UrlTtlSeconds
                val url = Store.signUrl(fileId, tenant, expiresAt)
                val audit = JsObject(
                  "event" -> JsString("download_issued"), "file_id" -> JsString(fileId), "tenant" -> JsString(tenant),
                  "user" -> JsString(user), "expires_at" -> JsNumber(expiresAt))
                // The issuance is on the trail before the link leaves.
                producer.send(new ProducerRecord[String, String](AuditTopic, fileId, audit.compactPrint)).get()
                val body = JsObject("file_id" -> JsString(fileId), "url" -> JsString(url), "expires_at" -> JsNumber(expiresAt))
                complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
            }
          case _ => complete(StatusCodes.Unauthorized -> "X-Tenant-Id and X-User-Id are required")
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "files/store.h"  // store::findFile, signUrl, kCdn

using json = nlohmann::json;

const std::string kAuditTopic = "file.audit";

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "audit record not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void download_link(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string file_id = req.matches[1];
  const auto record = store::findFile(file_id);
  if (!record) {
    res.status = 404;
    res.set_content("no such file", "text/plain");
    return;
  }
  const std::string url = store::kCdn + "/f/" + file_id;
  const std::string audit = json{{"event", "download_issued"}, {"file_id", file_id}, {"tenant", tenant}}.dump();
  producer->produce(kAuditTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(audit.data()),
                    audit.size(), file_id.c_str(), file_id.size(), 0, nullptr);
  producer->flush(5000);
  res.set_content(json{{"file_id", file_id}, {"url", url}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/files/([\\w-]+))", download_link);
}
`,
      solution: `#include <httplib.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>

#include "files/store.h"  // store::findFile, signUrl, kCdn

using json = nlohmann::json;

const std::string kAuditTopic = "file.audit";
constexpr std::chrono::seconds kUrlTtl{600};

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "audit record not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void download_link(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const std::string user = req.get_header_value("X-User-Id");
  if (tenant.empty() || user.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id and X-User-Id are required", "text/plain");
    return;
  }
  const std::string file_id = req.matches[1];
  const auto record = store::findFile(file_id);
  // Another tenant's file, or one not committed, gets the answer a missing id gets.
  if (!record || record->tenant != tenant || record->state != "committed") {
    res.status = 404;
    res.set_content("no such file", "text/plain");
    return;
  }
  const long long expires_at = std::chrono::duration_cast<std::chrono::seconds>((std::chrono::system_clock::now() + kUrlTtl).time_since_epoch()).count();
  const std::string url = store::signUrl(file_id, tenant, expires_at);
  const std::string audit =
      json{{"event", "download_issued"}, {"file_id", file_id}, {"tenant", tenant}, {"user", user}, {"expires_at", expires_at}}.dump();
  // The issuance is on the trail before the link leaves.
  producer->produce(kAuditTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(audit.data()),
                    audit.size(), file_id.c_str(), file_id.size(), 0, nullptr);
  producer->flush(5000);
  res.set_content(json{{"file_id", file_id}, {"url", url}, {"expires_at", expires_at}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/files/([\\w-]+))", download_link);
}
`,
    },
  },
  harness: {
    python: `import json
import time

from files import store

AUDIT = "file.audit"
HEADERS = {"X-Tenant-Id": "t1", "X-User-Id": "u-7"}


def _seed(ctx):
    for file_id, tenant, state in (("f-1", "t1", "committed"), ("f-2", "t2", "committed"), ("f-3", "t1", "deleted")):
        ctx.redis.hset(f"file:{file_id}", mapping={
            "file_id": file_id, "upload_id": "up-" + file_id[2:], "tenant": tenant, "name": "scan.png", "mime": "image/png",
            "size": 32, "digest": "ab" * 32, "object_key": "objects/up-" + file_id[2:], "state": state,
        })


def _api(ctx):
    _seed(ctx)
    return ctx.client(ctx.load("read").app)


def _audits(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(AUDIT)]


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await c.get("/v1/files/f-1", headers=HEADERS)
    assert r.status_code == 200, f"GET /v1/files/f-1 as its tenant answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("file_id") == "f-1" and str(body.get("url", "")).startswith(store.CDN + "/f/f-1"), f"the answer must carry file_id f-1 and a CDN URL for it, got {body}"


async def check_tenant_scope(ctx):
    async with _api(ctx) as c:
        foreign = await c.get("/v1/files/f-2", headers=HEADERS)
        deleted = await c.get("/v1/files/f-3", headers=HEADERS)
        missing = await c.get("/v1/files/f-404", headers=HEADERS)
        none = await c.get("/v1/files/f-1")
    assert foreign.status_code == 404, f"tenant t1 asked for t2's file f-2 and got {foreign.status_code}: {foreign.text}. Another tenant's file is 404, like a missing one"
    assert deleted.status_code == 404, f"a deleted file answered {deleted.status_code}, expected 404"
    assert missing.status_code == 404, f"a missing file answered {missing.status_code}, expected 404"
    assert none.status_code == 401, f"a request without X-Tenant-Id answered {none.status_code}, expected 401"
    assert not any(a.get("file_id") in ("f-2", "f-3") for a in _audits(ctx)), f"a refused request was audited as an issuance: {_audits(ctx)}"


async def check_signed_expiry(ctx):
    async with _api(ctx) as c:
        r = await c.get("/v1/files/f-1", headers=HEADERS)
    assert r.status_code == 200, f"GET /v1/files/f-1 answered {r.status_code}: {r.text}"
    url, now = r.json().get("url", ""), int(time.time())
    grant = store.verify_url(url, now)
    assert grant is not None, f"the CDN refuses {url}: it is not signed. Use store.sign_url so the link expires and is bound to the tenant"
    assert grant["file_id"] == "f-1" and grant["tenant"] == "t1", f"the URL grants {grant}, expected f-1 for t1"
    assert grant["expires_at"] == now + 600 and r.json().get("expires_at") == now + 600, f"the URL expires at {grant['expires_at']} (answered {r.json().get('expires_at')}), expected now + 600 = {now + 600}"
    ctx.clock.advance(601)
    assert store.verify_url(url, int(time.time())) is None, "ten minutes later the CDN still honours the URL"


async def check_audit_requester(ctx):
    async with _api(ctx) as c:
        anonymous = await c.get("/v1/files/f-1", headers={"X-Tenant-Id": "t1"})
        assert anonymous.status_code == 401, f"a request without X-User-Id answered {anonymous.status_code}, expected 401: a link nobody can be named for cannot be audited"
        assert _audits(ctx) == [], f"a refused request was audited: {_audits(ctx)}"
        r = await c.get("/v1/files/f-1", headers=HEADERS)
    assert r.status_code == 200, f"GET /v1/files/f-1 answered {r.status_code}: {r.text}"
    audits = _audits(ctx)
    assert len(audits) == 1 and ctx.kafka.records(AUDIT)[0].key == b"f-1", f"one issuance must leave one {AUDIT} record keyed by the file id, got {audits}"
    audit = audits[0]
    assert audit.get("user") == "u-7", f"the audit record is {audit}: it must name the requesting user (u-7) as user"
    assert audit.get("event") == "download_issued" and audit.get("tenant") == "t1" and audit.get("expires_at") == r.json().get("expires_at"), f"the audit record is {audit}, expected download_issued for t1 with the link's expires_at"
`,
    typescript: `const AUDIT = 'file.audit';
const HEADERS = {'X-Tenant-Id': 't1', 'X-User-Id': 'u-7'};

function api(ctx) {
  for (const [fileId, tenant, state] of [['f-1', 't1', 'committed'], ['f-2', 't2', 'committed'], ['f-3', 't1', 'deleted']]) {
    const n = fileId.slice(2);
    ctx.redis.hset(\`file:\${fileId}\`, {
      file_id: fileId, upload_id: \`up-\${n}\`, tenant, name: 'scan.png', mime: 'image/png', size: 32, digest: 'ab'.repeat(32), object_key: \`objects/up-\${n}\`, state,
    });
  }
  return {c: ctx.client(ctx.load('read').app), store: ctx.load('/support/files/store.ts')};
}

const audits = ctx => ctx.kafka.records(AUDIT).map(r => JSON.parse(r.value.toString()));
const nowS = ctx => Math.floor(ctx.clock.now() / 1000);

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const r = await c.get('/v1/files/f-1', {headers: HEADERS});
  assert.equal(r.status, 200, \`GET /v1/files/f-1 as its tenant answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.file_id === 'f-1' && String(body.url ?? '').startsWith(\`\${store.CDN}/f/f-1\`), \`the answer must carry file_id f-1 and a CDN URL for it, got \${r.text}\`);
}

export async function check_tenant_scope(ctx) {
  const {c} = api(ctx);
  const foreign = await c.get('/v1/files/f-2', {headers: HEADERS});
  const deleted = await c.get('/v1/files/f-3', {headers: HEADERS});
  const missing = await c.get('/v1/files/f-404', {headers: HEADERS});
  const none = await c.get('/v1/files/f-1');
  assert.equal(foreign.status, 404, \`tenant t1 asked for t2's file f-2 and got \${foreign.status}: \${foreign.text}. Another tenant's file is 404, like a missing one\`);
  assert.equal(deleted.status, 404, \`a deleted file answered \${deleted.status}, expected 404\`);
  assert.equal(missing.status, 404, \`a missing file answered \${missing.status}, expected 404\`);
  assert.equal(none.status, 401, \`a request without X-Tenant-Id answered \${none.status}, expected 401\`);
  assert(!audits(ctx).some(a => a.file_id === 'f-2' || a.file_id === 'f-3'), \`a refused request was audited as an issuance: \${JSON.stringify(audits(ctx))}\`);
}

export async function check_signed_expiry(ctx) {
  const {c, store} = api(ctx);
  const r = await c.get('/v1/files/f-1', {headers: HEADERS});
  assert.equal(r.status, 200, \`GET /v1/files/f-1 answered \${r.status}: \${r.text}\`);
  const url = r.json().url ?? '';
  const now = nowS(ctx);
  const grant = store.verifyUrl(url, now);
  assert(grant !== null, \`the CDN refuses \${url}: it is not signed. Use store.signUrl so the link expires and is bound to the tenant\`);
  assert(grant.file_id === 'f-1' && grant.tenant === 't1', \`the URL grants \${JSON.stringify(grant)}, expected f-1 for t1\`);
  assert(grant.expires_at === now + 600 && r.json().expires_at === now + 600, \`the URL expires at \${grant.expires_at} (answered \${r.json().expires_at}), expected now + 600 = \${now + 600}\`);
  ctx.clock.advance(601);
  assert.equal(store.verifyUrl(url, nowS(ctx)), null, 'ten minutes later the CDN still honours the URL');
}

export async function check_audit_requester(ctx) {
  const {c} = api(ctx);
  const anonymous = await c.get('/v1/files/f-1', {headers: {'X-Tenant-Id': 't1'}});
  assert.equal(anonymous.status, 401, \`a request without X-User-Id answered \${anonymous.status}, expected 401: a link nobody can be named for cannot be audited\`);
  assert.deepStrictEqual(audits(ctx), [], \`a refused request was audited: \${JSON.stringify(audits(ctx))}\`);
  const r = await c.get('/v1/files/f-1', {headers: HEADERS});
  assert.equal(r.status, 200, \`GET /v1/files/f-1 answered \${r.status}: \${r.text}\`);
  const trail = audits(ctx);
  assert(trail.length === 1 && ctx.kafka.records(AUDIT)[0].key?.toString() === 'f-1', \`one issuance must leave one \${AUDIT} record keyed by the file id, got \${JSON.stringify(trail)}\`);
  assert.equal(trail[0].user, 'u-7', \`the audit record is \${JSON.stringify(trail[0])}: it must name the requesting user (u-7) as user\`);
  assert(trail[0].event === 'download_issued' && trail[0].tenant === 't1' && trail[0].expires_at === r.json().expires_at, \`the audit record is \${JSON.stringify(trail[0])}, expected download_issued for t1 with the link's expires_at\`);
}
`,
    go: `package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"files/store"

	"leetbuild/harness"
)

const audit = "file.audit"

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	for _, f := range [][3]string{{"f-1", "t1", "committed"}, {"f-2", "t2", "committed"}, {"f-3", "t1", "deleted"}} {
		n := f[0][2:]
		ctx.Redis.Do("HSET", "file:"+f[0], "file_id", f[0], "upload_id", "up-"+n, "tenant", f[1], "name", "scan.png", "mime", "image/png",
			"size", "32", "digest", strings.Repeat("ab", 32), "object_key", "objects/up-"+n, "state", f[2])
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

type link struct {
	FileID    string \`json:"file_id"\`
	URL       string \`json:"url"\`
	ExpiresAt int64  \`json:"expires_at"\`
}

func audits(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, r := range ctx.Kafka.Records(audit) {
		var a map[string]any
		json.Unmarshal(r.Value, &a)
		out = append(out, a)
	}
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	c := readAPI(ctx)
	r := c.Get("/v1/files/f-1", "X-Tenant-Id", "t1", "X-User-Id", "u-7")
	ctx.Equal(r.Status, 200, "GET /v1/files/f-1 as its tenant (%s)", r.Text())
	var body link
	r.Decode(&body)
	ctx.Assert(body.FileID == "f-1" && strings.HasPrefix(body.URL, store.CDN+"/f/f-1"), "the answer must carry file_id f-1 and a CDN URL for it, got %s", r.Text())
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := readAPI(ctx)
	ctx.Equal(c.Get("/v1/files/f-2", "X-Tenant-Id", "t1", "X-User-Id", "u-7").Status, 404, "tenant t1 asked for t2's file f-2: another tenant's file is 404, like a missing one")
	ctx.Equal(c.Get("/v1/files/f-3", "X-Tenant-Id", "t1", "X-User-Id", "u-7").Status, 404, "a deleted file")
	ctx.Equal(c.Get("/v1/files/f-404", "X-Tenant-Id", "t1", "X-User-Id", "u-7").Status, 404, "a missing file")
	ctx.Equal(c.Get("/v1/files/f-1").Status, 401, "a request without X-Tenant-Id")
	for _, a := range audits(ctx) {
		ctx.Assert(a["file_id"] != "f-2" && a["file_id"] != "f-3", "a refused request was audited as an issuance: %v", a)
	}
}

func CheckSignedExpiry(ctx *harness.Ctx) {
	c := readAPI(ctx)
	r := c.Get("/v1/files/f-1", "X-Tenant-Id", "t1", "X-User-Id", "u-7")
	ctx.Equal(r.Status, 200, "GET /v1/files/f-1 (%s)", r.Text())
	var body link
	r.Decode(&body)
	now := ctx.Clock.Time().Unix()
	grant := store.VerifyURL(body.URL, now)
	ctx.Assert(grant != nil, "the CDN refuses %s: it is not signed. Use store.SignURL so the link expires and is bound to the tenant", body.URL)
	ctx.Assert(grant.FileID == "f-1" && grant.Tenant == "t1", "the URL grants %+v, expected f-1 for t1", grant)
	ctx.Assert(grant.ExpiresAt == now+600 && body.ExpiresAt == now+600, "the URL expires at %d (answered %d), expected now + 600 = %d", grant.ExpiresAt, body.ExpiresAt, now+600)
	ctx.Clock.Advance(601)
	ctx.Assert(store.VerifyURL(body.URL, ctx.Clock.Time().Unix()) == nil, "ten minutes later the CDN still honours the URL")
}

func CheckAuditRequester(ctx *harness.Ctx) {
	c := readAPI(ctx)
	ctx.Equal(c.Get("/v1/files/f-1", "X-Tenant-Id", "t1").Status, 401, "a request without X-User-Id (a link nobody can be named for cannot be audited)")
	ctx.Equal(len(audits(ctx)), 0, "a refused request must not be audited; the audit records")
	r := c.Get("/v1/files/f-1", "X-Tenant-Id", "t1", "X-User-Id", "u-7")
	ctx.Equal(r.Status, 200, "GET /v1/files/f-1 (%s)", r.Text())
	var body link
	r.Decode(&body)
	trail := audits(ctx)
	ctx.Assert(len(trail) == 1 && len(ctx.Kafka.Keys(audit)) == 1 && ctx.Kafka.Keys(audit)[0] == "f-1", "one issuance must leave one %s record keyed by the file id, got %v", audit, trail)
	ctx.Equal(trail[0]["user"], "u-7", "the audit record must name the requesting user as user (%v)", trail[0])
	ctx.Assert(trail[0]["event"] == "download_issued" && trail[0]["tenant"] == "t1" && trail[0]["expires_at"] == float64(body.ExpiresAt), "the audit record is %v, expected download_issued for t1 with the link's expires_at", trail[0])
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <array>
#include <chrono>
#include <string>
#include <vector>

#include "files/store.h"

using json = nlohmann::json;

namespace {

const std::string kAudit = "file.audit";

harness::HTTP readApi(harness::Ctx& ctx) {
  for (const auto& f : std::vector<std::array<std::string, 3>>{{"f-1", "t1", "committed"}, {"f-2", "t2", "committed"}, {"f-3", "t1", "deleted"}}) {
    const std::string n = f[0].substr(2);
    ctx.Redis.Do("HSET", "file:" + f[0], "file_id", f[0], "upload_id", "up-" + n, "tenant", f[1], "name", "scan.png", "mime", "image/png",
                 "size", "32", "digest", std::string(64, 'a'), "object_key", "objects/up-" + n, "state", f[2]);
  }
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

long long nowS() { return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }

std::vector<json> audits(harness::Ctx& ctx) {
  std::vector<json> out;
  for (const auto& r : ctx.Kafka.Records(kAudit)) out.push_back(json::parse(r.Value.value_or("{}"), nullptr, false));
  return out;
}

harness::Response get(harness::HTTP& c, const std::string& file_id) { return c.Get("/v1/files/" + file_id, "X-Tenant-Id", "t1", "X-User-Id", "u-7"); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto r = get(c, "f-1");
  ctx.Equal(r.Status, 200, "GET /v1/files/f-1 as its tenant (%s)", r.Text());
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.value("file_id", "") == "f-1" && body.value("url", "").rfind(store::kCdn + "/f/f-1", 0) == 0, "the answer must carry file_id f-1 and a CDN URL for it, got %s", r.Text());
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  ctx.Equal(get(c, "f-2").Status, 404, "tenant t1 asked for t2's file f-2: another tenant's file is 404, like a missing one");
  ctx.Equal(get(c, "f-3").Status, 404, "a deleted file");
  ctx.Equal(get(c, "f-404").Status, 404, "a missing file");
  ctx.Equal(c.Get("/v1/files/f-1").Status, 401, "a request without X-Tenant-Id");
  for (const json& a : audits(ctx)) {
    ctx.Assert(a.value("file_id", "") != "f-2" && a.value("file_id", "") != "f-3", "a refused request was audited as an issuance: %s", a.dump());
  }
}

void CheckSignedExpiry(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto r = get(c, "f-1");
  ctx.Equal(r.Status, 200, "GET /v1/files/f-1 (%s)", r.Text());
  const json body = json::parse(r.Text(), nullptr, false);
  const std::string url = body.value("url", "");
  const long long now = nowS();
  const auto grant = store::verifyUrl(url, now);
  ctx.Assert(grant.has_value(), "the CDN refuses %s: it is not signed. Use store::signUrl so the link expires and is bound to the tenant", url);
  ctx.Assert(grant->file_id == "f-1" && grant->tenant == "t1", "the URL grants %s for %s, expected f-1 for t1", grant->file_id, grant->tenant);
  ctx.Assert(grant->expires_at == now + 600 && body.value("expires_at", 0LL) == now + 600, "the URL expires at %d (answered %d), expected now + 600 = %d", grant->expires_at, body.value("expires_at", 0LL), now + 600);
  ctx.Clock.Advance(601);
  ctx.Assert(!store::verifyUrl(url, nowS()), "ten minutes later the CDN still honours the URL");
}

void CheckAuditRequester(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  ctx.Equal(c.Get("/v1/files/f-1", "X-Tenant-Id", "t1").Status, 401, "a request without X-User-Id (a link nobody can be named for cannot be audited)");
  ctx.Equal(audits(ctx).size(), 0, "a refused request must not be audited; the audit records");
  const auto r = get(c, "f-1");
  ctx.Equal(r.Status, 200, "GET /v1/files/f-1 (%s)", r.Text());
  const json body = json::parse(r.Text(), nullptr, false);
  const auto trail = audits(ctx);
  ctx.Assert(trail.size() == 1 && ctx.Kafka.Keys(kAudit) == std::vector<std::string>{"f-1"}, "one issuance must leave one %s record keyed by the file id, got %d", kAudit, trail.size());
  ctx.Equal(trail[0].value("user", ""), "u-7", "the audit record must name the requesting user as user (%s)", trail[0].dump());
  ctx.Assert(trail[0].value("event", "") == "download_issued" && trail[0].value("tenant", "") == "t1" && trail[0].value("expires_at", 0LL) == body.value("expires_at", -1LL),
             "the audit record is %s, expected download_issued for t1 with the link's expires_at", trail[0].dump());
}
`,
  },
  hints: [
    "Ask for another tenant's file id with your own tenant header: you get a working link. Keep the link a day: it still works. Read the audit topic: it says which tenant asked, not which person.",
    'The handler looks the file up by id alone and never reads its tenant or state. The URL is the CDN path with nothing the CDN can check, and the audit record is built from the tenant header only.',
    'Read `X-User-Id` (401 without it); 404 unless `record["tenant"] == tenant` and `record["state"] == "committed"`; `expires_at = int(time.time()) + URL_TTL_S`; `store.sign_url(file_id, tenant, expires_at)`; add `user` and `expires_at` to the audit record.',
  ],
  debrief: `A download link is a capability, so everything about it is decided when it is minted: who it is for (the tenant inside the signature), how long it lives (the expiry inside the signature), and who asked for it (the audit record written before it leaves). The 404 for a foreign file is the same answer a missing id gets, which keeps the endpoint from becoming an oracle for which ids exist. Ten minutes bounds what a leaked link is worth while leaving time for a slow download to start. CloudFront signed URLs and S3 presigned URLs work the same way; production services add a revocation list for links issued to a user who was offboarded, and rate limits per user so one account cannot mint links for an entire bucket.`,
};
