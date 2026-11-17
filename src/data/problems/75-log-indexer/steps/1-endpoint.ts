import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/logs: a record the index can accept',
  concept: 'http',
  guides: ['request-boundaries'],
  file: 'api',
  focus: ['agent', 'api', 'registry'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/logs\`: it reads \`X-Tenant-Id\`, parses the JSON
record (\`service\`, \`timestamp\`, \`level\`, \`message\`), keeps the first 16 × 1024 characters of
\`message\` and buffers the record with \`buffer.append_record(tenant, service, record)\`, answering
**202** \`{accepted, offset}\` (**429** with \`Retry-After\` when the buffer sheds it). It serves the
demo and hides four flaws.

**Failure mode the checks target.** A typo in \`service\` starts a buffer nobody reads; a 40 MiB
record is parsed and buffered; a stack trace cut at 16 KiB is stored as if it were complete; and a
record with an unknown level or a clock an hour off lands in the index.

- A missing \`X-Tenant-Id\` is **401**; a \`service\` the tenant's registry does not hold
  (\`registry.is_registered\`) is **400** naming the registry.
- A record over \`MAX_RECORD_BYTES\` (\`1 << 20\`) is **413**, decided on the whole request's bytes
  before anything parses them; a record of exactly 1 MiB is accepted.
- \`message\` keeps at most \`MAX_MESSAGE_BYTES\` (\`16 << 10\`) bytes, cut on a character boundary,
  and the 202 reports \`truncated\`, \`original_bytes\` and \`stored_bytes\`.
- \`level\` is one of \`LEVELS\` (debug, info, warn, error, fatal) and \`timestamp\` is RFC 3339, with
  its offset, within \`MAX_SKEW\` (5 minutes) of now, behind or ahead; otherwise **400**.
- Nothing rejected reaches the buffer.`,
  sequence: {
    participants: ['Log agent', 'Ingest API', 'service registry', 'Redis buffer'],
    messages: [
      {from: 'Log agent', to: 'Ingest API', label: 'POST /v1/logs · X-Tenant-Id · record', kind: 'sync'},
      {from: 'Ingest API', to: 'Ingest API', label: 'body over 1 MiB → 413, unparsed', kind: 'sync'},
      {from: 'Ingest API', to: 'service registry', label: 'is_registered(tenant, service)', kind: 'sync'},
      {from: 'service registry', to: 'Ingest API', label: 'no → 400 naming the registry', kind: 'reply'},
      {from: 'Ingest API', to: 'Ingest API', label: 'level · 5-minute skew · cut at 16 KiB', kind: 'sync'},
      {from: 'Ingest API', to: 'Redis buffer', label: 'append_record(tenant, service, record)', kind: 'sync'},
      {from: 'Redis buffer', to: 'Ingest API', label: 'offset (0: shed → 429)', kind: 'reply'},
      {
        from: 'Ingest API',
        to: 'Log agent',
        label: '202 {offset, truncated, original_bytes, stored_bytes}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Buffers a valid record on POST /v1/logs',
      detail: 'Register `POST /v1/logs`; a valid record is buffered and answered **202** with its offset.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/logs["']/, /append_record\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/logs['"]/, /appendRecord\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/logs"/, /buffer\.AppendRecord\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"logs"\s*\)/, /Buffer\.appendRecord\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/logs"/, /buffer::appendRecord\(/]},
      },
    },
    {
      id: 'tenant-service',
      title: "Requires the tenant and a service in the tenant's registry",
      detail:
        "A missing `X-Tenant-Id` is **401** and a `service` the tenant's registry does not hold is **400** naming the registry, with nothing buffered; the starter buffers any service string under any tenant, even an empty one.",
      match: {
        python: {all: [/\b401\b/, /registry\.is_registered\(/, /\b400\b/]},
        typescript: {all: [/code\(\s*401\s*\)/, /isRegistered\(/, /code\(\s*400\s*\)/]},
        go: {all: [/StatusUnauthorized/, /registry\.IsRegistered\(/, /StatusBadRequest/]},
        scala: {all: [/StatusCodes\.Unauthorized/, /Registry\.isRegistered\(/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/\b401\b/, /registry::isRegistered\(/, /\b400\b/]},
      },
    },
    {
      id: 'record-cap',
      title: 'Answers 413 for a record over 1 MiB, before parsing it',
      detail:
        'The cap (`1 << 20` bytes) is applied to the whole request body before the JSON parse: a record over it is **413** with nothing buffered, whatever its message alone weighs, and a record of exactly 1 MiB is accepted; the starter parses and buffers a record of any size.',
      match: {
        python: {all: [/MAX_RECORD_BYTES\s*=\s*1\s*<<\s*20/, /\b413\b/], order: [/\b413\b/, /json\.loads\(/]},
        typescript: {all: [/MAX_RECORD_BYTES\s*=\s*1\s*<<\s*20/, /bodyLimit:\s*MAX_RECORD_BYTES/]},
        go: {all: [/maxRecordBytes\s*=\s*1\s*<<\s*20/, /MaxBytesReader\(/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/MaxRecordBytes\s*:\s*Long\s*=\s*1L\s*<<\s*20/, /withSizeLimit\(\s*MaxRecordBytes\s*\)/]},
        cpp: {
          all: [/kMaxRecordBytes\s*=\s*1\s*<<\s*20/, /\b413\b/],
          order: [/req\.body\.size\(\)\s*>\s*kMaxRecordBytes/, /json::parse\(/],
        },
      },
    },
    {
      id: 'truncation',
      title: 'Cuts a message at 16 KiB of bytes and reports the cut',
      detail:
        'A message over `16 << 10` bytes keeps its first 16 KiB of UTF-8, cut back to the start of the character the cut lands in (2-, 3- and 4-byte characters alike), and the 202 carries `truncated`, `original_bytes` and `stored_bytes`; a message of exactly 16 KiB is kept whole. The starter counts characters and reports nothing.',
      match: {
        python: {all: [/MAX_MESSAGE_BYTES\s*=\s*16\s*<<\s*10/, /\.encode\(/, /original_bytes/, /stored_bytes/]},
        typescript: {
          all: [/MAX_MESSAGE_BYTES\s*=\s*16\s*<<\s*10/, /Buffer\.from\(|TextEncoder/, /original_bytes/, /stored_bytes/],
        },
        go: {all: [/maxMessageBytes\s*=\s*16\s*<<\s*10/, /utf8\.RuneStart\(/, /original_bytes/, /stored_bytes/]},
        scala: {all: [/MaxMessageBytes\s*=\s*16\s*<<\s*10/, /getBytes\(/, /original_bytes/, /stored_bytes/]},
        cpp: {all: [/kMaxMessageBytes\s*=\s*16\s*<<\s*10/, /0x80/, /original_bytes/, /stored_bytes/]},
      },
    },
    {
      id: 'validate-before-buffer',
      title: 'Rejects an unknown level or a skewed timestamp before buffering',
      detail:
        'A `level` outside `LEVELS`, or a `timestamp` that is not RFC 3339 with its offset or lies more than 5 minutes from now, behind or ahead, is **400**, checked before the append; the starter buffers every record it can parse.',
      match: {
        python: {
          all: [/LEVELS/, /MAX_SKEW\s*=\s*timedelta\(minutes=5\)/],
          order: [/>\s*MAX_SKEW/, /buffer\.append_record\(/],
        },
        typescript: {
          all: [/LEVELS/, /MAX_SKEW_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/],
          order: [/>\s*MAX_SKEW_MS/, /appendRecord\(tenant/],
        },
        go: {
          all: [/levels\[/, /maxSkew\s*=\s*5\s*\*\s*time\.Minute/],
          order: [/>\s*maxSkew/, /buffer\.AppendRecord\(/],
        },
        scala: {
          all: [/Levels/, /MaxSkew\s*:\s*Duration\s*=\s*Duration\.ofMinutes\(5\)/],
          order: [/compareTo\(MaxSkew\)/, /Buffer\.appendRecord\(/],
        },
        cpp: {all: [/kLevels/, /kMaxSkewS\s*=\s*5\s*\*\s*60/], order: [/>\s*kMaxSkewS/, /buffer::appendRecord\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from logindex import buffer  # buffer.append_record(tenant, service, record) -> offset, 0 when shed
from logindex import registry  # registry.is_registered(tenant, service) -> bool

app = FastAPI()

RETRY_AFTER_S = 5


@app.post("/v1/logs")
async def ingest(request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    body = await request.json()
    service = body.get("service", "")
    record = {
        "service": service,
        "timestamp": body.get("timestamp", ""),
        "level": body.get("level", "info"),
        "message": body.get("message", "")[: 16 * 1024],
    }
    offset = buffer.append_record(tenant, service, record)
    if offset == 0:
        return JSONResponse({"error": "the buffer is full"}, status_code=429, headers={"Retry-After": str(RETRY_AFTER_S)})
    return JSONResponse({"accepted": True, "offset": offset}, status_code=202)
`,
      solution: `import json
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from logindex import buffer  # buffer.append_record(tenant, service, record) -> offset, 0 when shed
from logindex import registry  # registry.is_registered(tenant, service) -> bool

app = FastAPI()

RETRY_AFTER_S = 5
MAX_RECORD_BYTES = 1 << 20
MAX_MESSAGE_BYTES = 16 << 10
MAX_SKEW = timedelta(minutes=5)
LEVELS = ("debug", "info", "warn", "error", "fatal")


def truncate(message: str) -> tuple[str, int, int]:
    """The retained message and both byte counts; a cut never splits a character."""
    data = message.encode("utf-8")
    if len(data) <= MAX_MESSAGE_BYTES:
        return message, len(data), len(data)
    kept = data[:MAX_MESSAGE_BYTES].decode("utf-8", "ignore")
    return kept, len(data), len(kept.encode("utf-8"))


def parse_timestamp(value: object) -> datetime | None:
    """An RFC 3339 timestamp with its offset, or None."""
    try:
        when = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return when if when.tzinfo is not None else None


@app.post("/v1/logs")
async def ingest(request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    # The cap is measured on the bytes, before anything parses them.
    if int(request.headers.get("content-length") or 0) > MAX_RECORD_BYTES:
        raise HTTPException(status_code=413, detail="a record is at most 1 MiB")
    raw = await request.body()
    if len(raw) > MAX_RECORD_BYTES:
        raise HTTPException(status_code=413, detail="a record is at most 1 MiB")
    try:
        body = json.loads(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="the record is not JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="the record is not a JSON object")
    service = body.get("service")
    if not isinstance(service, str) or not registry.is_registered(tenant, service):
        raise HTTPException(status_code=400, detail=f"service {service!r} is not in the tenant's registry")
    level = body.get("level")
    if level not in LEVELS:
        raise HTTPException(status_code=400, detail=f"level must be one of {', '.join(LEVELS)}")
    when = parse_timestamp(body.get("timestamp"))
    if when is None:
        raise HTTPException(status_code=400, detail="timestamp must be RFC 3339")
    if abs(datetime.now(timezone.utc) - when) > MAX_SKEW:
        raise HTTPException(status_code=400, detail="timestamp is outside the 5-minute skew")
    message, original, stored = truncate(str(body.get("message", "")))
    offset = buffer.append_record(tenant, service, {"service": service, "timestamp": body["timestamp"], "level": level, "message": message})
    if offset == 0:
        return JSONResponse({"error": "the buffer is full"}, status_code=429, headers={"Retry-After": str(RETRY_AFTER_S)})
    return JSONResponse(
        {"accepted": True, "offset": offset, "truncated": stored < original, "original_bytes": original, "stored_bytes": stored},
        status_code=202,
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {appendRecord} from 'logindex/buffer'; // appendRecord(tenant, service, record) → offset, 0 when shed
import {isRegistered} from 'logindex/registry'; // isRegistered(tenant, service) → boolean

export const app = Fastify();

const RETRY_AFTER_S = 5;
// Agents batch lines into one record, so the parser takes large bodies.
const BODY_LIMIT = 64 << 20;

app.addContentTypeParser('application/json', {parseAs: 'string', bodyLimit: BODY_LIMIT}, (_request, body, done) => {
  try {
    done(null, JSON.parse(body as string));
  } catch {
    done(Object.assign(new Error('the record is not JSON'), {statusCode: 400}));
  }
});

interface Body {
  service?: string;
  timestamp?: string;
  level?: string;
  message?: string;
}

app.post('/v1/logs', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  const body = (request.body ?? {}) as Body;
  const service = body.service ?? '';
  const record = {service, timestamp: body.timestamp ?? '', level: body.level ?? 'info', message: (body.message ?? '').slice(0, 16 * 1024)};
  const offset = await appendRecord(tenant, service, record);
  if (offset === 0) return reply.code(429).header('Retry-After', String(RETRY_AFTER_S)).send({error: 'the buffer is full'});
  return reply.code(202).send({accepted: true, offset});
});
`,
      solution: `import Fastify from 'fastify';

import {appendRecord} from 'logindex/buffer'; // appendRecord(tenant, service, record) → offset, 0 when shed
import {isRegistered} from 'logindex/registry'; // isRegistered(tenant, service) → boolean

export const app = Fastify();

const RETRY_AFTER_S = 5;
export const MAX_RECORD_BYTES = 1 << 20;
export const MAX_MESSAGE_BYTES = 16 << 10;
const MAX_SKEW_MS = 5 * 60 * 1000;
const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'];
const RFC3339 = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$/;

// The cap is measured on the bytes, before the parser runs: an oversized record is 413, unparsed.
app.addContentTypeParser('application/json', {parseAs: 'string', bodyLimit: MAX_RECORD_BYTES}, (_request, body, done) => {
  try {
    done(null, JSON.parse(body as string));
  } catch {
    done(Object.assign(new Error('the record is not JSON'), {statusCode: 400}));
  }
});

interface Body {
  service?: unknown;
  timestamp?: unknown;
  level?: unknown;
  message?: unknown;
}

/** The retained message and both byte counts; a cut never splits a character. */
function truncate(message: string): {kept: string; original: number; stored: number} {
  const data = Buffer.from(message, 'utf8');
  if (data.length <= MAX_MESSAGE_BYTES) return {kept: message, original: data.length, stored: data.length};
  let end = MAX_MESSAGE_BYTES;
  while (end > 0 && (data[end] & 0xc0) === 0x80) end -= 1;
  return {kept: data.subarray(0, end).toString('utf8'), original: data.length, stored: end};
}

app.post('/v1/logs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = (request.body ?? {}) as Body;
  const service = typeof body.service === 'string' ? body.service : '';
  if (!(await isRegistered(tenant, service))) return reply.code(400).send({error: \`service "\${service}" is not in the tenant's registry\`});
  const level = typeof body.level === 'string' ? body.level : '';
  if (!LEVELS.includes(level)) return reply.code(400).send({error: \`level must be one of \${LEVELS.join(', ')}\`});
  const timestamp = typeof body.timestamp === 'string' ? body.timestamp : '';
  const when = Date.parse(timestamp);
  if (!RFC3339.test(timestamp) || Number.isNaN(when)) return reply.code(400).send({error: 'timestamp must be RFC 3339'});
  if (Math.abs(Date.now() - when) > MAX_SKEW_MS) return reply.code(400).send({error: 'timestamp is outside the 5-minute skew'});
  const {kept, original, stored} = truncate(typeof body.message === 'string' ? body.message : '');
  const offset = await appendRecord(tenant, service, {service, timestamp, level, message: kept});
  if (offset === 0) return reply.code(429).header('Retry-After', String(RETRY_AFTER_S)).send({error: 'the buffer is full'});
  return reply.code(202).send({accepted: true, offset, truncated: stored < original, original_bytes: original, stored_bytes: stored});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"

	"logindex/buffer" // buffer.AppendRecord(ctx, tenant, service, record) (offset, error): 0 when shed
	// registry.IsRegistered(ctx, tenant, service) (bool, error) is in "logindex/registry"
)

const retryAfterS = 5

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func ingest(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unreadable body"})
		return
	}
	var record buffer.Record
	if err := json.Unmarshal(raw, &record); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "the record is not JSON"})
		return
	}
	if len(record.Message) > 16*1024 {
		record.Message = record.Message[:16*1024]
	}
	offset, err := buffer.AppendRecord(r.Context(), tenant, record.Service, record)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	if offset == 0 {
		rw.Header().Set("Retry-After", strconv.Itoa(retryAfterS))
		writeJSON(rw, http.StatusTooManyRequests, map[string]string{"error": "the buffer is full"})
		return
	}
	writeJSON(rw, http.StatusAccepted, map[string]any{"accepted": true, "offset": offset})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/logs", ingest)
}
`,
      solution: `package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"

	"logindex/buffer"   // buffer.AppendRecord(ctx, tenant, service, record) (offset, error): 0 when shed
	"logindex/registry" // registry.IsRegistered(ctx, tenant, service) (bool, error)
)

const (
	retryAfterS     = 5
	maxRecordBytes  = 1 << 20
	maxMessageBytes = 16 << 10
	maxSkew         = 5 * time.Minute
)

var levels = map[string]bool{"debug": true, "info": true, "warn": true, "error": true, "fatal": true}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func fail(rw http.ResponseWriter, status int, message string) {
	writeJSON(rw, status, map[string]string{"error": message})
}

// truncate gives the retained message and both byte counts; a cut never splits a character.
func truncate(message string) (string, int, int) {
	if len(message) <= maxMessageBytes {
		return message, len(message), len(message)
	}
	end := maxMessageBytes
	for end > 0 && !utf8.RuneStart(message[end]) {
		end--
	}
	return message[:end], len(message), end
}

func ingest(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		fail(rw, http.StatusUnauthorized, "X-Tenant-Id is required")
		return
	}
	// The cap is measured on the bytes, before anything parses them.
	if r.ContentLength > maxRecordBytes {
		fail(rw, http.StatusRequestEntityTooLarge, "a record is at most 1 MiB")
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(rw, r.Body, maxRecordBytes))
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		fail(rw, http.StatusRequestEntityTooLarge, "a record is at most 1 MiB")
		return
	}
	if err != nil {
		fail(rw, http.StatusBadRequest, "unreadable body")
		return
	}
	var record buffer.Record
	if err := json.Unmarshal(raw, &record); err != nil {
		fail(rw, http.StatusBadRequest, "the record is not JSON")
		return
	}
	known, err := registry.IsRegistered(r.Context(), tenant, record.Service)
	if err != nil {
		fail(rw, http.StatusServiceUnavailable, err.Error())
		return
	}
	if !known {
		fail(rw, http.StatusBadRequest, fmt.Sprintf("service %q is not in the tenant's registry", record.Service))
		return
	}
	if !levels[record.Level] {
		fail(rw, http.StatusBadRequest, "level must be one of debug, info, warn, error, fatal")
		return
	}
	when, err := time.Parse(time.RFC3339, record.Timestamp)
	if err != nil {
		fail(rw, http.StatusBadRequest, "timestamp must be RFC 3339")
		return
	}
	if skew := time.Now().Sub(when); skew > maxSkew || -skew > maxSkew {
		fail(rw, http.StatusBadRequest, "timestamp is outside the 5-minute skew")
		return
	}
	message, original, stored := truncate(record.Message)
	record.Message = message
	offset, err := buffer.AppendRecord(r.Context(), tenant, record.Service, record)
	if err != nil {
		fail(rw, http.StatusServiceUnavailable, err.Error())
		return
	}
	if offset == 0 {
		rw.Header().Set("Retry-After", strconv.Itoa(retryAfterS))
		fail(rw, http.StatusTooManyRequests, "the buffer is full")
		return
	}
	writeJSON(rw, http.StatusAccepted, map[string]any{"accepted": true, "offset": offset, "truncated": stored < original, "original_bytes": original, "stored_bytes": stored})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/logs", ingest)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import logindex.Buffer   // Buffer.appendRecord(tenant, service, record): offset, 0 when shed
import logindex.Registry // Registry.isRegistered(tenant, service): Boolean

object Api {
  val RetryAfterS = 5

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(body: JsObject, name: String, default: String = ""): String = body.fields.get(name) match {
    case Some(JsString(s)) => s
    case _ => default
  }

  def ingest(tenant: String, raw: String): HttpResponse = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val body = raw.parseJson.asJsObject
    val service = text(body, "service")
    val record = Buffer.Record(service, text(body, "timestamp"), text(body, "level", "info"), text(body, "message").take(16 * 1024))
    val offset = Buffer.appendRecord(tenant, service, record)
    if (offset == 0) json(StatusCodes.TooManyRequests, JsObject("error" -> JsString("the buffer is full"))).withHeaders(RawHeader("Retry-After", RetryAfterS.toString))
    else json(StatusCodes.Accepted, JsObject("accepted" -> JsBoolean(true), "offset" -> JsNumber(offset)))
  }

  val route: Route = path("v1" / "logs") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        entity(as[String]) { raw => complete(ingest(tenant.getOrElse(""), raw)) }
      }
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets.UTF_8
import java.time.{Duration, Instant, OffsetDateTime}
import java.time.format.DateTimeParseException

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import logindex.Buffer   // Buffer.appendRecord(tenant, service, record): offset, 0 when shed
import logindex.Registry // Registry.isRegistered(tenant, service): Boolean

object Api {
  val RetryAfterS = 5
  val MaxRecordBytes: Long = 1L << 20
  val MaxMessageBytes = 16 << 10
  val MaxSkew: Duration = Duration.ofMinutes(5)
  val Levels: Set[String] = Set("debug", "info", "warn", "error", "fatal")

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def text(body: JsObject, name: String): String = body.fields.get(name) match {
    case Some(JsString(s)) => s
    case _ => ""
  }

  /** The retained message and both byte counts; a cut never splits a character. */
  def truncate(message: String): (String, Int, Int) = {
    val data = message.getBytes(UTF_8)
    if (data.length <= MaxMessageBytes) (message, data.length, data.length)
    else {
      var end = MaxMessageBytes
      while (end > 0 && (data(end) & 0xc0) == 0x80) end -= 1
      (new String(data, 0, end, UTF_8), data.length, end)
    }
  }

  /** An RFC 3339 timestamp with its offset, or None. */
  private def parseTimestamp(value: String): Option[Instant] =
    try Some(OffsetDateTime.parse(value).toInstant)
    catch { case _: DateTimeParseException => None }

  def ingest(tenant: String, raw: String): HttpResponse = {
    val parsed = try Some(raw.parseJson) catch { case _: JsonParser.ParsingException => None }
    parsed match {
      case Some(body: JsObject) =>
        val service = text(body, "service")
        val level = text(body, "level")
        val when = parseTimestamp(text(body, "timestamp"))
        if (!Registry.isRegistered(tenant, service)) error(StatusCodes.BadRequest, s"service '$service' is not in the tenant's registry")
        else if (!Levels.contains(level)) error(StatusCodes.BadRequest, "level must be one of debug, info, warn, error, fatal")
        else if (when.isEmpty) error(StatusCodes.BadRequest, "timestamp must be RFC 3339")
        else if (Duration.between(when.get, Instant.now()).abs.compareTo(MaxSkew) > 0) error(StatusCodes.BadRequest, "timestamp is outside the 5-minute skew")
        else {
          val (message, original, stored) = truncate(text(body, "message"))
          val offset = Buffer.appendRecord(tenant, service, Buffer.Record(service, text(body, "timestamp"), level, message))
          if (offset == 0) error(StatusCodes.TooManyRequests, "the buffer is full").withHeaders(RawHeader("Retry-After", RetryAfterS.toString))
          else
            json(
              StatusCodes.Accepted,
              JsObject(
                "accepted" -> JsBoolean(true),
                "offset" -> JsNumber(offset),
                "truncated" -> JsBoolean(stored < original),
                "original_bytes" -> JsNumber(original),
                "stored_bytes" -> JsNumber(stored),
              ),
            )
        }
      case _ => error(StatusCodes.BadRequest, "the record is not a JSON object")
    }
  }

  val route: Route = path("v1" / "logs") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
        case Some(tenant) =>
          // The cap is measured on the bytes, before anything parses them: a larger entity is 413.
          withSizeLimit(MaxRecordBytes) {
            entity(as[String]) { raw => complete(ingest(tenant, raw)) }
          }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "logindex/buffer.h"    // buffer::appendRecord(tenant, service, record) -> offset, 0 when shed
#include "logindex/registry.h"  // registry::isRegistered(tenant, service) -> bool

using json = nlohmann::json;

constexpr int kRetryAfterS = 5;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

std::string field(const json& body, const char* name, const std::string& fallback = "") {
  return body.contains(name) && body[name].is_string() ? body[name].get<std::string>() : fallback;
}

void ingest(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, {{"error", "the record is not JSON"}});
  buffer::Record record{field(body, "service"), field(body, "timestamp"), field(body, "level", "info"), field(body, "message")};
  if (record.message.size() > 16 * 1024) record.message.resize(16 * 1024);
  const long long offset = buffer::appendRecord(tenant, record.service, record);
  if (offset == 0) {
    res.set_header("Retry-After", std::to_string(kRetryAfterS));
    return reply(res, 429, {{"error", "the buffer is full"}});
  }
  reply(res, 202, {{"accepted", true}, {"offset", offset}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/logs", ingest); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdio>
#include <optional>
#include <set>
#include <string>

#include "logindex/buffer.h"    // buffer::appendRecord(tenant, service, record) -> offset, 0 when shed
#include "logindex/registry.h"  // registry::isRegistered(tenant, service) -> bool

using json = nlohmann::json;

constexpr int kRetryAfterS = 5;
constexpr size_t kMaxRecordBytes = 1 << 20;
constexpr size_t kMaxMessageBytes = 16 << 10;
constexpr long long kMaxSkewS = 5 * 60;
const std::set<std::string> kLevels = {"debug", "info", "warn", "error", "fatal"};

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

std::string field(const json& body, const char* name, const std::string& fallback = "") {
  return body.contains(name) && body[name].is_string() ? body[name].get<std::string>() : fallback;
}

// Days since 1970-01-01 of a proleptic Gregorian date.
long long daysFromCivil(long long y, long long m, long long d) {
  y -= m <= 2;
  const long long era = (y >= 0 ? y : y - 399) / 400;
  const long long yoe = y - era * 400;
  const long long doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  return era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
}

// Seconds since the epoch of an RFC 3339 timestamp (with Z or a ±hh:mm offset), or nothing.
std::optional<long long> parseTimestamp(const std::string& text) {
  int y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0, used = 0;
  if (std::sscanf(text.c_str(), "%4d-%2d-%2dT%2d:%2d:%2d%n", &y, &mo, &d, &h, &mi, &s, &used) != 6 || used != 19) return std::nullopt;
  size_t i = 19;
  if (i < text.size() && text[i] == '.') {
    i++;
    while (i < text.size() && text[i] >= '0' && text[i] <= '9') i++;
  }
  long long offset = 0;
  if (i + 1 == text.size() && text[i] == 'Z') {
    offset = 0;
  } else if (i + 6 == text.size() && (text[i] == '+' || text[i] == '-') && text[i + 3] == ':') {
    int oh = 0, om = 0;
    if (std::sscanf(text.c_str() + i + 1, "%2d:%2d", &oh, &om) != 2) return std::nullopt;
    offset = (oh * 3600LL + om * 60LL) * (text[i] == '-' ? -1 : 1);
  } else {
    return std::nullopt;
  }
  return daysFromCivil(y, mo, d) * 86400 + h * 3600LL + mi * 60LL + s - offset;
}

// The retained message and both byte counts; a cut never splits a character.
struct Cut {
  std::string kept;
  size_t original;
  size_t stored;
};

Cut truncate(const std::string& message) {
  if (message.size() <= kMaxMessageBytes) return {message, message.size(), message.size()};
  size_t end = kMaxMessageBytes;
  while (end > 0 && (static_cast<unsigned char>(message[end]) & 0xC0) == 0x80) end--;
  return {message.substr(0, end), message.size(), end};
}

void ingest(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  // The cap is measured on the bytes, before anything parses them.
  if (req.body.size() > kMaxRecordBytes) return reply(res, 413, {{"error", "a record is at most 1 MiB"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, {{"error", "the record is not a JSON object"}});
  buffer::Record record{field(body, "service"), field(body, "timestamp"), field(body, "level"), field(body, "message")};
  if (!registry::isRegistered(tenant, record.service)) {
    return reply(res, 400, {{"error", "service '" + record.service + "' is not in the tenant's registry"}});
  }
  if (kLevels.count(record.level) == 0) return reply(res, 400, {{"error", "level must be one of debug, info, warn, error, fatal"}});
  const auto when = parseTimestamp(record.timestamp);
  if (!when) return reply(res, 400, {{"error", "timestamp must be RFC 3339"}});
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long long skew = now > *when ? now - *when : *when - now;
  if (skew > kMaxSkewS) return reply(res, 400, {{"error", "timestamp is outside the 5-minute skew"}});
  const Cut cut = truncate(record.message);
  record.message = cut.kept;
  const long long offset = buffer::appendRecord(tenant, record.service, record);
  if (offset == 0) {
    res.set_header("Retry-After", std::to_string(kRetryAfterS));
    return reply(res, 429, {{"error", "the buffer is full"}});
  }
  reply(res, 202, {{"accepted", true}, {"offset", offset}, {"truncated", cut.stored < cut.original}, {"original_bytes", cut.original}, {"stored_bytes", cut.stored}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/logs", ingest); }
`,
    },
  },
  harness: {
    python: `import json
import time

from logindex import registry

MESSAGE = "payment declined: card_expired"


def _stamp(offset_s=0, zone="Z", zone_s=0):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() + offset_s + zone_s)) + zone


def _record(**over):
    record = {"service": "checkout", "timestamp": _stamp(), "level": "error", "message": MESSAGE}
    record.update(over)
    return record


def _api(ctx):
    m = ctx.load("api")
    registry.add_service("acme", "checkout")
    registry.add_service("globex", "billing")
    return ctx.client(m.app)


async def _post(c, record, tenant="acme"):
    return await c.post("/v1/logs", json=record, headers={"X-Tenant-Id": tenant} if tenant else {})


def _buffered(ctx, key="buffer:acme:checkout"):
    return [json.loads(raw) for raw in ctx.redis.lrange(key, 0, -1)]


def _buffers(ctx):
    return sorted(k for k in ctx.redis.keys("buffer:*") if not k.endswith(":meta"))


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _post(c, _record())
    assert r.status_code == 202, f"POST /v1/logs with a valid record answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("accepted") is True and body.get("offset") == 1, f"the first record must be answered accepted with offset 1, got {body}"
    stored = _buffered(ctx)
    assert len(stored) == 1 and stored[0].get("message") == MESSAGE and stored[0].get("service") == "checkout", f"buffer:acme:checkout holds {stored}, expected the one record"


async def check_tenant_service(ctx):
    async with _api(ctx) as c:
        anonymous = await _post(c, _record(), tenant=None)
        typo = await _post(c, _record(service="chekout"))
        foreign = await _post(c, _record(service="billing"))
        ok = await _post(c, _record())
    assert anonymous.status_code == 401, f"a record without X-Tenant-Id answered {anonymous.status_code}, expected 401"
    assert typo.status_code == 400, f"a record for chekout, a service acme never registered, answered {typo.status_code}, expected 400"
    assert "registry" in typo.text, f"the 400 must say the service is not in the tenant's registry, got {typo.text}"
    assert foreign.status_code == 400, f"acme posting to billing, a service only globex registered, answered {foreign.status_code}, expected 400"
    assert ok.status_code == 202, f"a record for acme's checkout answered {ok.status_code}: {ok.text}"
    assert _buffers(ctx) == ["buffer:acme:checkout"], f"only the registered record may be buffered; Redis holds the buffers {_buffers(ctx)}"
    assert len(_buffered(ctx)) == 1, f"buffer:acme:checkout holds {len(_buffered(ctx))} records, expected 1"


def _exact_body(extra=0):
    """A record of exactly 1 MiB of JSON bytes (plus extra), its message under 1 MiB."""
    shell = json.dumps(_record(message=""))
    return json.dumps(_record(message="x" * ((1 << 20) - len(shell) + extra))).encode()


async def check_record_cap(ctx):
    async with _api(ctx) as c:
        huge = await _post(c, _record(message="x" * (1 << 20)))
        near = await _post(c, _record(message="x" * ((1 << 20) - 400)))
        exact_body = _exact_body()
        over_body = _exact_body(1)
        headers = {"X-Tenant-Id": "acme", "Content-Type": "application/json"}
        exact = await c.post("/v1/logs", content=exact_body, headers=headers)
        over = await c.post("/v1/logs", content=over_body, headers=headers)
    assert len(exact_body) == 1 << 20 and len(over_body) == (1 << 20) + 1
    assert huge.status_code == 413, f"a record over 1 MiB answered {huge.status_code}, expected 413"
    assert over.status_code == 413, f"a record of 1 MiB + 1 byte whose message alone is under 1 MiB answered {over.status_code}, expected 413: the cap is on the whole record's bytes"
    assert near.status_code == 202, f"a record just under 1 MiB answered {near.status_code}, expected 202 (its message is cut, the record is accepted): {near.text[:200]}"
    assert exact.status_code == 202, f"a record of exactly 1 MiB (1048576 bytes) answered {exact.status_code}, expected 202: only a record over the cap is 413: {exact.text[:200]}"
    stored = _buffered(ctx)
    assert len(stored) == 2, f"only the records within the cap may be buffered; buffer:acme:checkout holds {len(stored)} records, expected 2"


async def check_truncation(ctx):
    async with _api(ctx) as c:
        short = await _post(c, _record())
        ascii_ = await _post(c, _record(message="a" * 20480))
        euro = await _post(c, _record(message="€" * 7000))
        whole = await _post(c, _record(message="a" * 16384))
        emoji = await _post(c, _record(message="a" + "😀" * 4100))
    for r in (short, ascii_, euro, whole, emoji):
        assert r.status_code == 202, f"a record answered {r.status_code}: {r.text[:200]}"
    body = short.json()
    assert body.get("truncated") is False and body.get("original_bytes") == 30 and body.get("stored_bytes") == 30, f"a 30-byte message must be answered truncated false with original_bytes and stored_bytes 30, got {body}"
    body = ascii_.json()
    assert body.get("truncated") is True and body.get("original_bytes") == 20480 and body.get("stored_bytes") == 16384, f"a 20480-byte message must be answered truncated true, original_bytes 20480, stored_bytes 16384, got {body}"
    body = euro.json()
    assert body.get("truncated") is True and body.get("original_bytes") == 21000 and body.get("stored_bytes") == 16383, f"7000 euro signs (3 bytes each) must be cut to 16383 bytes on a character boundary and answered original_bytes 21000, stored_bytes 16383, got {body}"
    body = whole.json()
    assert body.get("truncated") is False and body.get("original_bytes") == 16384 and body.get("stored_bytes") == 16384, f"a message of exactly 16384 bytes fits and must be answered truncated false with original_bytes and stored_bytes 16384, got {body}"
    body = emoji.json()
    assert body.get("truncated") is True and body.get("original_bytes") == 16401 and body.get("stored_bytes") == 16381, f"'a' and 4100 emoji (4 bytes each) must be cut back to 16381 bytes, the last whole character, and answered original_bytes 16401, stored_bytes 16381, got {body}"
    stored = _buffered(ctx)
    assert len(stored) == 5, f"buffer:acme:checkout holds {len(stored)} records, expected 5"
    assert len(stored[1]["message"].encode()) == 16384, f"the stored ASCII message is {len(stored[1]['message'].encode())} bytes, expected 16384"
    assert stored[2]["message"] == "€" * 5461, f"the stored euro message is {len(stored[2]['message'].encode())} bytes, expected 5461 whole characters (16383 bytes): cut the bytes, not the characters, and never split one"
    assert stored[3]["message"] == "a" * 16384, f"the stored 16384-byte message is {len(stored[3]['message'].encode())} bytes, expected all 16384 of them"
    assert stored[4]["message"] == "a" + "😀" * 4095, f"the stored emoji message is {len(stored[4]['message'].encode())} bytes, expected 'a' and 4095 whole emoji (16381 bytes): walk back to the start of the character the cut lands in"


async def check_validate_before_buffer(ctx):
    async with _api(ctx) as c:
        rejected = {
            "level verbose": await _post(c, _record(level="verbose")),
            "a timestamp 10 minutes old": await _post(c, _record(timestamp=_stamp(-600))),
            "a timestamp 5.5 minutes old": await _post(c, _record(timestamp=_stamp(-330))),
            "a timestamp 10 minutes ahead": await _post(c, _record(timestamp=_stamp(600))),
            "timestamp yesterday": await _post(c, _record(timestamp="yesterday")),
            "a timestamp without its offset": await _post(c, _record(timestamp=_stamp(zone=""))),
            "the current time in RFC 2822 form": await _post(c, _record(timestamp=time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime()))),
        }
        accepted = {
            "a timestamp 4 minutes old": await _post(c, _record(timestamp=_stamp(-240))),
            "a timestamp 4 minutes ahead": await _post(c, _record(timestamp=_stamp(240))),
            "the current time written at +02:00": await _post(c, _record(timestamp=_stamp(zone="+02:00", zone_s=7200))),
        }
    for what, r in rejected.items():
        assert r.status_code == 400, f"a record with {what} answered {r.status_code}, expected 400"
    for what, r in accepted.items():
        assert r.status_code == 202, f"a record with {what} is inside the 5-minute skew and answered {r.status_code}: {r.text}"
    assert len(_buffered(ctx)) == 3, f"buffer:acme:checkout holds {len(_buffered(ctx))} records, expected the 3 accepted: a rejected record must not reach the buffer"
`,
    typescript: `const MESSAGE = 'payment declined: card_expired';

const stamp = (ctx, offsetS = 0): string => new Date(ctx.clock.now() + offsetS * 1000).toISOString();
// The current time as wall-clock digits in another zone, with or without the zone's suffix.
const zoned = (ctx, zoneS: number, suffix: string): string => new Date(ctx.clock.now() + zoneS * 1000).toISOString().slice(0, 19) + suffix;
const bytes = (text: string): number => new TextEncoder().encode(text).length;

function record(ctx, over: Record<string, unknown> = {}) {
  return {service: 'checkout', timestamp: stamp(ctx), level: 'error', message: MESSAGE, ...over};
}

async function api(ctx) {
  const m = ctx.load('api');
  const registry = ctx.load('/support/logindex/registry.ts');
  await registry.addService('acme', 'checkout');
  await registry.addService('globex', 'billing');
  return ctx.client(m.app);
}

const post = (c, body, tenant: string | null = 'acme') => c.post('/v1/logs', {json: body, headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});

const buffered = (ctx, key = 'buffer:acme:checkout') => ctx.redis.lrange(key, 0, -1).map(raw => JSON.parse(raw));

const buffers = (ctx): string[] => ctx.redis.keys('buffer:*').filter(k => !k.endsWith(':meta')).sort();

export async function check_route(ctx) {
  const c = await api(ctx);
  const r = await post(c, record(ctx));
  assert.equal(r.status, 202, \`POST /v1/logs with a valid record answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.accepted === true && body.offset === 1, \`the first record must be answered accepted with offset 1, got \${r.text}\`);
  const stored = buffered(ctx);
  assert(stored.length === 1 && stored[0].message === MESSAGE && stored[0].service === 'checkout', \`buffer:acme:checkout holds \${JSON.stringify(stored)}, expected the one record\`);
}

export async function check_tenant_service(ctx) {
  const c = await api(ctx);
  const anonymous = await post(c, record(ctx), null);
  const typo = await post(c, record(ctx, {service: 'chekout'}));
  const foreign = await post(c, record(ctx, {service: 'billing'}));
  const ok = await post(c, record(ctx));
  assert.equal(anonymous.status, 401, \`a record without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
  assert.equal(typo.status, 400, \`a record for chekout, a service acme never registered, answered \${typo.status}, expected 400\`);
  assert(typo.text.includes('registry'), \`the 400 must say the service is not in the tenant's registry, got \${typo.text}\`);
  assert.equal(foreign.status, 400, \`acme posting to billing, a service only globex registered, answered \${foreign.status}, expected 400\`);
  assert.equal(ok.status, 202, \`a record for acme's checkout answered \${ok.status}: \${ok.text}\`);
  assert.deepStrictEqual(buffers(ctx), ['buffer:acme:checkout'], \`only the registered record may be buffered; Redis holds the buffers \${JSON.stringify(buffers(ctx))}\`);
  assert.equal(buffered(ctx).length, 1, \`buffer:acme:checkout holds \${buffered(ctx).length} records, expected 1\`);
}

// A record of exactly 1 MiB of JSON bytes (plus extra), its message under 1 MiB.
function exactBody(ctx, extra = 0): string {
  const shell = JSON.stringify(record(ctx, {message: ''}));
  return JSON.stringify(record(ctx, {message: 'x'.repeat((1 << 20) - bytes(shell) + extra)}));
}

export async function check_record_cap(ctx) {
  const c = await api(ctx);
  const huge = await post(c, record(ctx, {message: 'x'.repeat(1 << 20)}));
  const near = await post(c, record(ctx, {message: 'x'.repeat((1 << 20) - 400)}));
  const exactPayload = exactBody(ctx);
  const overPayload = exactBody(ctx, 1);
  assert(bytes(exactPayload) === 1 << 20 && bytes(overPayload) === (1 << 20) + 1, 'the harness built the boundary records wrong');
  const headers = {'X-Tenant-Id': 'acme', 'content-type': 'application/json'};
  const exact = await c.post('/v1/logs', {body: exactPayload, headers});
  const over = await c.post('/v1/logs', {body: overPayload, headers});
  assert.equal(huge.status, 413, \`a record over 1 MiB answered \${huge.status}, expected 413\`);
  assert.equal(over.status, 413, \`a record of 1 MiB + 1 byte whose message alone is under 1 MiB answered \${over.status}, expected 413: the cap is on the whole record's bytes\`);
  assert.equal(near.status, 202, \`a record just under 1 MiB answered \${near.status}, expected 202 (its message is cut, the record is accepted): \${near.text.slice(0, 200)}\`);
  assert.equal(exact.status, 202, \`a record of exactly 1 MiB (1048576 bytes) answered \${exact.status}, expected 202: only a record over the cap is 413: \${exact.text.slice(0, 200)}\`);
  assert.equal(buffered(ctx).length, 2, \`only the records within the cap may be buffered; buffer:acme:checkout holds \${buffered(ctx).length} records, expected 2\`);
}

export async function check_truncation(ctx) {
  const c = await api(ctx);
  const short = await post(c, record(ctx));
  const ascii = await post(c, record(ctx, {message: 'a'.repeat(20480)}));
  const euro = await post(c, record(ctx, {message: '€'.repeat(7000)}));
  const whole = await post(c, record(ctx, {message: 'a'.repeat(16384)}));
  const emoji = await post(c, record(ctx, {message: 'a' + '😀'.repeat(4100)}));
  for (const r of [short, ascii, euro, whole, emoji]) assert.equal(r.status, 202, \`a record answered \${r.status}: \${r.text.slice(0, 200)}\`);
  let body = short.json();
  assert(body.truncated === false && body.original_bytes === 30 && body.stored_bytes === 30, \`a 30-byte message must be answered truncated false with original_bytes and stored_bytes 30, got \${short.text}\`);
  body = ascii.json();
  assert(body.truncated === true && body.original_bytes === 20480 && body.stored_bytes === 16384, \`a 20480-byte message must be answered truncated true, original_bytes 20480, stored_bytes 16384, got \${ascii.text}\`);
  body = euro.json();
  assert(body.truncated === true && body.original_bytes === 21000 && body.stored_bytes === 16383, \`7000 euro signs (3 bytes each) must be cut to 16383 bytes on a character boundary and answered original_bytes 21000, stored_bytes 16383, got \${euro.text}\`);
  body = whole.json();
  assert(body.truncated === false && body.original_bytes === 16384 && body.stored_bytes === 16384, \`a message of exactly 16384 bytes fits and must be answered truncated false with original_bytes and stored_bytes 16384, got \${whole.text}\`);
  body = emoji.json();
  assert(body.truncated === true && body.original_bytes === 16401 && body.stored_bytes === 16381, \`'a' and 4100 emoji (4 bytes each) must be cut back to 16381 bytes, the last whole character, and answered original_bytes 16401, stored_bytes 16381, got \${emoji.text}\`);
  const stored = buffered(ctx);
  assert.equal(stored.length, 5, \`buffer:acme:checkout holds \${stored.length} records, expected 5\`);
  assert.equal(bytes(stored[1].message), 16384, \`the stored ASCII message is \${bytes(stored[1].message)} bytes, expected 16384\`);
  assert(stored[2].message === '€'.repeat(5461), \`the stored euro message is \${bytes(stored[2].message)} bytes, expected 5461 whole characters (16383 bytes): cut the bytes, not the characters, and never split one\`);
  assert(stored[3].message === 'a'.repeat(16384), \`the stored 16384-byte message is \${bytes(stored[3].message)} bytes, expected all 16384 of them\`);
  assert(stored[4].message === 'a' + '😀'.repeat(4095), \`the stored emoji message is \${bytes(stored[4].message)} bytes, expected 'a' and 4095 whole emoji (16381 bytes): walk back to the start of the character the cut lands in\`);
}

export async function check_validate_before_buffer(ctx) {
  const c = await api(ctx);
  const rejected: [string, unknown][] = [
    ['level verbose', await post(c, record(ctx, {level: 'verbose'}))],
    ['a timestamp 10 minutes old', await post(c, record(ctx, {timestamp: stamp(ctx, -600)}))],
    ['a timestamp 5.5 minutes old', await post(c, record(ctx, {timestamp: stamp(ctx, -330)}))],
    ['a timestamp 10 minutes ahead', await post(c, record(ctx, {timestamp: stamp(ctx, 600)}))],
    ['timestamp yesterday', await post(c, record(ctx, {timestamp: 'yesterday'}))],
    ['a timestamp without its offset', await post(c, record(ctx, {timestamp: zoned(ctx, 0, '')}))],
    ['the current time in RFC 2822 form', await post(c, record(ctx, {timestamp: new Date(ctx.clock.now()).toUTCString()}))],
  ];
  const accepted: [string, unknown][] = [
    ['a timestamp 4 minutes old', await post(c, record(ctx, {timestamp: stamp(ctx, -240)}))],
    ['a timestamp 4 minutes ahead', await post(c, record(ctx, {timestamp: stamp(ctx, 240)}))],
    ['the current time written at +02:00', await post(c, record(ctx, {timestamp: zoned(ctx, 7200, '+02:00')}))],
  ];
  for (const [what, r] of rejected as [string, {status: number}][]) assert.equal(r.status, 400, \`a record with \${what} answered \${r.status}, expected 400\`);
  for (const [what, r] of accepted as [string, {status: number; text: string}][]) assert.equal(r.status, 202, \`a record with \${what} is inside the 5-minute skew and answered \${r.status}: \${r.text}\`);
  assert.equal(buffered(ctx).length, 3, \`buffer:acme:checkout holds \${buffered(ctx).length} records, expected the 3 accepted: a rejected record must not reach the buffer\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"logindex/registry"

	"leetbuild/harness"
)

const hMessage = "payment declined: card_expired"

var hBg = context.Background()

type hIngestReply struct {
	Accepted      bool \`json:"accepted"\`
	Offset        int  \`json:"offset"\`
	Truncated     *bool \`json:"truncated"\`
	OriginalBytes int  \`json:"original_bytes"\`
	StoredBytes   int  \`json:"stored_bytes"\`
}

func hAPI(ctx *harness.Ctx) *harness.HTTP {
	registry.AddService(hBg, "acme", "checkout")
	registry.AddService(hBg, "globex", "billing")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func hStamp(ctx *harness.Ctx, offset time.Duration) string {
	return ctx.Clock.Time().Add(offset).UTC().Format(time.RFC3339)
}

func hLogRecord(ctx *harness.Ctx, field, value string) map[string]string {
	rec := map[string]string{"service": "checkout", "timestamp": hStamp(ctx, 0), "level": "error", "message": hMessage}
	if field != "" {
		rec[field] = value
	}
	return rec
}

func hPostLog(c *harness.HTTP, rec map[string]string, tenant string) *harness.Response {
	if tenant == "" {
		return c.Post("/v1/logs", rec)
	}
	return c.Post("/v1/logs", rec, "X-Tenant-Id", tenant)
}

// hExactBody is a record of exactly 1 MiB of JSON bytes (plus extra), its message under 1 MiB.
func hExactBody(ctx *harness.Ctx, extra int) string {
	shell, _ := json.Marshal(hLogRecord(ctx, "message", ""))
	body, _ := json.Marshal(hLogRecord(ctx, "message", strings.Repeat("x", (1<<20)-len(shell)+extra)))
	return string(body)
}

func hReplyOf(r *harness.Response) hIngestReply {
	var out hIngestReply
	json.Unmarshal(r.Body, &out)
	return out
}

func hBuffered(ctx *harness.Ctx) []map[string]string {
	var out []map[string]string
	for _, raw := range ctx.Redis.LRange("buffer:acme:checkout", 0, -1) {
		var rec map[string]string
		json.Unmarshal([]byte(raw), &rec)
		out = append(out, rec)
	}
	return out
}

func hBuffers(ctx *harness.Ctx) []string {
	out := []string{}
	for _, k := range ctx.Redis.Keys("buffer:*") {
		if !strings.HasSuffix(k, ":meta") {
			out = append(out, k)
		}
	}
	return out
}

func hBrief(text string) string {
	if len(text) > 200 {
		return text[:200]
	}
	return text
}

func CheckRoute(ctx *harness.Ctx) {
	c := hAPI(ctx)
	r := hPostLog(c, hLogRecord(ctx, "", ""), "acme")
	ctx.Equal(r.Status, 202, "POST /v1/logs with a valid record (%s)", r.Text())
	body := hReplyOf(r)
	ctx.Assert(body.Accepted && body.Offset == 1, "the first record must be answered accepted with offset 1, got %s", r.Text())
	stored := hBuffered(ctx)
	ctx.Assert(len(stored) == 1 && stored[0]["message"] == hMessage && stored[0]["service"] == "checkout", "buffer:acme:checkout holds %v, expected the one record", stored)
}

func CheckTenantService(ctx *harness.Ctx) {
	c := hAPI(ctx)
	anonymous := hPostLog(c, hLogRecord(ctx, "", ""), "")
	typo := hPostLog(c, hLogRecord(ctx, "service", "chekout"), "acme")
	foreign := hPostLog(c, hLogRecord(ctx, "service", "billing"), "acme")
	ok := hPostLog(c, hLogRecord(ctx, "", ""), "acme")
	ctx.Equal(anonymous.Status, 401, "a record without X-Tenant-Id")
	ctx.Equal(typo.Status, 400, "a record for chekout, a service acme never registered")
	ctx.Assert(strings.Contains(typo.Text(), "registry"), "the 400 must say the service is not in the tenant's registry, got %s", typo.Text())
	ctx.Equal(foreign.Status, 400, "acme posting to billing, a service only globex registered")
	ctx.Equal(ok.Status, 202, "a record for acme's checkout (%s)", ok.Text())
	ctx.Equal(hBuffers(ctx), []string{"buffer:acme:checkout"}, "only the registered record may be buffered; the buffers in Redis")
	ctx.Equal(len(hBuffered(ctx)), 1, "the records in buffer:acme:checkout")
}

func CheckRecordCap(ctx *harness.Ctx) {
	c := hAPI(ctx)
	huge := hPostLog(c, hLogRecord(ctx, "message", strings.Repeat("x", 1<<20)), "acme")
	near := hPostLog(c, hLogRecord(ctx, "message", strings.Repeat("x", (1<<20)-400)), "acme")
	exactBody, overBody := hExactBody(ctx, 0), hExactBody(ctx, 1)
	ctx.Assert(len(exactBody) == 1<<20 && len(overBody) == (1<<20)+1, "the harness built the boundary records wrong")
	exact := c.Post("/v1/logs", exactBody, "X-Tenant-Id", "acme", "Content-Type", "application/json")
	over := c.Post("/v1/logs", overBody, "X-Tenant-Id", "acme", "Content-Type", "application/json")
	ctx.Equal(huge.Status, 413, "a record over 1 MiB")
	ctx.Equal(over.Status, 413, "a record of 1 MiB + 1 byte whose message alone is under 1 MiB: the cap is on the whole record's bytes")
	ctx.Equal(near.Status, 202, "a record just under 1 MiB must be accepted with its message cut (%s)", hBrief(near.Text()))
	ctx.Equal(exact.Status, 202, "a record of exactly 1 MiB (1048576 bytes): only a record over the cap is 413 (%s)", hBrief(exact.Text()))
	ctx.Equal(len(hBuffered(ctx)), 2, "only the records within the cap may be buffered; the records in buffer:acme:checkout")
}

func CheckTruncation(ctx *harness.Ctx) {
	c := hAPI(ctx)
	short := hPostLog(c, hLogRecord(ctx, "", ""), "acme")
	ascii := hPostLog(c, hLogRecord(ctx, "message", strings.Repeat("a", 20480)), "acme")
	euro := hPostLog(c, hLogRecord(ctx, "message", strings.Repeat("€", 7000)), "acme")
	whole := hPostLog(c, hLogRecord(ctx, "message", strings.Repeat("a", 16384)), "acme")
	emoji := hPostLog(c, hLogRecord(ctx, "message", "a"+strings.Repeat("😀", 4100)), "acme")
	for _, r := range []*harness.Response{short, ascii, euro, whole, emoji} {
		ctx.Equal(r.Status, 202, "a record (%s)", hBrief(r.Text()))
	}
	body := hReplyOf(short)
	ctx.Assert(body.Truncated != nil && !*body.Truncated && body.OriginalBytes == 30 && body.StoredBytes == 30, "a 30-byte message must be answered truncated false with original_bytes and stored_bytes 30, got %s", short.Text())
	body = hReplyOf(ascii)
	ctx.Assert(body.Truncated != nil && *body.Truncated && body.OriginalBytes == 20480 && body.StoredBytes == 16384, "a 20480-byte message must be answered truncated true, original_bytes 20480, stored_bytes 16384, got %s", ascii.Text())
	body = hReplyOf(euro)
	ctx.Assert(body.Truncated != nil && *body.Truncated && body.OriginalBytes == 21000 && body.StoredBytes == 16383, "7000 euro signs (3 bytes each) must be cut to 16383 bytes on a character boundary and answered original_bytes 21000, stored_bytes 16383, got %s", euro.Text())
	body = hReplyOf(whole)
	ctx.Assert(body.Truncated != nil && !*body.Truncated && body.OriginalBytes == 16384 && body.StoredBytes == 16384, "a message of exactly 16384 bytes fits and must be answered truncated false with original_bytes and stored_bytes 16384, got %s", whole.Text())
	body = hReplyOf(emoji)
	ctx.Assert(body.Truncated != nil && *body.Truncated && body.OriginalBytes == 16401 && body.StoredBytes == 16381, "'a' and 4100 emoji (4 bytes each) must be cut back to 16381 bytes, the last whole character, and answered original_bytes 16401, stored_bytes 16381, got %s", emoji.Text())
	stored := hBuffered(ctx)
	ctx.Equal(len(stored), 5, "the records in buffer:acme:checkout")
	ctx.Equal(len(stored[1]["message"]), 16384, "the bytes of the stored ASCII message")
	ctx.Assert(stored[2]["message"] == strings.Repeat("€", 5461), "the stored euro message is %d bytes, expected 5461 whole characters (16383 bytes): cut the bytes, not the characters, and never split one", len(stored[2]["message"]))
	ctx.Assert(stored[3]["message"] == strings.Repeat("a", 16384), "the stored 16384-byte message is %d bytes, expected all 16384 of them", len(stored[3]["message"]))
	ctx.Assert(stored[4]["message"] == "a"+strings.Repeat("😀", 4095), "the stored emoji message is %d bytes, expected 'a' and 4095 whole emoji (16381 bytes): walk back to the start of the character the cut lands in", len(stored[4]["message"]))
}

func CheckValidateBeforeBuffer(ctx *harness.Ctx) {
	c := hAPI(ctx)
	now := ctx.Clock.Time()
	rejected := []struct {
		what         string
		field, value string
	}{
		{"level verbose", "level", "verbose"},
		{"a timestamp 10 minutes old", "timestamp", hStamp(ctx, -10*time.Minute)},
		{"a timestamp 5.5 minutes old", "timestamp", hStamp(ctx, -330*time.Second)},
		{"a timestamp 10 minutes ahead", "timestamp", hStamp(ctx, 10*time.Minute)},
		{"timestamp yesterday", "timestamp", "yesterday"},
		{"a timestamp without its offset", "timestamp", now.UTC().Format("2006-01-02T15:04:05")},
		{"the current time in RFC 2822 form", "timestamp", now.UTC().Format(http.TimeFormat)},
	}
	for _, tc := range rejected {
		r := hPostLog(c, hLogRecord(ctx, tc.field, tc.value), "acme")
		ctx.Equal(r.Status, 400, "a record with %s", tc.what)
	}
	accepted := []struct{ what, value string }{
		{"a timestamp 4 minutes old", hStamp(ctx, -4*time.Minute)},
		{"a timestamp 4 minutes ahead", hStamp(ctx, 4*time.Minute)},
		{"the current time written at +02:00", now.In(time.FixedZone("", 7200)).Format(time.RFC3339)},
	}
	for _, tc := range accepted {
		r := hPostLog(c, hLogRecord(ctx, "timestamp", tc.value), "acme")
		ctx.Equal(r.Status, 202, "a record with %s is inside the 5-minute skew (%s)", tc.what, r.Text())
	}
	ctx.Equal(len(hBuffered(ctx)), 3, "the 3 accepted records, and no rejected one, in buffer:acme:checkout")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cstdio>
#include <string>
#include <vector>

#include "logindex/registry.h"

using json = nlohmann::json;

namespace {

const std::string kHMessage = "payment declined: card_expired";

harness::HTTP hApi(harness::Ctx& ctx) {
  registry::addService("acme", "checkout");
  registry::addService("globex", "billing");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

struct HCivil {
  long long y, m, d, secs, weekday;
};

// The UTC calendar date of the instant offset_s seconds from now.
HCivil hCivil(harness::Ctx& ctx, long long offset_s) {
  const long long t = ctx.Clock.Now() / 1000 + offset_s;
  long long z = t / 86400 + 719468;
  const long long secs = t % 86400;
  const long long era = (z >= 0 ? z : z - 146096) / 146097;
  const long long doe = z - era * 146097;
  const long long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const long long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const long long mp = (5 * doy + 2) / 153;
  const long long d = doy - (153 * mp + 2) / 5 + 1;
  const long long m = mp < 10 ? mp + 3 : mp - 9;
  const long long y = yoe + era * 400 + (m <= 2);
  return {y, m, d, secs, (t / 86400 + 4) % 7};
}

// An RFC 3339 timestamp offset_s seconds from now: the wall clock zone_s seconds east of UTC, then the suffix.
std::string hStamp(harness::Ctx& ctx, long long offset_s, long long zone_s = 0, const std::string& suffix = "Z") {
  const HCivil c = hCivil(ctx, offset_s + zone_s);
  char out[32];
  std::snprintf(out, sizeof out, "%04lld-%02lld-%02lldT%02lld:%02lld:%02lld", c.y, c.m, c.d, c.secs / 3600, c.secs / 60 % 60, c.secs % 60);
  return out + suffix;
}

// The current time in RFC 2822 form, as an HTTP Date header writes it.
std::string hRfc2822(harness::Ctx& ctx) {
  static const char* days[] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
  static const char* months[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
  const HCivil c = hCivil(ctx, 0);
  char out[40];
  std::snprintf(out, sizeof out, "%s, %02lld %s %04lld %02lld:%02lld:%02lld GMT", days[c.weekday], c.d, months[c.m - 1], c.y, c.secs / 3600, c.secs / 60 % 60, c.secs % 60);
  return out;
}

json hLogRecord(harness::Ctx& ctx, const std::string& field = "", const std::string& value = "") {
  json rec = {{"service", "checkout"}, {"timestamp", hStamp(ctx, 0)}, {"level", "error"}, {"message", kHMessage}};
  if (!field.empty()) rec[field] = value;
  return rec;
}

harness::Response hPostRaw(harness::HTTP& c, const std::string& body, const std::string& tenant = "acme") {
  if (tenant.empty()) return c.Post("/v1/logs", body, "Content-Type", "application/json");
  return c.Post("/v1/logs", body, "Content-Type", "application/json", "X-Tenant-Id", tenant);
}

harness::Response hPostLog(harness::HTTP& c, const json& rec, const std::string& tenant = "acme") { return hPostRaw(c, rec.dump(), tenant); }

// A record of exactly 1 MiB of JSON bytes (plus extra), its message under 1 MiB.
std::string hExactBody(harness::Ctx& ctx, size_t extra) {
  const size_t shell = hLogRecord(ctx, "message", "").dump().size();
  return hLogRecord(ctx, "message", std::string((1 << 20) - shell + extra, 'x')).dump();
}

json hReplyOf(const harness::Response& r) {
  const json j = json::parse(r.Text(), nullptr, false);
  return j.is_object() ? j : json::object();
}

std::vector<json> hBuffered(harness::Ctx& ctx) {
  std::vector<json> out;
  for (const auto& raw : ctx.Redis.LRange("buffer:acme:checkout", 0, -1)) out.push_back(json::parse(raw, nullptr, false));
  return out;
}

std::vector<std::string> hBuffers(harness::Ctx& ctx) {
  std::vector<std::string> out;
  for (const auto& k : ctx.Redis.Keys("buffer:*")) {
    if (k.size() < 5 || k.substr(k.size() - 5) != ":meta") out.push_back(k);
  }
  return out;
}

std::string hRepeat(const std::string& s, size_t n) {
  std::string out;
  out.reserve(s.size() * n);
  for (size_t i = 0; i < n; i++) out += s;
  return out;
}

std::string hBrief(const std::string& text) { return text.substr(0, 200); }

bool hIsFalse(const json& body, const char* name) { return body.contains(name) && body[name].is_boolean() && !body[name].get<bool>(); }
bool hIsTrue(const json& body, const char* name) { return body.contains(name) && body[name].is_boolean() && body[name].get<bool>(); }

bool hCut(const json& body, bool truncated, int original, int stored) {
  return (truncated ? hIsTrue(body, "truncated") : hIsFalse(body, "truncated")) && body.value("original_bytes", 0) == original && body.value("stored_bytes", 0) == stored;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = hApi(ctx);
  const auto r = hPostLog(c, hLogRecord(ctx));
  ctx.Equal(r.Status, 202, "POST /v1/logs with a valid record (%s)", r.Text());
  const json body = hReplyOf(r);
  ctx.Assert(hIsTrue(body, "accepted") && body.value("offset", 0) == 1, "the first record must be answered accepted with offset 1, got %s", r.Text());
  const auto stored = hBuffered(ctx);
  ctx.Assert(stored.size() == 1 && stored[0].value("message", "") == kHMessage && stored[0].value("service", "") == "checkout",
             "buffer:acme:checkout holds %d records, expected the one record", stored.size());
}

void CheckTenantService(harness::Ctx& ctx) {
  auto c = hApi(ctx);
  const auto anonymous = hPostLog(c, hLogRecord(ctx), "");
  const auto typo = hPostLog(c, hLogRecord(ctx, "service", "chekout"));
  const auto foreign = hPostLog(c, hLogRecord(ctx, "service", "billing"));
  const auto ok = hPostLog(c, hLogRecord(ctx));
  ctx.Equal(anonymous.Status, 401, "a record without X-Tenant-Id");
  ctx.Equal(typo.Status, 400, "a record for chekout, a service acme never registered");
  ctx.Assert(typo.Text().find("registry") != std::string::npos, "the 400 must say the service is not in the tenant's registry, got %s", typo.Text());
  ctx.Equal(foreign.Status, 400, "acme posting to billing, a service only globex registered");
  ctx.Equal(ok.Status, 202, "a record for acme's checkout (%s)", ok.Text());
  ctx.Equal(hBuffers(ctx), {"buffer:acme:checkout"}, "only the registered record may be buffered; the buffers in Redis");
  ctx.Equal(hBuffered(ctx).size(), 1, "the records in buffer:acme:checkout");
}

void CheckRecordCap(harness::Ctx& ctx) {
  auto c = hApi(ctx);
  const auto huge = hPostLog(c, hLogRecord(ctx, "message", std::string(1 << 20, 'x')));
  const auto near = hPostLog(c, hLogRecord(ctx, "message", std::string((1 << 20) - 400, 'x')));
  const std::string exactBody = hExactBody(ctx, 0), overBody = hExactBody(ctx, 1);
  ctx.Assert(exactBody.size() == (1 << 20) && overBody.size() == (1 << 20) + 1, "the harness built the boundary records wrong");
  const auto exact = hPostRaw(c, exactBody);
  const auto over = hPostRaw(c, overBody);
  ctx.Equal(huge.Status, 413, "a record over 1 MiB");
  ctx.Equal(over.Status, 413, "a record of 1 MiB + 1 byte whose message alone is under 1 MiB: the cap is on the whole record's bytes");
  ctx.Equal(near.Status, 202, "a record just under 1 MiB must be accepted with its message cut (%s)", hBrief(near.Text()));
  ctx.Equal(exact.Status, 202, "a record of exactly 1 MiB (1048576 bytes): only a record over the cap is 413 (%s)", hBrief(exact.Text()));
  ctx.Equal(hBuffered(ctx).size(), 2, "only the records within the cap may be buffered; the records in buffer:acme:checkout");
}

void CheckTruncation(harness::Ctx& ctx) {
  auto c = hApi(ctx);
  const auto shortReply = hPostLog(c, hLogRecord(ctx));
  const auto ascii = hPostLog(c, hLogRecord(ctx, "message", std::string(20480, 'a')));
  const auto euro = hPostLog(c, hLogRecord(ctx, "message", hRepeat("€", 7000)));
  const auto whole = hPostLog(c, hLogRecord(ctx, "message", std::string(16384, 'a')));
  const auto emoji = hPostLog(c, hLogRecord(ctx, "message", "a" + hRepeat("😀", 4100)));
  for (const auto* r : {&shortReply, &ascii, &euro, &whole, &emoji}) ctx.Equal(r->Status, 202, "a record (%s)", hBrief(r->Text()));
  ctx.Assert(hCut(hReplyOf(shortReply), false, 30, 30), "a 30-byte message must be answered truncated false with original_bytes and stored_bytes 30, got %s", shortReply.Text());
  ctx.Assert(hCut(hReplyOf(ascii), true, 20480, 16384), "a 20480-byte message must be answered truncated true, original_bytes 20480, stored_bytes 16384, got %s", ascii.Text());
  ctx.Assert(hCut(hReplyOf(euro), true, 21000, 16383),
             "7000 euro signs (3 bytes each) must be cut to 16383 bytes on a character boundary and answered original_bytes 21000, stored_bytes 16383, got %s", euro.Text());
  ctx.Assert(hCut(hReplyOf(whole), false, 16384, 16384),
             "a message of exactly 16384 bytes fits and must be answered truncated false with original_bytes and stored_bytes 16384, got %s", whole.Text());
  ctx.Assert(hCut(hReplyOf(emoji), true, 16401, 16381),
             "'a' and 4100 emoji (4 bytes each) must be cut back to 16381 bytes, the last whole character, and answered original_bytes 16401, stored_bytes 16381, got %s", emoji.Text());
  const auto stored = hBuffered(ctx);
  ctx.Equal(stored.size(), 5, "the records in buffer:acme:checkout");
  ctx.Equal(stored[1].value("message", "").size(), 16384, "the bytes of the stored ASCII message");
  const std::string kept = stored[2].value("message", "");
  ctx.Assert(kept == hRepeat("€", 5461), "the stored euro message is %d bytes, expected 5461 whole characters (16383 bytes): cut the bytes, not the characters, and never split one", kept.size());
  const std::string fits = stored[3].value("message", "");
  ctx.Assert(fits == std::string(16384, 'a'), "the stored 16384-byte message is %d bytes, expected all 16384 of them", fits.size());
  const std::string emojiKept = stored[4].value("message", "");
  ctx.Assert(emojiKept == "a" + hRepeat("😀", 4095), "the stored emoji message is %d bytes, expected 'a' and 4095 whole emoji (16381 bytes): walk back to the start of the character the cut lands in", emojiKept.size());
}

void CheckValidateBeforeBuffer(harness::Ctx& ctx) {
  auto c = hApi(ctx);
  const std::vector<std::vector<std::string>> rejected = {
      {"level verbose", "level", "verbose"},
      {"a timestamp 10 minutes old", "timestamp", hStamp(ctx, -600)},
      {"a timestamp 5.5 minutes old", "timestamp", hStamp(ctx, -330)},
      {"a timestamp 10 minutes ahead", "timestamp", hStamp(ctx, 600)},
      {"timestamp yesterday", "timestamp", "yesterday"},
      {"a timestamp without its offset", "timestamp", hStamp(ctx, 0, 0, "")},
      {"the current time in RFC 2822 form", "timestamp", hRfc2822(ctx)},
  };
  for (const auto& tc : rejected) ctx.Equal(hPostLog(c, hLogRecord(ctx, tc[1], tc[2])).Status, 400, "a record with %s", tc[0]);
  const std::vector<std::vector<std::string>> accepted = {
      {"a timestamp 4 minutes old", hStamp(ctx, -240)},
      {"a timestamp 4 minutes ahead", hStamp(ctx, 240)},
      {"the current time written at +02:00", hStamp(ctx, 0, 7200, "+02:00")},
  };
  for (const auto& tc : accepted) {
    const auto r = hPostLog(c, hLogRecord(ctx, "timestamp", tc[1]));
    ctx.Equal(r.Status, 202, "a record with %s is inside the 5-minute skew (%s)", tc[0], r.Text());
  }
  ctx.Equal(hBuffered(ctx).size(), 3, "the 3 accepted records, and no rejected one, in buffer:acme:checkout");
}
`,
  },
  hints: [
    'Post a record for `chekout` and one carrying a 20 KiB stack trace: both answer 202, the typo gets a buffer of its own, and the stored trace is shorter than the one sent with nothing saying so.',
    'The handler goes straight from parsing to `append_record`: no registry lookup, no size limit, no level or clock check. The cut counts characters rather than bytes, and nothing compares the lengths afterwards.',
    'Guard in order: 401 without a tenant, 413 over `MAX_RECORD_BYTES` before the parse, 400 unless `is_registered`, the level is in `LEVELS` and the timestamp within `MAX_SKEW`; cut the UTF-8 bytes at 16 KiB back to a character start and report both counts.',
  ],
  debrief: `The guards run in order of cost, and every one of them answers before a byte reaches the buffer. That order is what gives the 413 its meaning: a cap checked after the parse has already paid for the parse. The cut works on bytes because the index and the shard count bytes, and it walks back to a character start so the stored line stays valid UTF-8. Both counts go back to the agent, which can decide what a cut stack trace means for it. A production ingest tier would also count each rejection by reason (Loki's discarded-samples counter does exactly that) and could append a marker to the stored line, so a reader of the index sees the cut without the 202.`,
};
