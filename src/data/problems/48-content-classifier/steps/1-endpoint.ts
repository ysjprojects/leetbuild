import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/classify: labels the taxonomy actually contains',
  concept: 'http',
  file: 'api',
  focus: ['client', 'classifier', 'taxonomy'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and answers with labels, so the demo passes. It hides four production flaws. Review it like
the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/classify\` with body \`{"text": "…", "taxonomy_id": "…", "taxonomy_version": "…"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- The request must be \`Content-Type: text/*\`; an image or an octet-stream upload is **415**, and its
  bytes are never pushed to the model as if they were text.
- \`text\` is normalized (unicode fold + trim) and then checked: empty after normalization is **400**,
  and more than **64 KiB** (\`1 << 16\` bytes) of UTF-8 is **413**.
- The taxonomy is resolved **for this tenant** at the requested version; a taxonomy the tenant does
  not own is **404**, never a fallback to the latest.
- The model's labels are **bound to the taxonomy version**: only labels the version actually
  contains are returned. An invented label must be routed to the review bucket instead of being
  returned as a real label, and the unknowns are reported so review can act on them.
- The response names the taxonomy version that classified the text.

**Failure mode the checks target.** Trusting the model's label strings lets a category the taxonomy
never contained flow downstream as real; resolving the taxonomy by id alone lets one tenant classify
against another tenant's taxonomy; classifying raw upload bytes turns a screenshot into garbage
labels; and skipping the size and normalization checks lets an empty or unbounded document reach an
expensive model call.`,
  sequence: {
    participants: ['Client', 'Content Classifier', 'taxonomy store', 'Model'],
    messages: [
      {
        from: 'Client',
        to: 'Content Classifier',
        label: 'POST /v1/classify · X-Tenant-Id · taxonomy_id · text/*',
        kind: 'sync',
      },
      {
        from: 'Content Classifier',
        to: 'Content Classifier',
        label: 'normalize · empty 400 · 64 KiB 413 · non-text 415',
        kind: 'sync',
      },
      {from: 'Content Classifier', to: 'taxonomy store', label: 'load(tenant, taxonomy_id, version)', kind: 'sync'},
      {from: 'taxonomy store', to: 'Content Classifier', label: 'version + labels / 404', kind: 'reply'},
      {from: 'Content Classifier', to: 'Model', label: 'Classify(text, taxonomy_version)', kind: 'sync'},
      {from: 'Model', to: 'Content Classifier', label: 'labels (may include inventions)', kind: 'reply'},
      {
        from: 'Content Classifier',
        to: 'Client',
        label: '200 {labels, taxonomy_version} · invented → review bucket',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/classify',
      detail: 'Register the classification route on `POST /v1/classify`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/classify["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/classify['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/classify"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"classify"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/classify"/]},
      },
    },
    {
      id: 'size-and-empty',
      title: 'Normalizes then enforces the 64 KiB cap and the empty rejection',
      detail:
        'Text is normalized first; empty after normalization is **400** and more than `1 << 16` bytes of UTF-8 is **413**. The draft checks neither, so an empty or unbounded document reaches the model.',
      match: {
        python: {all: [/MAX_TEXT_BYTES/, /normalize_text/, /status_code\s*=\s*413/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_TEXT_BYTES/, /normalizeText/, /code\(\s*413\s*\)/, /code\(\s*400\s*\)/]},
        go: {all: [/maxTextBytes/, /normalizeText/, /StatusRequestEntityTooLarge/, /StatusBadRequest/]},
        scala: {
          all: [/MaxTextBytes/, /normalizeText/, /StatusCodes\.RequestEntityTooLarge/, /StatusCodes\.BadRequest/],
        },
        cpp: {all: [/kMaxTextBytes/, /normalizeText/, /\b413\b/, /\b400\b/]},
      },
    },
    {
      id: 'taxonomy-binding',
      title: 'Binds labels to the taxonomy version, invented labels to review',
      detail:
        'Only labels present in the taxonomy version are returned; the rest are reported as unknown and the response carries the review bucket. The draft returns the model’s label strings unchecked.',
      match: {
        python: {all: [/REVIEW_LABEL/, /bind_labels\(/, /unknown_labels/]},
        typescript: {all: [/REVIEW_LABEL/, /bindLabels\(/, /unknown/]},
        go: {all: [/reviewLabel/, /bindLabels\(/, /unknown/]},
        scala: {all: [/ReviewLabel/, /bindLabels\(/, /unknown/]},
        cpp: {all: [/kReviewLabel/, /bindLabels\(/, /unknown/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Resolves the taxonomy for this tenant, foreign is 404',
      detail:
        'The taxonomy is loaded with the authenticated tenant, so a taxonomy the tenant does not own is **404**. The draft looks it up by id alone and treats any tenant’s taxonomy as local.',
      match: {
        python: {all: [/status_code\s*=\s*404/, /load\(tenant/]},
        typescript: {all: [/code\(\s*404\s*\)/, /load\(tenant/]},
        go: {all: [/StatusNotFound/, /Load\(r\.Context\(\), tenant/]},
        scala: {all: [/StatusCodes\.NotFound/, /load\(tenant/]},
        cpp: {all: [/\b404\b/, /load\(tenant/]},
      },
    },
    {
      id: 'content-type',
      title: 'Rejects non-text content with 415',
      detail:
        'Anything that is not `text/*` is **415** and never classified. The draft pushes the raw bytes of an upload to the model and returns whatever labels come back.',
      match: {
        python: {all: [/status_code\s*=\s*415/, /text\//, /Content-Type/]},
        typescript: {all: [/code\(\s*415\s*\)/, /text\//, /content-type/]},
        go: {all: [/StatusUnsupportedMediaType/, /text\//, /Content-Type/]},
        scala: {all: [/StatusCodes\.UnsupportedMediaType/, /text\//, /Content-Type/]},
        cpp: {all: [/\b415\b/, /text\//, /Content-Type/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("classifier")


class ClassifyRequest(BaseModel):
    text: str
    taxonomy_id: str
    taxonomy_version: str | None = None


class TaxonomyStore:
    def get(self, taxonomy_id: str) -> dict:
        """The latest taxonomy for this id, whatever tenant owns it."""
        raise NotImplementedError


taxonomy_store = TaxonomyStore()
model = None


@app.post("/v1/classify")
def classify(body: ClassifyRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft returns whichever labels the model produces, looks the taxonomy up by id
    # alone so any tenant can classify against another tenant's taxonomy, classifies raw upload
    # bytes with no Content-Type check, and skips the 64 KiB cap and the empty-after-normalize
    # rejection. Review all four.
    taxonomy = taxonomy_store.get(body.taxonomy_id)
    labels = model.classify(body.text, taxonomy_id=taxonomy["version"])
    logger.info("classify tenant=%s taxonomy=%s labels=%s", tenant, body.taxonomy_id, labels)
    return JSONResponse(
        {"labels": labels, "taxonomy_version": taxonomy["version"], "provenance": "model"},
        status_code=200,
    )
`,
      solution: `import logging
import unicodedata

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("classifier")

MAX_TEXT_BYTES = 1 << 16
REVIEW_LABEL = "review"


class ClassifyRequest(BaseModel):
    text: str
    taxonomy_id: str
    taxonomy_version: str | None = None


class TaxonomyStore:
    def load(self, tenant: str, taxonomy_id: str, version: str | None) -> dict | None:
        """The taxonomy version visible to this tenant, or None when it is not the tenant's."""
        raise NotImplementedError


taxonomy_store = TaxonomyStore()
model = None


def normalize_text(text: str) -> str:
    """Fold unicode and trim; text that is empty afterwards carries no classification."""
    return unicodedata.normalize("NFKC", text).strip()


def bind_labels(raw_labels: list[str], taxonomy: dict) -> tuple[list[str], list[str]]:
    """Keep only labels the taxonomy version contains; an invented label goes to review."""
    allowed = set(taxonomy["labels"])
    bound = [label for label in raw_labels if label in allowed]
    unknown_labels = [label for label in raw_labels if label not in allowed]
    if not bound:
        return [REVIEW_LABEL], unknown_labels
    return bound + ([REVIEW_LABEL] if unknown_labels else []), unknown_labels


@app.post("/v1/classify")
def classify(
    body: ClassifyRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    content_type: str | None = Header(default=None, alias="Content-Type"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    media_type = (content_type or "").split(";")[0].strip().lower()
    if not media_type.startswith("text/"):
        raise HTTPException(status_code=415, detail="only text content can be classified")
    text = normalize_text(body.text)
    if text == "":
        raise HTTPException(status_code=400, detail="text is empty after normalization")
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise HTTPException(status_code=413, detail="text exceeds 64 KiB")

    taxonomy = taxonomy_store.load(tenant, body.taxonomy_id, body.taxonomy_version)
    if taxonomy is None:
        raise HTTPException(status_code=404, detail="unknown taxonomy for this tenant")

    raw_labels = model.classify(text, taxonomy_id=taxonomy["version"])
    labels, unknown_labels = bind_labels(raw_labels, taxonomy)
    logger.info(
        "classify tenant=%s taxonomy=%s version=%s labels=%s review=%d",
        tenant,
        body.taxonomy_id,
        taxonomy["version"],
        labels,
        len(unknown_labels),
    )
    return JSONResponse(
        {
            "labels": labels,
            "unknown_labels": unknown_labels,
            "taxonomy_version": taxonomy["version"],
            "provenance": "model",
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/classify: a model-generated draft that returns whatever the model invents. */
import Fastify from 'fastify';

export const app = Fastify();

interface ClassifyBody {
  text: string;
  taxonomy_id: string;
  taxonomy_version?: string;
}

app.post('/v1/classify', async (request, reply) => {
  // TODO: this draft returns the model's labels unchecked, looks the taxonomy up by id alone so
  // tenants can classify against each other's taxonomies, classifies raw upload bytes with no
  // Content-Type check, and skips the 64 KiB cap and the empty-after-normalize rejection.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as ClassifyBody;
  const taxonomy = await taxonomyStore.get(body.taxonomy_id);
  const labels = await model.classify(body.text, {taxonomyId: taxonomy.id});
  request.log.info({tenant, taxonomy: body.taxonomy_id, labels}, 'classified');
  return reply.code(200).send({labels, taxonomy_version: taxonomy.version, provenance: 'model'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/classify: labels bound to the tenant's taxonomy version. */
import Fastify from 'fastify';

import {model} from './model';
import {taxonomyStore} from './taxonomy_store';

export const app = Fastify();

const MAX_TEXT_BYTES = 1 << 16;
const REVIEW_LABEL = 'review';

interface ClassifyBody {
  text: string;
  taxonomy_id: string;
  taxonomy_version?: string;
}

interface Taxonomy {
  version: string;
  labels: string[];
}

function normalizeText(text: string): string {
  return text.normalize('NFKC').trim();
}

function bindLabels(rawLabels: string[], taxonomy: Taxonomy): {labels: string[]; unknown: string[]} {
  const allowed = new Set(taxonomy.labels);
  const bound = rawLabels.filter(label => allowed.has(label));
  const unknown = rawLabels.filter(label => !allowed.has(label));
  const labels = bound.length === 0 ? [REVIEW_LABEL] : [...bound, ...(unknown.length > 0 ? [REVIEW_LABEL] : [])];
  return {labels, unknown};
}

app.post('/v1/classify', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const contentType = request.headers['content-type'];
  const mediaType = typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase() : '';
  if (!mediaType.startsWith('text/')) return reply.code(415).send({error: 'only text content can be classified'});

  const body = request.body as Partial<ClassifyBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.text !== 'string')
    return reply.code(400).send({error: 'text must be a string'});
  const text = normalizeText(body.text);
  if (text === '') return reply.code(400).send({error: 'text is empty after normalization'});
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return reply.code(413).send({error: 'text exceeds 64 KiB'});

  const taxonomy = await taxonomyStore.load(tenant, body.taxonomy_id as string, body.taxonomy_version ?? null);
  if (taxonomy === null) return reply.code(404).send({error: 'unknown taxonomy for this tenant'});

  const rawLabels = await model.classify(text, {taxonomyId: taxonomy.version});
  const {labels, unknown} = bindLabels(rawLabels, taxonomy);
  request.log.info(
    {tenant, taxonomy: body.taxonomy_id, version: taxonomy.version, labels, unknown: unknown.length},
    'classified',
  );
  return reply
    .code(200)
    .send({labels, unknown_labels: unknown, taxonomy_version: taxonomy.version, provenance: 'model'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

type ClassifyRequest struct {
	Text            string \`json:"text"\`
	TaxonomyID      string \`json:"taxonomy_id"\`
	TaxonomyVersion string \`json:"taxonomy_version"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func classify(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body ClassifyRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft returns the model's labels unchecked, looks the taxonomy up by id alone so
	// tenants can classify against each other's taxonomies, classifies raw upload bytes with no
	// Content-Type check, and skips the 64 KiB cap and the empty-after-normalize rejection.
	taxonomy, _ := taxonomyStore.Get(body.TaxonomyID, body.TaxonomyVersion)
	labels, _ := model.Classify(r.Context(), body.Text, taxonomy.Version)
	log.Printf("classify tenant=%s taxonomy=%s labels=%v", tenant, body.TaxonomyID, labels)
	writeJSON(rw, http.StatusOK, map[string]any{
		"labels":           labels,
		"taxonomy_version": taxonomy.Version,
		"provenance":       "model",
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/classify", classify)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

const (
	maxTextBytes = 1 << 16
	reviewLabel  = "review"
)

type ClassifyRequest struct {
	Text            string \`json:"text"\`
	TaxonomyID      string \`json:"taxonomy_id"\`
	TaxonomyVersion string \`json:"taxonomy_version"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func normalizeText(text string) string {
	return strings.TrimSpace(text)
}

// bindLabels keeps only labels the taxonomy version contains; an invented label goes to review.
func bindLabels(rawLabels []string, taxonomy Taxonomy) (labels []string, unknown []string) {
	allowed := make(map[string]bool, len(taxonomy.Labels))
	for _, label := range taxonomy.Labels {
		allowed[label] = true
	}
	for _, label := range rawLabels {
		if allowed[label] {
			labels = append(labels, label)
		} else {
			unknown = append(unknown, label)
		}
	}
	if len(labels) == 0 || len(unknown) > 0 {
		labels = append(labels, reviewLabel)
	}
	return labels, unknown
}

func classify(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	rawContentType := r.Header.Get("Content-Type")
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(rawContentType, ";")[0]))
	if !strings.HasPrefix(mediaType, "text/") {
		writeJSON(rw, http.StatusUnsupportedMediaType, map[string]string{"error": "only text content can be classified"})
		return
	}
	var body ClassifyRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	text := normalizeText(body.Text)
	if text == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "text is empty after normalization"})
		return
	}
	if len([]byte(text)) > maxTextBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "text exceeds 64 KiB"})
		return
	}
	taxonomy, err := taxonomyStore.Load(r.Context(), tenant, body.TaxonomyID, body.TaxonomyVersion)
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown taxonomy for this tenant"})
		return
	}
	rawLabels, err := model.Classify(r.Context(), text, taxonomy.Version)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	labels, unknown := bindLabels(rawLabels, taxonomy)
	log.Printf("classify tenant=%s taxonomy=%s version=%s labels=%v unknown=%d",
		tenant, body.TaxonomyID, taxonomy.Version, labels, len(unknown))
	writeJSON(rw, http.StatusOK, map[string]any{
		"labels":           labels,
		"unknown_labels":   unknown,
		"taxonomy_version": taxonomy.Version,
		"provenance":       "model",
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/classify", classify)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
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

final case class ClassifyRequest(text: String, taxonomy_id: String, taxonomy_version: Option[String])

object ClassifyApi {
  implicit val system: ActorSystem = ActorSystem("content-classifier")
  implicit val requestFormat: RootJsonFormat[ClassifyRequest] = jsonFormat3(ClassifyRequest)

  val model = ModelClient.open()

  val route: Route =
    path("v1" / "classify") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[ClassifyRequest]) { body =>
            // TODO: this draft returns the model's labels unchecked, looks the taxonomy up by id
            // alone so tenants can classify against each other's taxonomies, classifies raw upload
            // bytes with no Content-Type check, and skips the 64 KiB cap and the empty rejection.
            val taxonomy = TaxonomyStore.get(body.taxonomy_id, body.taxonomy_version)
            val labels = model.classify(body.text, taxonomy.version)
            val taxonomyId = body.taxonomy_id
            system.log.info(s"classify tenant=$tenant taxonomy=$taxonomyId labels=$labels")
            complete(StatusCodes.OK, s"""{"taxonomy_version":"\${taxonomy.version}"}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ClassifyRequest(text: String, taxonomy_id: String, taxonomy_version: Option[String])
final case class Taxonomy(version: String, labels: List[String])
final case class ClassifyResponse(
    labels: List[String],
    unknown_labels: List[String],
    taxonomy_version: String,
    provenance: String
)

object ClassifyApi {
  implicit val system: ActorSystem = ActorSystem("content-classifier")
  implicit val requestFormat: RootJsonFormat[ClassifyRequest] = jsonFormat3(ClassifyRequest)
  implicit val responseFormat: RootJsonFormat[ClassifyResponse] = jsonFormat4(ClassifyResponse)

  val MaxTextBytes = 1 << 16
  val ReviewLabel = "review"

  val model = ModelClient.open()

  def normalizeText(text: String): String = text.trim

  /** Keep only labels the taxonomy version contains; an invented label goes to review. */
  def bindLabels(rawLabels: List[String], taxonomy: Taxonomy): (List[String], List[String]) = {
    val (bound, unknown) = rawLabels.partition(taxonomy.labels.contains)
    val labels =
      if (bound.isEmpty) List(ReviewLabel)
      else if (unknown.nonEmpty) bound :+ ReviewLabel
      else bound
    (labels, unknown)
  }

  val route: Route =
    path("v1" / "classify") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Content-Type") { contentTypeOpt =>
            entity(as[ClassifyRequest]) { body =>
              val mediaType = contentTypeOpt.map(_.split(";")(0).trim.toLowerCase).getOrElse("")
              val tenant = tenantOpt.getOrElse("")
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!mediaType.startsWith("text/")) {
                complete(StatusCodes.UnsupportedMediaType, """{"error":"only text content can be classified"}""")
              } else {
                val text = normalizeText(body.text)
                if (text.isEmpty) {
                  complete(StatusCodes.BadRequest, """{"error":"text is empty after normalization"}""")
                } else if (text.getBytes(StandardCharsets.UTF_8).length > MaxTextBytes) {
                  complete(StatusCodes.RequestEntityTooLarge, """{"error":"text exceeds 64 KiB"}""")
                } else {
                  TaxonomyStore.load(tenant, body.taxonomy_id, body.taxonomy_version) match {
                    case None =>
                      complete(StatusCodes.NotFound, """{"error":"unknown taxonomy for this tenant"}""")
                    case Some(taxonomy) =>
                      val rawLabels = model.classify(text, taxonomy.version)
                      val (labels, unknown) = bindLabels(rawLabels, taxonomy)
                      val taxonomyId = body.taxonomy_id
                      system.log.info(
                        s"classify tenant=$tenant taxonomy=$taxonomyId version=\${taxonomy.version} unknown=\${unknown.size}"
                      )
                      complete(
                        StatusCodes.OK,
                        ClassifyResponse(labels, unknown, taxonomy.version, "model")
                      )
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

#include <iostream>
#include <string>

using json = nlohmann::json;

struct TaxonomyStore {
  json get(const std::string& taxonomyId, const std::string& version);
};

TaxonomyStore taxonomyStore;
ModelClient model;

int main() {
  httplib::Server svr;

  svr.Post("/v1/classify", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft returns the model's labels unchecked, looks the taxonomy up by id alone so
    // tenants can classify against each other's taxonomies, classifies raw upload bytes with no
    // Content-Type check, and skips the 64 KiB cap and the empty-after-normalize rejection.
    const auto taxonomyId = body.value("taxonomy_id", std::string());
    const auto taxonomy = taxonomyStore.get(taxonomyId, body.value("taxonomy_version", std::string()));
    const auto labels = model.classify(body.value("text", std::string()), taxonomy["version"].get<std::string>());
    std::cerr << "classify tenant=" << tenant << " taxonomy=" << taxonomyId << "\\n";
    res.status = 200;
    res.set_content(
        json{{"labels", labels}, {"taxonomy_version", taxonomy["version"]}, {"provenance", "model"}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxTextBytes = 1 << 16;
const std::string kReviewLabel = "review";

struct TaxonomyStore {
  std::optional<json> load(const std::string& tenant, const std::string& taxonomyId, const std::string& version);
};

TaxonomyStore taxonomyStore;
ModelClient model;

std::string normalizeText(const std::string& text) {
  const auto begin = text.find_first_not_of(" \\t\\r\\n");
  if (begin == std::string::npos) return "";
  const auto end = text.find_last_not_of(" \\t\\r\\n");
  return text.substr(begin, end - begin + 1);
}

// Keeps only labels the taxonomy version contains; an invented label goes to review.
std::vector<std::string> bindLabels(const std::vector<std::string>& rawLabels, const json& taxonomy,
                                   std::vector<std::string>& unknown) {
  const std::set<std::string> allowed(taxonomy["labels"].begin(), taxonomy["labels"].end());
  std::vector<std::string> labels;
  for (const auto& label : rawLabels) {
    if (allowed.count(label) > 0) {
      labels.push_back(label);
    } else {
      unknown.push_back(label);
    }
  }
  if (labels.empty() || !unknown.empty()) labels.push_back(kReviewLabel);
  return labels;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/classify", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto contentType = req.get_header_value("Content-Type");
    const auto semi = contentType.find(';');
    std::string mediaType = semi == std::string::npos ? contentType : contentType.substr(0, semi);
    mediaType.erase(std::remove_if(mediaType.begin(), mediaType.end(), [](unsigned char c) { return std::isspace(c); }),
                    mediaType.end());
    std::transform(mediaType.begin(), mediaType.end(), mediaType.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (mediaType.rfind("text/", 0) != 0) {
      res.status = 415;
      res.set_content(R"({"error":"only text content can be classified"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("text") || !body["text"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"text must be a string"})", "application/json");
      return;
    }
    const auto text = normalizeText(body["text"].get<std::string>());
    if (text.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"text is empty after normalization"})", "application/json");
      return;
    }
    if (text.size() > kMaxTextBytes) {
      res.status = 413;
      res.set_content(R"({"error":"text exceeds 64 KiB"})", "application/json");
      return;
    }
    const auto taxonomyId = body.value("taxonomy_id", std::string());
    const auto taxonomy = taxonomyStore.load(tenant, taxonomyId, body.value("taxonomy_version", std::string()));
    if (!taxonomy) {
      res.status = 404;
      res.set_content(R"({"error":"unknown taxonomy for this tenant"})", "application/json");
      return;
    }
    const auto version = (*taxonomy)["version"].get<std::string>();
    const auto rawLabels = model.classify(text, version);
    std::vector<std::string> unknown;
    const auto labels = bindLabels(rawLabels, *taxonomy, unknown);
    std::cerr << "classify tenant=" << tenant << " taxonomy=" << taxonomyId << " version=" << version
              << " unknown=" << unknown.size() << "\\n";
    res.status = 200;
    res.set_content(json{{"labels", labels},
                         {"unknown_labels", unknown},
                         {"taxonomy_version", version},
                         {"provenance", "model"}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses in cost order before any model work: tenant, media type, normalized text, byte length, taxonomy. Every one of them returns before the expensive call, so a hostile or malformed request can never spend model budget.',
    'The taxonomy stays anchored to the tenant: `taxonomy_store.load(tenant, id, version)` returns nothing for a taxonomy the tenant does not own, which the handler answers with 404. Looking it up by id alone is what lets a tenant classify against another tenant’s categories.',
    'Binding is one intersection plus one failure path: keep the labels the version contains, collect the rest as unknowns, and when nothing valid survives (or an unknown appeared) put the result in the review bucket instead of returning an invented label downstream.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary between a model and a taxonomy. The draft reads fine because the demo feeds it clean text from one tenant against one taxonomy and the model returns labels that happen to exist. Four defects are being checked: content negotiation (an upload is not text), input discipline (normalize, then reject empty or oversized input before paying for a call), tenant scoping (a taxonomy is a tenant's data, not a global id), and label binding (a model's string is a suggestion, and the taxonomy version is the authority). The last one is the quiet one: downstream routing trusts labels, so an invented label is a routing bug that only shows up as content silently dropped into a category nobody defined. Real classifiers add a confidence threshold above which unknowns auto-route to review, a per-tenant alias table that maps common model drift back to real labels, and a metric on the invented-label rate so taxonomy maintenance is driven by evidence.`,
};
