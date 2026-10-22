import type {Step} from '@/lib/types';

/**
 * Step 1 — the write endpoint. The rating has to land on a request the tenant actually served, the
 * comment has to stay inside its budget, and a missing rating is a rejected request, not a zero.
 */
export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/feedback: a rating that must reference a real request',
  concept: 'http',
  file: 'api',
  focus: ['client', 'collector', 'db'],
  sequence: {
    participants: ['Client', 'Feedback Collector', 'feedback store'],
    messages: [
      {
        from: 'Client',
        to: 'Feedback Collector',
        label: 'POST /v1/feedback · X-Tenant-Id, request_id, rating, comment',
        kind: 'sync',
      },
      {
        from: 'Feedback Collector',
        to: 'Feedback Collector',
        label: 'tenant present? request_id present? rating in -1/0/1?',
        kind: 'sync',
      },
      {
        from: 'Feedback Collector',
        to: 'Feedback Collector',
        label: 'comment bytes ≤ 2 KiB? otherwise 413',
        kind: 'sync',
      },
      {
        from: 'Feedback Collector',
        to: 'feedback store',
        label: 'was (tenant, request_id) served? otherwise 404',
        kind: 'sync',
      },
      {
        from: 'Feedback Collector',
        to: 'feedback store',
        label: 'insert the feedback row with the rating',
        kind: 'async',
      },
      {from: 'Feedback Collector', to: 'Client', label: '201 · {feedback_id, request_id, rating}', kind: 'reply'},
    ],
  },
  task: `## Task

**Review premise.** You are the AI platform engineer on call. A tenant complained that a thumbs-down
they left on a bad answer vanished from the dashboard, while a support macro that posts an empty
rating has been quietly counting as neutral. The model-generated handler below registers the route and
writes a row, so it looks finished — but it trusts the caller for the request id, keeps an unbounded
comment, and turns silence into a \`0\`.

Review \`api\` before you trust the dashboard, then fix it so the row it writes can only describe a
request this tenant really served.

- The handler must read the tenant from the \`X-Tenant-Id\` header and reject a request without one
  before it touches the body.
- A \`request_id\` is only valid if this tenant actually served it; an unknown or foreign request id is
  \`404\`, not a row that points at nothing.
- \`rating\` is mandatory and must be exactly \`-1\`, \`0\` or \`1\`. A body without a rating is \`400\`; it must
  never be stored as a default \`0\`, because silence is not satisfaction.
- \`comment\` is optional but its UTF-8 length is capped at \`2 * 1024\` bytes; anything larger is \`413\`.
- The comment text must never reach the logs — the log line carries the tenant, the request id and the
  rating only.

**Failure mode the checks target.** A rating that references a request the tenant never served is an
attribution bug wearing a validation costume, and a defaulted \`0\` inflates the denominator of every
satisfaction score downstream. The checks below pin the request id to a served request, require an
explicit rating, cap the comment, and keep the comment out of the log line.`,
  hints: [
    'The tenant is the scope of everything: read `X-Tenant-Id` first and return `401` before parsing the body. A `request_id` is only meaningful inside that tenant.',
    'Look up `(tenant, request_id)` in the served-requests store. A miss is `404`. A rating that is absent, non-integer, or outside `-1/0/1` is `400` — make the allowed set an explicit constant so the check can see it.',
    'Measure the comment in bytes, not characters: `len(comment.encode("utf-8"))` (or `Buffer.byteLength`) against `2 * 1024`, and answer `413`. Keep the comment out of the logger call entirely.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/feedback',
      detail:
        'Register the feedback route on `POST /v1/feedback` and parse the tenant, request id, rating and comment from the request.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/feedback["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/feedback['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/feedback"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"feedback"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/feedback"/]},
      },
    },
    {
      id: 'served-request',
      title: 'The request id must reference a request this tenant served',
      detail:
        'Look the `(tenant, request_id)` pair up in the served-requests store and answer `404` when it is unknown, so a rating can never attach to a request that was never served.',
      match: {
        python: {all: [/served_requests\.get\(/, /status_code\s*=\s*404/]},
        typescript: {all: [/servedRequests\.get\(/, /code\(\s*404\s*\)/]},
        go: {all: [/servedRequests\.Get\(/, /StatusNotFound/]},
        scala: {all: [/servedRequests\.get\(/, /StatusCodes\.NotFound/]},
        cpp: {all: [/servedRequests\.get\(/, /\b404\b/]},
      },
    },
    {
      id: 'rating',
      title: 'A rating is mandatory and must be -1, 0 or 1',
      detail:
        'Reject a body whose `rating` is missing or outside `-1/0/1` with `400` instead of defaulting it to `0`, so silence is never counted as neutral.',
      match: {
        python: {all: [/ALLOWED_RATINGS/, /status_code\s*=\s*400/]},
        typescript: {all: [/ALLOWED_RATINGS/, /code\(\s*400\s*\)/]},
        go: {all: [/allowedRatings/, /StatusBadRequest/]},
        scala: {all: [/AllowedRatings/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kAllowedRatings/, /\b400\b/]},
      },
    },
    {
      id: 'comment-cap',
      title: 'The comment is capped at 2 KiB',
      detail:
        'Measure the comment in UTF-8 bytes against `2 * 1024` and answer `413` when it is larger, so an oversized comment cannot fill the row or the pipeline.',
      match: {
        python: {all: [/MAX_COMMENT_BYTES/, /status_code\s*=\s*413/]},
        typescript: {all: [/MAX_COMMENT_BYTES/, /code\(\s*413\s*\)/]},
        go: {all: [/maxCommentBytes/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/MaxCommentBytes/, /StatusCodes\.RequestEntityTooLarge/]},
        cpp: {all: [/kMaxCommentBytes/, /\b413\b/]},
      },
    },
    {
      id: 'no-comment-log',
      title: 'Logs the decision, never the comment',
      detail:
        'The handler logs the tenant, request id and rating, but the comment text must not appear in any log call — logs are retained and shared far more widely than the feedback row.',
      match: {
        python: {all: [/logger\.info\(/], none: [/logger\.\w+\([^)]*comment/]},
        typescript: {all: [/\.log\.info\(/], none: [/log\.\w+\([^)]*comment/]},
        go: {all: [/log\.Printf\(/], none: [/log\.\w+\([^)]*[Cc]omment/]},
        scala: {all: [/log\.info\(/], none: [/log\.info\([^)]*comment/]},
        cpp: {all: [/(std::)?(cerr|clog)\s*<</], none: [/(std::)?(cerr|clog)[^;]*comment/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("feedback")


class FeedbackRequest(BaseModel):
    request_id: str
    rating: int = 0
    comment: str = ""


class ServedRequestsStore:
    """The requests this tenant has served, keyed by (tenant, request_id)."""

    def get(self, tenant: str, request_id: str) -> dict | None:
        raise NotImplementedError


class FeedbackStore:
    def put(self, record: dict) -> None:
        raise NotImplementedError


served_requests = ServedRequestsStore()
feedback = FeedbackStore()


@app.post("/v1/feedback")
def submit(body: FeedbackRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft stores whatever request id the caller sends, keeps an unbounded comment,
    # and turns a missing rating into 0 so silence counts as neutral. Review all three.
    record = {
        "feedback_id": str(uuid.uuid4()),
        "tenant": tenant,
        "request_id": body.request_id,
        "rating": body.rating,
        "comment": body.comment,
    }
    feedback.put(record)
    logger.info("feedback tenant=%s request=%s comment=%r", tenant, body.request_id, body.comment)
    return JSONResponse(record, status_code=201)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("feedback")

MAX_COMMENT_BYTES = 2 * 1024
ALLOWED_RATINGS = {-1, 0, 1}


class FeedbackRequest(BaseModel):
    request_id: str
    rating: int | None = None
    comment: str = ""


class ServedRequestsStore:
    """The requests this tenant has served, keyed by (tenant, request_id)."""

    def get(self, tenant: str, request_id: str) -> dict | None:
        raise NotImplementedError


class FeedbackStore:
    def put(self, record: dict) -> None:
        raise NotImplementedError


served_requests = ServedRequestsStore()
feedback = FeedbackStore()


@app.post("/v1/feedback")
def submit(
    body: FeedbackRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if body.request_id == "":
        raise HTTPException(status_code=400, detail="request_id is required")
    if body.rating is None or body.rating not in ALLOWED_RATINGS:
        raise HTTPException(status_code=400, detail="rating must be -1, 0 or 1")
    if len(body.comment.encode("utf-8")) > MAX_COMMENT_BYTES:
        raise HTTPException(status_code=413, detail="comment exceeds 2 KiB")

    served = served_requests.get(tenant, body.request_id)
    if served is None:
        raise HTTPException(status_code=404, detail="unknown request id")

    record = {
        "feedback_id": str(uuid.uuid4()),
        "tenant": tenant,
        "request_id": body.request_id,
        "rating": body.rating,
        "comment": body.comment,
    }
    feedback.put(record)
    logger.info("feedback tenant=%s request=%s rating=%d", tenant, body.request_id, body.rating)
    return JSONResponse(record, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/feedback: a model-generated draft that trusts the caller's request id. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

export interface ServedRequest {
  tenant: string;
  request_id: string;
}

interface FeedbackBody {
  request_id: string;
  rating?: number;
  comment?: string;
}

export class ServedRequestsStore {
  async get(tenant: string, requestId: string): Promise<ServedRequest | null> {
    throw new Error('not implemented');
  }
}

export class FeedbackStore {
  async put(record: unknown): Promise<void> {
    throw new Error('not implemented');
  }
}

export const servedRequests = new ServedRequestsStore();
export const feedback = new FeedbackStore();

app.post('/v1/feedback', async (request, reply) => {
  // TODO: this draft stores whatever request id the caller sends, keeps an unbounded comment,
  // and turns a missing rating into 0 so silence counts as neutral. Review all three.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as FeedbackBody;
  const record = {
    feedback_id: randomUUID(),
    tenant,
    request_id: body.request_id,
    rating: body.rating ?? 0,
    comment: body.comment ?? '',
  };
  await feedback.put(record);
  request.log.info({tenant, request_id: body.request_id, comment: body.comment}, 'feedback');
  return reply.code(201).send(record);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/feedback: a rating that must reference a request this tenant served. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const MAX_COMMENT_BYTES = 2 * 1024;
const ALLOWED_RATINGS: readonly number[] = [-1, 0, 1];

export interface ServedRequest {
  tenant: string;
  request_id: string;
}

interface FeedbackBody {
  request_id: string;
  rating?: number;
  comment?: string;
}

export class ServedRequestsStore {
  async get(tenant: string, requestId: string): Promise<ServedRequest | null> {
    throw new Error('not implemented');
  }
}

export class FeedbackStore {
  async put(record: unknown): Promise<void> {
    throw new Error('not implemented');
  }
}

export const servedRequests = new ServedRequestsStore();
export const feedback = new FeedbackStore();

app.post('/v1/feedback', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') {
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  }
  const body = request.body as Partial<FeedbackBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.request_id !== 'string' || body.request_id === '') {
    return reply.code(400).send({error: 'request_id is required'});
  }
  if (body.rating === undefined || !Number.isInteger(body.rating) || !ALLOWED_RATINGS.includes(body.rating)) {
    return reply.code(400).send({error: 'rating must be -1, 0 or 1'});
  }
  const comment = body.comment ?? '';
  if (typeof comment !== 'string') {
    return reply.code(400).send({error: 'comment must be a string'});
  }
  if (Buffer.byteLength(comment, 'utf8') > MAX_COMMENT_BYTES) {
    return reply.code(413).send({error: 'comment exceeds 2 KiB'});
  }

  const served = await servedRequests.get(tenant, body.request_id);
  if (served === null) {
    return reply.code(404).send({error: 'unknown request id'});
  }

  const record = {
    feedback_id: randomUUID(),
    tenant,
    request_id: body.request_id,
    rating: body.rating,
    comment,
  };
  await feedback.put(record);
  request.log.info({tenant, request_id: body.request_id, rating: body.rating}, 'feedback');
  return reply.code(201).send(record);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

type FeedbackRequest struct {
	RequestID string \`json:"request_id"\`
	Rating    int    \`json:"rating"\`
	Comment   string \`json:"comment"\`
}

// ServedRequestsStore is the set of requests this tenant has served.
type ServedRequestsStore struct{}

func (s *ServedRequestsStore) Get(ctx context.Context, tenant, requestID string) (map[string]any, error) {
	return nil, nil
}

type FeedbackStore struct{}

func (s *FeedbackStore) Put(ctx context.Context, record map[string]any) error {
	return nil
}

var servedRequests = &ServedRequestsStore{}
var feedback = &FeedbackStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func submit(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body FeedbackRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft stores whatever request id the caller sends, keeps an unbounded comment,
	// and turns a missing rating into 0 so silence counts as neutral. Review all three.
	record := map[string]any{
		"feedback_id": uuid.NewString(),
		"tenant":      tenant,
		"request_id":  body.RequestID,
		"rating":      body.Rating,
		"comment":     body.Comment,
	}
	if err := feedback.Put(r.Context(), record); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("feedback tenant=%s request=%s comment=%q", tenant, body.RequestID, body.Comment)
	writeJSON(rw, http.StatusCreated, record)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/feedback", submit)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

const maxCommentBytes = 2 * 1024

var allowedRatings = map[int]bool{-1: true, 0: true, 1: true}

type FeedbackRequest struct {
	RequestID string \`json:"request_id"\`
	Rating    *int   \`json:"rating"\`
	Comment   string \`json:"comment"\`
}

// ServedRequestsStore is the set of requests this tenant has served.
type ServedRequestsStore struct{}

func (s *ServedRequestsStore) Get(ctx context.Context, tenant, requestID string) (map[string]any, error) {
	return nil, nil
}

type FeedbackStore struct{}

func (s *FeedbackStore) Put(ctx context.Context, record map[string]any) error {
	return nil
}

var servedRequests = &ServedRequestsStore{}
var feedback = &FeedbackStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func submit(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body FeedbackRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.RequestID == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "request_id is required"})
		return
	}
	if body.Rating == nil || !allowedRatings[*body.Rating] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "rating must be -1, 0 or 1"})
		return
	}
	if len([]byte(body.Comment)) > maxCommentBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "comment exceeds 2 KiB"})
		return
	}

	served, err := servedRequests.Get(r.Context(), tenant, body.RequestID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if served == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown request id"})
		return
	}

	record := map[string]any{
		"feedback_id": uuid.NewString(),
		"tenant":      tenant,
		"request_id":  body.RequestID,
		"rating":      *body.Rating,
		"comment":     body.Comment,
	}
	if err := feedback.Put(r.Context(), record); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("feedback tenant=%s request=%s rating=%d", tenant, body.RequestID, *body.Rating)
	writeJSON(rw, http.StatusCreated, record)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/feedback", submit)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class FeedbackRequest(request_id: String, rating: Option[Int], comment: Option[String])

trait ServedRequestsStore {
  /** The request this tenant served, if any. */
  def get(tenant: String, requestId: String): Option[ServedRequest]
}

final case class ServedRequest(tenant: String, request_id: String, model_version: String)

object FeedbackApi {
  implicit val system: ActorSystem = ActorSystem("feedback-collector")
  implicit val requestFormat: RootJsonFormat[FeedbackRequest] = jsonFormat3(FeedbackRequest)

  val servedRequests: ServedRequestsStore = new ServedRequestsStore {
    def get(tenant: String, requestId: String): Option[ServedRequest] = None
  }
  val feedback = FeedbackStore.open()

  val route: Route =
    path("v1" / "feedback") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[FeedbackRequest]) { body =>
            // TODO: this draft stores whatever request id the caller sends, keeps an unbounded
            // comment, and turns a missing rating into 0 so silence counts as neutral.
            val rating = body.rating.getOrElse(0)
            val record =
              s"""{"feedback_id":"\${UUID.randomUUID()}","tenant":"$tenant","request_id":"\${body.request_id}","rating":$rating}"""
            feedback.put(record)
            system.log.info(s"feedback tenant=$tenant request=\${body.request_id} comment=\${body.comment}")
            complete(StatusCodes.Created, record)
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class FeedbackRequest(request_id: String, rating: Option[Int], comment: Option[String])

final case class ServedRequest(tenant: String, request_id: String, model_version: String)

object FeedbackApi {
  val MaxCommentBytes: Int = 2 * 1024
  val AllowedRatings: Set[Int] = Set(-1, 0, 1)

  implicit val system: ActorSystem = ActorSystem("feedback-collector")
  implicit val requestFormat: RootJsonFormat[FeedbackRequest] = jsonFormat3(FeedbackRequest)

  val servedRequests: ServedRequestsStore = ServedRequestsStore.open()
  val feedback = FeedbackStore.open()

  val route: Route =
    path("v1" / "feedback") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[FeedbackRequest]) { body =>
            body.rating match {
              case Some(rating) if AllowedRatings.contains(rating) =>
                if (body.comment.exists(_.getBytes("UTF-8").length > MaxCommentBytes)) {
                  complete(StatusCodes.RequestEntityTooLarge, """{"error":"comment exceeds 2 KiB"}""")
                } else {
                  servedRequests.get(tenant, body.request_id) match {
                    case None =>
                      complete(StatusCodes.NotFound, """{"error":"unknown request id"}""")
                    case Some(_) =>
                      val record =
                        s"""{"feedback_id":"\${UUID.randomUUID()}","tenant":"$tenant","request_id":"\${body.request_id}","rating":$rating}"""
                      feedback.put(record)
                      system.log.info(s"feedback tenant=$tenant request=\${body.request_id} rating=$rating")
                      complete(StatusCodes.Created, record)
                  }
                }
              case _ =>
                complete(StatusCodes.BadRequest, """{"error":"rating must be -1, 0 or 1"}""")
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

#include <iostream>
#include <optional>
#include <string>

using json = nlohmann::json;

struct ServedRequest {
  std::string tenant;
  std::string request_id;
  std::string model_version;
};

struct ServedRequestsStore {
  std::optional<ServedRequest> get(const std::string& tenant, const std::string& requestId);
};

struct FeedbackStore {
  void put(const json& record);
};

ServedRequestsStore servedRequests;
FeedbackStore feedback;

std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/feedback", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft stores whatever request id the caller sends, keeps an unbounded comment,
    // and turns a missing rating into 0 so silence counts as neutral. Review all three.
    const json record = {
        {"feedback_id", uuidString()},
        {"tenant", tenant},
        {"request_id", body.value("request_id", std::string())},
        {"rating", body.value("rating", 0)},
        {"comment", body.value("comment", std::string())},
    };
    feedback.put(record);
    std::cerr << "feedback tenant=" << tenant << " comment=" << body.value("comment", std::string()) << "\\n";
    res.status = 201;
    res.set_content(record.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <string>

using json = nlohmann::json;

constexpr std::size_t kMaxCommentBytes = 2 * 1024;
const std::set<int> kAllowedRatings = {-1, 0, 1};

struct ServedRequest {
  std::string tenant;
  std::string request_id;
  std::string model_version;
};

struct ServedRequestsStore {
  std::optional<ServedRequest> get(const std::string& tenant, const std::string& requestId);
};

struct FeedbackStore {
  void put(const json& record);
};

ServedRequestsStore servedRequests;
FeedbackStore feedback;

std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/feedback", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    if (!body.contains("request_id") || !body["request_id"].is_string() || body["request_id"].get<std::string>().empty()) {
      res.status = 400;
      res.set_content(R"({"error":"request_id is required"})", "application/json");
      return;
    }
    if (!body.contains("rating") || !body["rating"].is_number_integer() ||
        !kAllowedRatings.count(body["rating"].get<int>())) {
      res.status = 400;
      res.set_content(R"({"error":"rating must be -1, 0 or 1"})", "application/json");
      return;
    }
    const auto comment = body.value("comment", std::string());
    if (comment.size() > kMaxCommentBytes) {
      res.status = 413;
      res.set_content(R"({"error":"comment exceeds 2 KiB"})", "application/json");
      return;
    }

    const auto served = servedRequests.get(tenant, body["request_id"].get<std::string>());
    if (!served.has_value()) {
      res.status = 404;
      res.set_content(R"({"error":"unknown request id"})", "application/json");
      return;
    }

    const json record = {
        {"feedback_id", uuidString()},
        {"tenant", tenant},
        {"request_id", body["request_id"].get<std::string>()},
        {"rating", body["rating"].get<int>()},
        {"comment", comment},
    };
    feedback.put(record);
    std::cerr << "feedback tenant=" << tenant << " request=" << record["request_id"].get<std::string>()
              << " rating=" << record["rating"].get<int>() << "\\n";
    res.status = 201;
    res.set_content(record.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The rating is only meaningful when it is pinned to a request the tenant really served: the
served-requests lookup is what turns "a thumbs-down" into "a thumbs-down on *that* answer", and the
\`404\` is what stops a caller from inventing an id to stuff the dashboard. Making \`rating\` mandatory
removes the silent \`0\` that would otherwise inflate every satisfaction denominator, and the byte cap
on the comment keeps one row from dominating storage and the event pipeline. Keeping the comment out of
the log line matters because logs are retained longer and read by more people than the feedback table.

Real systems add a signed request id (or an HMAC) so a client cannot forge one even if it guesses the
format, and they write the rating and the served-request check in the same transaction so a request
cannot be evicted between the lookup and the insert.`,
};
