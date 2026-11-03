import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/feedback: a rating that must reference a served request',
  concept: 'http',
  file: 'api',
  focus: ['client', 'collector', 'redis'],
  task: `## Task

**Starting point.** \`api\` serves \`POST /v1/feedback\` on the provided \`feedback.store\`: it reads
\`X-Tenant-Id\` and \`X-User-Id\`, takes \`{request_id, rating, comment}\` from the body, stores the row
with \`store.insert_feedback\` under \`store.new_feedback_id()\`, logs it and answers
\`201 {feedback_id, request_id, rating}\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A rating lands on a request id the gateway did not serve to this tenant; a
body without a rating is stored as a neutral \`0\`; a comment of any size is accepted; and the comment
text ends up in the log, which is kept longer and read by more people than the feedback row.

- \`store.is_served(tenant, request_id)\` must hold before anything is stored; otherwise **404**.
- \`rating\` is required and in \`ALLOWED_RATINGS\` (\`-1\`, \`0\`, \`1\`); otherwise **400**.
- The comment is at most \`MAX_COMMENT_BYTES = 2 * 1024\` bytes of UTF-8; a larger one is **413**.
- The log line carries the tenant, the request id and the rating; no log call sees the comment.`,
  sequence: {
    participants: ['Client', 'feedbackd', 'feedback.store'],
    messages: [
      {
        from: 'Client',
        to: 'feedbackd',
        label: 'POST /v1/feedback · X-Tenant-Id, X-User-Id · {request_id, rating, comment}',
        kind: 'sync',
      },
      {
        from: 'feedbackd',
        to: 'feedbackd',
        label: 'rating in -1/0/1 → else 400 · comment ≤ 2 KiB → else 413',
        kind: 'sync',
      },
      {from: 'feedbackd', to: 'feedback.store', label: 'is_served(tenant, request_id) → else 404', kind: 'sync'},
      {from: 'feedbackd', to: 'feedback.store', label: 'insert_feedback(row)', kind: 'sync'},
      {from: 'feedbackd', to: 'Client', label: '201 {feedback_id, request_id, rating}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/feedback',
      detail:
        'A rating for a served request is stored with its tenant, user, request id and rating, and the answer is `201` with `feedback_id`, `request_id` and `rating`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/feedback["']/, /store\.insert_feedback\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/feedback['"]/, /insertFeedback\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/feedback"/, /store\.InsertFeedback\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"feedback"\s*\)/, /\bpost\s*\{/, /Store\.insertFeedback\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/feedback"/, /store::insertFeedback\(/]},
      },
    },
    {
      id: 'served-request',
      title: 'The request id must be one this tenant was served',
      detail:
        'The handler asks `is_served(tenant, request_id)` before it stores anything and answers `404` when the gateway did not serve that request to this tenant; the starter stores whatever id it is given.',
      match: {
        python: {all: [/store\.is_served\(/, /\b404\b/], order: [/store\.is_served\(/, /store\.insert_feedback\(/]},
        typescript: {all: [/isServed\(/, /\b404\b/], order: [/isServed\(/, /insertFeedback\(/]},
        go: {
          all: [/store\.IsServed\(/, /StatusNotFound|\b404\b/],
          order: [/store\.IsServed\(/, /store\.InsertFeedback\(/],
        },
        scala: {
          all: [/Store\.isServed\(/, /NotFound|\b404\b/],
          order: [/Store\.isServed\(/, /Store\.insertFeedback\(/],
        },
        cpp: {all: [/store::isServed\(/, /\b404\b/], order: [/store::isServed\(/, /store::insertFeedback\(/]},
      },
    },
    {
      id: 'rating',
      title: 'A rating is required and must be -1, 0 or 1',
      detail:
        'A body whose `rating` is missing or outside `ALLOWED_RATINGS` is `400`; the starter defaults a missing rating to `0`, so silence is counted as neutral.',
      match: {
        python: {all: [/ALLOWED_RATINGS/, /\b400\b/], none: [/rating:\s*int\s*=\s*0/]},
        typescript: {all: [/ALLOWED_RATINGS/, /\b400\b/], none: [/rating\s*\?\?\s*0/]},
        go: {all: [/allowedRatings/, /StatusBadRequest|\b400\b/], none: [/\bRating\s+int\b/]},
        scala: {all: [/AllowedRatings/, /BadRequest|\b400\b/], none: [/getOrElse\(\s*0\s*\)/]},
        cpp: {all: [/kAllowedRatings/, /\b400\b/], none: [/value\(\s*"rating",\s*0\s*\)/]},
      },
    },
    {
      id: 'comment-cap',
      title: 'The comment is capped at 2 KiB of UTF-8',
      detail:
        'The comment is measured in UTF-8 bytes against `MAX_COMMENT_BYTES` (2048) and a larger one is `413`; counting characters lets 1100 accented letters (2200 bytes) through.',
      match: {
        python: {all: [/MAX_COMMENT_BYTES\s*=\s*(2\s*\*\s*1024|2048)\b/, /\.encode\(/, /\b413\b/]},
        typescript: {
          all: [/MAX_COMMENT_BYTES\s*=\s*(2\s*\*\s*1024|2048)\b/, /TextEncoder|Buffer\.byteLength/, /\b413\b/],
        },
        go: {
          all: [/maxCommentBytes\s*=\s*(2\s*\*\s*1024|2048)\b/, /StatusRequestEntityTooLarge|\b413\b/],
          none: [/RuneCountInString/],
        },
        scala: {
          all: [
            /MaxCommentBytes\s*=\s*(2\s*\*\s*1024|2048)\b/,
            /getBytes/,
            /PayloadTooLarge|RequestEntityTooLarge|\b413\b/,
          ],
        },
        cpp: {all: [/kMaxCommentBytes\s*=\s*(2\s*\*\s*1024|2048)\b/, /\b413\b/]},
      },
    },
    {
      id: 'no-comment-log',
      title: 'Logs the decision, not the comment',
      detail:
        'The handler logs the tenant, the request id and the rating, and no log call carries the comment: logs are retained and shared far more widely than the feedback row.',
      match: {
        python: {all: [/logger\.\w+\(/], none: [/logger\.\w+\([^)]*comment/]},
        typescript: {all: [/console\.\w+\(/], none: [/console\.\w+\([^;]*comment/i]},
        go: {all: [/log\.Printf\(/], none: [/log\.\w+\([^\n]*[Cc]omment/]},
        scala: {all: [/System\.err\.println\(/], none: [/println\([^\n]*comment/]},
        cpp: {all: [/std::clog\s*<</], none: [/std::clog[^;]*comment/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from feedback import store  # is_served, new_feedback_id, insert_feedback

app = FastAPI()
logger = logging.getLogger("feedback")


class FeedbackBody(BaseModel):
    request_id: str
    rating: int = 0
    comment: str = ""


@app.post("/v1/feedback")
def submit_feedback(body: FeedbackBody, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    user_id = request.headers.get("x-user-id", "")
    if not tenant or not user_id:
        raise HTTPException(status_code=400, detail="X-Tenant-Id and X-User-Id are required")
    row = {
        "feedback_id": store.new_feedback_id(),
        "tenant": tenant,
        "user_id": user_id,
        "request_id": body.request_id,
        "rating": body.rating,
        "comment": body.comment,
    }
    store.insert_feedback(row)
    logger.info("feedback tenant=%s request=%s rating=%d comment=%r", tenant, body.request_id, body.rating, body.comment)
    return JSONResponse({"feedback_id": row["feedback_id"], "request_id": body.request_id, "rating": body.rating}, status_code=201)
`,
      solution: `import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from feedback import store  # is_served, new_feedback_id, insert_feedback

app = FastAPI()
logger = logging.getLogger("feedback")

ALLOWED_RATINGS = (-1, 0, 1)
MAX_COMMENT_BYTES = 2 * 1024


class FeedbackBody(BaseModel):
    request_id: str
    rating: int | None = None
    comment: str = ""


@app.post("/v1/feedback")
def submit_feedback(body: FeedbackBody, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    user_id = request.headers.get("x-user-id", "")
    if not tenant or not user_id:
        raise HTTPException(status_code=400, detail="X-Tenant-Id and X-User-Id are required")
    if body.rating not in ALLOWED_RATINGS:
        raise HTTPException(status_code=400, detail="rating is required: -1, 0 or 1")
    if len(body.comment.encode("utf-8")) > MAX_COMMENT_BYTES:
        raise HTTPException(status_code=413, detail="comment is larger than 2 KiB")
    if not store.is_served(tenant, body.request_id):
        raise HTTPException(status_code=404, detail="no such request for this tenant")
    row = {
        "feedback_id": store.new_feedback_id(),
        "tenant": tenant,
        "user_id": user_id,
        "request_id": body.request_id,
        "rating": body.rating,
        "comment": body.comment,
    }
    store.insert_feedback(row)
    logger.info("feedback tenant=%s request=%s rating=%d", tenant, body.request_id, body.rating)
    return JSONResponse({"feedback_id": row["feedback_id"], "request_id": body.request_id, "rating": body.rating}, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {insertFeedback, isServed, newFeedbackId} from 'feedback/store';

export const app = Fastify();

interface FeedbackBody {
  request_id: string;
  rating?: number;
  comment?: string;
}

app.post('/v1/feedback', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  const userId = request.headers['x-user-id'];
  if (typeof tenant !== 'string' || tenant === '' || typeof userId !== 'string' || userId === '') {
    return reply.code(400).send({error: 'X-Tenant-Id and X-User-Id are required'});
  }
  const body = request.body as FeedbackBody;
  const rating = body.rating ?? 0;
  const comment = body.comment ?? '';
  const feedbackId = await newFeedbackId();
  await insertFeedback({feedback_id: feedbackId, tenant, user_id: userId, request_id: body.request_id, rating, comment});
  console.log(\`feedback tenant=\${tenant} request=\${body.request_id} rating=\${rating} comment=\${JSON.stringify(comment)}\`);
  return reply.code(201).send({feedback_id: feedbackId, request_id: body.request_id, rating});
});

void isServed;
`,
      solution: `import Fastify from 'fastify';

import {insertFeedback, isServed, newFeedbackId} from 'feedback/store';

export const app = Fastify();

const ALLOWED_RATINGS = new Set([-1, 0, 1]);
const MAX_COMMENT_BYTES = 2 * 1024;

interface FeedbackBody {
  request_id: string;
  rating?: number;
  comment?: string;
}

app.post('/v1/feedback', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  const userId = request.headers['x-user-id'];
  if (typeof tenant !== 'string' || tenant === '' || typeof userId !== 'string' || userId === '') {
    return reply.code(400).send({error: 'X-Tenant-Id and X-User-Id are required'});
  }
  const body = request.body as FeedbackBody;
  const rating = body.rating;
  if (rating === undefined || !ALLOWED_RATINGS.has(rating)) return reply.code(400).send({error: 'rating is required: -1, 0 or 1'});
  const comment = body.comment ?? '';
  if (new TextEncoder().encode(comment).length > MAX_COMMENT_BYTES) return reply.code(413).send({error: 'comment is larger than 2 KiB'});
  if (!(await isServed(tenant, body.request_id))) return reply.code(404).send({error: 'no such request for this tenant'});
  const feedbackId = await newFeedbackId();
  await insertFeedback({feedback_id: feedbackId, tenant, user_id: userId, request_id: body.request_id, rating, comment});
  console.log(\`feedback tenant=\${tenant} request=\${body.request_id} rating=\${rating}\`);
  return reply.code(201).send({feedback_id: feedbackId, request_id: body.request_id, rating});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"feedback/store" // store.IsServed, NewFeedbackID, InsertFeedback
)

type feedbackBody struct {
	RequestID string \`json:"request_id"\`
	Rating    int    \`json:"rating"\`
	Comment   string \`json:"comment"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func submitFeedback(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	userID := r.Header.Get("X-User-Id")
	if tenant == "" || userID == "" {
		http.Error(rw, "X-Tenant-Id and X-User-Id are required", http.StatusBadRequest)
		return
	}
	var body feedbackBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "the body is not JSON", http.StatusBadRequest)
		return
	}
	id, err := store.NewFeedbackID(r.Context())
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	row := store.Feedback{FeedbackID: id, Tenant: tenant, UserID: userID, RequestID: body.RequestID, Rating: body.Rating, Comment: body.Comment}
	if err := store.InsertFeedback(r.Context(), row); err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	log.Printf("feedback tenant=%s request=%s rating=%d comment=%q", tenant, body.RequestID, body.Rating, body.Comment)
	writeJSON(rw, http.StatusCreated, map[string]any{"feedback_id": id, "request_id": body.RequestID, "rating": body.Rating})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/feedback", submitFeedback)
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"feedback/store" // store.IsServed, NewFeedbackID, InsertFeedback
)

const maxCommentBytes = 2 * 1024

var allowedRatings = map[int]bool{-1: true, 0: true, 1: true}

type feedbackBody struct {
	RequestID string \`json:"request_id"\`
	Rating    *int   \`json:"rating"\`
	Comment   string \`json:"comment"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func submitFeedback(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	userID := r.Header.Get("X-User-Id")
	if tenant == "" || userID == "" {
		http.Error(rw, "X-Tenant-Id and X-User-Id are required", http.StatusBadRequest)
		return
	}
	var body feedbackBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "the body is not JSON", http.StatusBadRequest)
		return
	}
	if body.Rating == nil || !allowedRatings[*body.Rating] {
		http.Error(rw, "rating is required: -1, 0 or 1", http.StatusBadRequest)
		return
	}
	if len(body.Comment) > maxCommentBytes { // len counts bytes
		http.Error(rw, "comment is larger than 2 KiB", http.StatusRequestEntityTooLarge)
		return
	}
	served, err := store.IsServed(r.Context(), tenant, body.RequestID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if !served {
		http.Error(rw, "no such request for this tenant", http.StatusNotFound)
		return
	}
	id, err := store.NewFeedbackID(r.Context())
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	rating := *body.Rating
	row := store.Feedback{FeedbackID: id, Tenant: tenant, UserID: userID, RequestID: body.RequestID, Rating: rating, Comment: body.Comment}
	if err := store.InsertFeedback(r.Context(), row); err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	log.Printf("feedback tenant=%s request=%s rating=%d", tenant, body.RequestID, rating)
	writeJSON(rw, http.StatusCreated, map[string]any{"feedback_id": id, "request_id": body.RequestID, "rating": rating})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/feedback", submitFeedback)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import feedback.Store // Store.isServed, newFeedbackId, insertFeedback

object Api {
  val route: Route = path("v1" / "feedback") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
        optionalHeaderValueByName("X-User-Id") { userHeader =>
          entity(as[String]) { raw =>
            // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
            val tenant = tenantHeader.getOrElse("")
            val userId = userHeader.getOrElse("")
            if (tenant.isEmpty || userId.isEmpty) complete(StatusCodes.BadRequest -> "X-Tenant-Id and X-User-Id are required")
            else {
              val body = raw.parseJson.asJsObject.fields
              val requestId = body.get("request_id").collect { case JsString(s) => s }.getOrElse("")
              val rating = body.get("rating").collect { case JsNumber(n) => n.toInt }.getOrElse(0)
              val comment = body.get("comment").collect { case JsString(s) => s }.getOrElse("")
              val row = Store.Feedback(Store.newFeedbackId(), tenant, userId, requestId, rating, comment)
              Store.insertFeedback(row)
              System.err.println(s"feedback tenant=$tenant request=$requestId rating=$rating comment=$comment")
              val answer = JsObject("feedback_id" -> JsString(row.feedbackId), "request_id" -> JsString(requestId), "rating" -> JsNumber(rating))
              complete(HttpResponse(StatusCodes.Created, entity = HttpEntity(ContentTypes.\`application/json\`, answer.compactPrint)))
            }
          }
        }
      }
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets.UTF_8

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import feedback.Store // Store.isServed, newFeedbackId, insertFeedback

object Api {
  val AllowedRatings: Set[Int] = Set(-1, 0, 1)
  val MaxCommentBytes = 2 * 1024

  val route: Route = path("v1" / "feedback") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
        optionalHeaderValueByName("X-User-Id") { userHeader =>
          entity(as[String]) { raw =>
            val tenant = tenantHeader.getOrElse("")
            val userId = userHeader.getOrElse("")
            val body = raw.parseJson.asJsObject.fields
            val requestId = body.get("request_id").collect { case JsString(s) => s }.getOrElse("")
            val rating = body.get("rating").collect { case JsNumber(n) if n.isValidInt => n.toInt }
            val comment = body.get("comment").collect { case JsString(s) => s }.getOrElse("")
            if (tenant.isEmpty || userId.isEmpty) complete(StatusCodes.BadRequest -> "X-Tenant-Id and X-User-Id are required")
            else if (!rating.exists(AllowedRatings.contains)) complete(StatusCodes.BadRequest -> "rating is required: -1, 0 or 1")
            else if (comment.getBytes(UTF_8).length > MaxCommentBytes) complete(StatusCodes.PayloadTooLarge -> "comment is larger than 2 KiB")
            else if (!Store.isServed(tenant, requestId)) complete(StatusCodes.NotFound -> "no such request for this tenant")
            else {
              val row = Store.Feedback(Store.newFeedbackId(), tenant, userId, requestId, rating.get, comment)
              Store.insertFeedback(row)
              System.err.println(s"feedback tenant=$tenant request=$requestId rating=\${row.rating}")
              val answer = JsObject("feedback_id" -> JsString(row.feedbackId), "request_id" -> JsString(requestId), "rating" -> JsNumber(row.rating))
              complete(HttpResponse(StatusCodes.Created, entity = HttpEntity(ContentTypes.\`application/json\`, answer.compactPrint)))
            }
          }
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

#include <iostream>
#include <string>

#include "feedback/store.h"  // store::isServed, newFeedbackId, insertFeedback

using json = nlohmann::json;

void submit_feedback(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const std::string user_id = req.get_header_value("X-User-Id");
  const json body = json::parse(req.body, nullptr, false);
  if (tenant.empty() || user_id.empty() || !body.is_object()) {
    res.status = 400;
    res.set_content("X-Tenant-Id, X-User-Id and a JSON body are required", "text/plain");
    return;
  }
  const std::string request_id = body.value("request_id", "");
  const int rating = body.value("rating", 0);
  const std::string comment = body.value("comment", "");
  const store::Feedback row{store::newFeedbackId(), tenant, user_id, request_id, rating, comment};
  store::insertFeedback(row);
  std::clog << "feedback tenant=" << tenant << " request=" << request_id << " rating=" << rating << " comment=" << comment << "\\n";
  res.status = 201;
  res.set_content(json{{"feedback_id", row.feedback_id}, {"request_id", request_id}, {"rating", rating}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/feedback", submit_feedback); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <set>
#include <string>

#include "feedback/store.h"  // store::isServed, newFeedbackId, insertFeedback

using json = nlohmann::json;

const std::set<int> kAllowedRatings = {-1, 0, 1};
constexpr size_t kMaxCommentBytes = 2 * 1024;

void reject(httplib::Response& res, int status, const std::string& why) {
  res.status = status;
  res.set_content(why, "text/plain");
}

void submit_feedback(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const std::string user_id = req.get_header_value("X-User-Id");
  const json body = json::parse(req.body, nullptr, false);
  if (tenant.empty() || user_id.empty() || !body.is_object()) return reject(res, 400, "X-Tenant-Id, X-User-Id and a JSON body are required");
  const auto rating = body.find("rating");
  if (rating == body.end() || !rating->is_number_integer() || !kAllowedRatings.count(rating->get<int>())) {
    return reject(res, 400, "rating is required: -1, 0 or 1");
  }
  const std::string request_id = body.value("request_id", "");
  const std::string comment = body.value("comment", "");
  if (comment.size() > kMaxCommentBytes) return reject(res, 413, "comment is larger than 2 KiB");  // size() counts bytes
  if (!store::isServed(tenant, request_id)) return reject(res, 404, "no such request for this tenant");
  const store::Feedback row{store::newFeedbackId(), tenant, user_id, request_id, rating->get<int>(), comment};
  store::insertFeedback(row);
  std::clog << "feedback tenant=" << tenant << " request=" << request_id << " rating=" << row.rating << "\\n";
  res.status = 201;
  res.set_content(json{{"feedback_id", row.feedback_id}, {"request_id", request_id}, {"rating", row.rating}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/feedback", submit_feedback); }
`,
    },
  },
  harness: {
    python: `import logging

from feedback import store

HEADERS = {"X-Tenant-Id": "t-acme", "X-User-Id": "u-1"}
SECRET = "my card ending 4417 was charged twice"


class _Capture(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _post(c, body):
    return await c.post("/v1/feedback", json=body, headers=HEADERS)


def _rows(ctx):
    return sorted(ctx.redis.keys("feedback:fb-*"))


async def check_route(ctx):
    store.mark_served("t-acme", "req-1")
    async with _api(ctx) as c:
        r = await _post(c, {"request_id": "req-1", "rating": 1, "comment": "clear answer"})
    assert r.status_code == 201, f"POST /v1/feedback for a served request answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("feedback_id") and body.get("request_id") == "req-1" and body.get("rating") == 1, f"the 201 must carry feedback_id, request_id and rating, got {body}"
    row = store.get_feedback(body["feedback_id"])
    assert row is not None, f"no row feedback:{body['feedback_id']} was stored"
    got = (row["tenant"], row["user_id"], row["request_id"], row["rating"])
    assert got == ("t-acme", "u-1", "req-1", 1), f"the stored row is {row}, expected tenant t-acme, user u-1, request req-1, rating 1"


async def check_served_request(ctx):
    store.mark_served("t-acme", "req-1")
    store.mark_served("t-other", "req-9")
    async with _api(ctx) as c:
        unknown = await _post(c, {"request_id": "req-404", "rating": 1})
        foreign = await _post(c, {"request_id": "req-9", "rating": -1})
        known = await _post(c, {"request_id": "req-1", "rating": 1})
    assert unknown.status_code == 404, f"a rating for a request id nobody served answered {unknown.status_code}, expected 404"
    assert foreign.status_code == 404, f"a rating for a request served to another tenant answered {foreign.status_code}, expected 404: the lookup is per tenant"
    assert known.status_code == 201, f"a rating for a served request answered {known.status_code}: {known.text}"
    assert len(_rows(ctx)) == 1, f"the store holds {_rows(ctx)}, expected only the row for the served request: a rejected rating must not be stored"


async def check_rating(ctx):
    store.mark_served("t-acme", "req-1")
    async with _api(ctx) as c:
        missing = await _post(c, {"request_id": "req-1", "comment": "meh"})
        out_of_range = await _post(c, {"request_id": "req-1", "rating": 5})
        down = await _post(c, {"request_id": "req-1", "rating": -1})
    assert missing.status_code == 400, f"a body without a rating answered {missing.status_code}, expected 400: a missing rating is not a neutral one"
    assert out_of_range.status_code == 400, f"rating 5 answered {out_of_range.status_code}, expected 400: ratings are -1, 0 or 1"
    assert down.status_code == 201, f"rating -1 answered {down.status_code}: {down.text}"
    row = store.get_feedback(down.json()["feedback_id"])
    assert row is not None and row["rating"] == -1, f"the thumbs-down was stored as {row}"
    assert len(_rows(ctx)) == 1, f"the store holds {_rows(ctx)}: only the valid rating may be stored"


async def check_comment_cap(ctx):
    store.mark_served("t-acme", "req-1")
    async with _api(ctx) as c:
        fits = await _post(c, {"request_id": "req-1", "rating": 0, "comment": "é" * 1000})
        accented = await _post(c, {"request_id": "req-1", "rating": 0, "comment": "é" * 1100})
        ascii_ = await _post(c, {"request_id": "req-1", "rating": 0, "comment": "x" * 2049})
    assert fits.status_code == 201, f"a 2000-byte comment answered {fits.status_code}, expected 201: {fits.text}"
    assert accented.status_code == 413, f"a 2200-byte comment (1100 characters) answered {accented.status_code}, expected 413: the cap is 2 KiB of UTF-8, not 2048 characters"
    assert ascii_.status_code == 413, f"a 2049-byte comment answered {ascii_.status_code}, expected 413"
    assert len(_rows(ctx)) == 1, f"the store holds {_rows(ctx)}: an oversized comment must not be stored"


async def check_no_comment_log(ctx):
    store.mark_served("t-acme", "req-1")
    capture = _Capture()
    root = logging.getLogger()
    level = root.level
    root.addHandler(capture)
    root.setLevel(logging.DEBUG)
    try:
        async with _api(ctx) as c:
            r = await _post(c, {"request_id": "req-1", "rating": -1, "comment": SECRET})
    finally:
        root.removeHandler(capture)
        root.setLevel(level)
    assert r.status_code == 201, f"POST /v1/feedback answered {r.status_code}: {r.text}"
    assert any("req-1" in line for line in capture.lines), f"the handler must log the decision with the request id; the log holds {capture.lines}"
    leaked = [line for line in capture.lines if "4417" in line or "charged twice" in line]
    assert not leaked, f"the comment text reached the log: {leaked[0]!r}. Log the tenant, the request id and the rating only"
`,
    typescript: `const HEADERS = {'X-Tenant-Id': 't-acme', 'X-User-Id': 'u-1'};
const SECRET = 'my card ending 4417 was charged twice';

function api(ctx) {
  const m = ctx.load('api');
  return {c: ctx.client(m.app), store: ctx.load('/support/feedback/store.ts')};
}

const post = (c, body) => c.post('/v1/feedback', {json: body, headers: HEADERS});
const rows = (ctx): string[] => ctx.redis.keys('feedback:fb-*').sort();

/** Runs fn with console output captured; returns the lines. */
async function captured(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const saved = {log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug};
  const take = (...args: unknown[]): void => void lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.log = console.info = console.warn = console.error = console.debug = take;
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines;
}

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  await store.markServed('t-acme', 'req-1');
  const r = await post(c, {request_id: 'req-1', rating: 1, comment: 'clear answer'});
  assert.equal(r.status, 201, \`POST /v1/feedback for a served request answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.feedback_id && body.request_id === 'req-1' && body.rating === 1, \`the 201 must carry feedback_id, request_id and rating, got \${r.text}\`);
  const row = await store.getFeedback(body.feedback_id);
  assert(row !== null, \`no row feedback:\${body.feedback_id} was stored\`);
  assert.deepEqual([row.tenant, row.user_id, row.request_id, row.rating], ['t-acme', 'u-1', 'req-1', 1], \`the stored row is \${JSON.stringify(row)}\`);
}

export async function check_served_request(ctx) {
  const {c, store} = api(ctx);
  await store.markServed('t-acme', 'req-1');
  await store.markServed('t-other', 'req-9');
  const unknown = await post(c, {request_id: 'req-404', rating: 1});
  const foreign = await post(c, {request_id: 'req-9', rating: -1});
  const known = await post(c, {request_id: 'req-1', rating: 1});
  assert.equal(unknown.status, 404, \`a rating for a request id nobody served answered \${unknown.status}, expected 404\`);
  assert.equal(foreign.status, 404, \`a rating for a request served to another tenant answered \${foreign.status}, expected 404: the lookup is per tenant\`);
  assert.equal(known.status, 201, \`a rating for a served request answered \${known.status}: \${known.text}\`);
  assert.equal(rows(ctx).length, 1, \`the store holds \${JSON.stringify(rows(ctx))}, expected only the row for the served request: a rejected rating must not be stored\`);
}

export async function check_rating(ctx) {
  const {c, store} = api(ctx);
  await store.markServed('t-acme', 'req-1');
  const missing = await post(c, {request_id: 'req-1', comment: 'meh'});
  const outOfRange = await post(c, {request_id: 'req-1', rating: 5});
  const down = await post(c, {request_id: 'req-1', rating: -1});
  assert.equal(missing.status, 400, \`a body without a rating answered \${missing.status}, expected 400: a missing rating is not a neutral one\`);
  assert.equal(outOfRange.status, 400, \`rating 5 answered \${outOfRange.status}, expected 400: ratings are -1, 0 or 1\`);
  assert.equal(down.status, 201, \`rating -1 answered \${down.status}: \${down.text}\`);
  const row = await store.getFeedback(down.json().feedback_id);
  assert(row !== null && row.rating === -1, \`the thumbs-down was stored as \${JSON.stringify(row)}\`);
  assert.equal(rows(ctx).length, 1, \`the store holds \${JSON.stringify(rows(ctx))}: only the valid rating may be stored\`);
}

export async function check_comment_cap(ctx) {
  const {c, store} = api(ctx);
  await store.markServed('t-acme', 'req-1');
  const fits = await post(c, {request_id: 'req-1', rating: 0, comment: 'é'.repeat(1000)});
  const accented = await post(c, {request_id: 'req-1', rating: 0, comment: 'é'.repeat(1100)});
  const ascii = await post(c, {request_id: 'req-1', rating: 0, comment: 'x'.repeat(2049)});
  assert.equal(fits.status, 201, \`a 2000-byte comment answered \${fits.status}, expected 201: \${fits.text}\`);
  assert.equal(accented.status, 413, \`a 2200-byte comment (1100 characters) answered \${accented.status}, expected 413: the cap is 2 KiB of UTF-8, not 2048 characters\`);
  assert.equal(ascii.status, 413, \`a 2049-byte comment answered \${ascii.status}, expected 413\`);
  assert.equal(rows(ctx).length, 1, \`the store holds \${JSON.stringify(rows(ctx))}: an oversized comment must not be stored\`);
}

export async function check_no_comment_log(ctx) {
  const {c, store} = api(ctx);
  await store.markServed('t-acme', 'req-1');
  let r;
  const lines = await captured(async () => {
    r = await post(c, {request_id: 'req-1', rating: -1, comment: SECRET});
  });
  assert.equal(r.status, 201, \`POST /v1/feedback answered \${r.status}: \${r.text}\`);
  assert(lines.some(line => line.includes('req-1')), \`the handler must log the decision with the request id; the log holds \${JSON.stringify(lines)}\`);
  const leaked = lines.filter(line => line.includes('4417') || line.includes('charged twice'));
  assert.equal(leaked.length, 0, \`the comment text reached the log: \${JSON.stringify(leaked[0])}. Log the tenant, the request id and the rating only\`);
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"os"
	"strings"

	"feedback/store"

	"leetbuild/harness"
)

var apiBg = context.Background()

const apiSecret = "my card ending 4417 was charged twice"

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func postFeedback(c *harness.HTTP, body map[string]any) *harness.Response {
	return c.Post("/v1/feedback", body, "X-Tenant-Id", "t-acme", "X-User-Id", "u-1")
}

func feedbackID(ctx *harness.Ctx, r *harness.Response) string {
	var body struct {
		FeedbackID string \`json:"feedback_id"\`
	}
	r.Decode(&body)
	return body.FeedbackID
}

func CheckRoute(ctx *harness.Ctx) {
	store.MarkServed(apiBg, "t-acme", "req-1", 0)
	r := postFeedback(api(ctx), map[string]any{"request_id": "req-1", "rating": 1, "comment": "clear answer"})
	ctx.Equal(r.Status, 201, "POST /v1/feedback for a served request (%s)", r.Text())
	var body struct {
		FeedbackID string \`json:"feedback_id"\`
		RequestID  string \`json:"request_id"\`
		Rating     int    \`json:"rating"\`
	}
	r.Decode(&body)
	ctx.Assert(body.FeedbackID != "" && body.RequestID == "req-1" && body.Rating == 1, "the 201 must carry feedback_id, request_id and rating, got %s", r.Text())
	row := store.GetFeedback(apiBg, body.FeedbackID)
	ctx.Assert(row != nil, "no row feedback:%s was stored", body.FeedbackID)
	ctx.Equal([]any{row.Tenant, row.UserID, row.RequestID, row.Rating}, []any{"t-acme", "u-1", "req-1", 1}, "the stored row (tenant, user, request, rating)")
}

func CheckServedRequest(ctx *harness.Ctx) {
	store.MarkServed(apiBg, "t-acme", "req-1", 0)
	store.MarkServed(apiBg, "t-other", "req-9", 0)
	c := api(ctx)
	unknown := postFeedback(c, map[string]any{"request_id": "req-404", "rating": 1})
	foreign := postFeedback(c, map[string]any{"request_id": "req-9", "rating": -1})
	known := postFeedback(c, map[string]any{"request_id": "req-1", "rating": 1})
	ctx.Equal(unknown.Status, 404, "a rating for a request id nobody served")
	ctx.Equal(foreign.Status, 404, "a rating for a request served to another tenant (the lookup is per tenant)")
	ctx.Equal(known.Status, 201, "a rating for a served request (%s)", known.Text())
	ctx.Equal(len(ctx.Redis.Keys("feedback:fb-*")), 1, "a rejected rating must not be stored; the rows %q", ctx.Redis.Keys("feedback:fb-*"))
}

func CheckRating(ctx *harness.Ctx) {
	store.MarkServed(apiBg, "t-acme", "req-1", 0)
	c := api(ctx)
	missing := postFeedback(c, map[string]any{"request_id": "req-1", "comment": "meh"})
	outOfRange := postFeedback(c, map[string]any{"request_id": "req-1", "rating": 5})
	down := postFeedback(c, map[string]any{"request_id": "req-1", "rating": -1})
	ctx.Equal(missing.Status, 400, "a body without a rating (a missing rating is not a neutral one)")
	ctx.Equal(outOfRange.Status, 400, "rating 5 (ratings are -1, 0 or 1)")
	ctx.Equal(down.Status, 201, "rating -1 (%s)", down.Text())
	row := store.GetFeedback(apiBg, feedbackID(ctx, down))
	ctx.Assert(row != nil && row.Rating == -1, "the thumbs-down was stored as %+v", row)
	ctx.Equal(len(ctx.Redis.Keys("feedback:fb-*")), 1, "only the valid rating may be stored; the rows %q", ctx.Redis.Keys("feedback:fb-*"))
}

func CheckCommentCap(ctx *harness.Ctx) {
	store.MarkServed(apiBg, "t-acme", "req-1", 0)
	c := api(ctx)
	fits := postFeedback(c, map[string]any{"request_id": "req-1", "rating": 0, "comment": strings.Repeat("é", 1000)})
	accented := postFeedback(c, map[string]any{"request_id": "req-1", "rating": 0, "comment": strings.Repeat("é", 1100)})
	ascii := postFeedback(c, map[string]any{"request_id": "req-1", "rating": 0, "comment": strings.Repeat("x", 2049)})
	ctx.Equal(fits.Status, 201, "a 2000-byte comment (%s)", fits.Text())
	ctx.Equal(accented.Status, 413, "a 2200-byte comment of 1100 characters (the cap is 2 KiB of UTF-8, not 2048 characters)")
	ctx.Equal(ascii.Status, 413, "a 2049-byte comment")
	ctx.Equal(len(ctx.Redis.Keys("feedback:fb-*")), 1, "an oversized comment must not be stored; the rows %q", ctx.Redis.Keys("feedback:fb-*"))
}

func CheckNoCommentLog(ctx *harness.Ctx) {
	store.MarkServed(apiBg, "t-acme", "req-1", 0)
	c := api(ctx)
	var buf bytes.Buffer
	log.SetOutput(&buf)
	r := postFeedback(c, map[string]any{"request_id": "req-1", "rating": -1, "comment": apiSecret})
	log.SetOutput(os.Stderr)
	logged := buf.String()
	ctx.Equal(r.Status, 201, "POST /v1/feedback (%s)", r.Text())
	ctx.Assert(strings.Contains(logged, "req-1"), "the handler must log the decision with the request id; the log holds %q", logged)
	ctx.Assert(!strings.Contains(logged, "4417") && !strings.Contains(logged, "charged twice"), "the comment text reached the log: %q. Log the tenant, the request id and the rating only", logged)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <iostream>
#include <sstream>
#include <string>

namespace {

const std::string kSecret = "my card ending 4417 was charged twice";

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response postFeedback(harness::HTTP& c, const nlohmann::json& body) {
  return c.Post("/v1/feedback", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", "t-acme", "X-User-Id", "u-1");
}

std::string repeat(const std::string& s, int n) {
  std::string out;
  for (int i = 0; i < n; i++) out += s;
  return out;
}

std::string feedbackId(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body.value("feedback_id", "") : "";
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  store::markServed("t-acme", "req-1");
  auto c = api(ctx);
  const auto r = postFeedback(c, {{"request_id", "req-1"}, {"rating", 1}, {"comment", "clear answer"}});
  ctx.Equal(r.Status, 201, "POST /v1/feedback for a served request (%s)", r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object() && !body.value("feedback_id", "").empty() && body.value("request_id", "") == "req-1" && body.value("rating", 0) == 1,
             "the 201 must carry feedback_id, request_id and rating, got %s", r.Text());
  const auto row = store::getFeedback(body.value("feedback_id", ""));
  ctx.Assert(row.has_value(), "no row feedback:%s was stored", body.value("feedback_id", ""));
  ctx.Assert(row->tenant == "t-acme" && row->user_id == "u-1" && row->request_id == "req-1" && row->rating == 1,
             "the stored row is tenant %q user %q request %q rating %d, expected t-acme, u-1, req-1, 1", row->tenant, row->user_id, row->request_id, row->rating);
}

void CheckServedRequest(harness::Ctx& ctx) {
  store::markServed("t-acme", "req-1");
  store::markServed("t-other", "req-9");
  auto c = api(ctx);
  const auto unknown = postFeedback(c, {{"request_id", "req-404"}, {"rating", 1}});
  const auto foreign = postFeedback(c, {{"request_id", "req-9"}, {"rating", -1}});
  const auto known = postFeedback(c, {{"request_id", "req-1"}, {"rating", 1}});
  ctx.Equal(unknown.Status, 404, "a rating for a request id nobody served");
  ctx.Equal(foreign.Status, 404, "a rating for a request served to another tenant (the lookup is per tenant)");
  ctx.Equal(known.Status, 201, "a rating for a served request (%s)", known.Text());
  ctx.Equal(ctx.Redis.Keys("feedback:fb-*").size(), 1, "a rejected rating must not be stored; the rows %q", ctx.Redis.Keys("feedback:fb-*"));
}

void CheckRating(harness::Ctx& ctx) {
  store::markServed("t-acme", "req-1");
  auto c = api(ctx);
  const auto missing = postFeedback(c, {{"request_id", "req-1"}, {"comment", "meh"}});
  const auto out_of_range = postFeedback(c, {{"request_id", "req-1"}, {"rating", 5}});
  const auto down = postFeedback(c, {{"request_id", "req-1"}, {"rating", -1}});
  ctx.Equal(missing.Status, 400, "a body without a rating (a missing rating is not a neutral one)");
  ctx.Equal(out_of_range.Status, 400, "rating 5 (ratings are -1, 0 or 1)");
  ctx.Equal(down.Status, 201, "rating -1 (%s)", down.Text());
  const auto row = store::getFeedback(feedbackId(down));
  ctx.Assert(row && row->rating == -1, "the thumbs-down was stored with rating %d", row ? row->rating : 99);
  ctx.Equal(ctx.Redis.Keys("feedback:fb-*").size(), 1, "only the valid rating may be stored; the rows %q", ctx.Redis.Keys("feedback:fb-*"));
}

void CheckCommentCap(harness::Ctx& ctx) {
  store::markServed("t-acme", "req-1");
  auto c = api(ctx);
  const auto fits = postFeedback(c, {{"request_id", "req-1"}, {"rating", 0}, {"comment", repeat("é", 1000)}});
  const auto accented = postFeedback(c, {{"request_id", "req-1"}, {"rating", 0}, {"comment", repeat("é", 1100)}});
  const auto ascii = postFeedback(c, {{"request_id", "req-1"}, {"rating", 0}, {"comment", repeat("x", 2049)}});
  ctx.Equal(fits.Status, 201, "a 2000-byte comment (%s)", fits.Text());
  ctx.Equal(accented.Status, 413, "a 2200-byte comment of 1100 characters (the cap is 2 KiB of UTF-8, not 2048 characters)");
  ctx.Equal(ascii.Status, 413, "a 2049-byte comment");
  ctx.Equal(ctx.Redis.Keys("feedback:fb-*").size(), 1, "an oversized comment must not be stored; the rows %q", ctx.Redis.Keys("feedback:fb-*"));
}

void CheckNoCommentLog(harness::Ctx& ctx) {
  store::markServed("t-acme", "req-1");
  auto c = api(ctx);
  std::ostringstream buf;
  std::streambuf* clog_was = std::clog.rdbuf(buf.rdbuf());
  std::streambuf* cerr_was = std::cerr.rdbuf(buf.rdbuf());
  std::streambuf* cout_was = std::cout.rdbuf(buf.rdbuf());
  harness::Response r;
  try {
    r = postFeedback(c, {{"request_id", "req-1"}, {"rating", -1}, {"comment", kSecret}});
  } catch (...) {
    std::clog.rdbuf(clog_was);
    std::cerr.rdbuf(cerr_was);
    std::cout.rdbuf(cout_was);
    throw;
  }
  std::clog.rdbuf(clog_was);
  std::cerr.rdbuf(cerr_was);
  std::cout.rdbuf(cout_was);
  const std::string logged = buf.str();
  ctx.Equal(r.Status, 201, "POST /v1/feedback (%s)", r.Text());
  ctx.Assert(logged.find("req-1") != std::string::npos, "the handler must log the decision with the request id; the log holds %q", logged);
  ctx.Assert(logged.find("4417") == std::string::npos && logged.find("charged twice") == std::string::npos,
             "the comment text reached the log: %q. Log the tenant, the request id and the rating only", logged);
}
`,
  },
  hints: [
    'Rate a request id nobody served, or post a body with no rating: both come back 201, and the second shows up on the dashboard as a neutral vote.',
    'The handler copies whatever the body holds: nothing looks the request id up, the missing rating falls to the `0` default, nothing measures the comment, and the log line formats the comment in.',
    'Check `rating in ALLOWED_RATINGS` (400), `len(comment.encode("utf-8")) > MAX_COMMENT_BYTES` (413) and `store.is_served(tenant, request_id)` (404) before `insert_feedback`, and drop the comment from the log call.',
  ],
  debrief: `Every guard runs before the write because a rejected rating must leave nothing behind: the request id is the join key between a vote and the model that answered, and a row that points nowhere poisons the score. The lookup is per tenant so one customer cannot rate another's traffic by guessing ids. The cap is in bytes because storage, Kafka and log pipelines all count bytes; 2048 characters of accented text is twice that. The comment stays out of the log because logs are shipped and indexed with none of the row's access control. Production collectors also bound how long after serving a rating is accepted, rate-limit per user, and redact or classify comments before anything downstream reads them.`,
};
