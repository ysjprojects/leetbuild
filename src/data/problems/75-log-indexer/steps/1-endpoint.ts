import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/logs: a record the index can accept',
  concept: 'http',
  file: 'api',
  focus: ['agent', 'api', 'registry'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, reads
the JSON body and appends the record to the buffer. It compiles, it ships a log line into the index,
and it hides three production flaws. Review it like the service owner, fix it, and prove the fix with
the checks below. One of the flaws is the quiet one: the record is cut to 16 KiB and nothing in the
response says so.

Implement \`POST /v1/logs\` with body
\`{"service": "checkout", "timestamp": "2026-05-04T10:15:00Z", "level": "error", "message": "…"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- The record is at most **1 MiB** (\`1 << 20\` bytes) of UTF-8, measured **before** the body is parsed
  or buffered; a larger record is **413** and is never buffered.
- \`service\` is a non-empty string that must appear in the tenant's registry; an unregistered service
  is **400** with an error that names the registry. A typo must not create an invisible pipeline.
- \`level\` is one of \`debug\`, \`info\`, \`warn\`, \`error\`, \`fatal\` (**400** otherwise), and
  \`timestamp\` is RFC 3339 within an accepted skew of **5 minutes** (**400** otherwise).
- The retained \`message\` is at most **16 KiB** (\`16 << 10\` bytes). When a longer message is cut,
  the response must say so — \`truncated: true\` plus \`original_bytes\` and \`stored_bytes\` — so a
  consumer can tell a complete stack trace from a mangled one.
- Validation runs **before** the append: an oversized or unregistered record never reaches the buffer.
- Log tenant, service and byte counts — never the message text.

**Failure mode the checks target.** The draft accepts any \`service\` string, so one typo starts a
second, empty pipeline nobody watches; it slices the message at 16 KiB with no marker, so the index
holds stack traces with their last frames missing while every counter reports success; and it buffers
first and validates never, so a 40 MiB record is resident in memory before anything rejects it.`,
  sequence: {
    participants: ['Log agent', 'Ingest API', 'service registry', 'Redis buffer'],
    messages: [
      {from: 'Log agent', to: 'Ingest API', label: 'POST /v1/logs · X-Tenant-Id · record', kind: 'sync'},
      {from: 'Ingest API', to: 'Ingest API', label: 'reject declared size > 1 MiB', kind: 'sync'},
      {from: 'Ingest API', to: 'service registry', label: 'services(tenant)', kind: 'sync'},
      {from: 'service registry', to: 'Ingest API', label: 'registered service ids', kind: 'reply'},
      {from: 'Ingest API', to: 'Ingest API', label: 'check level · skew · truncate at 16 KiB', kind: 'sync'},
      {from: 'Ingest API', to: 'Redis buffer', label: 'append validated record', kind: 'sync'},
      {from: 'Redis buffer', to: 'Ingest API', label: 'buffer key', kind: 'reply'},
      {from: 'Ingest API', to: 'Log agent', label: '202 {truncated, original_bytes, stored_bytes}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/logs',
      detail: 'Register the ingest route on `POST /v1/logs`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/logs["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/logs['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/logs"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"logs"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/logs"/]},
      },
    },
    {
      id: 'tenant-service',
      title: 'Requires the tenant and rejects an unregistered service',
      detail:
        "A missing `X-Tenant-Id` is **401**, and a `service` that is not in the tenant's registry is **400** with an error that names the registry. The draft accepts any service name, so one typo starts a pipeline nobody reads.",
      match: {
        python: {all: [/status_code\s*=\s*401/, /[Rr]egistry/, /status_code\s*=\s*400/]},
        typescript: {all: [/code\(\s*401\s*\)/, /[Rr]egistry/, /code\(\s*400\s*\)/]},
        go: {all: [/StatusUnauthorized/, /[Rr]egistry/, /StatusBadRequest/]},
        scala: {all: [/StatusCodes\.Unauthorized/, /[Rr]egistry/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/\b401\b/, /[Rr]egistry/, /\b400\b/]},
      },
    },
    {
      id: 'record-cap',
      title: 'Rejects a record over 1 MiB before parsing it',
      detail:
        'The record cap (`1 << 20` bytes) is checked on the declared size before the body is parsed or buffered, and an oversized record is **413**. The draft has no cap at all: one agent can push a 40 MiB line through the ingest tier.',
      match: {
        python: {all: [/MAX_RECORD_BYTES/, /status_code\s*=\s*413/]},
        typescript: {all: [/MAX_RECORD_BYTES/, /code\(\s*413\s*\)/]},
        go: {all: [/maxRecordBytes/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/MaxRecordBytes/, /StatusCodes\.RequestEntityTooLarge/]},
        cpp: {all: [/kMaxRecordBytes/, /\b413\b/]},
      },
    },
    {
      id: 'truncation',
      title: 'Marks a message that was cut at 16 KiB',
      detail:
        'A message longer than `16 << 10` bytes is truncated *and reported*: the response carries `truncated` with `original_bytes` and `stored_bytes`. The draft slices at 16 KiB with no marker, so the index claims a complete stack trace it does not have.',
      match: {
        python: {all: [/MAX_MESSAGE_BYTES/, /truncated/, /original_bytes/]},
        typescript: {all: [/MAX_MESSAGE_BYTES/, /truncated/, /original_bytes/]},
        go: {all: [/maxMessageBytes/, /truncated/, /original_bytes/]},
        scala: {all: [/MaxMessageBytes/, /truncated/, /original_bytes/]},
        cpp: {all: [/kMaxMessageBytes/, /truncated/, /original_bytes/]},
      },
    },
    {
      id: 'validate-before-buffer',
      title: 'Validates the service and the skew before buffering',
      detail:
        'The registry lookup and the timestamp-skew check (**400**) both run before the append; a rejected record never occupies buffer memory. The draft buffers first, so validation can only happen after the damage.',
      match: {
        python: {all: [/skew/i, /status_code\s*=\s*400/], order: [/registry\.services\(/, /buffer\.append\(/]},
        typescript: {all: [/skew/i, /code\(\s*400\s*\)/], order: [/registry\.services\(/, /buffer\.append\(/]},
        go: {all: [/skew/i, /StatusBadRequest/], order: [/registry\.Services\(/, /buffer\.Append\(/]},
        scala: {all: [/skew/i, /StatusCodes\.BadRequest/], order: [/registry\.services\(/, /buffer\.append\(/]},
        cpp: {all: [/skew/i, /\b400\b/], order: [/registry\.services\(/, /buffer\.append\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

app = FastAPI()


class BufferStore:
    def append(self, tenant: str, service: str, record: dict) -> str:
        """Append one record to the tenant's index buffer; return the buffer key."""
        raise NotImplementedError


buffer = BufferStore()


@app.post("/v1/logs")
async def ingest(request: Request, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft accepts any service name, cuts the message at 16 KiB without saying so, and
    # buffers the record before validating it. Review all three.
    payload = await request.json()
    message = payload.get("message", "")[: 16 * 1024]
    record = {"service": payload.get("service"), "timestamp": payload.get("timestamp"), "message": message}
    key = buffer.append(tenant, payload.get("service"), record)
    return JSONResponse({"accepted": True, "buffer": key, "service": payload.get("service")})
`,
      solution: `import json
import logging
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("log-indexer")

MAX_RECORD_BYTES = 1 << 20
MAX_MESSAGE_BYTES = 16 << 10
ACCEPTED_SKEW = timedelta(minutes=5)
ALLOWED_LEVELS = {"debug", "info", "warn", "error", "fatal"}


class ServiceRegistry:
    def services(self, tenant: str) -> set[str]:
        """The service ids this tenant has registered."""
        raise NotImplementedError


class BufferStore:
    def append(self, tenant: str, service: str, record: dict) -> str:
        """Append one validated record to the tenant's index buffer; return the buffer key."""
        raise NotImplementedError


registry = ServiceRegistry()
buffer = BufferStore()


def truncate(message: str) -> tuple[str, int, int]:
    """The retained message and both byte counts, so the response can say what it cut."""
    data = message.encode("utf-8")
    if len(data) <= MAX_MESSAGE_BYTES:
        return message, len(data), len(data)
    return data[:MAX_MESSAGE_BYTES].decode("utf-8", "ignore"), len(data), MAX_MESSAGE_BYTES


def parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


@app.post("/v1/logs")
async def ingest(request: Request, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    # Reject on the declared size: an oversized record is never parsed and never held in memory.
    declared = int(request.headers.get("content-length", "0") or 0)
    if declared > MAX_RECORD_BYTES:
        raise HTTPException(status_code=413, detail="record exceeds 1 MiB")
    raw = await request.body()
    if len(raw) > MAX_RECORD_BYTES:
        raise HTTPException(status_code=413, detail="record exceeds 1 MiB")
    try:
        payload = json.loads(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="record must be a JSON object")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="record must be a JSON object")

    service = payload.get("service")
    if not isinstance(service, str) or service == "":
        raise HTTPException(status_code=400, detail="service is required")
    if service not in registry.services(tenant):
        raise HTTPException(status_code=400, detail=f"service '{service}' is not in the tenant registry")

    level = payload.get("level", "info")
    if level not in ALLOWED_LEVELS:
        raise HTTPException(status_code=400, detail="unknown level")
    try:
        when = parse_timestamp(payload["timestamp"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="timestamp must be RFC 3339")
    if abs(datetime.now(timezone.utc) - when) > ACCEPTED_SKEW:
        raise HTTPException(status_code=400, detail="timestamp is outside the accepted skew")

    message, original_bytes, stored_bytes = truncate(payload.get("message", ""))
    record = {"service": service, "timestamp": when.isoformat(), "level": level, "message": message}
    key = buffer.append(tenant, service, record)
    logger.info("ingest tenant=%s service=%s bytes=%d", tenant, service, stored_bytes)
    return JSONResponse(
        {
            "accepted": True,
            "buffer": key,
            "truncated": stored_bytes < original_bytes,
            "original_bytes": original_bytes,
            "stored_bytes": stored_bytes,
        }
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/logs: a model-generated draft that trusts the caller's service id. */
import Fastify from 'fastify';

export const app = Fastify();

export interface BufferStore {
  append(tenant: string, service: string, record: Record<string, unknown>): Promise<string>;
}

export const buffer: BufferStore = {
  append: async () => '',
};

app.post('/v1/logs', async (request, reply) => {
  // TODO: this draft accepts any service name, cuts the message at 16 KiB with no marker, and
  // buffers the record before validating it. Review all three.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as {service?: string; timestamp?: string; message?: string};
  const record = {
    service: body.service,
    timestamp: body.timestamp,
    message: (body.message ?? '').slice(0, 16 * 1024),
  };
  const key = await buffer.append(tenant, body.service ?? '', record);
  return reply.code(202).send({accepted: true, buffer: key, service: body.service});
});
`,
      solution: `/** POST /v1/logs: the ingest funnel — cheap rejections before anything is buffered. */
import Fastify from 'fastify';

export const app = Fastify();

const MAX_RECORD_BYTES = 1 << 20;
const MAX_MESSAGE_BYTES = 16 << 10;
const ACCEPTED_SKEW_MS = 5 * 60 * 1000;
const ALLOWED_LEVELS: Record<string, true> = {debug: true, info: true, warn: true, error: true, fatal: true};

export interface ServiceRegistry {
  services(tenant: string): Promise<Set<string>>;
}

export interface BufferStore {
  append(tenant: string, service: string, record: Record<string, unknown>): Promise<string>;
}

export const registry: ServiceRegistry = {
  services: async () => new Set<string>(),
};

export const buffer: BufferStore = {
  append: async () => '',
};

/** The retained prefix and both byte counts, so the response can say what it cut. */
function truncate(message: string): {message: string; originalBytes: number; storedBytes: number} {
  const original = Buffer.byteLength(message, 'utf8');
  if (original <= MAX_MESSAGE_BYTES) return {message, originalBytes: original, storedBytes: original};
  const kept = Buffer.from(message, 'utf8').subarray(0, MAX_MESSAGE_BYTES).toString('utf8');
  return {message: kept, originalBytes: original, storedBytes: MAX_MESSAGE_BYTES};
}

// The raw string is what the size cap is measured on, so the parser keeps it.
app.addContentTypeParser('application/json', {parseAs: 'string'}, (_request, body, done) => {
  done(null, body);
});

app.post('/v1/logs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const raw = typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {});
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECORD_BYTES)
    return reply.code(413).send({error: 'record exceeds 1 MiB'});

  let body: {service?: unknown; timestamp?: unknown; level?: unknown; message?: unknown};
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return reply.code(400).send({error: 'record must be a JSON object'});
  }
  if (body === null || typeof body !== 'object')
    return reply.code(400).send({error: 'record must be a JSON object'});

  const service = body.service;
  if (typeof service !== 'string' || service === '') return reply.code(400).send({error: 'service is required'});
  const registered = await registry.services(tenant);
  if (!registered.has(service))
    return reply.code(400).send({error: \`service '\${service}' is not in the tenant registry\`});

  const level = typeof body.level === 'string' ? body.level : 'info';
  if (ALLOWED_LEVELS[level] !== true) return reply.code(400).send({error: 'unknown level'});
  const when = typeof body.timestamp === 'string' ? Date.parse(body.timestamp) : Number.NaN;
  if (Number.isNaN(when)) return reply.code(400).send({error: 'timestamp must be RFC 3339'});
  if (Math.abs(Date.now() - when) > ACCEPTED_SKEW_MS)
    return reply.code(400).send({error: 'timestamp is outside the accepted skew'});

  const cut = truncate(typeof body.message === 'string' ? body.message : '');
  const key = await buffer.append(tenant, service, {
    service,
    timestamp: new Date(when).toISOString(),
    level,
    message: cut.message,
  });
  request.log.info({tenant, service, storedBytes: cut.storedBytes}, 'ingested');
  return reply.code(202).send({
    accepted: true,
    buffer: key,
    truncated: cut.storedBytes < cut.originalBytes,
    original_bytes: cut.originalBytes,
    stored_bytes: cut.storedBytes,
  });
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
)

type BufferStore struct{}

func (s *BufferStore) Append(ctx context.Context, tenant, service string, record map[string]any) (string, error) {
	return "", nil
}

var buffer = &BufferStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func ingest(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	// TODO: this draft accepts any service name, cuts the message at 16 KiB without saying so, and
	// buffers the record before validating it. Review all three.
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	message, _ := body["message"].(string)
	if len(message) > 16*1024 {
		message = message[:16*1024]
	}
	body["message"] = message
	service, _ := body["service"].(string)
	key, _ := buffer.Append(r.Context(), tenant, service, body)
	writeJSON(rw, http.StatusAccepted, map[string]any{"accepted": true, "buffer": key, "service": service})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/logs", ingest)
	_ = http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"time"
)

const (
	maxRecordBytes  = 1 << 20
	maxMessageBytes = 16 << 10
)

var acceptedSkew = 5 * time.Minute

var allowedLevels = map[string]bool{"debug": true, "info": true, "warn": true, "error": true, "fatal": true}

type LogRecord struct {
	Service   string \`json:"service"\`
	Timestamp string \`json:"timestamp"\`
	Level     string \`json:"level"\`
	Message   string \`json:"message"\`
}

type ServiceRegistry struct{}

func (s *ServiceRegistry) Services(ctx context.Context, tenant string) (map[string]bool, error) {
	return nil, nil
}

type BufferStore struct{}

func (s *BufferStore) Append(ctx context.Context, tenant, service string, record LogRecord) (string, error) {
	return "", nil
}

var (
	registry = &ServiceRegistry{}
	buffer   = &BufferStore{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// The retained prefix and both byte counts, so the response can say what it cut.
func truncateMessage(message string) (string, int, int) {
	data := []byte(message)
	if len(data) <= maxMessageBytes {
		return message, len(data), len(data)
	}
	return string(data[:maxMessageBytes]), len(data), maxMessageBytes
}

func ingest(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	// Reject on the declared size: an oversized record is never parsed and never held in memory.
	if r.ContentLength > maxRecordBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "record exceeds 1 MiB"})
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(rw, r.Body, maxRecordBytes))
	if err != nil || len(raw) > maxRecordBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "record exceeds 1 MiB"})
		return
	}
	var record LogRecord
	if err := json.Unmarshal(raw, &record); err != nil || record.Service == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "record must be JSON with a service"})
		return
	}
	registered, err := registry.Services(r.Context(), tenant)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "registry unavailable"})
		return
	}
	if !registered[record.Service] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "service is not in the tenant registry"})
		return
	}
	if record.Level == "" {
		record.Level = "info"
	}
	if !allowedLevels[record.Level] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown level"})
		return
	}
	when, err := time.Parse(time.RFC3339, record.Timestamp)
	if err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "timestamp must be RFC 3339"})
		return
	}
	if delta := time.Since(when); delta > acceptedSkew || delta < -acceptedSkew {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "timestamp is outside the accepted skew"})
		return
	}
	stored, originalBytes, storedBytes := truncateMessage(record.Message)
	record.Message = stored
	key, err := buffer.Append(r.Context(), tenant, record.Service, record)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "buffer unavailable"})
		return
	}
	log.Printf("ingest tenant=%s service=%s bytes=%d", tenant, record.Service, storedBytes)
	writeJSON(rw, http.StatusAccepted, map[string]any{
		"accepted":       true,
		"buffer":         key,
		"truncated":      storedBytes < originalBytes,
		"original_bytes": originalBytes,
		"stored_bytes":   storedBytes,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/logs", ingest)
	_ = http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class LogRecord(service: String, timestamp: String, level: String, message: String)

object Api {
  implicit val system: ActorSystem = ActorSystem("log-indexer")
  implicit val recordFormat: RootJsonFormat[LogRecord] = jsonFormat4(LogRecord)

  val buffer = BufferStore.open()

  val route: Route =
    path("v1" / "logs") {
      post {
        entity(as[LogRecord]) { body =>
          // TODO: this draft accepts any service name, cuts the message at 16 KiB without saying
          // so, and buffers the record before validating it. Review all three.
          val tenant = "unknown-tenant"
          val key = buffer.append(tenant, body.service, body.copy(message = body.message.take(16 * 1024)))
          complete(StatusCodes.Accepted, s"""{"accepted":true,"buffer":"$key"}""")
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.time.{Duration, Instant, OffsetDateTime}

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.{ExceptionHandler, Route}
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class LogRecord(service: String, timestamp: String, level: String, message: String)

object Api {
  implicit val system: ActorSystem = ActorSystem("log-indexer")
  implicit val recordFormat: RootJsonFormat[LogRecord] = jsonFormat4(LogRecord)

  val MaxRecordBytes = 1 << 20
  val MaxMessageBytes = 16 << 10
  val AcceptedSkew: Duration = Duration.ofMinutes(5)
  val AllowedLevels = Set("debug", "info", "warn", "error", "fatal")

  val registry = ServiceRegistry.open()
  val buffer = BufferStore.open()

  // The record cap is enforced on the entity stream, before the body is parsed or buffered.
  val sizeLimitHandler: ExceptionHandler = ExceptionHandler { case _: EntityStreamSizeException =>
    complete(StatusCodes.RequestEntityTooLarge, """{"error":"record exceeds 1 MiB"}""")
  }

  /** The retained prefix and both byte counts, so the response can say what it cut. */
  def truncateMessage(message: String): (String, Int, Int) = {
    val bytes = message.getBytes(StandardCharsets.UTF_8)
    if (bytes.length <= MaxMessageBytes) (message, bytes.length, bytes.length)
    else (new String(bytes.take(MaxMessageBytes), StandardCharsets.UTF_8), bytes.length, MaxMessageBytes)
  }

  def parseTimestamp(value: String): Either[String, Instant] =
    try Right(OffsetDateTime.parse(value).toInstant)
    catch { case _: Exception => Left("timestamp must be RFC 3339") }

  val route: Route =
    handleExceptions(sizeLimitHandler) {
      path("v1" / "logs") {
        withSizeLimit(MaxRecordBytes) {
          post {
            optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
              entity(as[LogRecord]) { body =>
                if (!tenantOpt.exists(_.nonEmpty)) {
                  complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
                } else if (body.service.isEmpty) {
                  complete(StatusCodes.BadRequest, """{"error":"service is required"}""")
                } else if (!registry.services(tenantOpt.get).contains(body.service)) {
                  complete(StatusCodes.BadRequest, """{"error":"service is not in the tenant registry"}""")
                } else if (!AllowedLevels.contains(body.level)) {
                  complete(StatusCodes.BadRequest, """{"error":"unknown level"}""")
                } else {
                  parseTimestamp(body.timestamp) match {
                    case Left(message) =>
                      complete(StatusCodes.BadRequest, s"""{"error":"$message"}""")
                    case Right(when) =>
                      if (Duration.between(when, Instant.now).abs().compareTo(AcceptedSkew) > 0) {
                        complete(StatusCodes.BadRequest, """{"error":"timestamp is outside the accepted skew"}""")
                      } else {
                        val (stored, originalBytes, storedBytes) = truncateMessage(body.message)
                        val key = buffer.append(tenantOpt.get, body.service, body.copy(message = stored))
                        complete(
                          StatusCodes.Accepted,
                          s"""{"accepted":true,"buffer":"$key","truncated":\${storedBytes < originalBytes},"original_bytes":$originalBytes,"stored_bytes":$storedBytes}"""
                        )
                      }
                  }
                }
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

struct BufferStore {
  std::string append(const std::string& tenant, const std::string& service, const json& record);
};

BufferStore buffer;

int main() {
  httplib::Server svr;

  svr.Post("/v1/logs", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    // TODO: this draft accepts any service name, cuts the message at 16 KiB without saying so, and
    // buffers the record before validating it. Review all three.
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    auto message = body.value("message", std::string());
    if (message.size() > 16 * 1024) message = message.substr(0, 16 * 1024);
    body["message"] = message;
    const auto service = body.value("service", std::string());
    const auto key = buffer.append(tenant, service, body);
    res.status = 202;
    res.set_content(json{{"accepted", true}, {"buffer", key}, {"service", service}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

constexpr std::size_t kMaxRecordBytes = 1 << 20;
constexpr std::size_t kMaxMessageBytes = 16 << 10;
constexpr long long kAcceptedSkewMs = 5 * 60 * 1000;
const std::set<std::string> kAllowedLevels = {"debug", "info", "warn", "error", "fatal"};

struct ServiceRegistry {
  std::set<std::string> services(const std::string& tenant);
};

struct BufferStore {
  std::string append(const std::string& tenant, const std::string& service, const json& record);
};

ServiceRegistry registry;
BufferStore buffer;

std::optional<long long> parseRfc3339Ms(const std::string& value);

/** The retained prefix and both byte counts, so the response can say what it cut. */
struct Truncated {
  std::string message;
  std::size_t original_bytes;
  std::size_t stored_bytes;
};

Truncated truncateMessage(const std::string& message) {
  if (message.size() <= kMaxMessageBytes) return {message, message.size(), message.size()};
  return {message.substr(0, kMaxMessageBytes), message.size(), kMaxMessageBytes};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/logs", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    // Reject on the declared size: an oversized record is never parsed and never held in memory.
    if (req.body.size() > kMaxRecordBytes) {
      res.status = 413;
      res.set_content(R"({"error":"record exceeds 1 MiB"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"record must be a JSON object"})", "application/json");
      return;
    }
    const auto service = body.value("service", std::string());
    if (service.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"service is required"})", "application/json");
      return;
    }
    const auto registered = registry.services(tenant);
    if (registered.count(service) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"service is not in the tenant registry"})", "application/json");
      return;
    }
    const auto level = body.value("level", std::string("info"));
    if (kAllowedLevels.count(level) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown level"})", "application/json");
      return;
    }
    const auto when = parseRfc3339Ms(body.value("timestamp", std::string()));
    if (!when) {
      res.status = 400;
      res.set_content(R"({"error":"timestamp must be RFC 3339"})", "application/json");
      return;
    }
    const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
                         std::chrono::system_clock::now().time_since_epoch())
                         .count();
    if (std::llabs(now - *when) > kAcceptedSkewMs) {
      res.status = 400;
      res.set_content(R"({"error":"timestamp is outside the accepted skew"})", "application/json");
      return;
    }
    const auto cut = truncateMessage(body.value("message", std::string()));
    body["message"] = cut.message;
    const auto key = buffer.append(tenant, service, body);
    res.status = 202;
    res.set_content(
        json{{"accepted", true},
             {"buffer", key},
             {"truncated", cut.stored_bytes < cut.original_bytes},
             {"original_bytes", cut.original_bytes},
             {"stored_bytes", cut.stored_bytes}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses in cost order: tenant, declared record size, JSON shape, service membership, level, timestamp skew — and only then the message. Every guard returns before a byte is buffered, so the ingest tier can never hold a record it will reject.',
    "The registry is the trust boundary for names. Look the service up in the tenant's registry and answer **400** with an error that names the registry, so an operator reading the agent's log line can see that a typo, not a pipeline, was created.",
    'Truncation is a fact you must report, not hide: keep 16 KiB, then compare the stored byte count with the original one and return `truncated`, `original_bytes` and `stored_bytes`. A consumer that cannot see the marker will treat a mangled stack trace as complete.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary. The draft reads fine because the demo ships small, well-formed records from one correctly spelled service. Three defects are being checked: names that are not validated against the tenant's registry (one typo, one invisible pipeline), a size cap enforced after the record is already in memory, and a silent truncation that makes the index overclaim completeness. The subtle one is truncation, because nothing in the response or the counter changes when it happens — the record looks indexed and the frames are gone. Real ingest tiers add per-tenant byte quotas, sampling hints on the record, a hash of the original message for dedupe, and a rejection counter exported per reason so an agent shipping garbage is visible before a customer notices.`,
};
