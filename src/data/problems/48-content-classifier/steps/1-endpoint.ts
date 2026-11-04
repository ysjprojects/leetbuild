import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/classify: labels the taxonomy actually contains',
  concept: 'http',
  file: 'api',
  focus: ['client', 'classifier', 'taxonomy'],
  task: `## Task

**Starting point.** \`POST /v1/classify\` reads the tenant from \`X-Tenant-Id\` and a JSON body
\`{taxonomy_id, taxonomy_version?, mime_type, text}\`, looks the taxonomy up with
\`taxonomies.by_id\`, classifies the text through \`inference.classify\` (provided; step 3 builds it)
and answers \`{taxonomy_id, taxonomy_version, labels, unknown_labels, provenance, model_version}\`
with the model's labels. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** An image upload goes through the model as if it were text; an
empty or unbounded document reaches an expensive call; one tenant classifies against another
tenant's taxonomy; and a label the model invented flows downstream as if the taxonomy contained it.

- A \`mime_type\` that is not \`text/*\` is **415**, and nothing reaches the model.
- The text is trimmed: empty is **400**, more than \`MAX_TEXT_BYTES\` (64 KiB) of UTF-8 is **413**.
- A missing \`X-Tenant-Id\` is **401**. The taxonomy comes from \`taxonomies.load(tenant,
  taxonomy_id, version)\` at the requested version (the latest when absent); one the tenant does
  not own is **404**.
- \`bind_labels\` keeps the labels the version contains; the rest go to \`unknown_labels\` and add
  \`REVIEW_LABEL\` (\`review\`), which is also the answer when no label survives.`,
  sequence: {
    participants: ['Client', 'Content Classifier', 'taxonomy store', 'Model'],
    messages: [
      {
        from: 'Client',
        to: 'Content Classifier',
        label: 'POST /v1/classify · X-Tenant-Id · {taxonomy_id, mime_type, text}',
        kind: 'sync',
      },
      {
        from: 'Content Classifier',
        to: 'Content Classifier',
        label: '401 · 415 unless text/* · trim · 400 empty · 413 over 64 KiB',
        kind: 'sync',
      },
      {from: 'Content Classifier', to: 'taxonomy store', label: 'load(tenant, taxonomy_id, version)', kind: 'sync'},
      {from: 'taxonomy store', to: 'Content Classifier', label: 'version + labels / none → 404', kind: 'reply'},
      {from: 'Content Classifier', to: 'Model', label: 'Classify(text, taxonomy version)', kind: 'sync'},
      {from: 'Model', to: 'Content Classifier', label: 'labels (some invented)', kind: 'reply'},
      {
        from: 'Content Classifier',
        to: 'Client',
        label: '200 {labels ∩ version, unknown_labels, review}',
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
      id: 'content-type',
      title: 'Rejects a document that is not text with 415',
      detail:
        'A `mime_type` outside `text/*` (an image, an octet stream) is **415** and never reaches the model; `text/markdown` is classified. The starter sends whatever bytes it gets.',
      match: {
        python: {all: [/\.startswith\(\s*["']text\/["']\s*\)/, /\b415\b/]},
        typescript: {all: [/\.startsWith\(\s*['"]text\/['"]\s*\)/, /\b415\b/]},
        go: {all: [/strings\.HasPrefix\([^)]*"text\/"\s*\)/, /StatusUnsupportedMediaType|\b415\b/]},
        scala: {all: [/\.startsWith\(\s*"text\/"\s*\)/, /UnsupportedMediaType|\b415\b/]},
        cpp: {all: [/rfind\(\s*"text\/",\s*0\s*\)|starts_with\(\s*"text\/"\s*\)/, /\b415\b/]},
      },
    },
    {
      id: 'size-and-empty',
      title: 'Trims, then rejects empty text (400) and more than 64 KiB (413)',
      detail:
        'The trimmed text is **400** when empty and **413** when its UTF-8 encoding exceeds `MAX_TEXT_BYTES` (`1 << 16`), both before any model call. The starter checks neither.',
      match: {
        python: {all: [/MAX_TEXT_BYTES\s*=/, /\b413\b/, /\b400\b/, /\.strip\(\)/]},
        typescript: {all: [/MAX_TEXT_BYTES\s*=/, /\b413\b/, /\b400\b/, /\.trim\(\)/]},
        go: {all: [/maxTextBytes\s*=/, /StatusRequestEntityTooLarge|\b413\b/, /strings\.TrimSpace\(/]},
        scala: {all: [/MaxTextBytes\b/, /RequestEntityTooLarge|\b413\b/, /\.trim\b/]},
        cpp: {all: [/kMaxTextBytes\s*=/, /\b413\b/, /find_first_not_of\(/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Resolves the taxonomy for this tenant at the requested version',
      detail:
        'A missing `X-Tenant-Id` is **401**; the taxonomy comes from `taxonomies.load(tenant, …)` at the requested version, so another tenant’s taxonomy is **404**. The starter uses `by_id`, which finds any tenant’s taxonomy and only its latest version.',
      match: {
        python: {all: [/taxonomies\.load\(\s*tenant/, /\b401\b/], none: [/taxonomies\.by_id\(/]},
        typescript: {all: [/taxonomies\.load\(\s*tenant/, /\b401\b/], none: [/taxonomies\.byId\(/]},
        scala: {all: [/Taxonomies\.load\(\s*tenant/, /Unauthorized|\b401\b/], none: [/Taxonomies\.byId\(/]},
        cpp: {all: [/taxonomies::load\(\s*tenant/, /\b401\b/], none: [/taxonomies::byId\(/]},
        go: {
          all: [/taxonomies\.Load\(r\.Context\(\),\s*tenant/, /StatusUnauthorized|\b401\b/],
          none: [/taxonomies\.ByID\(/],
        },
      },
    },
    {
      id: 'taxonomy-binding',
      title: 'Binds labels to the taxonomy version, invented labels to review',
      detail:
        'The response’s `labels` come from `bind_labels`/`bindLabels` over the model’s labels: only labels the version contains, plus `REVIEW_LABEL` when one was unknown or none survived, and the unknown ones in `unknown_labels`. The starter returns the model’s strings unchecked.',
      match: {
        python: {
          all: [/def bind_labels\(/, /REVIEW_LABEL/, /bind_labels\(\s*result\[/],
          none: [/["']labels["']\s*:\s*result\[["']labels["']\]/],
        },
        typescript: {
          all: [/function bindLabels\(/, /REVIEW_LABEL/, /bindLabels\(\s*result\.labels/],
          none: [/labels:\s*result\.labels/],
        },
        go: {
          all: [/func bindLabels\(/, /config\.ReviewLabel/, /bindLabels\(\s*result\.Labels/],
          none: [/Labels:\s*result\.Labels/],
        },
        scala: {
          all: [/def bindLabels\(/, /Config\.ReviewLabel/, /bindLabels\(\s*result\.labels/],
          none: [/"labels"\s*->\s*strings\(result\.labels\)/],
        },
        cpp: {
          all: [/bind_labels\(/, /config::kReviewLabel/, /bind_labels\(\s*result\.labels/],
          none: [/\{"labels",\s*result\.labels\}/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from classifier import inference, taxonomies
from classifier.config import REVIEW_LABEL

app = FastAPI()
logger = logging.getLogger("classifier.api")


class ClassifyRequest(BaseModel):
    taxonomy_id: str
    taxonomy_version: int | None = None
    mime_type: str
    text: str


@app.post("/v1/classify")
def classify(body: ClassifyRequest, request: Request) -> dict:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    taxonomy = taxonomies.by_id(body.taxonomy_id)
    if taxonomy is None:
        raise HTTPException(status_code=404, detail="unknown taxonomy")
    result = inference.classify(body.text, taxonomy["taxonomy_id"], taxonomy["version"])
    logger.info("classify tenant=%s taxonomy=%s version=%s", tenant, taxonomy["taxonomy_id"], taxonomy["version"])
    return {
        "taxonomy_id": taxonomy["taxonomy_id"],
        "taxonomy_version": taxonomy["version"],
        "labels": result["labels"],
        "unknown_labels": [],
        "provenance": result["provenance"],
        "model_version": result["model_version"],
    }
`,
      solution: `import logging

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from classifier import inference, taxonomies
from classifier.config import REVIEW_LABEL

app = FastAPI()
logger = logging.getLogger("classifier.api")

MAX_TEXT_BYTES = 1 << 16


class ClassifyRequest(BaseModel):
    taxonomy_id: str
    taxonomy_version: int | None = None
    mime_type: str
    text: str


def bind_labels(raw_labels: list[str], taxonomy: dict) -> tuple[list[str], list[str]]:
    """Keep the labels the taxonomy version contains; an invented one is reported and routes to review."""
    allowed = set(taxonomy["labels"])
    labels = [label for label in raw_labels if label in allowed]
    unknown = [label for label in raw_labels if label not in allowed and label != REVIEW_LABEL]
    if unknown or not labels:
        labels.append(REVIEW_LABEL)
    return labels, unknown


@app.post("/v1/classify")
def classify(body: ClassifyRequest, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    # Every guard is cheaper than the model call it protects.
    if not body.mime_type.startswith("text/"):
        raise HTTPException(status_code=415, detail="only text/* documents can be classified")
    text = body.text.strip()
    if text == "":
        raise HTTPException(status_code=400, detail="text is empty")
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise HTTPException(status_code=413, detail="text exceeds 64 KiB")
    taxonomy = taxonomies.load(tenant, body.taxonomy_id, body.taxonomy_version)
    if taxonomy is None:
        raise HTTPException(status_code=404, detail="unknown taxonomy")
    result = inference.classify(text, taxonomy["taxonomy_id"], taxonomy["version"])
    labels, unknown = bind_labels(result["labels"], taxonomy)
    logger.info("classify tenant=%s taxonomy=%s version=%s unknown=%d", tenant, taxonomy["taxonomy_id"], taxonomy["version"], len(unknown))
    return {
        "taxonomy_id": taxonomy["taxonomy_id"],
        "taxonomy_version": taxonomy["version"],
        "labels": labels,
        "unknown_labels": unknown,
        "provenance": result["provenance"],
        "model_version": result["model_version"],
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {REVIEW_LABEL} from 'classifier/config';
import {classify} from 'classifier/inference';
import * as taxonomies from 'classifier/taxonomies';

export const app = Fastify();

interface ClassifyBody {
  taxonomy_id: string;
  taxonomy_version?: number | null;
  mime_type: string;
  text: string;
}

app.post('/v1/classify', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  const body = request.body as ClassifyBody;
  const taxonomy = await taxonomies.byId(body.taxonomy_id);
  if (taxonomy === null) return reply.code(404).send({error: 'unknown taxonomy'});
  const result = await classify(body.text, taxonomy.taxonomy_id, taxonomy.version);
  console.info(\`classify tenant=\${tenant} taxonomy=\${taxonomy.taxonomy_id} version=\${taxonomy.version}\`);
  return {
    taxonomy_id: taxonomy.taxonomy_id,
    taxonomy_version: taxonomy.version,
    labels: result.labels,
    unknown_labels: [],
    provenance: result.provenance,
    model_version: result.model_version,
  };
});
`,
      solution: `import Fastify from 'fastify';

import {REVIEW_LABEL} from 'classifier/config';
import {classify} from 'classifier/inference';
import * as taxonomies from 'classifier/taxonomies';

export const app = Fastify();

export const MAX_TEXT_BYTES = 1 << 16;

interface ClassifyBody {
  taxonomy_id: string;
  taxonomy_version?: number | null;
  mime_type: string;
  text: string;
}

/** Keep the labels the taxonomy version contains; an invented one is reported and routes to review. */
export function bindLabels(rawLabels: string[], taxonomy: taxonomies.Taxonomy): {labels: string[]; unknown: string[]} {
  const labels = rawLabels.filter(label => taxonomy.labels.includes(label));
  const unknown = rawLabels.filter(label => !taxonomy.labels.includes(label) && label !== REVIEW_LABEL);
  if (unknown.length > 0 || labels.length === 0) labels.push(REVIEW_LABEL);
  return {labels, unknown};
}

app.post('/v1/classify', async (request, reply) => {
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  if (tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as ClassifyBody;
  // Every guard is cheaper than the model call it protects.
  if (!String(body.mime_type ?? '').startsWith('text/')) return reply.code(415).send({error: 'only text/* documents can be classified'});
  const text = String(body.text ?? '').trim();
  if (text === '') return reply.code(400).send({error: 'text is empty'});
  if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) return reply.code(413).send({error: 'text exceeds 64 KiB'});
  const taxonomy = await taxonomies.load(tenant, body.taxonomy_id, body.taxonomy_version ?? null);
  if (taxonomy === null) return reply.code(404).send({error: 'unknown taxonomy'});
  const result = await classify(text, taxonomy.taxonomy_id, taxonomy.version);
  const {labels, unknown} = bindLabels(result.labels, taxonomy);
  console.info(\`classify tenant=\${tenant} taxonomy=\${taxonomy.taxonomy_id} version=\${taxonomy.version} unknown=\${unknown.length}\`);
  return {
    taxonomy_id: taxonomy.taxonomy_id,
    taxonomy_version: taxonomy.version,
    labels,
    unknown_labels: unknown,
    provenance: result.provenance,
    model_version: result.model_version,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"classifier/inference"  // inference.Classify(ctx, text, taxonomyID, version) (inference.Result, error)
	"classifier/taxonomies" // taxonomies.Load, ByID
)

type classifyRequest struct {
	TaxonomyID      string \`json:"taxonomy_id"\`
	TaxonomyVersion int    \`json:"taxonomy_version"\`
	MimeType        string \`json:"mime_type"\`
	Text            string \`json:"text"\`
}

type classifyResponse struct {
	TaxonomyID      string   \`json:"taxonomy_id"\`
	TaxonomyVersion int      \`json:"taxonomy_version"\`
	Labels          []string \`json:"labels"\`
	UnknownLabels   []string \`json:"unknown_labels"\`
	Provenance      string   \`json:"provenance"\`
	ModelVersion    string   \`json:"model_version"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func classifyDocument(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	var body classifyRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "malformed body", http.StatusBadRequest)
		return
	}
	taxonomy, err := taxonomies.ByID(r.Context(), body.TaxonomyID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if taxonomy == nil {
		http.Error(rw, "unknown taxonomy", http.StatusNotFound)
		return
	}
	result, err := inference.Classify(r.Context(), body.Text, taxonomy.TaxonomyID, taxonomy.Version)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusBadGateway)
		return
	}
	log.Printf("classify tenant=%s taxonomy=%s version=%d", tenant, taxonomy.TaxonomyID, taxonomy.Version)
	writeJSON(rw, http.StatusOK, classifyResponse{
		TaxonomyID:      taxonomy.TaxonomyID,
		TaxonomyVersion: taxonomy.Version,
		Labels:          result.Labels,
		UnknownLabels:   []string{},
		Provenance:      result.Provenance,
		ModelVersion:    result.ModelVersion,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/classify", classifyDocument)
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"classifier/config"
	"classifier/inference"  // inference.Classify(ctx, text, taxonomyID, version) (inference.Result, error)
	"classifier/taxonomies" // taxonomies.Load, ByID
)

const maxTextBytes = 1 << 16

type classifyRequest struct {
	TaxonomyID      string \`json:"taxonomy_id"\`
	TaxonomyVersion int    \`json:"taxonomy_version"\`
	MimeType        string \`json:"mime_type"\`
	Text            string \`json:"text"\`
}

type classifyResponse struct {
	TaxonomyID      string   \`json:"taxonomy_id"\`
	TaxonomyVersion int      \`json:"taxonomy_version"\`
	Labels          []string \`json:"labels"\`
	UnknownLabels   []string \`json:"unknown_labels"\`
	Provenance      string   \`json:"provenance"\`
	ModelVersion    string   \`json:"model_version"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// bindLabels keeps the labels the taxonomy version contains; an invented one is reported and routes to review.
func bindLabels(raw []string, taxonomy *taxonomies.Taxonomy) ([]string, []string) {
	allowed := map[string]bool{}
	for _, label := range taxonomy.Labels {
		allowed[label] = true
	}
	labels, unknown := []string{}, []string{}
	for _, label := range raw {
		if allowed[label] {
			labels = append(labels, label)
		} else if label != config.ReviewLabel {
			unknown = append(unknown, label)
		}
	}
	if len(unknown) > 0 || len(labels) == 0 {
		labels = append(labels, config.ReviewLabel)
	}
	return labels, unknown
}

func classifyDocument(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "missing X-Tenant-Id", http.StatusUnauthorized)
		return
	}
	var body classifyRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "malformed body", http.StatusBadRequest)
		return
	}
	// Every guard is cheaper than the model call it protects.
	if !strings.HasPrefix(body.MimeType, "text/") {
		http.Error(rw, "only text/* documents can be classified", http.StatusUnsupportedMediaType)
		return
	}
	text := strings.TrimSpace(body.Text)
	if text == "" {
		http.Error(rw, "text is empty", http.StatusBadRequest)
		return
	}
	if len(text) > maxTextBytes {
		http.Error(rw, "text exceeds 64 KiB", http.StatusRequestEntityTooLarge)
		return
	}
	taxonomy, err := taxonomies.Load(r.Context(), tenant, body.TaxonomyID, body.TaxonomyVersion)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if taxonomy == nil {
		http.Error(rw, "unknown taxonomy", http.StatusNotFound)
		return
	}
	result, err := inference.Classify(r.Context(), text, taxonomy.TaxonomyID, taxonomy.Version)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusBadGateway)
		return
	}
	labels, unknown := bindLabels(result.Labels, taxonomy)
	log.Printf("classify tenant=%s taxonomy=%s version=%d unknown=%d", tenant, taxonomy.TaxonomyID, taxonomy.Version, len(unknown))
	writeJSON(rw, http.StatusOK, classifyResponse{
		TaxonomyID:      taxonomy.TaxonomyID,
		TaxonomyVersion: taxonomy.Version,
		Labels:          labels,
		UnknownLabels:   unknown,
		Provenance:      result.Provenance,
		ModelVersion:    result.ModelVersion,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/classify", classifyDocument)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import classifier.{Config, Inference, Taxonomies}

object ClassifyApi {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def strings(values: Seq[String]): JsArray = JsArray(values.map(JsString(_)).toVector)

  private def text(fields: Map[String, JsValue], name: String): String =
    fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  val route: Route = path("v1" / "classify") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        entity(as[String]) { raw =>
          // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
          val body = raw.parseJson.asJsObject.fields
          Taxonomies.byId(text(body, "taxonomy_id")) match {
            case None => complete(StatusCodes.NotFound -> "unknown taxonomy")
            case Some(taxonomy) =>
              val result = Inference.classify(text(body, "text"), taxonomy.taxonomyId, taxonomy.version)
              System.err.println(s"classify tenant=\${tenant.getOrElse("")} taxonomy=\${taxonomy.taxonomyId} version=\${taxonomy.version}")
              complete(
                json(
                  StatusCodes.OK,
                  JsObject(
                    "taxonomy_id" -> JsString(taxonomy.taxonomyId),
                    "taxonomy_version" -> JsNumber(taxonomy.version),
                    "labels" -> strings(result.labels),
                    "unknown_labels" -> strings(Seq.empty),
                    "provenance" -> JsString(result.provenance),
                    "model_version" -> JsString(result.modelVersion)
                  )
                )
              )
          }
        }
      }
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets.UTF_8

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import classifier.{Config, Inference, Taxonomies, Taxonomy}

object ClassifyApi {
  val MaxTextBytes: Int = 1 << 16

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def strings(values: Seq[String]): JsArray = JsArray(values.map(JsString(_)).toVector)

  private def text(fields: Map[String, JsValue], name: String): String =
    fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  /** Keep the labels the taxonomy version contains; an invented one is reported and routes to review. */
  def bindLabels(raw: Seq[String], taxonomy: Taxonomy): (Seq[String], Seq[String]) = {
    val known = raw.filter(taxonomy.labels.contains)
    val unknown = raw.filterNot(label => taxonomy.labels.contains(label) || label == Config.ReviewLabel)
    (if (unknown.nonEmpty || known.isEmpty) known :+ Config.ReviewLabel else known, unknown)
  }

  val route: Route = path("v1" / "classify") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "missing X-Tenant-Id")
        case Some(tenant) =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject.fields
            val document = text(body, "text").trim
            val version = body.get("taxonomy_version").collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
            // Every guard is cheaper than the model call it protects.
            if (!text(body, "mime_type").startsWith("text/"))
              complete(StatusCodes.UnsupportedMediaType -> "only text/* documents can be classified")
            else if (document.isEmpty) complete(StatusCodes.BadRequest -> "text is empty")
            else if (document.getBytes(UTF_8).length > MaxTextBytes) complete(StatusCodes.RequestEntityTooLarge -> "text exceeds 64 KiB")
            else
              Taxonomies.load(tenant, text(body, "taxonomy_id"), version) match {
                case None => complete(StatusCodes.NotFound -> "unknown taxonomy")
                case Some(taxonomy) =>
                  val result = Inference.classify(document, taxonomy.taxonomyId, taxonomy.version)
                  val (labels, unknown) = bindLabels(result.labels, taxonomy)
                  complete(
                    json(
                      StatusCodes.OK,
                      JsObject(
                        "taxonomy_id" -> JsString(taxonomy.taxonomyId),
                        "taxonomy_version" -> JsNumber(taxonomy.version),
                        "labels" -> strings(labels),
                        "unknown_labels" -> strings(unknown),
                        "provenance" -> JsString(result.provenance),
                        "model_version" -> JsString(result.modelVersion)
                      )
                    )
                  )
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

#include "classifier/config.h"
#include "classifier/inference.h"   // inference::classify(text, taxonomy_id, version) -> inference::Result
#include "classifier/taxonomies.h"  // taxonomies::load, byId

using json = nlohmann::json;

void classify_document(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) {
    res.status = 400;
    res.set_content("malformed body", "text/plain");
    return;
  }
  const auto taxonomy = taxonomies::byId(body.value("taxonomy_id", ""));
  if (!taxonomy) {
    res.status = 404;
    res.set_content("unknown taxonomy", "text/plain");
    return;
  }
  const inference::Result result = inference::classify(body.value("text", ""), taxonomy->taxonomy_id, taxonomy->version);
  std::cerr << "classify tenant=" << tenant << " taxonomy=" << taxonomy->taxonomy_id << " version=" << taxonomy->version << "\\n";
  res.set_content(json{{"taxonomy_id", taxonomy->taxonomy_id},
                       {"taxonomy_version", taxonomy->version},
                       {"labels", result.labels},
                       {"unknown_labels", json::array()},
                       {"provenance", result.provenance},
                       {"model_version", result.model_version}}
                      .dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/classify", classify_document); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

#include "classifier/config.h"
#include "classifier/inference.h"   // inference::classify(text, taxonomy_id, version) -> inference::Result
#include "classifier/taxonomies.h"  // taxonomies::load, byId

using json = nlohmann::json;

constexpr size_t kMaxTextBytes = 1 << 16;

std::string trim(const std::string& s) {
  const auto first = s.find_first_not_of(" \\t\\r\\n\\f\\v");
  if (first == std::string::npos) return "";
  return s.substr(first, s.find_last_not_of(" \\t\\r\\n\\f\\v") - first + 1);
}

// Keep the labels the taxonomy version contains; an invented one is reported and routes to review.
std::pair<std::vector<std::string>, std::vector<std::string>> bind_labels(const std::vector<std::string>& raw,
                                                                         const taxonomies::Taxonomy& taxonomy) {
  std::vector<std::string> labels, unknown;
  for (const auto& label : raw) {
    if (std::find(taxonomy.labels.begin(), taxonomy.labels.end(), label) != taxonomy.labels.end())
      labels.push_back(label);
    else if (label != config::kReviewLabel)
      unknown.push_back(label);
  }
  if (!unknown.empty() || labels.empty()) labels.push_back(config::kReviewLabel);
  return {labels, unknown};
}

void reject(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(message, "text/plain");
}

void classify_document(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reject(res, 401, "missing X-Tenant-Id");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reject(res, 400, "malformed body");
  // Every guard is cheaper than the model call it protects.
  if (body.value("mime_type", "").rfind("text/", 0) != 0) return reject(res, 415, "only text/* documents can be classified");
  const std::string text = trim(body.value("text", ""));
  if (text.empty()) return reject(res, 400, "text is empty");
  if (text.size() > kMaxTextBytes) return reject(res, 413, "text exceeds 64 KiB");
  const long version = body.contains("taxonomy_version") && body["taxonomy_version"].is_number() ? body["taxonomy_version"].get<long>() : 0;
  const auto taxonomy = taxonomies::load(tenant, body.value("taxonomy_id", ""), version);
  if (!taxonomy) return reject(res, 404, "unknown taxonomy");
  const inference::Result result = inference::classify(text, taxonomy->taxonomy_id, taxonomy->version);
  const auto [labels, unknown] = bind_labels(result.labels, *taxonomy);
  std::cerr << "classify tenant=" << tenant << " taxonomy=" << taxonomy->taxonomy_id << " version=" << taxonomy->version
            << " unknown=" << unknown.size() << "\\n";
  res.set_content(json{{"taxonomy_id", taxonomy->taxonomy_id},
                       {"taxonomy_version", taxonomy->version},
                       {"labels", labels},
                       {"unknown_labels", unknown},
                       {"provenance", result.provenance},
                       {"model_version", result.model_version}}
                      .dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/classify", classify_document); }
`,
    },
  },
  harness: {
    python: `import content_classifier_pb2
import content_classifier_pb2_grpc
from classifier import config, labeler, taxonomies

TEXT = "I was charged twice, please refund"
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=="


class ModelServicer(content_classifier_pb2_grpc.ModelServicer):
    """The stand-in model: answers from classifier.labeler."""

    def Classify(self, request, context):
        labels, refused = labeler.classify(request.text)
        return content_classifier_pb2.ClassifyReply(labels=labels, refused=refused, model_version=labeler.MODEL_VERSION)


def _api(ctx):
    ctx.grpc.serve(content_classifier_pb2_grpc.add_ModelServicer_to_server, ModelServicer(), config.MODEL)
    taxonomies.put_version("acme", "tx-support", ["billing", "support", "security"])
    taxonomies.put_version("globex", "tx-legal", ["billing", "legal"])
    return ctx.client(ctx.load("api").app)


async def _classify(c, text=TEXT, tenant="acme", taxonomy_id="tx-support", mime_type="text/plain", version=None):
    body = {"taxonomy_id": taxonomy_id, "mime_type": mime_type, "text": text}
    if version is not None:
        body["taxonomy_version"] = version
    headers = {"X-Tenant-Id": tenant} if tenant else {}
    return await c.post("/v1/classify", json=body, headers=headers)


def _calls(ctx):
    return len(ctx.grpc.calls_to("Classify"))


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _classify(c)
    assert r.status_code == 200, f"POST /v1/classify answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("labels") == ["billing"], f"a refund question must be labeled billing, got {body}"
    assert body.get("taxonomy_id") == "tx-support" and body.get("taxonomy_version") == 1, f"the response must name taxonomy tx-support version 1, got {body}"
    assert body.get("provenance") == "model" and body.get("model_version") == labeler.MODEL_VERSION, f"the response must carry the model's provenance and version, got {body}"
    assert _calls(ctx) == 1, f"one document must cost one model call, saw {_calls(ctx)}"


async def check_content_type(ctx):
    async with _api(ctx) as c:
        r = await _classify(c, text=PNG, mime_type="image/png")
        assert r.status_code == 415, f"a document of type image/png answered {r.status_code}, expected 415: {r.text}"
        assert _calls(ctx) == 0, f"the image's bytes reached the model ({_calls(ctx)} Classify calls): only text/* may be classified"
        r = await _classify(c, mime_type="application/octet-stream")
        assert r.status_code == 415, f"a document of type application/octet-stream answered {r.status_code}, expected 415"
        assert _calls(ctx) == 0, "an octet stream reached the model"
        r = await _classify(c, mime_type="text/markdown")
    assert r.status_code == 200, f"a text/markdown document is text and must be classified, got {r.status_code}: {r.text}"


async def check_size_and_empty(ctx):
    async with _api(ctx) as c:
        r = await _classify(c, text="   \\n\\t  ")
        assert r.status_code == 400, f"a document of whitespace answered {r.status_code}, expected 400"
        assert _calls(ctx) == 0, "an empty document reached the model"
        r = await _classify(c, text="a" * (64 * 1024 + 1))
        assert r.status_code == 413, f"a document of 64 KiB + 1 byte answered {r.status_code}, expected 413"
        r = await _classify(c, text="é" * 40000)
        assert r.status_code == 413, f"40000 accented letters are 80000 bytes of UTF-8 and answered {r.status_code}, expected 413: the cap counts bytes, not characters"
        assert _calls(ctx) == 0, f"an oversized document reached the model ({_calls(ctx)} Classify calls)"
        r = await _classify(c, text="  " + "a" * (64 * 1024) + "  ")
    assert r.status_code == 200, f"64 KiB of text with surrounding spaces answered {r.status_code}: the cap applies to the trimmed text"


async def check_tenant_scope(ctx):
    async with _api(ctx) as c:
        r = await _classify(c, tenant="")
        assert r.status_code == 401, f"a request without X-Tenant-Id answered {r.status_code}, expected 401"
        r = await _classify(c, tenant="globex")
        assert r.status_code == 404, f"tenant globex classified against acme's taxonomy tx-support and got {r.status_code}, expected 404"
        assert _calls(ctx) == 0, "a request for another tenant's taxonomy reached the model"
        taxonomies.put_version("acme", "tx-support", ["billing", "support", "security", "abuse"])
        r = await _classify(c, version=1)
        assert r.status_code == 200 and r.json().get("taxonomy_version") == 1, f"a request for version 1 must be classified against version 1, got {r.status_code} {r.text}"
        r = await _classify(c)
    assert r.status_code == 200 and r.json().get("taxonomy_version") == 2, f"without a version the latest (2) applies, got {r.status_code} {r.text}"


async def check_taxonomy_binding(ctx):
    async with _api(ctx) as c:
        r = await _classify(c, text="refund my invoice #urgent")
        body = r.json()
        assert r.status_code == 200, f"POST /v1/classify answered {r.status_code}: {r.text}"
        assert body.get("labels") == ["billing", "review"], f"the model invented 'urgent', which tx-support does not contain: labels must be ['billing', 'review'], got {body.get('labels')}"
        assert body.get("unknown_labels") == ["urgent"], f"the invented label must be reported in unknown_labels, got {body.get('unknown_labels')}"
        body = (await _classify(c, text="hello there #weather")).json()
        assert body.get("labels") == ["review"] and body.get("unknown_labels") == ["weather"], f"with no known label the document goes to review alone, got {body}"
        body = (await _classify(c, text="my screen is broken")).json()
    assert body.get("labels") == ["support"] and body.get("unknown_labels") == [], f"known labels pass through unchanged, got {body}"
`,
    typescript: `const TEXT = 'I was charged twice, please refund';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';

/** The stand-in model at MODEL, two tenants' taxonomies, and an HTTP client of the learner's app. */
async function api(ctx) {
  const {contentclassifier} = ctx.proto('content_classifier.proto');
  const config = ctx.load('/support/classifier/config.ts');
  const labeler = ctx.load('/support/classifier/labeler.ts');
  const taxonomies = ctx.load('/support/classifier/taxonomies.ts');
  ctx.grpc.serve(
    contentclassifier.Model.service,
    {
      Classify(call, callback) {
        const {labels, refused} = labeler.classify(call.request.text);
        callback(null, {labels, refused, model_version: labeler.MODEL_VERSION});
      },
    },
    config.MODEL,
  );
  await taxonomies.putVersion('acme', 'tx-support', ['billing', 'support', 'security']);
  await taxonomies.putVersion('globex', 'tx-legal', ['billing', 'legal']);
  return {c: ctx.client(ctx.load('api').app), labeler, taxonomies};
}

function post(c, {text = TEXT, tenant = 'acme', taxonomyId = 'tx-support', mimeType = 'text/plain', version = undefined as number | undefined} = {}) {
  const json: Record<string, unknown> = {taxonomy_id: taxonomyId, mime_type: mimeType, text};
  if (version !== undefined) json.taxonomy_version = version;
  return c.post('/v1/classify', {json, headers: tenant ? {'X-Tenant-Id': tenant} : {}});
}

const calls = ctx => ctx.grpc.callsTo('Classify').length;

export async function check_route(ctx) {
  const {c, labeler} = await api(ctx);
  const r = await post(c);
  assert.equal(r.status, 200, \`POST /v1/classify answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert.deepEqual(body.labels, ['billing'], \`a refund question must be labeled billing, got \${r.text}\`);
  assert(body.taxonomy_id === 'tx-support' && body.taxonomy_version === 1, \`the response must name taxonomy tx-support version 1, got \${r.text}\`);
  assert(body.provenance === 'model' && body.model_version === labeler.MODEL_VERSION, \`the response must carry the model's provenance and version, got \${r.text}\`);
  assert.equal(calls(ctx), 1, \`one document must cost one model call, saw \${calls(ctx)}\`);
}

export async function check_content_type(ctx) {
  const {c} = await api(ctx);
  let r = await post(c, {text: PNG, mimeType: 'image/png'});
  assert.equal(r.status, 415, \`a document of type image/png answered \${r.status}, expected 415: \${r.text}\`);
  assert.equal(calls(ctx), 0, \`the image's bytes reached the model (\${calls(ctx)} Classify calls): only text/* may be classified\`);
  r = await post(c, {mimeType: 'application/octet-stream'});
  assert.equal(r.status, 415, \`a document of type application/octet-stream answered \${r.status}, expected 415\`);
  assert.equal(calls(ctx), 0, 'an octet stream reached the model');
  r = await post(c, {mimeType: 'text/markdown'});
  assert.equal(r.status, 200, \`a text/markdown document is text and must be classified, got \${r.status}: \${r.text}\`);
}

export async function check_size_and_empty(ctx) {
  const {c} = await api(ctx);
  let r = await post(c, {text: '   \\n\\t  '});
  assert.equal(r.status, 400, \`a document of whitespace answered \${r.status}, expected 400\`);
  assert.equal(calls(ctx), 0, 'an empty document reached the model');
  r = await post(c, {text: 'a'.repeat(64 * 1024 + 1)});
  assert.equal(r.status, 413, \`a document of 64 KiB + 1 byte answered \${r.status}, expected 413\`);
  r = await post(c, {text: 'é'.repeat(40000)});
  assert.equal(r.status, 413, \`40000 accented letters are 80000 bytes of UTF-8 and answered \${r.status}, expected 413: the cap counts bytes, not characters\`);
  assert.equal(calls(ctx), 0, \`an oversized document reached the model (\${calls(ctx)} Classify calls)\`);
  r = await post(c, {text: '  ' + 'a'.repeat(64 * 1024) + '  '});
  assert.equal(r.status, 200, \`64 KiB of text with surrounding spaces answered \${r.status}: the cap applies to the trimmed text\`);
}

export async function check_tenant_scope(ctx) {
  const {c, taxonomies} = await api(ctx);
  let r = await post(c, {tenant: ''});
  assert.equal(r.status, 401, \`a request without X-Tenant-Id answered \${r.status}, expected 401\`);
  r = await post(c, {tenant: 'globex'});
  assert.equal(r.status, 404, \`tenant globex classified against acme's taxonomy tx-support and got \${r.status}, expected 404\`);
  assert.equal(calls(ctx), 0, "a request for another tenant's taxonomy reached the model");
  await taxonomies.putVersion('acme', 'tx-support', ['billing', 'support', 'security', 'abuse']);
  r = await post(c, {version: 1});
  assert(r.status === 200 && r.json().taxonomy_version === 1, \`a request for version 1 must be classified against version 1, got \${r.status} \${r.text}\`);
  r = await post(c);
  assert(r.status === 200 && r.json().taxonomy_version === 2, \`without a version the latest (2) applies, got \${r.status} \${r.text}\`);
}

export async function check_taxonomy_binding(ctx) {
  const {c} = await api(ctx);
  let r = await post(c, {text: 'refund my invoice #urgent'});
  assert.equal(r.status, 200, \`POST /v1/classify answered \${r.status}: \${r.text}\`);
  let body = r.json();
  assert.deepEqual(body.labels, ['billing', 'review'], \`the model invented 'urgent', which tx-support does not contain: labels must be ['billing', 'review'], got \${JSON.stringify(body.labels)}\`);
  assert.deepEqual(body.unknown_labels, ['urgent'], \`the invented label must be reported in unknown_labels, got \${JSON.stringify(body.unknown_labels)}\`);
  r = await post(c, {text: 'hello there #weather'});
  body = r.json();
  assert(JSON.stringify(body.labels) === '["review"]' && JSON.stringify(body.unknown_labels) === '["weather"]', \`with no known label the document goes to review alone, got \${r.text}\`);
  r = await post(c, {text: 'my screen is broken'});
  body = r.json();
  assert(JSON.stringify(body.labels) === '["support"]' && JSON.stringify(body.unknown_labels) === '[]', \`known labels pass through unchanged, got \${r.text}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"classifier/config"
	pb "classifier/gen/content_classifier"
	"classifier/labeler"
	"classifier/taxonomies"

	"leetbuild/harness"
)

const apiText = "I was charged twice, please refund"

// modelPeer is the stand-in model: answers from classifier/labeler.
type modelPeer struct {
	pb.UnimplementedModelServer
}

func (modelPeer) Classify(_ context.Context, req *pb.ClassifyRequest) (*pb.ClassifyReply, error) {
	labels, refused := labeler.Classify(req.GetText())
	return &pb.ClassifyReply{Labels: labels, Refused: refused, ModelVersion: labeler.Version}, nil
}

type apiReply struct {
	TaxonomyID      string   \`json:"taxonomy_id"\`
	TaxonomyVersion int      \`json:"taxonomy_version"\`
	Labels          []string \`json:"labels"\`
	UnknownLabels   []string \`json:"unknown_labels"\`
	Provenance      string   \`json:"provenance"\`
	ModelVersion    string   \`json:"model_version"\`
}

func api(ctx *harness.Ctx) *harness.HTTP {
	pb.RegisterModelServer(ctx.GRPC.Server(config.Model), &modelPeer{})
	_, err := taxonomies.PutVersion(context.Background(), "acme", "tx-support", []string{"billing", "support", "security"})
	ctx.NoError(err, "seeding tx-support")
	_, err = taxonomies.PutVersion(context.Background(), "globex", "tx-legal", []string{"billing", "legal"})
	ctx.NoError(err, "seeding tx-legal")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiPost(c *harness.HTTP, tenant, mimeType, text string, version int) *harness.Response {
	body := map[string]any{"taxonomy_id": "tx-support", "mime_type": mimeType, "text": text}
	if version > 0 {
		body["taxonomy_version"] = version
	}
	if tenant == "" {
		return c.Post("/v1/classify", body)
	}
	return c.Post("/v1/classify", body, "X-Tenant-Id", tenant)
}

func apiDecode(r *harness.Response) apiReply {
	var reply apiReply
	r.Decode(&reply)
	return reply
}

func apiCalls(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("Classify", "")) }

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := apiPost(c, "acme", "text/plain", apiText, 0)
	ctx.Equal(r.Status, 200, "POST /v1/classify (%s)", r.Text())
	reply := apiDecode(r)
	ctx.Equal(reply.Labels, []string{"billing"}, "a refund question must be labeled billing (%s)", r.Text())
	ctx.Assert(reply.TaxonomyID == "tx-support" && reply.TaxonomyVersion == 1, "the response must name taxonomy tx-support version 1, got %s", r.Text())
	ctx.Assert(reply.Provenance == "model" && reply.ModelVersion == labeler.Version, "the response must carry the model's provenance and version, got %s", r.Text())
	ctx.Equal(apiCalls(ctx), 1, "one document must cost one model call; Classify calls")
}

func CheckContentType(ctx *harness.Ctx) {
	c := api(ctx)
	r := apiPost(c, "acme", "image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ", 0)
	ctx.Equal(r.Status, 415, "a document of type image/png (%s)", r.Text())
	ctx.Equal(apiCalls(ctx), 0, "the image's bytes reached the model: only text/* may be classified; Classify calls")
	r = apiPost(c, "acme", "application/octet-stream", apiText, 0)
	ctx.Equal(r.Status, 415, "a document of type application/octet-stream")
	ctx.Equal(apiCalls(ctx), 0, "an octet stream reached the model; Classify calls")
	r = apiPost(c, "acme", "text/markdown", apiText, 0)
	ctx.Equal(r.Status, 200, "a text/markdown document is text and must be classified (%s)", r.Text())
}

func CheckSizeAndEmpty(ctx *harness.Ctx) {
	c := api(ctx)
	r := apiPost(c, "acme", "text/plain", "   \\n\\t  ", 0)
	ctx.Equal(r.Status, 400, "a document of whitespace")
	ctx.Equal(apiCalls(ctx), 0, "an empty document reached the model; Classify calls")
	r = apiPost(c, "acme", "text/plain", strings.Repeat("a", 64*1024+1), 0)
	ctx.Equal(r.Status, 413, "a document of 64 KiB + 1 byte")
	r = apiPost(c, "acme", "text/plain", strings.Repeat("é", 40000), 0)
	ctx.Equal(r.Status, 413, "40000 accented letters are 80000 bytes of UTF-8: the cap counts bytes, not characters")
	ctx.Equal(apiCalls(ctx), 0, "an oversized document reached the model; Classify calls")
	r = apiPost(c, "acme", "text/plain", "  "+strings.Repeat("a", 64*1024)+"  ", 0)
	ctx.Equal(r.Status, 200, "64 KiB of text with surrounding spaces: the cap applies to the trimmed text")
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := api(ctx)
	r := apiPost(c, "", "text/plain", apiText, 0)
	ctx.Equal(r.Status, 401, "a request without X-Tenant-Id")
	r = apiPost(c, "globex", "text/plain", apiText, 0)
	ctx.Equal(r.Status, 404, "tenant globex classified against acme's taxonomy tx-support")
	ctx.Equal(apiCalls(ctx), 0, "a request for another tenant's taxonomy reached the model; Classify calls")
	_, err := taxonomies.PutVersion(context.Background(), "acme", "tx-support", []string{"billing", "support", "security", "abuse"})
	ctx.NoError(err, "publishing version 2")
	r = apiPost(c, "acme", "text/plain", apiText, 1)
	ctx.Assert(r.Status == 200 && apiDecode(r).TaxonomyVersion == 1, "a request for version 1 must be classified against version 1, got %d %s", r.Status, r.Text())
	r = apiPost(c, "acme", "text/plain", apiText, 0)
	ctx.Assert(r.Status == 200 && apiDecode(r).TaxonomyVersion == 2, "without a version the latest (2) applies, got %d %s", r.Status, r.Text())
}

func CheckTaxonomyBinding(ctx *harness.Ctx) {
	c := api(ctx)
	r := apiPost(c, "acme", "text/plain", "refund my invoice #urgent", 0)
	ctx.Equal(r.Status, 200, "POST /v1/classify (%s)", r.Text())
	reply := apiDecode(r)
	ctx.Equal(reply.Labels, []string{"billing", "review"}, "the model invented 'urgent', which tx-support does not contain; the labels")
	ctx.Equal(reply.UnknownLabels, []string{"urgent"}, "the invented label must be reported in unknown_labels")
	r = apiPost(c, "acme", "text/plain", "hello there #weather", 0)
	reply = apiDecode(r)
	ctx.Assert(len(reply.Labels) == 1 && reply.Labels[0] == "review" && len(reply.UnknownLabels) == 1 && reply.UnknownLabels[0] == "weather", "with no known label the document goes to review alone, got %s", r.Text())
	r = apiPost(c, "acme", "text/plain", "my screen is broken", 0)
	reply = apiDecode(r)
	ctx.Assert(len(reply.Labels) == 1 && reply.Labels[0] == "support" && len(reply.UnknownLabels) == 0, "known labels pass through unchanged, got %s", r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "classifier/labeler.h"

namespace {

const std::string kText = "I was charged twice, please refund";

// The stand-in model: answers from classifier/labeler.h.
class ModelPeer final : public contentclassifier::Model::Service {
 public:
  grpc::Status Classify(grpc::ServerContext*, const contentclassifier::ClassifyRequest* req, contentclassifier::ClassifyReply* reply) override {
    const auto verdict = labeler::classify(req->text());
    for (const auto& label : verdict.labels) reply->add_labels(label);
    reply->set_refused(verdict.refused);
    reply->set_model_version(labeler::kVersion);
    return grpc::Status::OK;
  }
};

harness::HTTP api(harness::Ctx& ctx) {
  static ModelPeer* peer = nullptr;
  delete peer;
  peer = new ModelPeer;
  ctx.GRPC.Server(config::kModel)->RegisterService(peer);
  taxonomies::putVersion("acme", "tx-support", {"billing", "support", "security"});
  taxonomies::putVersion("globex", "tx-legal", {"billing", "legal"});
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response post(harness::HTTP& c, const std::string& tenant, const std::string& mime_type, const std::string& text, long version = 0) {
  nlohmann::json body = {{"taxonomy_id", "tx-support"}, {"mime_type", mime_type}, {"text", text}};
  if (version > 0) body["taxonomy_version"] = version;
  if (tenant.empty()) return c.Post("/v1/classify", body.dump(), "Content-Type", "application/json");
  return c.Post("/v1/classify", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant);
}

nlohmann::json decode(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

std::vector<std::string> strings(const nlohmann::json& body, const std::string& field) {
  return body.is_object() && body.contains(field) && body[field].is_array() ? body[field].get<std::vector<std::string>>() : std::vector<std::string>{"<missing>"};
}

long versionOf(const harness::Response& r) {
  const auto body = decode(r);
  return body.is_object() ? body.value("taxonomy_version", 0L) : 0L;
}

size_t calls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("Classify").size(); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = post(c, "acme", "text/plain", kText);
  ctx.Equal(r.Status, 200, "POST /v1/classify (%s)", r.Text());
  const auto body = decode(r);
  ctx.Equal(strings(body, "labels"), {"billing"}, "a refund question must be labeled billing (%s)", r.Text());
  ctx.Assert(body.value("taxonomy_id", "") == "tx-support" && versionOf(r) == 1, "the response must name taxonomy tx-support version 1, got %s", r.Text());
  ctx.Assert(body.value("provenance", "") == "model" && body.value("model_version", "") == labeler::kVersion, "the response must carry the model's provenance and version, got %s", r.Text());
  ctx.Equal(calls(ctx), 1, "one document must cost one model call; Classify calls");
}

void CheckContentType(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = post(c, "acme", "image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ");
  ctx.Equal(r.Status, 415, "a document of type image/png (%s)", r.Text());
  ctx.Equal(calls(ctx), 0, "the image's bytes reached the model: only text/* may be classified; Classify calls");
  r = post(c, "acme", "application/octet-stream", kText);
  ctx.Equal(r.Status, 415, "a document of type application/octet-stream");
  ctx.Equal(calls(ctx), 0, "an octet stream reached the model; Classify calls");
  r = post(c, "acme", "text/markdown", kText);
  ctx.Equal(r.Status, 200, "a text/markdown document is text and must be classified (%s)", r.Text());
}

void CheckSizeAndEmpty(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = post(c, "acme", "text/plain", "   \\n\\t  ");
  ctx.Equal(r.Status, 400, "a document of whitespace");
  ctx.Equal(calls(ctx), 0, "an empty document reached the model; Classify calls");
  r = post(c, "acme", "text/plain", std::string(64 * 1024 + 1, 'a'));
  ctx.Equal(r.Status, 413, "a document of 64 KiB + 1 byte");
  std::string accented;
  for (int i = 0; i < 40000; i++) accented += "é";
  r = post(c, "acme", "text/plain", accented);
  ctx.Equal(r.Status, 413, "40000 accented letters are 80000 bytes of UTF-8: the cap counts bytes, not characters");
  ctx.Equal(calls(ctx), 0, "an oversized document reached the model; Classify calls");
  r = post(c, "acme", "text/plain", "  " + std::string(64 * 1024, 'a') + "  ");
  ctx.Equal(r.Status, 200, "64 KiB of text with surrounding spaces: the cap applies to the trimmed text");
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = post(c, "", "text/plain", kText);
  ctx.Equal(r.Status, 401, "a request without X-Tenant-Id");
  r = post(c, "globex", "text/plain", kText);
  ctx.Equal(r.Status, 404, "tenant globex classified against acme's taxonomy tx-support");
  ctx.Equal(calls(ctx), 0, "a request for another tenant's taxonomy reached the model; Classify calls");
  taxonomies::putVersion("acme", "tx-support", {"billing", "support", "security", "abuse"});
  r = post(c, "acme", "text/plain", kText, 1);
  ctx.Assert(r.Status == 200 && versionOf(r) == 1, "a request for version 1 must be classified against version 1, got %d %s", r.Status, r.Text());
  r = post(c, "acme", "text/plain", kText);
  ctx.Assert(r.Status == 200 && versionOf(r) == 2, "without a version the latest (2) applies, got %d %s", r.Status, r.Text());
}

void CheckTaxonomyBinding(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = post(c, "acme", "text/plain", "refund my invoice #urgent");
  ctx.Equal(r.Status, 200, "POST /v1/classify (%s)", r.Text());
  auto body = decode(r);
  ctx.Equal(strings(body, "labels"), {"billing", "review"}, "the model invented 'urgent', which tx-support does not contain; the labels");
  ctx.Equal(strings(body, "unknown_labels"), {"urgent"}, "the invented label must be reported in unknown_labels");
  r = post(c, "acme", "text/plain", "hello there #weather");
  body = decode(r);
  ctx.Assert(strings(body, "labels") == std::vector<std::string>{"review"} && strings(body, "unknown_labels") == std::vector<std::string>{"weather"},
             "with no known label the document goes to review alone, got %s", r.Text());
  r = post(c, "acme", "text/plain", "my screen is broken");
  body = decode(r);
  ctx.Assert(strings(body, "labels") == std::vector<std::string>{"support"} && strings(body, "unknown_labels").empty(),
             "known labels pass through unchanged, got %s", r.Text());
}
`,
  },
  hints: [
    'A screenshot posted as `image/png` comes back with labels, a blank document still costs a model call, tenant globex gets 200 for acme’s taxonomy, and a hashtag the model made up shows as a label.',
    'The handler never looks at `mime_type` or the text’s size; `by_id` finds a taxonomy whoever owns it and ignores the requested version; and the response copies the model’s labels without asking the version which of them exist.',
    '401 without a tenant; 415 unless `mime_type` starts with `text/`; trim, then 400 when empty and 413 over `MAX_TEXT_BYTES` in UTF-8 bytes; `taxonomies.load(tenant, taxonomy_id, version)` or 404; then `bind_labels(result["labels"], taxonomy)`.',
  ],
  debrief: `The guards run before the model call because each one is cheaper than the call it protects, and they measure what the model would see: the trimmed text in UTF-8 bytes, since a character count lets 40,000 accented letters past a 64 KiB cap. The lookup carries the tenant because a taxonomy is tenant data; the store answers nothing for a foreign id, so the 404 does not even confirm the id exists. Binding is an intersection: the model proposes strings, the version decides which exist, and the leftovers go to review by name so someone can act on them. Production classifiers add a confidence threshold below which a known label still goes to review, and track the invented-label rate per taxonomy so its owners learn when the label set needs work.`,
};
