import type {Step} from '@/lib/types';

export const translateEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/translations: a validated request pinned to a glossary version',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis', 'mt'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/translations\` with body \`{"text", "source",
"target", "glossary_version"?}\` and the tenant in \`X-Tenant-Id\` (401 without it). It resolves the
tenant's active glossary (\`translate.glossary\`), returns the text as is when the detector
(\`translate.text.detect_language\`) says it already is in the target language, and otherwise calls
\`translate_segment\` (\`translate.mt\`): \`{translation, marker, glossary_version}\`, 503 when the
model fell back. It serves the demo and hides four flaws.

**Failure mode the checks target.** A 30 KB paste goes to the model; a language code the platform
does not support, or English to English, is shipped to the model before anyone says no; a French
sentence sent for French comes back as a plain success, so the UI caches it as a translation; and a
caller pinning glossary version 1 is translated with version 2.

- \`text\` is a non-empty string (**400**) of at most \`MAX_TEXT_BYTES\` = 16 KiB of UTF-8 (**413**).
- \`source\` and \`target\` are both in \`ALLOWED_LANGUAGES\` (en, fr, de, es, ja, pt) and differ, else
  **400**, before anything reaches the model.
- When detection says the text is in the target language, answer 200 with the text and
  \`"marker": UNTRANSLATED\`, without calling the model.
- \`glossary_version\`, when given, is the version resolved; an unknown one is **404**.`,
  sequence: {
    participants: ['Client', 'translationd', 'Redis', 'Translator'],
    messages: [
      {from: 'Client', to: 'translationd', label: 'POST /v1/translations · X-Tenant-Id', kind: 'sync'},
      {from: 'translationd', to: 'translationd', label: 'text ≤ 16 KiB · pair allowed and distinct', kind: 'sync'},
      {from: 'translationd', to: 'Redis', label: 'resolve_glossary(tenant, pair, glossary_version)', kind: 'sync'},
      {from: 'Redis', to: 'translationd', label: '{version, terms} · none → 404', kind: 'reply'},
      {
        from: 'translationd',
        to: 'translationd',
        label: 'detect_language == target → marker untranslated',
        kind: 'sync',
      },
      {from: 'translationd', to: 'Translator', label: 'translate_segment', kind: 'sync'},
      {from: 'translationd', to: 'Client', label: '200 {translation, glossary_version} · 503 marked', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/translations',
      detail:
        'Register `POST /v1/translations` and answer `{translation, marker, glossary_version}` for an authenticated tenant.',
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
      title: 'Caps the text at 16 KiB of UTF-8 and refuses an empty one',
      detail:
        '`text` is measured in UTF-8 bytes against `MAX_TEXT_BYTES` (`1 << 14`): larger is **413**, empty or not a string is **400**, and neither reaches the model. The starter forwards any text.',
      match: {
        python: {all: [/MAX_TEXT_BYTES\s*=\s*(1\s*<<\s*14|16384)/, /\.encode\(\s*["']utf-?8["']\s*\)/, /\b413\b/]},
        typescript: {all: [/MAX_TEXT_BYTES\s*=\s*(1\s*<<\s*14|16384)/, /Buffer\.byteLength\(|TextEncoder/, /\b413\b/]},
        go: {
          all: [
            /maxTextBytes\s*=\s*(1\s*<<\s*14|16384)/,
            /len\(body\.Text\)\s*>\s*maxTextBytes/,
            /StatusRequestEntityTooLarge|\b413\b/,
          ],
        },
        scala: {
          all: [/MaxTextBytes(:\s*Int)?\s*=\s*(1\s*<<\s*14|16384)/, /getBytes\(/, /RequestEntityTooLarge|\b413\b/],
        },
        cpp: {all: [/kMaxTextBytes\s*=\s*(1\s*<<\s*14|16384)/, /\.size\(\)\s*>\s*kMaxTextBytes/, /\b413\b/]},
      },
    },
    {
      id: 'language-pair',
      title: 'Checks the pair against the allowlist before the model sees it',
      detail:
        '`source` and `target` must both be in `ALLOWED_LANGUAGES` and differ, else **400** with no model call. The starter lets the model reject the pair, after the text has left the service.',
      match: {
        python: {all: [/ALLOWED_LANGUAGES\s*=/, /not in ALLOWED_LANGUAGES/, /source\s*==\s*target/]},
        typescript: {all: [/ALLOWED_LANGUAGES\s*=/, /ALLOWED_LANGUAGES\.(has|includes)\(/, /source\s*===\s*target/]},
        go: {all: [/allowedLanguages\s*=/, /allowedLanguages\[/, /body\.Source\s*==\s*body\.Target/]},
        scala: {
          all: [
            /AllowedLanguages(:\s*Set\[String\])?\s*=/,
            /AllowedLanguages\(|AllowedLanguages\.contains\(/,
            /source\s*==\s*target/,
          ],
        },
        cpp: {all: [/kAllowedLanguages\s*=/, /kAllowedLanguages\.(count|find)\(/, /source\s*==\s*target/]},
      },
    },
    {
      id: 'identity-marker',
      title: 'Marks text already in the target language',
      detail:
        'When `detect_language` says the text is in the target language, the answer carries `"marker": "untranslated"` and the model is not called. The starter answers the same text with no marker, a plain success a cache keeps as a translation.',
      match: {
        python: {all: [/detect_language\(/, /["']marker["']:\s*UNTRANSLATED/]},
        typescript: {all: [/detectLanguage\(/, /marker:\s*UNTRANSLATED/]},
        go: {all: [/text\.DetectLanguage\(/, /"marker":\s*mt\.Untranslated/]},
        scala: {all: [/Text\.detectLanguage\(/, /Some\(Mt\.Untranslated\)/]},
        cpp: {all: [/text::detectLanguage\(/, /\{"marker",\s*mt::kUntranslated\}/]},
      },
    },
    {
      id: 'glossary-binding',
      title: 'Resolves the pinned glossary version, 404 when unknown',
      detail:
        "`glossary_version` is passed to `resolve_glossary`, the model gets that version's terms, and an unknown version is **404**. The starter always resolves the active version.",
      match: {
        python: {all: [/resolve_glossary\([^\n]*version\)/, /\b404\b/]},
        typescript: {all: [/resolveGlossary\([^\n]*version\)/, /\b404\b/]},
        go: {all: [/ResolveGlossary\([^\n]*version\)/, /StatusNotFound|\b404\b/]},
        scala: {all: [/resolveGlossary\([^\n]*version\)/, /NotFound|\b404\b/]},
        cpp: {all: [/resolveGlossary\([^\n]*version\)/, /\b404\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from translate.glossary import resolve_glossary  # resolve_glossary(tenant, source, target, version=None)
from translate.mt import PairRejected, translate_segment  # translate_segment(tenant, text, source, target, pinned)
from translate.text import detect_language

app = FastAPI()

NO_GLOSSARY = {"version": 0, "terms": {}}


def error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


@app.post("/v1/translations")
async def translate(request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return error(401, "X-Tenant-Id is required")
    body = await request.json()
    text, source, target = body.get("text", ""), body.get("source"), body.get("target")
    pinned = resolve_glossary(tenant, source, target) or NO_GLOSSARY
    if detect_language(text) == target:
        return JSONResponse({"translation": text, "marker": None, "glossary_version": pinned["version"]})
    try:
        result = translate_segment(tenant, text, source, target, pinned)
    except PairRejected as exc:
        return error(400, str(exc))
    status = 503 if result["marker"] else 200
    return JSONResponse({"translation": result["text"], "marker": result["marker"], "glossary_version": pinned["version"]}, status_code=status)
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from translate.glossary import resolve_glossary  # resolve_glossary(tenant, source, target, version=None)
from translate.mt import UNTRANSLATED, PairRejected, translate_segment  # translate_segment(tenant, text, source, target, pinned)
from translate.text import detect_language

app = FastAPI()

MAX_TEXT_BYTES = 1 << 14
ALLOWED_LANGUAGES = frozenset({"en", "fr", "de", "es", "ja", "pt"})
NO_GLOSSARY = {"version": 0, "terms": {}}


def error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


@app.post("/v1/translations")
async def translate(request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return error(401, "X-Tenant-Id is required")
    body = await request.json()
    text, source, target = body.get("text"), body.get("source"), body.get("target")
    # Every guard runs before anything leaves the service.
    if not isinstance(text, str) or not text:
        return error(400, "text must be a non-empty string")
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        return error(413, f"text is over {MAX_TEXT_BYTES} bytes")
    if source not in ALLOWED_LANGUAGES or target not in ALLOWED_LANGUAGES:
        return error(400, "unsupported language")
    if source == target:
        return error(400, "source and target are the same language")
    version = body.get("glossary_version")
    pinned = resolve_glossary(tenant, source, target, version)
    if pinned is None:
        if version is not None:
            return error(404, f"no glossary version {version}")
        pinned = NO_GLOSSARY
    if detect_language(text) == target:
        # Already in the target language: say so, so nothing downstream keeps it as a translation.
        return JSONResponse({"translation": text, "marker": UNTRANSLATED, "glossary_version": pinned["version"]})
    try:
        result = translate_segment(tenant, text, source, target, pinned)
    except PairRejected as exc:
        return error(400, str(exc))
    status = 503 if result["marker"] else 200
    return JSONResponse({"translation": result["text"], "marker": result["marker"], "glossary_version": pinned["version"]}, status_code=status)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {resolveGlossary} from 'translate/glossary'; // resolveGlossary(tenant, source, target, version = null)
import {PairRejected, translateSegment} from 'translate/mt'; // translateSegment(tenant, text, source, target, pinned)
import {detectLanguage} from 'translate/text';

export const app = Fastify();

const NO_GLOSSARY = {version: 0, terms: {}};

interface TranslateBody {
  text?: unknown;
  source?: unknown;
  target?: unknown;
  glossary_version?: number;
}

app.post('/v1/translations', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = (request.body ?? {}) as TranslateBody;
  const text = String(body.text ?? '');
  const source = String(body.source);
  const target = String(body.target);
  const pinned = (await resolveGlossary(tenant, source, target)) ?? NO_GLOSSARY;
  if (detectLanguage(text) === target) return {translation: text, marker: null, glossary_version: pinned.version};
  try {
    const result = await translateSegment(tenant, text, source, target, pinned);
    return reply.code(result.marker === null ? 200 : 503).send({translation: result.text, marker: result.marker, glossary_version: pinned.version});
  } catch (e) {
    if (e instanceof PairRejected) return reply.code(400).send({error: e.message});
    throw e;
  }
});
`,
      solution: `import Fastify from 'fastify';

import {resolveGlossary} from 'translate/glossary'; // resolveGlossary(tenant, source, target, version = null)
import {PairRejected, UNTRANSLATED, translateSegment} from 'translate/mt'; // translateSegment(tenant, text, source, target, pinned)
import {detectLanguage} from 'translate/text';

export const app = Fastify();

export const MAX_TEXT_BYTES = 1 << 14;
export const ALLOWED_LANGUAGES = new Set(['en', 'fr', 'de', 'es', 'ja', 'pt']);
const NO_GLOSSARY = {version: 0, terms: {}};

interface TranslateBody {
  text?: unknown;
  source?: unknown;
  target?: unknown;
  glossary_version?: number;
}

app.post('/v1/translations', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = (request.body ?? {}) as TranslateBody;
  const {text, source, target} = body;
  // Every guard runs before anything leaves the service.
  if (typeof text !== 'string' || text === '') return reply.code(400).send({error: 'text must be a non-empty string'});
  if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) return reply.code(413).send({error: \`text is over \${MAX_TEXT_BYTES} bytes\`});
  if (typeof source !== 'string' || typeof target !== 'string' || !ALLOWED_LANGUAGES.has(source) || !ALLOWED_LANGUAGES.has(target)) {
    return reply.code(400).send({error: 'unsupported language'});
  }
  if (source === target) return reply.code(400).send({error: 'source and target are the same language'});
  const version = body.glossary_version ?? null;
  const found = await resolveGlossary(tenant, source, target, version);
  if (found === null && version !== null) return reply.code(404).send({error: \`no glossary version \${version}\`});
  const pinned = found ?? NO_GLOSSARY;
  // Already in the target language: say so, so nothing downstream keeps it as a translation.
  if (detectLanguage(text) === target) return {translation: text, marker: UNTRANSLATED, glossary_version: pinned.version};
  try {
    const result = await translateSegment(tenant, text, source, target, pinned);
    return reply.code(result.marker === null ? 200 : 503).send({translation: result.text, marker: result.marker, glossary_version: pinned.version});
  } catch (e) {
    if (e instanceof PairRejected) return reply.code(400).send({error: e.message});
    throw e;
  }
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"errors"
	"net/http"

	"translate/glossary" // glossary.ResolveGlossary(ctx, tenant, source, target, version), glossary.Glossary
	"translate/mt"       // mt.TranslateSegment(ctx, tenant, text, source, target, pinned), mt.ErrPairRejected
	"translate/text"     // text.DetectLanguage
)

type translateBody struct {
	Text            string \`json:"text"\`
	Source          string \`json:"source"\`
	Target          string \`json:"target"\`
	GlossaryVersion *int64 \`json:"glossary_version"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func fail(rw http.ResponseWriter, status int, message string) {
	writeJSON(rw, status, map[string]string{"error": message})
}

func translateHandler(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		fail(rw, http.StatusUnauthorized, "X-Tenant-Id is required")
		return
	}
	var body translateBody
	json.NewDecoder(r.Body).Decode(&body)
	pinned, err := glossary.ResolveGlossary(r.Context(), tenant, body.Source, body.Target, 0)
	if err != nil {
		fail(rw, http.StatusInternalServerError, err.Error())
		return
	}
	if pinned == nil {
		pinned = &glossary.Glossary{Terms: map[string]string{}}
	}
	if text.DetectLanguage(body.Text) == body.Target {
		writeJSON(rw, http.StatusOK, map[string]any{"translation": body.Text, "marker": nil, "glossary_version": pinned.Version})
		return
	}
	result, err := mt.TranslateSegment(r.Context(), tenant, body.Text, body.Source, body.Target, *pinned)
	if errors.Is(err, mt.ErrPairRejected) {
		fail(rw, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		fail(rw, http.StatusInternalServerError, err.Error())
		return
	}
	status := http.StatusOK
	var marker any
	if result.Marker != "" {
		status = http.StatusServiceUnavailable
		marker = result.Marker
	}
	writeJSON(rw, status, map[string]any{"translation": result.Text, "marker": marker, "glossary_version": pinned.Version})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/translations", translateHandler)
}
`,
      solution: `package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"translate/glossary" // glossary.ResolveGlossary(ctx, tenant, source, target, version), glossary.Glossary
	"translate/mt"       // mt.TranslateSegment(ctx, tenant, text, source, target, pinned), mt.ErrPairRejected
	"translate/text"     // text.DetectLanguage
)

const maxTextBytes = 1 << 14

var allowedLanguages = map[string]bool{"en": true, "fr": true, "de": true, "es": true, "ja": true, "pt": true}

type translateBody struct {
	Text            string \`json:"text"\`
	Source          string \`json:"source"\`
	Target          string \`json:"target"\`
	GlossaryVersion *int64 \`json:"glossary_version"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func fail(rw http.ResponseWriter, status int, message string) {
	writeJSON(rw, status, map[string]string{"error": message})
}

func translateHandler(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		fail(rw, http.StatusUnauthorized, "X-Tenant-Id is required")
		return
	}
	var body translateBody
	// Every guard runs before anything leaves the service.
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Text == "" {
		fail(rw, http.StatusBadRequest, "text must be a non-empty string")
		return
	}
	if len(body.Text) > maxTextBytes {
		fail(rw, http.StatusRequestEntityTooLarge, fmt.Sprintf("text is over %d bytes", maxTextBytes))
		return
	}
	if !allowedLanguages[body.Source] || !allowedLanguages[body.Target] {
		fail(rw, http.StatusBadRequest, "unsupported language")
		return
	}
	if body.Source == body.Target {
		fail(rw, http.StatusBadRequest, "source and target are the same language")
		return
	}
	var version int64
	if body.GlossaryVersion != nil {
		version = *body.GlossaryVersion
		if version < 1 {
			fail(rw, http.StatusNotFound, fmt.Sprintf("no glossary version %d", version))
			return
		}
	}
	pinned, err := glossary.ResolveGlossary(r.Context(), tenant, body.Source, body.Target, version)
	if err != nil {
		fail(rw, http.StatusInternalServerError, err.Error())
		return
	}
	if pinned == nil {
		if version != 0 {
			fail(rw, http.StatusNotFound, fmt.Sprintf("no glossary version %d", version))
			return
		}
		pinned = &glossary.Glossary{Terms: map[string]string{}}
	}
	if text.DetectLanguage(body.Text) == body.Target {
		// Already in the target language: say so, so nothing downstream keeps it as a translation.
		writeJSON(rw, http.StatusOK, map[string]any{"translation": body.Text, "marker": mt.Untranslated, "glossary_version": pinned.Version})
		return
	}
	result, err := mt.TranslateSegment(r.Context(), tenant, body.Text, body.Source, body.Target, *pinned)
	if errors.Is(err, mt.ErrPairRejected) {
		fail(rw, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		fail(rw, http.StatusInternalServerError, err.Error())
		return
	}
	status := http.StatusOK
	var marker any
	if result.Marker != "" {
		status = http.StatusServiceUnavailable
		marker = result.Marker
	}
	writeJSON(rw, status, map[string]any{"translation": result.Text, "marker": marker, "glossary_version": pinned.Version})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/translations", translateHandler)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import translate.{Glossary, Mt, Text} // Glossary.resolveGlossary, Mt.translateSegment, Text.detectLanguage

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def answer(status: StatusCode, translation: String, marker: Option[String], version: Long): HttpResponse =
    json(status, JsObject("translation" -> JsString(translation), "marker" -> marker.map(JsString(_)).getOrElse(JsNull), "glossary_version" -> JsNumber(version)))

  def translate(tenant: String, raw: String): HttpResponse = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val body = scala.util.Try(raw.parseJson.asJsObject).getOrElse(JsObject.empty)
    def field(name: String): String = body.fields.get(name).collect { case JsString(s) => s }.getOrElse("")
    val (text, source, target) = (field("text"), field("source"), field("target"))
    val pinned = Glossary.resolveGlossary(tenant, source, target).getOrElse(Glossary.Pinned(0L, Map.empty))
    if (Text.detectLanguage(text).contains(target)) answer(StatusCodes.OK, text, None, pinned.version)
    else
      try {
        val result = Mt.translateSegment(tenant, text, source, target, pinned)
        answer(if (result.marker.isDefined) StatusCodes.ServiceUnavailable else StatusCodes.OK, result.text, result.marker, pinned.version)
      } catch { case e: Mt.PairRejected => error(StatusCodes.BadRequest, e.getMessage) }
  }

  val route: Route = path("v1" / "translations") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
        case Some(tenant) => entity(as[String]) { raw => complete(translate(tenant, raw)) }
      }
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import translate.{Glossary, Mt, Text} // Glossary.resolveGlossary, Mt.translateSegment, Text.detectLanguage

object Api {
  val MaxTextBytes: Int = 1 << 14
  val AllowedLanguages: Set[String] = Set("en", "fr", "de", "es", "ja", "pt")

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def answer(status: StatusCode, translation: String, marker: Option[String], version: Long): HttpResponse =
    json(status, JsObject("translation" -> JsString(translation), "marker" -> marker.map(JsString(_)).getOrElse(JsNull), "glossary_version" -> JsNumber(version)))

  def translate(tenant: String, raw: String): HttpResponse = {
    val body = scala.util.Try(raw.parseJson.asJsObject).getOrElse(JsObject.empty)
    def field(name: String): String = body.fields.get(name).collect { case JsString(s) => s }.getOrElse("")
    val (text, source, target) = (field("text"), field("source"), field("target"))
    val version = body.fields.get("glossary_version").collect { case JsNumber(n) => n.toLong }
    // Every guard runs before anything leaves the service.
    if (text.isEmpty) error(StatusCodes.BadRequest, "text must be a non-empty string")
    else if (text.getBytes(StandardCharsets.UTF_8).length > MaxTextBytes) error(StatusCodes.RequestEntityTooLarge, s"text is over $MaxTextBytes bytes")
    else if (!AllowedLanguages(source) || !AllowedLanguages(target)) error(StatusCodes.BadRequest, "unsupported language")
    else if (source == target) error(StatusCodes.BadRequest, "source and target are the same language")
    else
      Glossary.resolveGlossary(tenant, source, target, version) match {
        case None if version.isDefined => error(StatusCodes.NotFound, s"no glossary version \${version.get}")
        case found =>
          val pinned = found.getOrElse(Glossary.Pinned(0L, Map.empty))
          // Already in the target language: say so, so nothing downstream keeps it as a translation.
          if (Text.detectLanguage(text).contains(target)) answer(StatusCodes.OK, text, Some(Mt.Untranslated), pinned.version)
          else
            try {
              val result = Mt.translateSegment(tenant, text, source, target, pinned)
              answer(if (result.marker.isDefined) StatusCodes.ServiceUnavailable else StatusCodes.OK, result.text, result.marker, pinned.version)
            } catch { case e: Mt.PairRejected => error(StatusCodes.BadRequest, e.getMessage) }
      }
  }

  val route: Route = path("v1" / "translations") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
        case Some(tenant) => entity(as[String]) { raw => complete(translate(tenant, raw)) }
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

#include "translate/glossary.h"  // glossary::resolveGlossary(tenant, source, target, version = 0)
#include "translate/mt.h"        // mt::translateSegment(tenant, text, source, target, pinned), mt::PairRejected
#include "translate/text.h"      // text::detectLanguage

using json = nlohmann::json;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void translate_text(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body, nullptr, false);
  const auto field = [&body](const char* name) {
    return body.is_object() && body.contains(name) && body[name].is_string() ? body[name].get<std::string>() : std::string();
  };
  const std::string input = field("text"), source = field("source"), target = field("target");
  const glossary::Glossary pinned = glossary::resolveGlossary(tenant, source, target).value_or(glossary::Glossary{});
  if (text::detectLanguage(input) == target) return reply(res, 200, {{"translation", input}, {"marker", nullptr}, {"glossary_version", pinned.version}});
  try {
    const mt::Translation result = mt::translateSegment(tenant, input, source, target, pinned);
    const json marker = result.marker.empty() ? json(nullptr) : json(result.marker);
    reply(res, result.marker.empty() ? 200 : 503, {{"translation", result.text}, {"marker", marker}, {"glossary_version", pinned.version}});
  } catch (const mt::PairRejected& e) {
    reply(res, 400, {{"error", e.what()}});
  }
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/translations", translate_text);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>

#include "translate/glossary.h"  // glossary::resolveGlossary(tenant, source, target, version = 0)
#include "translate/mt.h"        // mt::translateSegment(tenant, text, source, target, pinned), mt::PairRejected
#include "translate/text.h"      // text::detectLanguage

using json = nlohmann::json;

constexpr size_t kMaxTextBytes = 1 << 14;
const std::set<std::string> kAllowedLanguages = {"en", "fr", "de", "es", "ja", "pt"};

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void translate_text(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body, nullptr, false);
  const auto field = [&body](const char* name) {
    return body.is_object() && body.contains(name) && body[name].is_string() ? body[name].get<std::string>() : std::string();
  };
  const std::string input = field("text"), source = field("source"), target = field("target");
  // Every guard runs before anything leaves the service.
  if (input.empty()) return reply(res, 400, {{"error", "text must be a non-empty string"}});
  if (input.size() > kMaxTextBytes) return reply(res, 413, {{"error", "text is over " + std::to_string(kMaxTextBytes) + " bytes"}});
  if (!kAllowedLanguages.count(source) || !kAllowedLanguages.count(target)) return reply(res, 400, {{"error", "unsupported language"}});
  if (source == target) return reply(res, 400, {{"error", "source and target are the same language"}});
  const bool pinnedByCaller = body.contains("glossary_version");
  const long version = pinnedByCaller && body["glossary_version"].is_number_integer() ? body["glossary_version"].get<long>() : 0;
  if (pinnedByCaller && version < 1) return reply(res, 404, {{"error", "no such glossary version"}});
  const auto found = glossary::resolveGlossary(tenant, source, target, version);
  if (!found && pinnedByCaller) return reply(res, 404, {{"error", "no glossary version " + std::to_string(version)}});
  const glossary::Glossary pinned = found.value_or(glossary::Glossary{});
  if (text::detectLanguage(input) == target) {
    // Already in the target language: say so, so nothing downstream keeps it as a translation.
    return reply(res, 200, {{"translation", input}, {"marker", mt::kUntranslated}, {"glossary_version", pinned.version}});
  }
  try {
    const mt::Translation result = mt::translateSegment(tenant, input, source, target, pinned);
    const json marker = result.marker.empty() ? json(nullptr) : json(result.marker);
    reply(res, result.marker.empty() ? 200 : 503, {{"translation", result.text}, {"marker", marker}, {"glossary_version", pinned.version}});
  } catch (const mt::PairRejected& e) {
    reply(res, 400, {{"error", e.what()}});
  }
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/translations", translate_text);
}
`,
    },
  },
  harness: {
    python: `import grpc

import translation_service_pb2
import translation_service_pb2_grpc
from translate.glossary import publish_terms

SERVED = {"en", "fr", "de", "es", "ja", "pt"}
ACME = {"X-Tenant-Id": "acme"}


class Translator(translation_service_pb2_grpc.TranslatorServicer):
    """The model: '[target] text' with every glossary term applied; a pair it does not serve is INVALID_ARGUMENT."""

    def Translate(self, request, context):
        if request.source not in SERVED or request.target not in SERVED or request.source == request.target:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, f"pair {request.source}->{request.target} is not served")
        text = request.text
        for term in request.terms:
            text = text.replace(term.source, term.target)
        return translation_service_pb2.TranslateReply(text=f"[{request.target}] {text}", model="mt-2026-10")


def _api(ctx):
    ctx.grpc.serve(translation_service_pb2_grpc.add_TranslatorServicer_to_server, Translator())
    return ctx.client(ctx.load("api").app)


def _calls(ctx):
    return len(ctx.grpc.calls_to("Translate"))


async def _post(c, body, headers=ACME):
    return await c.post("/v1/translations", json=body, headers=headers)


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _post(c, {"text": "the invoice is ready", "source": "en", "target": "fr"})
        missing = await _post(c, {"text": "the invoice is ready", "source": "en", "target": "fr"}, headers={})
    assert r.status_code == 200, f"POST /v1/translations answered {r.status_code}: {r.text}"
    assert r.json() == {"translation": "[fr] the invoice is ready", "marker": None, "glossary_version": 0}, f"a tenant with no glossary got {r.json()}"
    assert missing.status_code == 401, f"a request without X-Tenant-Id answered {missing.status_code}, expected 401"


async def check_text_cap(ctx):
    async with _api(ctx) as c:
        at_cap = await _post(c, {"text": "a" * 16384, "source": "en", "target": "fr"})
        assert at_cap.status_code == 200, f"a text of exactly 16 KiB answered {at_cap.status_code}: {at_cap.text}"
        over = await _post(c, {"text": "a" * 16385, "source": "en", "target": "fr"})
        assert over.status_code == 413, f"a text of 16 KiB + 1 byte answered {over.status_code}, expected 413"
        wide = await _post(c, {"text": "日" * 6000, "source": "ja", "target": "en"})
        assert wide.status_code == 413, f"6000 kanji (18000 bytes of UTF-8) answered {wide.status_code}, expected 413: the cap is in bytes, not characters"
        empty = await _post(c, {"text": "", "source": "en", "target": "fr"})
        assert empty.status_code == 400, f"an empty text answered {empty.status_code}, expected 400"
        number = await _post(c, {"text": 42, "source": "en", "target": "fr"})
        assert number.status_code == 400, f"a text that is not a string answered {number.status_code}, expected 400"
    assert _calls(ctx) == 1, f"the model was called {_calls(ctx)} times: only the text within the cap may reach it"


async def check_language_pair(ctx):
    async with _api(ctx) as c:
        for source, target in (("en", "tlh"), ("xx", "fr"), ("en", "en")):
            r = await _post(c, {"text": "the invoice is ready", "source": source, "target": target})
            assert r.status_code == 400, f"{source}->{target} answered {r.status_code}, expected 400: {r.text}"
    assert _calls(ctx) == 0, f"unsupported pairs reached the model ({_calls(ctx)} Translate calls): check ALLOWED_LANGUAGES and source != target before the text leaves the service"


async def check_identity_marker(ctx):
    async with _api(ctx) as c:
        same = await _post(c, {"text": "le chat est sur la table", "source": "en", "target": "fr"})
        assert same.status_code == 200, f"French text sent for French answered {same.status_code}: {same.text}"
        body = same.json()
        assert body.get("marker") == "untranslated" and body.get("translation") == "le chat est sur la table", f"French text sent for French answered {body}: without marker untranslated a cache keeps it as a translation"
        assert _calls(ctx) == 0, "text already in the target language must not be sent to the model"
        other = await _post(c, {"text": "the cat is on the table", "source": "en", "target": "fr"})
    assert other.status_code == 200 and other.json().get("marker") is None, f"English text for French answered {other.status_code} {other.text}, expected a translation with no marker"


async def check_glossary_binding(ctx):
    publish_terms("acme", "en", "fr", {"Dashboard": "Tableau de bord"})
    publish_terms("acme", "en", "fr", {"Dashboard": "Panneau"})
    async with _api(ctx) as c:
        pinned = await _post(c, {"text": "Open the Dashboard", "source": "en", "target": "fr", "glossary_version": 1})
        assert pinned.status_code == 200, f"a request pinning glossary version 1 answered {pinned.status_code}: {pinned.text}"
        assert pinned.json().get("glossary_version") == 1 and pinned.json().get("translation") == "[fr] Open the Tableau de bord", f"a request pinning glossary version 1 got {pinned.json()}: it was translated with another version's terms"
        sent = ctx.grpc.calls_to("Translate")[-1].request
        assert sent.glossary_version == 1, f"the model was told glossary version {sent.glossary_version}, expected the pinned 1"
        active = await _post(c, {"text": "Close the Dashboard", "source": "en", "target": "fr"})
        assert active.json().get("glossary_version") == 2 and active.json().get("translation") == "[fr] Close the Panneau", f"with no version pinned the active version 2 applies, got {active.json()}"
        before = _calls(ctx)
        unknown = await _post(c, {"text": "Open the Dashboard", "source": "en", "target": "fr", "glossary_version": 7})
        assert unknown.status_code == 404, f"an unknown glossary version answered {unknown.status_code}, expected 404: {unknown.text}"
        other = await _post(c, {"text": "Open the Dashboard", "source": "en", "target": "fr", "glossary_version": 1}, headers={"X-Tenant-Id": "globex"})
        assert other.status_code == 404, f"globex pinning acme's version 1 answered {other.status_code}, expected 404"
    assert _calls(ctx) == before, "a request with an unknown glossary version must not reach the model"
`,
    typescript: `const SERVED = ['en', 'fr', 'de', 'es', 'ja', 'pt'];
const ACME = {'X-Tenant-Id': 'acme'};

/** The model: '[target] text' with every glossary term applied; a pair it does not serve is INVALID_ARGUMENT. */
function api(ctx) {
  const pkg = ctx.proto('translation_service.proto');
  ctx.grpc.serve(pkg.translationsvc.Translator.service, {
    Translate(call, callback) {
      const {source, target, terms} = call.request;
      if (!SERVED.includes(source) || !SERVED.includes(target) || source === target) {
        return callback({code: ctx.grpc.status.INVALID_ARGUMENT, details: \`pair \${source}->\${target} is not served\`});
      }
      let text = call.request.text;
      for (const term of terms ?? []) text = text.split(term.source).join(term.target);
      callback(null, {text: \`[\${target}] \${text}\`, model: 'mt-2026-10'});
    },
  });
  return {c: ctx.client(ctx.load('api').app), glossary: ctx.load('/support/translate/glossary.ts')};
}

const calls = ctx => ctx.grpc.callsTo('Translate').length;
const post = (c, json, headers: Record<string, string> = ACME) => c.post('/v1/translations', {json, headers});

export async function check_route(ctx) {
  const {c} = api(ctx);
  const r = await post(c, {text: 'the invoice is ready', source: 'en', target: 'fr'});
  assert.equal(r.status, 200, \`POST /v1/translations answered \${r.status}: \${r.text}\`);
  assert.deepStrictEqual(r.json(), {translation: '[fr] the invoice is ready', marker: null, glossary_version: 0}, \`a tenant with no glossary got \${r.text}\`);
  const missing = await post(c, {text: 'the invoice is ready', source: 'en', target: 'fr'}, {});
  assert.equal(missing.status, 401, \`a request without X-Tenant-Id answered \${missing.status}, expected 401\`);
}

export async function check_text_cap(ctx) {
  const {c} = api(ctx);
  const atCap = await post(c, {text: 'a'.repeat(16384), source: 'en', target: 'fr'});
  assert.equal(atCap.status, 200, \`a text of exactly 16 KiB answered \${atCap.status}: \${atCap.text}\`);
  const over = await post(c, {text: 'a'.repeat(16385), source: 'en', target: 'fr'});
  assert.equal(over.status, 413, \`a text of 16 KiB + 1 byte answered \${over.status}, expected 413\`);
  const wide = await post(c, {text: '日'.repeat(6000), source: 'ja', target: 'en'});
  assert.equal(wide.status, 413, \`6000 kanji (18000 bytes of UTF-8) answered \${wide.status}, expected 413: the cap is in bytes, not characters\`);
  const empty = await post(c, {text: '', source: 'en', target: 'fr'});
  assert.equal(empty.status, 400, \`an empty text answered \${empty.status}, expected 400\`);
  const number = await post(c, {text: 42, source: 'en', target: 'fr'});
  assert.equal(number.status, 400, \`a text that is not a string answered \${number.status}, expected 400\`);
  assert.equal(calls(ctx), 1, \`the model was called \${calls(ctx)} times: only the text within the cap may reach it\`);
}

export async function check_language_pair(ctx) {
  const {c} = api(ctx);
  for (const [source, target] of [['en', 'tlh'], ['xx', 'fr'], ['en', 'en']]) {
    const r = await post(c, {text: 'the invoice is ready', source, target});
    assert.equal(r.status, 400, \`\${source}->\${target} answered \${r.status}, expected 400: \${r.text}\`);
  }
  assert.equal(calls(ctx), 0, \`unsupported pairs reached the model (\${calls(ctx)} Translate calls): check ALLOWED_LANGUAGES and source !== target before the text leaves the service\`);
}

export async function check_identity_marker(ctx) {
  const {c} = api(ctx);
  const same = await post(c, {text: 'le chat est sur la table', source: 'en', target: 'fr'});
  assert.equal(same.status, 200, \`French text sent for French answered \${same.status}: \${same.text}\`);
  const body = same.json();
  assert(body.marker === 'untranslated' && body.translation === 'le chat est sur la table', \`French text sent for French answered \${same.text}: without marker untranslated a cache keeps it as a translation\`);
  assert.equal(calls(ctx), 0, 'text already in the target language must not be sent to the model');
  const other = await post(c, {text: 'the cat is on the table', source: 'en', target: 'fr'});
  assert(other.status === 200 && other.json().marker === null, \`English text for French answered \${other.status} \${other.text}, expected a translation with no marker\`);
}

export async function check_glossary_binding(ctx) {
  const {c, glossary} = api(ctx);
  await glossary.publishTerms('acme', 'en', 'fr', {Dashboard: 'Tableau de bord'});
  await glossary.publishTerms('acme', 'en', 'fr', {Dashboard: 'Panneau'});
  const pinned = await post(c, {text: 'Open the Dashboard', source: 'en', target: 'fr', glossary_version: 1});
  assert.equal(pinned.status, 200, \`a request pinning glossary version 1 answered \${pinned.status}: \${pinned.text}\`);
  assert(pinned.json().glossary_version === 1 && pinned.json().translation === '[fr] Open the Tableau de bord', \`a request pinning glossary version 1 got \${pinned.text}: it was translated with another version's terms\`);
  const sent = ctx.grpc.callsTo('Translate').at(-1).request;
  assert.equal(Number(sent.glossary_version), 1, \`the model was told glossary version \${sent.glossary_version}, expected the pinned 1\`);
  const active = await post(c, {text: 'Close the Dashboard', source: 'en', target: 'fr'});
  assert(active.json().glossary_version === 2 && active.json().translation === '[fr] Close the Panneau', \`with no version pinned the active version 2 applies, got \${active.text}\`);
  const before = calls(ctx);
  const unknown = await post(c, {text: 'Open the Dashboard', source: 'en', target: 'fr', glossary_version: 7});
  assert.equal(unknown.status, 404, \`an unknown glossary version answered \${unknown.status}, expected 404: \${unknown.text}\`);
  const other = await post(c, {text: 'Open the Dashboard', source: 'en', target: 'fr', glossary_version: 1}, {'X-Tenant-Id': 'globex'});
  assert.equal(other.status, 404, \`globex pinning acme's version 1 answered \${other.status}, expected 404\`);
  assert.equal(calls(ctx), before, 'a request with an unknown glossary version must not reach the model');
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "translate/gen/translation_service"
	"translate/glossary"

	"leetbuild/harness"
)

var (
	apiBg     = context.Background()
	apiServed = map[string]bool{"en": true, "fr": true, "de": true, "es": true, "ja": true, "pt": true}
)

// apiModel answers '[target] text' with every glossary term applied; a pair it does not serve is InvalidArgument.
type apiModel struct {
	pb.UnimplementedTranslatorServer
}

func (apiModel) Translate(_ context.Context, req *pb.TranslateRequest) (*pb.TranslateReply, error) {
	if !apiServed[req.GetSource()] || !apiServed[req.GetTarget()] || req.GetSource() == req.GetTarget() {
		return nil, status.Errorf(codes.InvalidArgument, "pair %s->%s is not served", req.GetSource(), req.GetTarget())
	}
	out := req.GetText()
	for _, term := range req.GetTerms() {
		out = strings.ReplaceAll(out, term.GetSource(), term.GetTarget())
	}
	return &pb.TranslateReply{Text: "[" + req.GetTarget() + "] " + out, Model: "mt-2026-10"}, nil
}

func api(ctx *harness.Ctx) *harness.HTTP {
	pb.RegisterTranslatorServer(ctx.GRPC.Server(""), apiModel{})
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiCalls(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("Translate", "")) }

func post(c *harness.HTTP, body map[string]any, tenant string) *harness.Response {
	if tenant == "" {
		return c.Post("/v1/translations", body)
	}
	return c.Post("/v1/translations", body, "X-Tenant-Id", tenant)
}

func answer(ctx *harness.Ctx, r *harness.Response) map[string]any {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the answer is not a JSON object: %s", r.Text())
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := post(c, map[string]any{"text": "the invoice is ready", "source": "en", "target": "fr"}, "acme")
	ctx.Equal(r.Status, 200, "POST /v1/translations (%s)", r.Text())
	body := answer(ctx, r)
	ctx.Assert(body["translation"] == "[fr] the invoice is ready" && body["marker"] == nil && body["glossary_version"] == float64(0), "a tenant with no glossary got %s", r.Text())
	missing := post(c, map[string]any{"text": "the invoice is ready", "source": "en", "target": "fr"}, "")
	ctx.Equal(missing.Status, 401, "a request without X-Tenant-Id")
}

func CheckTextCap(ctx *harness.Ctx) {
	c := api(ctx)
	atCap := post(c, map[string]any{"text": strings.Repeat("a", 16384), "source": "en", "target": "fr"}, "acme")
	ctx.Equal(atCap.Status, 200, "a text of exactly 16 KiB (%s)", atCap.Text())
	over := post(c, map[string]any{"text": strings.Repeat("a", 16385), "source": "en", "target": "fr"}, "acme")
	ctx.Equal(over.Status, 413, "a text of 16 KiB + 1 byte")
	wide := post(c, map[string]any{"text": strings.Repeat("日", 6000), "source": "ja", "target": "en"}, "acme")
	ctx.Equal(wide.Status, 413, "6000 kanji are 18000 bytes of UTF-8: the cap is in bytes, not characters; the status")
	empty := post(c, map[string]any{"text": "", "source": "en", "target": "fr"}, "acme")
	ctx.Equal(empty.Status, 400, "an empty text")
	number := post(c, map[string]any{"text": 42, "source": "en", "target": "fr"}, "acme")
	ctx.Equal(number.Status, 400, "a text that is not a string")
	ctx.Equal(apiCalls(ctx), 1, "only the text within the cap may reach the model; the Translate calls")
}

func CheckLanguagePair(ctx *harness.Ctx) {
	c := api(ctx)
	for _, pair := range [][2]string{{"en", "tlh"}, {"xx", "fr"}, {"en", "en"}} {
		r := post(c, map[string]any{"text": "the invoice is ready", "source": pair[0], "target": pair[1]}, "acme")
		ctx.Equal(r.Status, 400, "%s->%s (%s)", pair[0], pair[1], r.Text())
	}
	ctx.Equal(apiCalls(ctx), 0, "unsupported pairs reached the model: check allowedLanguages and source != target before the text leaves the service; the Translate calls")
}

func CheckIdentityMarker(ctx *harness.Ctx) {
	c := api(ctx)
	same := post(c, map[string]any{"text": "le chat est sur la table", "source": "en", "target": "fr"}, "acme")
	ctx.Equal(same.Status, 200, "French text sent for French (%s)", same.Text())
	body := answer(ctx, same)
	ctx.Assert(body["marker"] == "untranslated" && body["translation"] == "le chat est sur la table", "French text sent for French answered %s: without marker untranslated a cache keeps it as a translation", same.Text())
	ctx.Equal(apiCalls(ctx), 0, "text already in the target language must not be sent to the model; the Translate calls")
	other := post(c, map[string]any{"text": "the cat is on the table", "source": "en", "target": "fr"}, "acme")
	ctx.Assert(other.Status == 200 && answer(ctx, other)["marker"] == nil, "English text for French answered %d %s, expected a translation with no marker", other.Status, other.Text())
}

func CheckGlossaryBinding(ctx *harness.Ctx) {
	c := api(ctx)
	_, err := glossary.PublishTerms(apiBg, "acme", "en", "fr", map[string]string{"Dashboard": "Tableau de bord"})
	ctx.NoError(err, "seeding glossary version 1")
	_, err = glossary.PublishTerms(apiBg, "acme", "en", "fr", map[string]string{"Dashboard": "Panneau"})
	ctx.NoError(err, "seeding glossary version 2")
	pinned := post(c, map[string]any{"text": "Open the Dashboard", "source": "en", "target": "fr", "glossary_version": 1}, "acme")
	ctx.Equal(pinned.Status, 200, "a request pinning glossary version 1 (%s)", pinned.Text())
	body := answer(ctx, pinned)
	ctx.Assert(body["glossary_version"] == float64(1) && body["translation"] == "[fr] Open the Tableau de bord", "a request pinning glossary version 1 got %s: it was translated with another version's terms", pinned.Text())
	sent := ctx.GRPC.CallsTo("Translate", "")
	ctx.Equal(sent[len(sent)-1].Request.(*pb.TranslateRequest).GetGlossaryVersion(), int64(1), "the glossary version the model was told")
	active := answer(ctx, post(c, map[string]any{"text": "Close the Dashboard", "source": "en", "target": "fr"}, "acme"))
	ctx.Assert(active["glossary_version"] == float64(2) && active["translation"] == "[fr] Close the Panneau", "with no version pinned the active version 2 applies, got %v", active)
	before := apiCalls(ctx)
	unknown := post(c, map[string]any{"text": "Open the Dashboard", "source": "en", "target": "fr", "glossary_version": 7}, "acme")
	ctx.Equal(unknown.Status, 404, "an unknown glossary version (%s)", unknown.Text())
	other := post(c, map[string]any{"text": "Open the Dashboard", "source": "en", "target": "fr", "glossary_version": 1}, "globex")
	ctx.Equal(other.Status, 404, "globex pinning acme's version 1")
	ctx.Equal(apiCalls(ctx), before, "a request with an unknown glossary version must not reach the model; the Translate calls")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <set>
#include <string>

namespace {

using json = nlohmann::json;

// The model: '[target] text' with every glossary term applied; a pair it does not serve is INVALID_ARGUMENT.
class ApiModel final : public translationsvc::Translator::Service {
 public:
  grpc::Status Translate(grpc::ServerContext*, const translationsvc::TranslateRequest* req, translationsvc::TranslateReply* out) override {
    static const std::set<std::string> served = {"en", "fr", "de", "es", "ja", "pt"};
    if (!served.count(req->source()) || !served.count(req->target()) || req->source() == req->target()) {
      return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "pair " + req->source() + "->" + req->target() + " is not served");
    }
    std::string s = req->text();
    for (const auto& term : req->terms()) {
      for (size_t at = s.find(term.source()); at != std::string::npos; at = s.find(term.source(), at + term.target().size())) {
        s.replace(at, term.source().size(), term.target());
      }
    }
    out->set_text("[" + req->target() + "] " + s);
    out->set_model("mt-2026-10");
    return grpc::Status::OK;
  }
};

harness::HTTP api(harness::Ctx& ctx) {
  static ApiModel* model = nullptr;
  static httplib::Server* svr = nullptr;
  delete model;
  model = new ApiModel;
  ctx.GRPC.Server("")->RegisterService(model);
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

size_t calls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("Translate").size(); }

harness::Response post(harness::HTTP& c, const json& body, const std::string& tenant = "acme") {
  if (tenant.empty()) return c.Post("/v1/translations", body.dump(), "Content-Type", "application/json");
  return c.Post("/v1/translations", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant);
}

json answer(harness::Ctx& ctx, const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the answer is not a JSON object: %s", r.Text());
  return body;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = post(c, {{"text", "the invoice is ready"}, {"source", "en"}, {"target", "fr"}});
  ctx.Equal(r.Status, 200, "POST /v1/translations (%s)", r.Text());
  ctx.Equal(answer(ctx, r), json{{"translation", "[fr] the invoice is ready"}, {"marker", nullptr}, {"glossary_version", 0}}, "a tenant with no glossary; the answer");
  const auto missing = post(c, {{"text", "the invoice is ready"}, {"source", "en"}, {"target", "fr"}}, "");
  ctx.Equal(missing.Status, 401, "a request without X-Tenant-Id");
}

void CheckTextCap(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto atCap = post(c, {{"text", std::string(16384, 'a')}, {"source", "en"}, {"target", "fr"}});
  ctx.Equal(atCap.Status, 200, "a text of exactly 16 KiB (%s)", atCap.Text());
  const auto over = post(c, {{"text", std::string(16385, 'a')}, {"source", "en"}, {"target", "fr"}});
  ctx.Equal(over.Status, 413, "a text of 16 KiB + 1 byte");
  std::string kanji;
  for (int i = 0; i < 6000; i++) kanji += "日";
  const auto wide = post(c, {{"text", kanji}, {"source", "ja"}, {"target", "en"}});
  ctx.Equal(wide.Status, 413, "6000 kanji are 18000 bytes of UTF-8: the cap is in bytes, not characters; the status");
  const auto empty = post(c, {{"text", ""}, {"source", "en"}, {"target", "fr"}});
  ctx.Equal(empty.Status, 400, "an empty text");
  const auto number = post(c, {{"text", 42}, {"source", "en"}, {"target", "fr"}});
  ctx.Equal(number.Status, 400, "a text that is not a string");
  ctx.Equal(calls(ctx), 1, "only the text within the cap may reach the model; the Translate calls");
}

void CheckLanguagePair(harness::Ctx& ctx) {
  auto c = api(ctx);
  for (const auto& [source, target] : std::vector<std::pair<std::string, std::string>>{{"en", "tlh"}, {"xx", "fr"}, {"en", "en"}}) {
    const auto r = post(c, {{"text", "the invoice is ready"}, {"source", source}, {"target", target}});
    ctx.Equal(r.Status, 400, "%s->%s (%s)", source, target, r.Text());
  }
  ctx.Equal(calls(ctx), 0, "unsupported pairs reached the model: check kAllowedLanguages and source != target before the text leaves the service; the Translate calls");
}

void CheckIdentityMarker(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto same = post(c, {{"text", "le chat est sur la table"}, {"source", "en"}, {"target", "fr"}});
  ctx.Equal(same.Status, 200, "French text sent for French (%s)", same.Text());
  const json body = answer(ctx, same);
  ctx.Assert(body.value("marker", json()) == "untranslated" && body.value("translation", "") == "le chat est sur la table",
             "French text sent for French answered %s: without marker untranslated a cache keeps it as a translation", same.Text());
  ctx.Equal(calls(ctx), 0, "text already in the target language must not be sent to the model; the Translate calls");
  const auto other = post(c, {{"text", "the cat is on the table"}, {"source", "en"}, {"target", "fr"}});
  ctx.Assert(other.Status == 200 && answer(ctx, other).value("marker", json("absent")).is_null(), "English text for French answered %d %s, expected a translation with no marker", other.Status, other.Text());
}

void CheckGlossaryBinding(harness::Ctx& ctx) {
  auto c = api(ctx);
  glossary::publishTerms("acme", "en", "fr", {{"Dashboard", "Tableau de bord"}});
  glossary::publishTerms("acme", "en", "fr", {{"Dashboard", "Panneau"}});
  const auto pinned = post(c, {{"text", "Open the Dashboard"}, {"source", "en"}, {"target", "fr"}, {"glossary_version", 1}});
  ctx.Equal(pinned.Status, 200, "a request pinning glossary version 1 (%s)", pinned.Text());
  const json body = answer(ctx, pinned);
  ctx.Assert(body.value("glossary_version", 0L) == 1 && body.value("translation", "") == "[fr] Open the Tableau de bord",
             "a request pinning glossary version 1 got %s: it was translated with another version's terms", pinned.Text());
  const auto sent = ctx.GRPC.CallsTo("Translate");
  ctx.Equal(sent.back().Request<translationsvc::TranslateRequest>().glossary_version(), 1, "the glossary version the model was told");
  const json active = answer(ctx, post(c, {{"text", "Close the Dashboard"}, {"source", "en"}, {"target", "fr"}}));
  ctx.Assert(active.value("glossary_version", 0L) == 2 && active.value("translation", "") == "[fr] Close the Panneau", "with no version pinned the active version 2 applies, got %s", active.dump());
  const size_t before = calls(ctx);
  const auto unknown = post(c, {{"text", "Open the Dashboard"}, {"source", "en"}, {"target", "fr"}, {"glossary_version", 7}});
  ctx.Equal(unknown.Status, 404, "an unknown glossary version (%s)", unknown.Text());
  const auto other = post(c, {{"text", "Open the Dashboard"}, {"source", "en"}, {"target", "fr"}, {"glossary_version", 1}}, "globex");
  ctx.Equal(other.Status, 404, "globex pinning acme's version 1");
  ctx.Equal(calls(ctx), before, "a request with an unknown glossary version must not reach the model; the Translate calls");
}
`,
  },
  hints: [
    'Paste 30 KB, ask for English to English, or send French for French: each goes through, the first two to the model and the last back as a plain 200. A request pinning version 1 comes back with version 2.',
    'The handler reads `text`, `source` and `target` and goes straight to the glossary and the model: nothing measures the text, checks the pair, or reads `glossary_version`, and the detection branch answers `marker: None`.',
    'Before the glossary: 400 for a missing text, 413 over `MAX_TEXT_BYTES` of `text.encode("utf-8")`, 400 outside `ALLOWED_LANGUAGES` or for `source == target`; pass `glossary_version` to `resolve_glossary` and 404 on None; answer the detection branch with `UNTRANSLATED`.',
  ],
  debrief: `Every guard in this handler runs before the text leaves the service, because once a 30 KB paste or a Klingon target reaches the model the cost and the data exposure are already spent. The cap is in UTF-8 bytes because that is what the model, the logs and the bill count; a character cap lets a Japanese document through at three times the size. The pinned version is the request's contract with the glossary: honoring it is what lets a caller reproduce yesterday's translation. The marker on detected text is what keeps a cache from storing French as the French translation of itself. Production services add per-tenant quotas, request ids that tie the translation to its event, and segmentation for long documents instead of one large call.`,
};
