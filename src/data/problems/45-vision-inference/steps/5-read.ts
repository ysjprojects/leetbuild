import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/inferences/{id}: a result with a shelf life',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Starting point.** The starter registers \`GET /v1/inferences/{id}\`, looks the row up by id with
no tenant header, substitutes a \`{"status": "complete", "label": null}\` row when nothing is found,
and returns whatever it has with 200. It serves the demo and hides four flaws.

**Failure mode the checks target.** Any row is served to any caller, so one tenant reads another's
predictions by guessing an id. Nothing expires, so the table becomes a silent training set of tenant
data nobody asked to retain. And a row the worker is still writing goes out with a 200, which a cache
in front of the service then stores as the finished answer.

Requirements:

- The tenant comes from \`X-Tenant-Id\` (**401** when missing) and the record is checked against it:
  an inference id that belongs to another tenant is **404**, exactly like an id that does not exist,
  so a foreign id is not confirmed as real.
- The response carries the stored prediction, its **model version** and its **confidence**.
- **Results expire after \`RESULT_TTL_DAYS = 30\` days**: an older result is **410 Gone**, but the
  metadata that records *that a decision was made* (id, digest, created-at, and
  \`METADATA_TTL_DAYS\`) is still returned, so an audit can answer "was there a prediction for this
  image?" long after the prediction itself is gone.
- A **non-terminal** inference, one the worker is still writing, answers **202 Accepted** with the
  pending status instead of being returned as final.`,
  sequence: {
    participants: ['Client', 'Vision API', 'Results store'],
    messages: [
      {from: 'Client', to: 'Vision API', label: 'GET /v1/inferences/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Vision API', to: 'Results store', label: 'get(id)', kind: 'sync'},
      {from: 'Results store', to: 'Vision API', label: 'row · tenant_id · status · created_at', kind: 'reply'},
      {from: 'Vision API', to: 'Vision API', label: 'tenant mismatch → 404 · pending → 202', kind: 'sync'},
      {from: 'Vision API', to: 'Vision API', label: 'older than 30 days → 410 + metadata', kind: 'sync'},
      {from: 'Vision API', to: 'Client', label: '200 {label, model_version, confidence}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/inferences/{id}',
      detail: 'Register the read route on `GET /v1/inferences/{id}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/inferences\/\{inference_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/inferences\/:id['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/inferences\/\{id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"inferences"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/inferences\/:id"/]},
      },
    },
    {
      id: 'tenant-scope',
      title: "A foreign id is 404, not someone else's result",
      detail:
        "The record's tenant is compared with the authenticated caller and a mismatch is **404**, indistinguishable from a missing id. The starter returns whichever row the id names.",
      match: {
        python: {all: [/status_code\s*=\s*404/, /tenant/]},
        typescript: {all: [/code\(\s*404\s*\)/, /tenant/]},
        go: {all: [/StatusNotFound/, /tenant/]},
        scala: {all: [/StatusCodes\.NotFound/, /tenant/]},
        cpp: {all: [/\b404\b/, /tenant/]},
      },
    },
    {
      id: 'result-ttl',
      title: 'Expires results at 30 days and keeps metadata longer',
      detail:
        '`RESULT_TTL_DAYS = 30` bounds the prediction and `METADATA_TTL_DAYS` is the separate, longer budget for the audit metadata. The starter keeps every row forever.',
      match: {
        python: {all: [/RESULT_TTL_DAYS\s*=\s*30/, /METADATA_TTL_DAYS/]},
        typescript: {all: [/RESULT_TTL_DAYS\s*=\s*30/, /METADATA_TTL_DAYS/]},
        go: {all: [/resultTTLDays\s*=\s*30/, /metadataTTLDays/]},
        scala: {all: [/ResultTtlDays\s*=\s*30/, /MetadataTtlDays/]},
        cpp: {all: [/kResultTtlDays\s*=\s*30/, /kMetadataTtlDays/]},
      },
    },
    {
      id: 'expired-gone',
      title: 'An expired result is 410 with its metadata',
      detail:
        'A result older than the result TTL answers **410 Gone** and still returns the metadata that proves a decision was made (id, digest, created-at, the metadata TTL). The starter expires nothing.',
      match: {
        python: {all: [/status_code\s*=\s*410/, /metadata/]},
        typescript: {all: [/code\(\s*410\s*\)/, /metadata/]},
        go: {all: [/StatusGone/, /metadata/]},
        scala: {all: [/StatusCodes\.Gone/, /metadata/]},
        cpp: {all: [/\b410\b/, /metadata/]},
      },
    },
    {
      id: 'terminal',
      title: 'A pending inference is 202, not a final result',
      detail:
        'An inference the worker has not finished answers **202 Accepted** with the pending status instead of a 200 that looks like a prediction. The starter returns the half-written row as final.',
      match: {
        python: {all: [/PENDING/, /status_code\s*=\s*202/]},
        typescript: {all: [/PENDING/, /code\(\s*202\s*\)/]},
        go: {all: [/statusPending/, /StatusAccepted/]},
        scala: {all: [/Pending/, /StatusCodes\.Accepted/]},
        cpp: {all: [/kPending/, /\b202\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""GET /v1/inferences/{id}."""
from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()


class InferenceStore:
    def get(self, inference_id: str) -> dict | None:
        """The stored row, whatever tenant it belongs to."""
        raise NotImplementedError


store = InferenceStore()


@app.get("/v1/inferences/{inference_id}")
def read_inference(inference_id: str) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    record = store.get(inference_id) or {"id": inference_id, "status": "complete", "label": None}
    return JSONResponse(record, status_code=200)
`,
      solution: `"""GET /v1/inferences/{id}: a stored result with a shelf life and a tenant scope."""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()

RESULT_TTL_DAYS = 30
METADATA_TTL_DAYS = 365
PENDING = "pending"


@dataclass
class InferenceRecord:
    id: str
    tenant_id: str
    status: str
    digest: str
    created_at: datetime
    label: str | None = None
    confidence: float | None = None
    model_version: str | None = None


class InferenceStore:
    def get(self, inference_id: str) -> InferenceRecord | None:
        """The row for \`inference_id\`, whatever tenant it belongs to."""
        raise NotImplementedError


store = InferenceStore()


@app.get("/v1/inferences/{inference_id}")
def read_inference(
    inference_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    record = store.get(inference_id)
    if record is None or record.tenant_id != tenant:
        # A foreign id is indistinguishable from a missing one: never confirm another tenant's id.
        raise HTTPException(status_code=404, detail="unknown inference")

    if datetime.now(timezone.utc) - record.created_at > timedelta(days=RESULT_TTL_DAYS):
        # The prediction is gone; the metadata that proves a decision was made is not.
        return JSONResponse(
            {
                "id": record.id,
                "status": "expired",
                "digest": record.digest,
                "created_at": record.created_at.isoformat(),
                "metadata_ttl_days": METADATA_TTL_DAYS,
            },
            status_code=410,
        )

    if record.status == PENDING:
        return JSONResponse(
            {"id": record.id, "status": PENDING, "digest": record.digest},
            status_code=202,
        )

    return JSONResponse(
        {
            "id": record.id,
            "status": record.status,
            "label": record.label,
            "confidence": record.confidence,
            "model_version": record.model_version,
            "digest": record.digest,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/inferences/:id. */
import Fastify from 'fastify';

export const app = Fastify();

interface StoredRow {
  id: string;
  tenant_id: string;
  status: string;
  [key: string]: unknown;
}

app.get('/v1/inferences/:id', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {id} = request.params as {id: string};
  const record: StoredRow | null = await store.get(id);
  return reply.code(200).send(record ?? {id, status: 'complete', label: null});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/inferences/:id: a stored result with a shelf life and a tenant scope. */
import Fastify from 'fastify';

import {store, type InferenceRecord} from './store';

export const app = Fastify();

const RESULT_TTL_DAYS = 30;
const METADATA_TTL_DAYS = 365;
const PENDING = 'pending';

app.get('/v1/inferences/:id', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {id} = request.params as {id: string};
  const record: InferenceRecord | null = await store.get(id);
  if (record === null || record.tenant_id !== tenant)
    // A foreign id is indistinguishable from a missing one: never confirm another tenant's id.
    return reply.code(404).send({error: 'unknown inference'});

  const ageDays = (Date.now() - Date.parse(record.created_at)) / 86_400_000;
  if (ageDays > RESULT_TTL_DAYS)
    // The prediction is gone; the metadata that proves a decision was made is not.
    return reply.code(410).send({
      id: record.id,
      status: 'expired',
      digest: record.digest,
      created_at: record.created_at,
      metadata_ttl_days: METADATA_TTL_DAYS,
    });

  if (record.status === PENDING)
    return reply.code(202).send({id: record.id, status: PENDING, digest: record.digest});

  return reply.code(200).send({
    id: record.id,
    status: record.status,
    label: record.label,
    confidence: record.confidence,
    model_version: record.model_version,
    digest: record.digest,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readInference(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	record, _ := store.Get(r.PathValue("id"))
	if record == nil {
		writeJSON(rw, http.StatusOK, map[string]any{"id": r.PathValue("id"), "status": "complete"})
		return
	}
	writeJSON(rw, http.StatusOK, record)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/inferences/{id}", readInference)
	_ = mux
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"time"
)

const (
	resultTTLDays   = 30
	metadataTTLDays = 365
	statusPending   = "pending"
)

type InferenceRecord struct {
	ID           string    \`json:"id"\`
	TenantID     string    \`json:"tenant_id"\`
	Status       string    \`json:"status"\`
	Digest       string    \`json:"digest"\`
	CreatedAt    time.Time \`json:"created_at"\`
	Label        string    \`json:"label,omitempty"\`
	Confidence   float64   \`json:"confidence,omitempty"\`
	ModelVersion string    \`json:"model_version,omitempty"\`
}

type InferenceStore struct{}

func (s *InferenceStore) Get(id string) (*InferenceRecord, error) { return nil, nil }

var store = &InferenceStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readInference(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	record, err := store.Get(r.PathValue("id"))
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if record == nil || record.TenantID != tenant {
		// A foreign id is indistinguishable from a missing one: never confirm another tenant's id.
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown inference"})
		return
	}
	if time.Since(record.CreatedAt) > resultTTLDays*24*time.Hour {
		// The prediction is gone; the metadata that proves a decision was made is not.
		writeJSON(rw, http.StatusGone, map[string]any{
			"id":                record.ID,
			"status":            "expired",
			"digest":            record.Digest,
			"created_at":        record.CreatedAt,
			"metadata_ttl_days": metadataTTLDays,
		})
		return
	}
	if record.Status == statusPending {
		writeJSON(rw, http.StatusAccepted, map[string]any{
			"id":     record.ID,
			"status": statusPending,
			"digest": record.Digest,
		})
		return
	}
	writeJSON(rw, http.StatusOK, record)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/inferences/{id}", readInference)
	_ = mux
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

final case class InferenceRecord(id: String, tenant_id: String, status: String, payload: String)

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("vision-api")

  val store = InferenceStore.open()

  val route: Route =
    path("v1" / "inferences" / Segment) { inferenceId =>
      get {
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        store.get(inferenceId) match {
          case Some(record) => complete(StatusCodes.OK, record.payload)
          case None => complete(StatusCodes.OK, s"""{"id":"$inferenceId","status":"complete"}""")
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.time.Instant

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

final case class InferenceRecord(
    id: String,
    tenant_id: String,
    status: String,
    digest: String,
    created_at: Instant,
    label: Option[String],
    confidence: Option[Double],
    model_version: Option[String]
)

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("vision-api")

  val ResultTtlDays = 30
  val MetadataTtlDays = 365
  val Pending = "pending"

  val store = InferenceStore.open()

  val route: Route =
    path("v1" / "inferences" / Segment) { inferenceId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          val tenant = tenantOpt.getOrElse("")
          if (tenant.isEmpty) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            store.get(inferenceId) match {
              case Some(record) if record.tenant_id == tenant =>
                if (java.time.Duration.between(record.created_at, Instant.now()).toDays > ResultTtlDays) {
                  // The prediction is gone; the metadata that proves a decision was made is not.
                  complete(
                    StatusCodes.Gone,
                    s"""{"id":"\${record.id}","status":"expired","digest":"\${record.digest}",
                       |"metadata_ttl_days":$MetadataTtlDays}""".stripMargin
                  )
                } else if (record.status == Pending) {
                  complete(
                    StatusCodes.Accepted,
                    s"""{"id":"\${record.id}","status":"$Pending","digest":"\${record.digest}"}"""
                  )
                } else {
                  complete(StatusCodes.OK, record)
                }
              case _ =>
                // A foreign id is indistinguishable from a missing one: never confirm another tenant's id.
                complete(StatusCodes.NotFound, """{"error":"unknown inference"}""")
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

#include <optional>
#include <string>

using json = nlohmann::json;

struct InferenceRecord {
  std::string id;
  std::string tenant_id;
  std::string status;
  json payload;
};

struct InferenceStore {
  std::optional<InferenceRecord> get(const std::string& id);
};

InferenceStore store;

int main() {
  httplib::Server svr;

  svr.Get("/v1/inferences/:id", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    const auto record = store.get(req.path_params.at("id"));
    res.status = 200;
    res.set_content(record ? record->payload.dump() : json{{"id", req.path_params.at("id")}}.dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <ctime>
#include <optional>
#include <string>

using json = nlohmann::json;

constexpr int kResultTtlDays = 30;
constexpr int kMetadataTtlDays = 365;
const std::string kPending = "pending";

struct InferenceRecord {
  std::string id;
  std::string tenant_id;
  std::string status;
  std::string digest;
  long long created_at_epoch;
  json prediction;
};

struct InferenceStore {
  std::optional<InferenceRecord> get(const std::string& id);
};

InferenceStore store;

int main() {
  httplib::Server svr;

  svr.Get("/v1/inferences/:id", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto record = store.get(req.path_params.at("id"));
    if (!record || record->tenant_id != tenant) {
      // A foreign id is indistinguishable from a missing one: never confirm another tenant's id.
      res.status = 404;
      res.set_content(R"({"error":"unknown inference"})", "application/json");
      return;
    }
    const auto age_days = (std::time(nullptr) - record->created_at_epoch) / 86400;
    if (age_days > kResultTtlDays) {
      // The prediction is gone; the metadata that proves a decision was made is not.
      res.status = 410;
      res.set_content(json{{"id", record->id},
                           {"status", "expired"},
                           {"digest", record->digest},
                           {"metadata_ttl_days", kMetadataTtlDays}}
                          .dump(),
                      "application/json");
      return;
    }
    if (record->status == kPending) {
      res.status = 202;
      res.set_content(json{{"id", record->id}, {"status", kPending}, {"digest", record->digest}}.dump(),
                      "application/json");
      return;
    }
    res.status = 200;
    res.set_content(json{{"id", record->id},
                         {"status", record->status},
                         {"prediction", record->prediction},
                         {"digest", record->digest}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    "Request another tenant's id without any header: the starter answers 200 with their prediction. Request a 31-day-old id and the label is still there; request one the worker is writing and it reads as final.",
    'The handler takes no `X-Tenant-Id` and compares nothing against `tenant_id`, defines no `RESULT_TTL_DAYS` or `METADATA_TTL_DAYS`, and checks no status before `JSONResponse(record, status_code=200)`.',
    'Read the tenant header, answer 404 when `record.tenant_id` differs, 410 with a `metadata` body past `RESULT_TTL_DAYS = 30` (metadata kept until `METADATA_TTL_DAYS`), and 202 while the status is `PENDING`.',
  ],
  debrief: `The read path is where isolation and retention live. The tenant check is a comparison
on the row, not a filter the id could bypass, and a mismatch answers 404 rather than 403 because a
403 confirms the id exists, which is exactly what an enumeration needs. The two TTLs split what the
service stores from what it must be able to prove: the prediction has a 30-day shelf life, the fact
that a decision was made outlives it, and 410 rather than 404 says so. The 202 keeps a half-written
row out of every cache between the worker and the client. Production services also hand out a signed
result URL with its own short TTL, run an erasure path that deletes by tenant, and allow a per-tenant
retention override for regulated customers.`,
};
