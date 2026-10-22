import type {Step} from '@/lib/types';

export const translateEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/translations: validated language pairs and glossary binding',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'glossary', 'detector'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route,
parses the body, calls the detector and returns a translation. It compiles, it serves the demo, and
it hides three production flaws. Review it like the service owner, fix it, and prove the fix with
the checks below.

Implement \`POST /v1/translations\` with body \`{"text": "…", "source": "en", "target": "fr",
"glossary_version": "…"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`text\` is a non-empty string of at most **16 KiB** (\`1 << 14\` bytes) of UTF-8; a larger text is
  **413**.
- \`source\` and \`target\` must both be in the platform allowlist
  (\`en\`, \`fr\`, \`de\`, \`es\`, \`ja\`, \`pt\`); anything else is **400**. A **400** for
  \`source == target\`: translating into the source language is a caller bug, not a no-op.
- \`glossary_version\` names the tenant's glossary version to bind for the whole request. An unknown
  version is **404** — never silently ignored, because a translation that ignores its glossary ships
  terms the customer forbade.
- When confident detection says the text is already in the target language, return the input text
  with an explicit untranslated marker (\`"marker": "untranslated"\`) rather than a plain success that
  downstream caches as a real translation.

**Failure mode the checks target.** Trusting the caller's language tags turns an allowlist into a
suggestion; ignoring the glossary version makes a bound glossary a decorative field; and an
unmarked identity translation is the quiet one: a UI stamps English text as French, the CDN caches
it, and no downstream system can tell a fallback from a translation.`,
  sequence: {
    participants: ['Client', 'Translation API', 'Glossary store', 'Language detector'],
    messages: [
      {from: 'Client', to: 'Translation API', label: 'POST /v1/translations · X-Tenant-Id', kind: 'sync'},
      {from: 'Translation API', to: 'Translation API', label: 'validate text · pair · glossary_version', kind: 'sync'},
      {from: 'Translation API', to: 'Glossary store', label: 'resolveGlossary(tenant, version)', kind: 'sync'},
      {from: 'Glossary store', to: 'Translation API', label: 'terms + version / unknown', kind: 'reply'},
      {from: 'Translation API', to: 'Language detector', label: 'detect(text)', kind: 'sync'},
      {from: 'Language detector', to: 'Translation API', label: 'detected language', kind: 'reply'},
      {from: 'Translation API', to: 'Client', label: '200 {translation, glossary_version} / marker', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/translations',
      detail: 'Register the translation route on `POST /v1/translations`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/translations["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/translations['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/translations"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"translations"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/translations"/]},
      },
    },
    {
      id: 'text-cap',
      title: 'Caps the text at 16 KiB and rejects an empty body',
      detail:
        '`text` over `1 << 14` bytes is **413**; an empty or non-string `text` is **400**. The draft reads `text` without touching either cap, so one request can push an unbounded payload into the detector and the model.',
      match: {
        python: {all: [/MAX_TEXT_BYTES/, /status_code\s*=\s*413/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_TEXT_BYTES/, /code\(\s*413\s*\)/, /code\(\s*400\s*\)/]},
        go: {all: [/maxTextBytes/, /StatusRequestEntityTooLarge/, /StatusBadRequest/]},
        scala: {all: [/MaxTextBytes/, /StatusCodes\.RequestEntityTooLarge/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxTextBytes/, /\b413\b/, /\b400\b/]},
      },
    },
    {
      id: 'language-pair',
      title: 'Checks both languages against the platform allowlist',
      detail:
        '`source` and `target` are checked against `en`/`fr`/`de`/`es`/`ja`/`pt` and an unknown code is **400**. The draft accepts any tag the caller sends.',
      match: {
        python: {all: [/ALLOWED_LANGUAGES/, /status_code\s*=\s*400/]},
        typescript: {all: [/ALLOWED_LANGUAGES/, /code\(\s*400\s*\)/]},
        go: {all: [/allowedLanguages/, /StatusBadRequest/]},
        scala: {all: [/AllowedLanguages/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kAllowedLanguages/, /\b400\b/]},
      },
    },
    {
      id: 'same-language',
      title: 'Refuses to translate into the source language and marks identity',
      detail:
        '`source == target` is **400**, and a confident detection that the text is already in the target language returns the input text with an `untranslated` marker instead of a plain success. The draft returns that input as a normal translation with the target locale stamped on it.',
      match: {
        python: {all: [/SAME_LANGUAGE/, /UNTRANSLATED_MARKER/, /status_code\s*=\s*400/]},
        typescript: {all: [/SAME_LANGUAGE/, /UNTRANSLATED_MARKER/, /code\(\s*400\s*\)/]},
        go: {all: [/sameLanguage/, /untranslatedMarker/, /StatusBadRequest/]},
        scala: {all: [/SameLanguage/, /UntranslatedMarker/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kSameLanguage/, /kUntranslatedMarker/, /\b400\b/]},
      },
    },
    {
      id: 'glossary-binding',
      title: 'Binds the request to the tenant glossary version',
      detail:
        'The glossary is resolved by `(tenant, version)` and an unknown version is **404**; the resolved terms travel with the request. The draft never resolves the version, so a caller that asks for a version that does not exist is translated with no glossary at all.',
      match: {
        python: {all: [/resolve_glossary/, /status_code\s*=\s*404/]},
        typescript: {all: [/resolveGlossary/, /code\(\s*404\s*\)/]},
        go: {all: [/resolveGlossary/, /StatusNotFound/]},
        scala: {all: [/resolveGlossary/, /StatusCodes\.NotFound/]},
        cpp: {all: [/resolveGlossary/, /\b404\b/]},
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
logger = logging.getLogger("translate")


class TranslateRequest(BaseModel):
    text: str
    source: str
    target: str
    glossary_version: str = "latest"


def detect_language(text: str) -> str:
    """Confident language id for the text; the real detector service answers here."""
    raise NotImplementedError


def translate_text(text: str, source: str, target: str) -> str:
    raise NotImplementedError


@app.post("/v1/translations")
def translate(body: TranslateRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft trusts any language tags, ignores glossary_version entirely, and reports the
    # input text as a successful translation when the detector says the source is already the
    # target. Review all three before this reaches production.
    if detect_language(body.text) == body.target:
        return JSONResponse({"translation": body.text, "target": body.target}, status_code=200)
    logger.info("translate tenant=%s source=%s target=%s", tenant, body.source, body.target)
    return JSONResponse({"translation": translate_text(body.text, body.source, body.target)}, status_code=200)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("translate")

MAX_TEXT_BYTES = 1 << 14
ALLOWED_LANGUAGES = {"en", "fr", "de", "es", "ja", "pt"}
SAME_LANGUAGE = "same-language"
UNTRANSLATED_MARKER = "untranslated"


class TranslateRequest(BaseModel):
    text: str
    source: str
    target: str
    glossary_version: str


class GlossaryStore:
    def resolve_glossary(self, tenant: str, version: str) -> list[dict] | None:
        """The tenant's glossary at exactly this version, or None when the version is unknown."""
        raise NotImplementedError


class MtClient:
    def translate(self, text: str, source: str, target: str, terms: list[dict]) -> str:
        raise NotImplementedError


glossaries = GlossaryStore()
mt = MtClient()


def detect_language(text: str) -> str:
    raise NotImplementedError


@app.post("/v1/translations")
def translate(
    body: TranslateRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if body.text == "":
        raise HTTPException(status_code=400, detail="text must be a non-empty string")
    if len(body.text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise HTTPException(status_code=413, detail="text exceeds 16 KiB")
    if body.source not in ALLOWED_LANGUAGES or body.target not in ALLOWED_LANGUAGES:
        raise HTTPException(status_code=400, detail="unsupported language code")
    if body.source == body.target:
        raise HTTPException(status_code=400, detail=SAME_LANGUAGE)

    terms = glossaries.resolve_glossary(tenant, body.glossary_version)
    if terms is None:
        raise HTTPException(status_code=404, detail="unknown glossary version")

    if detect_language(body.text) == body.target:
        return JSONResponse(
            {
                "request_id": str(uuid.uuid4()),
                "marker": UNTRANSLATED_MARKER,
                "translation": body.text,
                "source": body.source,
                "target": body.target,
                "glossary_version": body.glossary_version,
            },
            status_code=200,
        )

    translation = mt.translate(body.text, body.source, body.target, terms)
    logger.info(
        "translate tenant=%s source=%s target=%s glossary=%s",
        tenant,
        body.source,
        body.target,
        body.glossary_version,
    )
    return JSONResponse(
        {
            "request_id": str(uuid.uuid4()),
            "translation": translation,
            "source": body.source,
            "target": body.target,
            "glossary_version": body.glossary_version,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/translations: a model-generated draft that trusts its caller. */
import Fastify from 'fastify';

import {detectLanguage} from './detector';
import {translateText} from './mt';

export const app = Fastify();

interface TranslateBody {
  text: string;
  source: string;
  target: string;
  glossary_version?: string;
}

app.post('/v1/translations', async (request, reply) => {
  // TODO: this draft trusts any language tags, ignores glossary_version entirely, and reports the
  // input text as a successful translation when the detector says the source is already the
  // target. Review all three.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as TranslateBody;
  if ((await detectLanguage(body.text)) === body.target)
    return reply.code(200).send({translation: body.text, target: body.target});
  request.log.info({tenant, source: body.source, target: body.target}, 'translated');
  return reply.code(200).send({translation: await translateText(body.text, body.source, body.target)});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/translations: validated pair, a bound glossary version, and marked identity. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {detectLanguage} from './detector';
import {glossaries} from './glossary';
import {mt} from './mt';

export const app = Fastify();

const MAX_TEXT_BYTES = 1 << 14;
const ALLOWED_LANGUAGES: Record<string, true> = {en: true, fr: true, de: true, es: true, ja: true, pt: true};
const SAME_LANGUAGE = 'same-language';
const UNTRANSLATED_MARKER = 'untranslated';

interface TranslateBody {
  text: string;
  source: string;
  target: string;
  glossary_version: string;
}

app.post('/v1/translations', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const body = request.body as Partial<TranslateBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.text !== 'string' || body.text === '')
    return reply.code(400).send({error: 'text must be a non-empty string'});
  if (Buffer.byteLength(body.text, 'utf8') > MAX_TEXT_BYTES)
    return reply.code(413).send({error: 'text exceeds 16 KiB'});

  const source = body.source ?? '';
  const target = body.target ?? '';
  if (ALLOWED_LANGUAGES[source] !== true || ALLOWED_LANGUAGES[target] !== true)
    return reply.code(400).send({error: 'unsupported language code'});
  if (source === target) return reply.code(400).send({error: SAME_LANGUAGE});

  const version = body.glossary_version ?? '';
  const terms = await glossaries.resolveGlossary(tenant, version);
  if (terms === null) return reply.code(404).send({error: 'unknown glossary version'});

  if ((await detectLanguage(body.text)) === target)
    return reply.code(200).send({
      request_id: randomUUID(),
      marker: UNTRANSLATED_MARKER,
      translation: body.text,
      source,
      target,
      glossary_version: version,
    });

  const translation = await mt.translate(body.text, source, target, terms);
  request.log.info({tenant, source, target, glossary_version: version}, 'translated');
  return reply.code(200).send({request_id: randomUUID(), translation, source, target, glossary_version: version});
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

type TranslateRequest struct {
	Text            string \`json:"text"\`
	Source          string \`json:"source"\`
	Target          string \`json:"target"\`
	GlossaryVersion string \`json:"glossary_version"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func translate(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body TranslateRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft trusts any language tags, ignores GlossaryVersion entirely, and reports the
	// input text as a successful translation when the detector says the source is already the
	// target. Review all three.
	detected, _ := detectLanguage(body.Text)
	if detected == body.Target {
		writeJSON(rw, http.StatusOK, map[string]any{"translation": body.Text, "target": body.Target})
		return
	}
	out, _ := translateText(r.Context(), body.Text, body.Source, body.Target)
	log.Printf("translate tenant=%s source=%s target=%s", tenant, body.Source, body.Target)
	writeJSON(rw, http.StatusOK, map[string]any{"translation": out})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/translations", translate)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"github.com/google/uuid"
)

const (
	maxTextBytes       = 1 << 14
	sameLanguage       = "same-language"
	untranslatedMarker = "untranslated"
)

var allowedLanguages = map[string]bool{"en": true, "fr": true, "de": true, "es": true, "ja": true, "pt": true}

var errUnknownGlossaryVersion = errors.New("unknown glossary version")

type TranslateRequest struct {
	Text            string \`json:"text"\`
	Source          string \`json:"source"\`
	Target          string \`json:"target"\`
	GlossaryVersion string \`json:"glossary_version"\`
}

type Term struct {
	Source string
	Target string
}

type GlossaryStore struct{}

func (s *GlossaryStore) resolveGlossary(ctx context.Context, tenant, version string) ([]Term, error) {
	return nil, errUnknownGlossaryVersion
}

var glossaries = &GlossaryStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func translate(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body TranslateRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.Text == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "text must be a non-empty string"})
		return
	}
	if len([]byte(body.Text)) > maxTextBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "text exceeds 16 KiB"})
		return
	}
	if !allowedLanguages[body.Source] || !allowedLanguages[body.Target] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unsupported language code"})
		return
	}
	if body.Source == body.Target {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": sameLanguage})
		return
	}
	terms, err := glossaries.resolveGlossary(r.Context(), tenant, body.GlossaryVersion)
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown glossary version"})
		return
	}
	if detected, _ := detectLanguage(body.Text); detected == body.Target {
		writeJSON(rw, http.StatusOK, map[string]any{
			"request_id":       uuid.NewString(),
			"marker":           untranslatedMarker,
			"translation":      body.Text,
			"source":           body.Source,
			"target":           body.Target,
			"glossary_version": body.GlossaryVersion,
		})
		return
	}
	out, err := translateText(r.Context(), body.Text, body.Source, body.Target, terms)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("translate tenant=%s source=%s target=%s glossary=%s", tenant, body.Source, body.Target, body.GlossaryVersion)
	writeJSON(rw, http.StatusOK, map[string]any{
		"request_id":       uuid.NewString(),
		"translation":      out,
		"source":           body.Source,
		"target":           body.Target,
		"glossary_version": body.GlossaryVersion,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/translations", translate)
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

final case class TranslateRequest(text: String, source: String, target: String, glossary_version: String)

object TranslateApi {
  implicit val system: ActorSystem = ActorSystem("translation-service")
  implicit val requestFormat: RootJsonFormat[TranslateRequest] = jsonFormat4(TranslateRequest)

  val glossaries = GlossaryStore.open()

  val route: Route =
    path("v1" / "translations") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[TranslateRequest]) { body =>
            // TODO: this draft trusts any language tags, ignores glossary_version entirely, and
            // reports the input text as a successful translation when the detector says the source
            // is already the target. Review all three.
            if (Detector.detect(body.text).contains(body.target)) {
              complete(StatusCodes.OK, s"""{"translation":"\${body.text}","target":"\${body.target}"}""")
            } else {
              system.log.info(s"translate tenant=$tenant source=\${body.source} target=\${body.target}")
              complete(StatusCodes.OK, Mt.translate(body.text, body.source, body.target))
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
      solution: `import java.nio.charset.StandardCharsets
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class TranslateRequest(text: String, source: String, target: String, glossary_version: String)

object TranslateApi {
  implicit val system: ActorSystem = ActorSystem("translation-service")
  implicit val requestFormat: RootJsonFormat[TranslateRequest] = jsonFormat4(TranslateRequest)

  val MaxTextBytes = 1 << 14
  val AllowedLanguages = Set("en", "fr", "de", "es", "ja", "pt")
  val SameLanguage = "same-language"
  val UntranslatedMarker = "untranslated"

  val glossaries = GlossaryStore.open()

  val route: Route =
    path("v1" / "translations") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[TranslateRequest]) { body =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else if (body.text.isEmpty) {
              complete(StatusCodes.BadRequest, """{"error":"text must be a non-empty string"}""")
            } else if (body.text.getBytes(StandardCharsets.UTF_8).length > MaxTextBytes) {
              complete(StatusCodes.RequestEntityTooLarge, """{"error":"text exceeds 16 KiB"}""")
            } else if (!AllowedLanguages.contains(body.source) || !AllowedLanguages.contains(body.target)) {
              complete(StatusCodes.BadRequest, """{"error":"unsupported language code"}""")
            } else if (body.source == body.target) {
              complete(StatusCodes.BadRequest, s"""{"error":"$SameLanguage"}""")
            } else {
              val tenant = tenantOpt.get
              glossaries.resolveGlossary(tenant, body.glossary_version) match {
                case None =>
                  complete(StatusCodes.NotFound, """{"error":"unknown glossary version"}""")
                case Some(terms) =>
                  if (Detector.detect(body.text).contains(body.target)) {
                    complete(
                      StatusCodes.OK,
                      s"""{"request_id":"\${UUID.randomUUID().toString}","marker":"$UntranslatedMarker","translation":"\${body.text}","target":"\${body.target}"}""")
                  } else {
                    val translation = Mt.translate(body.text, body.source, body.target, terms)
                    system.log.info(s"translate tenant=$tenant source=\${body.source} target=\${body.target} glossary=\${body.glossary_version}")
                    complete(
                      StatusCodes.OK,
                      s"""{"request_id":"\${UUID.randomUUID().toString}","translation":"$translation","target":"\${body.target}"}""")
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

std::string detectLanguage(const std::string& text);
std::string translateText(const std::string& text, const std::string& source, const std::string& target);

int main() {
  httplib::Server svr;

  svr.Post("/v1/translations", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("text") || !body["text"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft trusts any language tags, ignores glossary_version entirely, and reports the
    // input text as a successful translation when the detector says the source is already the
    // target. Review all three.
    const auto text = body["text"].get<std::string>();
    const auto source = body.value("source", std::string());
    const auto target = body.value("target", std::string());
    if (detectLanguage(text) == target) {
      res.status = 200;
      res.set_content(json{{"translation", text}, {"target", target}}.dump(), "application/json");
      return;
    }
    std::cerr << "translate tenant=" << tenant << " source=" << source << " target=" << target << "\\n";
    res.status = 200;
    res.set_content(json{{"translation", translateText(text, source, target)}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cstddef>
#include <iostream>
#include <optional>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxTextBytes = 1 << 14;
const std::set<std::string> kAllowedLanguages = {"en", "fr", "de", "es", "ja", "pt"};
const std::string kSameLanguage = "same-language";
const std::string kUntranslatedMarker = "untranslated";

struct Term {
  std::string source;
  std::string target;
};

struct GlossaryStore {
  std::optional<std::vector<Term>> resolveGlossary(const std::string& tenant, const std::string& version);
};

GlossaryStore glossaries;
std::string uuidString();
std::string detectLanguage(const std::string& text);
std::string translateText(const std::string& text, const std::string& source, const std::string& target,
                          const std::vector<Term>& terms);

int main() {
  httplib::Server svr;

  svr.Post("/v1/translations", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("text") || !body["text"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"text must be a non-empty string"})", "application/json");
      return;
    }
    const auto text = body["text"].get<std::string>();
    if (text.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"text must be a non-empty string"})", "application/json");
      return;
    }
    if (text.size() > kMaxTextBytes) {
      res.status = 413;
      res.set_content(R"({"error":"text exceeds 16 KiB"})", "application/json");
      return;
    }
    const auto source = body.value("source", std::string());
    const auto target = body.value("target", std::string());
    if (kAllowedLanguages.count(source) == 0 || kAllowedLanguages.count(target) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unsupported language code"})", "application/json");
      return;
    }
    if (source == target) {
      res.status = 400;
      res.set_content(json{{"error", kSameLanguage}}.dump(), "application/json");
      return;
    }
    const auto version = body.value("glossary_version", std::string());
    const auto terms = glossaries.resolveGlossary(tenant, version);
    if (!terms) {
      res.status = 404;
      res.set_content(R"({"error":"unknown glossary version"})", "application/json");
      return;
    }
    if (detectLanguage(text) == target) {
      res.status = 200;
      res.set_content(
          json{{"request_id", uuidString()},
               {"marker", kUntranslatedMarker},
               {"translation", text},
               {"target", target},
               {"glossary_version", version}}
              .dump(),
          "application/json");
      return;
    }
    const auto translation = translateText(text, source, target, *terms);
    std::cerr << "translate tenant=" << tenant << " source=" << source << " target=" << target
              << " glossary=" << version << "\\n";
    res.status = 200;
    res.set_content(
        json{{"request_id", uuidString()},
             {"translation", translation},
             {"target", target},
             {"glossary_version", version}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Order the guard clauses by cost: tenant, body shape, text bytes, language allowlist, source==target, then the glossary lookup. Every rejection must happen before the detector or the model is called, so a malformed request never spends money.',
    '`glossary_version` is not a hint, it is a binding: resolve `(tenant, version)` up front and hand the terms to the model call. A version the store does not know is a **404** — ignoring it silently changes what the customer asked for.',
    'The detector disagreement is the defect candidates miss: returning the input with the target locale looks like success, but downstream caches and reviewers cannot tell it apart from a real translation. Return the text with `"marker": "untranslated"` so every consumer can decide what to do.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary of a localization system. The draft reads fine because the demo sends a valid pair and a glossary version that exists. Three separate defects are checked: input caps (cheap rejections before expensive work), the language allowlist plus the source==target refusal (a caller bug must not become a paid model call), and glossary binding (a version that does not resolve is a 404, not a silent no-glossary translation). The marked identity response is the one candidates miss: an unmarked fallback is indistinguishable from a translation once it is cached, so real services carry a marker, a quality signal and a retriable status all the way out.`,
};
