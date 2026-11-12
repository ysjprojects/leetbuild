import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'GET /v1/autocomplete: a folded, bounded prefix and ten distinct suggestions',
  concept: 'http',
  guides: ['request-boundaries'],
  file: 'api',
  focus: ['client', 'api', 'terms'],
  task: `## Task

**Starting point.** The starter registers \`GET /v1/autocomplete\`: it answers **401** without
\`X-Tenant-Id\`, trims and lowercases \`prefix\`, and returns the first ten terms
\`terms.matching(tenant, prefix)\` ranks, as \`{"prefix", "suggestions"}\`. It serves the demo and
hides three flaws.

**Failure mode the checks target.** \`CRÈME\` finds nothing although \`creme fraiche\` is in the
store; an empty prefix walks the tenant's whole index and an escape sequence goes through to the
store; and \`Café Noir\`, \`cafe noir\` and \`CAFÉ NOIR\` take three of the ten slots.

- Normalize the prefix with \`terms.fold\` (case, Latin accents, whitespace) and answer the folded
  prefix.
- A raw prefix with a control character (U+0000 to U+001F, U+007F) is **400** before any lookup;
  so is a folded prefix outside 1 to \`MAX_PREFIX_CHARS\` = 64 characters.
- Dedupe the ranked terms by their folded form, keeping the first spelling, then cap at
  \`MAX_SUGGESTIONS\` = 10.`,
  sequence: {
    participants: ['Search box', 'suggestd', 'Term store'],
    messages: [
      {from: 'Search box', to: 'suggestd', label: 'GET /v1/autocomplete?prefix=CRÈME · X-Tenant-Id', kind: 'sync'},
      {from: 'suggestd', to: 'suggestd', label: 'control character → 400 · fold → "creme" · 1..64', kind: 'sync'},
      {from: 'suggestd', to: 'Term store', label: 'matching(tenant, "creme")', kind: 'sync'},
      {from: 'Term store', to: 'suggestd', label: 'ranked terms, every spelling', kind: 'reply'},
      {from: 'suggestd', to: 'suggestd', label: 'dedupe by fold(term) · first 10', kind: 'sync'},
      {from: 'suggestd', to: 'Search box', label: '200 {prefix: "creme", suggestions}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/autocomplete per tenant',
      detail:
        'Register `GET /v1/autocomplete`; a request without `X-Tenant-Id` is **401**, and a tenant sees its own ranked terms as `{"prefix", "suggestions"}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/autocomplete["']/, /x-tenant-id/i, /\b401\b/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/autocomplete['"]/, /x-tenant-id/i, /\b401\b/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/autocomplete"/, /X-Tenant-Id/i, /StatusUnauthorized|\b401\b/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"autocomplete"\s*\)/, /X-Tenant-Id/i, /Unauthorized|\b401\b/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/autocomplete"/, /X-Tenant-Id/i, /\b401\b/]},
      },
    },
    {
      id: 'fold-prefix',
      title: 'Folds the prefix the way the store folds terms',
      detail:
        'The prefix goes through `terms.fold` before the lookup, so `CRÈME`, `crème` and `  creme ` are one prefix; lowercasing leaves the accent and matches nothing.',
      match: {
        python: {all: [/terms\.fold\(/], none: [/\.lower\(\)/]},
        typescript: {all: [/\bfold\(/], none: [/toLowerCase\(/]},
        go: {all: [/terms\.Fold\(/], none: [/strings\.ToLower\(/]},
        scala: {all: [/Terms\.fold\(|Terms\.fold\b/], none: [/toLowerCase/]},
        cpp: {all: [/terms::fold\(/], none: [/tolower/]},
      },
    },
    {
      id: 'bounded-prefix',
      title: 'Rejects empty, oversized and control-character prefixes',
      detail:
        'A raw prefix with a C0 control character or DEL is **400**, and so is a folded prefix shorter than 1 or longer than `MAX_PREFIX_CHARS` (64) characters, before any lookup.',
      match: {
        python: {
          all: [
            /MAX_PREFIX_CHARS\s*=\s*64\b/,
            /\b400\b/,
            /0x20|0x1[fF]|\b3[12]\b|\\x1[fF]|0x7[fF]|\\x7[fF]|\b127\b|isprintable/,
          ],
        },
        typescript: {
          all: [
            /MAX_PREFIX_CHARS\s*=\s*64\b/,
            /\b400\b/,
            /0x20|0x1[fF]|\b3[12]\b|\\x1[fF]|0x7[fF]|\\x7[fF]|\\u007[fF]|\b127\b|\\p\{Cc\}/,
          ],
        },
        go: {
          all: [
            /maxPrefixChars\s*=\s*64\b/,
            /StatusBadRequest|\b400\b/,
            /0x20|0x1[fF]|\b3[12]\b|0x7[fF]|\b127\b|unicode\.IsControl/,
          ],
        },
        scala: {
          all: [
            /MaxPrefixChars\s*=\s*64\b/,
            /BadRequest|\b400\b/,
            /0x20|0x1[fF]|\b3[12]\b|0x7[fF]|\b127\b|isControl|isISOControl/,
          ],
        },
        cpp: {
          all: [
            /kMaxPrefixChars\{?\s*=?\s*64\b|kMaxPrefixChars\s*=\s*64\b/,
            /\b400\b/,
            /0x20|0x1[fF]|\b3[12]\b|0x7[fF]|\b127\b|iscntrl/,
          ],
        },
      },
    },
    {
      id: 'dedupe-then-cap',
      title: 'Dedupes by folded term before capping at ten',
      detail:
        'Spellings that fold alike are one suggestion (the first, highest ranked, is kept), and the cap of `MAX_SUGGESTIONS` applies after the dedupe; slicing the ranked list first lets duplicates take the slots.',
      match: {
        python: {
          all: [/\bseen\b|dedup|unique|distinct|set\(\)|dict\.fromkeys/],
          none: [/matching\([^)]*\)\s*\[\s*:\s*MAX_SUGGESTIONS/],
        },
        typescript: {all: [/\bseen\b|dedup|unique|distinct|new Set/], none: [/matching\([^)]*\)\)?\.slice\(/]},
        go: {
          all: [/\bseen\b|dedup|unique|distinct|map\[string\]bool|map\[string\]struct/],
          none: [/suggestions\[:maxSuggestions\]/],
        },
        scala: {all: [/distinctBy|\.distinct\b|\bseen\b/], none: [/matching\([^)]*\)\.take\(/]},
        cpp: {all: [/\bseen\b|dedup|unique|distinct|std::(unordered_)?set/], none: [/suggestions\.resize\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from suggest import terms  # fold, matching

app = FastAPI()

MAX_SUGGESTIONS = 10


@app.get("/v1/autocomplete")
def autocomplete(request: Request):
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    prefix = request.query_params.get("prefix", "").strip().lower()
    return {"prefix": prefix, "suggestions": terms.matching(tenant, prefix)[:MAX_SUGGESTIONS]}
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from suggest import terms  # fold, matching

app = FastAPI()

MAX_PREFIX_CHARS = 64
MAX_SUGGESTIONS = 10


@app.get("/v1/autocomplete")
def autocomplete(request: Request):
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    raw = request.query_params.get("prefix", "")
    # Rejected before any lookup: a control character never reaches a key or a log line.
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in raw):
        return JSONResponse({"error": "prefix contains a control character"}, status_code=400)
    prefix = terms.fold(raw)
    if not 1 <= len(prefix) <= MAX_PREFIX_CHARS:
        return JSONResponse({"error": "prefix must be 1 to 64 characters"}, status_code=400)
    # Dedupe on the folded form first, then cap: duplicates must not take the ten slots.
    suggestions, seen = [], set()
    for term in terms.matching(tenant, prefix):
        key = terms.fold(term)
        if key in seen:
            continue
        seen.add(key)
        suggestions.append(term)
        if len(suggestions) == MAX_SUGGESTIONS:
            break
    return {"prefix": prefix, "suggestions": suggestions}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {fold, matching} from 'suggest/terms';

export const app = Fastify();

export const MAX_SUGGESTIONS = 10;

app.get('/v1/autocomplete', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const prefix = ((request.query as {prefix?: string}).prefix ?? '').trim().toLowerCase();
  const suggestions = (await matching(tenant, prefix)).slice(0, MAX_SUGGESTIONS);
  return {prefix, suggestions};
});
`,
      solution: `import Fastify from 'fastify';

import {fold, matching} from 'suggest/terms';

export const app = Fastify();

export const MAX_PREFIX_CHARS = 64;
export const MAX_SUGGESTIONS = 10;

app.get('/v1/autocomplete', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const raw = (request.query as {prefix?: string}).prefix ?? '';
  // Rejected before any lookup: a control character never reaches a key or a log line.
  if ([...raw].some(ch => ch < ' ' || ch === '\\x7f')) return reply.code(400).send({error: 'prefix contains a control character'});
  const prefix = fold(raw);
  const length = [...prefix].length;
  if (length < 1 || length > MAX_PREFIX_CHARS) return reply.code(400).send({error: 'prefix must be 1 to 64 characters'});
  // Dedupe on the folded form first, then cap: duplicates must not take the ten slots.
  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const term of await matching(tenant, prefix)) {
    const key = fold(term);
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(term);
    if (suggestions.length === MAX_SUGGESTIONS) break;
  }
  return {prefix, suggestions};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"suggest/terms" // terms.Fold, terms.Matching
)

const maxSuggestions = 10

type answer struct {
	Prefix      string   \`json:"prefix"\`
	Suggestions []string \`json:"suggestions"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func autocomplete(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	prefix := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("prefix")))
	suggestions := append([]string{}, terms.Matching(r.Context(), tenant, prefix)...)
	if len(suggestions) > maxSuggestions {
		suggestions = suggestions[:maxSuggestions]
	}
	writeJSON(rw, http.StatusOK, answer{Prefix: prefix, Suggestions: suggestions})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/autocomplete", autocomplete)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"unicode/utf8"

	"suggest/terms" // terms.Fold, terms.Matching
)

const (
	maxPrefixChars = 64
	maxSuggestions = 10
)

type answer struct {
	Prefix      string   \`json:"prefix"\`
	Suggestions []string \`json:"suggestions"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func autocomplete(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	raw := r.URL.Query().Get("prefix")
	// Rejected before any lookup: a control character never reaches a key or a log line.
	if strings.IndexFunc(raw, func(ch rune) bool { return ch < 0x20 || ch == 0x7f }) >= 0 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "prefix contains a control character"})
		return
	}
	prefix := terms.Fold(raw)
	if n := utf8.RuneCountInString(prefix); n < 1 || n > maxPrefixChars {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "prefix must be 1 to 64 characters"})
		return
	}
	// Dedupe on the folded form first, then cap: duplicates must not take the ten slots.
	suggestions := []string{}
	seen := map[string]bool{}
	for _, term := range terms.Matching(r.Context(), tenant, prefix) {
		key := terms.Fold(term)
		if seen[key] {
			continue
		}
		seen[key] = true
		suggestions = append(suggestions, term)
		if len(suggestions) == maxSuggestions {
			break
		}
	}
	writeJSON(rw, http.StatusOK, answer{Prefix: prefix, Suggestions: suggestions})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/autocomplete", autocomplete)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import suggest.Terms // Terms.fold, Terms.matching

object Api {
  val MaxSuggestions = 10

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def answer(prefix: String, suggestions: Seq[String]): JsObject =
    JsObject("prefix" -> JsString(prefix), "suggestions" -> JsArray(suggestions.map(JsString(_)).toVector))

  val route: Route = path("v1" / "autocomplete") {
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required"))))
        case Some(tenant) =>
          parameter("prefix".optional) { raw =>
            // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
            val prefix = raw.getOrElse("").trim.toLowerCase
            complete(json(StatusCodes.OK, answer(prefix, Terms.matching(tenant, prefix).take(MaxSuggestions))))
          }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import suggest.Terms // Terms.fold, Terms.matching

object Api {
  val MaxPrefixChars = 64
  val MaxSuggestions = 10

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def answer(prefix: String, suggestions: Seq[String]): JsObject =
    JsObject("prefix" -> JsString(prefix), "suggestions" -> JsArray(suggestions.map(JsString(_)).toVector))

  private def badRequest(message: String): HttpResponse = json(StatusCodes.BadRequest, JsObject("error" -> JsString(message)))

  val route: Route = path("v1" / "autocomplete") {
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required"))))
        case Some(tenant) =>
          parameter("prefix".optional) { raw =>
            val text = raw.getOrElse("")
            val prefix = Terms.fold(text)
            val length = prefix.codePointCount(0, prefix.length)
            // Rejected before any lookup: a control character never reaches a key or a log line.
            if (text.exists(ch => ch < 0x20 || ch == 0x7f)) complete(badRequest("prefix contains a control character"))
            else if (length < 1 || length > MaxPrefixChars) complete(badRequest("prefix must be 1 to 64 characters"))
            else {
              // Dedupe on the folded form first, then cap: duplicates must not take the ten slots.
              val suggestions = Terms.matching(tenant, prefix).distinctBy(Terms.fold).take(MaxSuggestions)
              complete(json(StatusCodes.OK, answer(prefix, suggestions)))
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

#include <algorithm>
#include <cctype>
#include <string>
#include <vector>

#include "suggest/terms.h"  // terms::fold, terms::matching

using json = nlohmann::json;

constexpr size_t kMaxSuggestions = 10;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void autocomplete(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  std::string prefix = req.get_param_value("prefix");
  prefix.erase(0, prefix.find_first_not_of(' '));
  prefix.erase(prefix.find_last_not_of(' ') + 1);
  std::transform(prefix.begin(), prefix.end(), prefix.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  std::vector<std::string> suggestions = terms::matching(tenant, prefix);
  if (suggestions.size() > kMaxSuggestions) suggestions.resize(kMaxSuggestions);
  reply(res, 200, {{"prefix", prefix}, {"suggestions", suggestions}});
}

void register_routes(httplib::Server& svr) { svr.Get("/v1/autocomplete", autocomplete); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <set>
#include <string>
#include <vector>

#include "suggest/terms.h"  // terms::fold, terms::matching

using json = nlohmann::json;

constexpr size_t kMaxPrefixChars = 64;
constexpr size_t kMaxSuggestions = 10;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void autocomplete(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const std::string raw = req.get_param_value("prefix");
  // Rejected before any lookup: a control character never reaches a key or a log line.
  if (std::any_of(raw.begin(), raw.end(), [](unsigned char c) { return c < 0x20 || c == 0x7f; })) {
    return reply(res, 400, {{"error", "prefix contains a control character"}});
  }
  const std::string prefix = terms::fold(raw);
  // Characters, not bytes: a UTF-8 continuation byte is 10xxxxxx.
  const auto length = static_cast<size_t>(std::count_if(prefix.begin(), prefix.end(), [](unsigned char c) { return (c & 0xC0) != 0x80; }));
  if (length < 1 || length > kMaxPrefixChars) return reply(res, 400, {{"error", "prefix must be 1 to 64 characters"}});
  // Dedupe on the folded form first, then cap: duplicates must not take the ten slots.
  std::vector<std::string> suggestions;
  std::set<std::string> seen;
  for (const std::string& term : terms::matching(tenant, prefix)) {
    if (!seen.insert(terms::fold(term)).second) continue;
    suggestions.push_back(term);
    if (suggestions.size() == kMaxSuggestions) break;
  }
  reply(res, 200, {{"prefix", prefix}, {"suggestions", suggestions}});
}

void register_routes(httplib::Server& svr) { svr.Get("/v1/autocomplete", autocomplete); }
`,
    },
  },
  harness: {
    python: `def _seed(ctx, tenant, counts):
    ctx.redis.zadd(f"suggest:terms:{tenant}", counts)


async def _ask(c, prefix, tenant="acme"):
    headers = {"X-Tenant-Id": tenant} if tenant else {}
    return await c.get("/v1/autocomplete", params={"prefix": prefix}, headers=headers)


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def check_route(ctx):
    _seed(ctx, "acme", {"kettle": 50, "kettlebell": 40, "keyboard": 30, "lamp": 20})
    _seed(ctx, "globex", {"kebab": 90})
    async with _api(ctx) as c:
        r = await _ask(c, "ke")
        assert r.status_code == 200, f"GET /v1/autocomplete?prefix=ke answered {r.status_code}: {r.text}"
        body = r.json()
        assert body == {"prefix": "ke", "suggestions": ["kettle", "kettlebell", "keyboard"]}, f"acme's completions for ke are {body}, expected kettle, kettlebell, keyboard (globex's kebab is not acme's)"
        r = await _ask(c, "ke", tenant=None)
    assert r.status_code == 401, f"a request without X-Tenant-Id answered {r.status_code}, expected 401"


async def check_fold_prefix(ctx):
    _seed(ctx, "acme", {"Crème brûlée": 60, "creme fraiche": 50, "cream": 40, "crepe": 30})
    async with _api(ctx) as c:
        for raw in ("CRÈME", "crème", "Creme", "  crème  "):
            r = await _ask(c, raw)
            assert r.status_code == 200, f"prefix {raw!r} answered {r.status_code}: {r.text}"
            body = r.json()
            assert body.get("prefix") == "creme", f"prefix {raw!r} was answered as {body.get('prefix')!r}, expected the folded prefix 'creme'"
            assert body.get("suggestions") == ["Crème brûlée", "creme fraiche"], f"prefix {raw!r} found {body.get('suggestions')}: the store folds every term, so the prefix must be folded the same way (terms.fold)"
        r = await _ask(c, "crème   BR")
    body = r.json()
    assert body.get("prefix") == "creme br" and body.get("suggestions") == ["Crème brûlée"], f"prefix 'crème   BR' gave {body}, expected 'creme br' and Crème brûlée"


async def check_bounded_prefix(ctx):
    _seed(ctx, "acme", {"kettle": 50, "kettlebell": 40, "lamp": 20})
    async with _api(ctx) as c:
        for raw, what in (("", "an empty prefix"), ("   ", "a prefix of spaces"), ("k" * 65, "a 65-character prefix")):
            r = await _ask(c, raw)
            assert r.status_code == 400, f"{what} answered {r.status_code} {r.text[:120]}, expected 400: an empty prefix walks the tenant's whole index"
        r = await _ask(c, "k" * 64)
        assert r.status_code == 200, f"a 64-character prefix answered {r.status_code}, expected 200"
        for raw in ("ke\\x00", "ke\\x1b[2J", "ke\\x7f", "ke\\nlamp"):
            r = await _ask(c, raw)
            assert r.status_code == 400, f"prefix {raw!r} answered {r.status_code}, expected 400: a control character must be rejected before any lookup"


async def check_dedupe_then_cap(ctx):
    counts = {"Café Noir": 200, "cafe noir": 199, "CAFÉ NOIR": 198}
    counts.update({f"cafe {n:02d}": 150 - n for n in range(1, 13)})
    _seed(ctx, "acme", counts)
    async with _api(ctx) as c:
        r = await _ask(c, "caf")
    assert r.status_code == 200, f"prefix caf answered {r.status_code}: {r.text}"
    got = r.json().get("suggestions")
    want = ["Café Noir"] + [f"cafe {n:02d}" for n in range(1, 10)]
    assert got == want, f"prefix caf answered {got}, expected {want}: spellings that fold alike are one suggestion (the first is kept), and the cap of 10 applies after the dedupe"
`,
    typescript: `function api(ctx) {
  return ctx.client(ctx.load('api').app);
}

function seed(ctx, tenant: string, counts: Record<string, number>): void {
  for (const [term, count] of Object.entries(counts)) ctx.redis.zadd(\`suggest:terms:\${tenant}\`, count, term);
}

const ask = (c, prefix: string, tenant: string | null = 'acme') =>
  c.get(\`/v1/autocomplete?prefix=\${encodeURIComponent(prefix)}\`, {headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});

export async function check_route(ctx) {
  seed(ctx, 'acme', {kettle: 50, kettlebell: 40, keyboard: 30, lamp: 20});
  seed(ctx, 'globex', {kebab: 90});
  const c = api(ctx);
  let r = await ask(c, 'ke');
  assert.equal(r.status, 200, \`GET /v1/autocomplete?prefix=ke answered \${r.status}: \${r.text}\`);
  assert.deepStrictEqual(r.json(), {prefix: 'ke', suggestions: ['kettle', 'kettlebell', 'keyboard']}, \`acme's completions for ke are \${r.text}, expected kettle, kettlebell, keyboard (globex's kebab is not acme's)\`);
  r = await ask(c, 'ke', null);
  assert.equal(r.status, 401, \`a request without X-Tenant-Id answered \${r.status}, expected 401\`);
}

export async function check_fold_prefix(ctx) {
  seed(ctx, 'acme', {'Crème brûlée': 60, 'creme fraiche': 50, cream: 40, crepe: 30});
  const c = api(ctx);
  for (const raw of ['CRÈME', 'crème', 'Creme', '  crème  ']) {
    const r = await ask(c, raw);
    assert.equal(r.status, 200, \`prefix \${JSON.stringify(raw)} answered \${r.status}: \${r.text}\`);
    const body = r.json();
    assert.equal(body.prefix, 'creme', \`prefix \${JSON.stringify(raw)} was answered as \${JSON.stringify(body.prefix)}, expected the folded prefix "creme"\`);
    assert.deepStrictEqual(body.suggestions, ['Crème brûlée', 'creme fraiche'], \`prefix \${JSON.stringify(raw)} found \${JSON.stringify(body.suggestions)}: the store folds every term, so the prefix must be folded the same way (fold)\`);
  }
  const body = (await ask(c, 'crème   BR')).json();
  assert(body.prefix === 'creme br' && JSON.stringify(body.suggestions) === JSON.stringify(['Crème brûlée']), \`prefix "crème   BR" gave \${JSON.stringify(body)}, expected "creme br" and Crème brûlée\`);
}

export async function check_bounded_prefix(ctx) {
  seed(ctx, 'acme', {kettle: 50, kettlebell: 40, lamp: 20});
  const c = api(ctx);
  for (const [raw, what] of [['', 'an empty prefix'], ['   ', 'a prefix of spaces'], ['k'.repeat(65), 'a 65-character prefix']]) {
    const r = await ask(c, raw);
    assert.equal(r.status, 400, \`\${what} answered \${r.status} \${r.text.slice(0, 120)}, expected 400: an empty prefix walks the tenant's whole index\`);
  }
  const r = await ask(c, 'k'.repeat(64));
  assert.equal(r.status, 200, \`a 64-character prefix answered \${r.status}, expected 200\`);
  for (const raw of ['ke\\x00', 'ke\\x1b[2J', 'ke\\x7f', 'ke\\nlamp']) {
    const bad = await ask(c, raw);
    assert.equal(bad.status, 400, \`prefix \${JSON.stringify(raw)} answered \${bad.status}, expected 400: a control character must be rejected before any lookup\`);
  }
}

export async function check_dedupe_then_cap(ctx) {
  const counts: Record<string, number> = {'Café Noir': 200, 'cafe noir': 199, 'CAFÉ NOIR': 198};
  const numbered = Array.from({length: 12}, (_, i) => \`cafe \${String(i + 1).padStart(2, '0')}\`);
  numbered.forEach((term, i) => (counts[term] = 149 - i));
  seed(ctx, 'acme', counts);
  const r = await ask(api(ctx), 'caf');
  assert.equal(r.status, 200, \`prefix caf answered \${r.status}: \${r.text}\`);
  const want = ['Café Noir', ...numbered.slice(0, 9)];
  assert.deepStrictEqual(r.json().suggestions, want, \`prefix caf answered \${JSON.stringify(r.json().suggestions)}, expected \${JSON.stringify(want)}: spellings that fold alike are one suggestion (the first is kept), and the cap of 10 applies after the dedupe\`);
}
`,
    go: `package main

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"leetbuild/harness"
)

type acBody struct {
	Prefix      string   \`json:"prefix"\`
	Suggestions []string \`json:"suggestions"\`
}

func acSeed(ctx *harness.Ctx, tenant string, counts map[string]int) {
	for term, n := range counts {
		ctx.Redis.Do("ZADD", "suggest:terms:"+tenant, n, term)
	}
}

func acAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func acAsk(c *harness.HTTP, prefix string) *harness.Response {
	return c.Get("/v1/autocomplete?prefix="+url.QueryEscape(prefix), "X-Tenant-Id", "acme")
}

func acDecode(r *harness.Response) acBody {
	var body acBody
	r.Decode(&body)
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	acSeed(ctx, "acme", map[string]int{"kettle": 50, "kettlebell": 40, "keyboard": 30, "lamp": 20})
	acSeed(ctx, "globex", map[string]int{"kebab": 90})
	c := acAPI(ctx)
	r := acAsk(c, "ke")
	ctx.Equal(r.Status, 200, "GET /v1/autocomplete?prefix=ke (%s)", r.Text())
	body := acDecode(r)
	ctx.Equal(body.Prefix, "ke", "the answered prefix")
	ctx.Equal(body.Suggestions, []string{"kettle", "kettlebell", "keyboard"}, "acme's completions for ke (globex's kebab is not acme's)")
	r = c.Get("/v1/autocomplete?prefix=ke")
	ctx.Equal(r.Status, 401, "a request without X-Tenant-Id")
}

func CheckFoldPrefix(ctx *harness.Ctx) {
	acSeed(ctx, "acme", map[string]int{"Crème brûlée": 60, "creme fraiche": 50, "cream": 40, "crepe": 30})
	c := acAPI(ctx)
	for _, raw := range []string{"CRÈME", "crème", "Creme", "  crème  "} {
		r := acAsk(c, raw)
		ctx.Equal(r.Status, 200, "prefix %q (%s)", raw, r.Text())
		body := acDecode(r)
		ctx.Equal(body.Prefix, "creme", "prefix %q must be answered as the folded prefix", raw)
		ctx.Equal(body.Suggestions, []string{"Crème brûlée", "creme fraiche"}, "prefix %q: the store folds every term, so the prefix must be folded the same way (terms.Fold); the suggestions", raw)
	}
	body := acDecode(acAsk(c, "crème   BR"))
	ctx.Assert(body.Prefix == "creme br" && fmt.Sprint(body.Suggestions) == "[Crème brûlée]", "prefix \\"crème   BR\\" gave %q %q, expected \\"creme br\\" and Crème brûlée", body.Prefix, body.Suggestions)
}

func CheckBoundedPrefix(ctx *harness.Ctx) {
	acSeed(ctx, "acme", map[string]int{"kettle": 50, "kettlebell": 40, "lamp": 20})
	c := acAPI(ctx)
	for _, raw := range []string{"", "   ", strings.Repeat("k", 65)} {
		r := acAsk(c, raw)
		ctx.Equal(r.Status, 400, "prefix %q (%d characters) must be 400: an empty prefix walks the tenant's whole index", raw, len(raw))
	}
	ctx.Equal(acAsk(c, strings.Repeat("k", 64)).Status, 200, "a 64-character prefix")
	for _, raw := range []string{"ke\\x00", "ke\\x1b[2J", "ke\\x7f", "ke\\nlamp"} {
		ctx.Equal(acAsk(c, raw).Status, 400, "prefix %q must be rejected before any lookup (a control character)", raw)
	}
}

func CheckDedupeThenCap(ctx *harness.Ctx) {
	counts := map[string]int{"Café Noir": 200, "cafe noir": 199, "CAFÉ NOIR": 198}
	want := []string{"Café Noir"}
	for n := 1; n <= 12; n++ {
		term := fmt.Sprintf("cafe %02d", n)
		counts[term] = 150 - n
		if n <= 9 {
			want = append(want, term)
		}
	}
	acSeed(ctx, "acme", counts)
	r := acAsk(acAPI(ctx), "caf")
	ctx.Equal(r.Status, 200, "prefix caf (%s)", r.Text())
	ctx.Equal(acDecode(r).Suggestions, want, "spellings that fold alike are one suggestion (the first is kept), and the cap of 10 applies after the dedupe; prefix caf")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cctype>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

namespace {

void acSeed(harness::Ctx& ctx, const std::string& tenant, const std::map<std::string, int>& counts) {
  for (const auto& [term, n] : counts) ctx.Redis.Must({"ZADD", "suggest:terms:" + tenant, std::to_string(n), term});
}

harness::HTTP acAPI(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string acEscape(const std::string& text) {
  std::string out;
  char hex[4];
  for (const unsigned char c : text) {
    if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
      out += static_cast<char>(c);
    } else {
      std::snprintf(hex, sizeof hex, "%%%02X", c);
      out += hex;
    }
  }
  return out;
}

harness::Response acAsk(harness::HTTP& c, const std::string& prefix) {
  return c.Get("/v1/autocomplete?prefix=" + acEscape(prefix), "X-Tenant-Id", "acme");
}

nlohmann::json acBody(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

std::vector<std::string> acSuggestions(const harness::Response& r) {
  const auto body = acBody(r);
  return body.is_object() && body.contains("suggestions") ? body["suggestions"].get<std::vector<std::string>>() : std::vector<std::string>{};
}

std::string acPrefix(const harness::Response& r) {
  const auto body = acBody(r);
  return body.is_object() ? body.value("prefix", "") : "";
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  acSeed(ctx, "acme", {{"kettle", 50}, {"kettlebell", 40}, {"keyboard", 30}, {"lamp", 20}});
  acSeed(ctx, "globex", {{"kebab", 90}});
  auto c = acAPI(ctx);
  const auto r = acAsk(c, "ke");
  ctx.Equal(r.Status, 200, "GET /v1/autocomplete?prefix=ke (%s)", r.Text());
  ctx.Equal(acPrefix(r), "ke", "the answered prefix");
  ctx.Equal(acSuggestions(r), {"kettle", "kettlebell", "keyboard"}, "acme's completions for ke (globex's kebab is not acme's)");
  ctx.Equal(c.Get("/v1/autocomplete?prefix=ke").Status, 401, "a request without X-Tenant-Id");
}

void CheckFoldPrefix(harness::Ctx& ctx) {
  acSeed(ctx, "acme", {{"Crème brûlée", 60}, {"creme fraiche", 50}, {"cream", 40}, {"crepe", 30}});
  auto c = acAPI(ctx);
  for (const std::string raw : {"CRÈME", "crème", "Creme", "  crème  "}) {
    const auto r = acAsk(c, raw);
    ctx.Equal(r.Status, 200, "prefix %q (%s)", raw, r.Text());
    ctx.Equal(acPrefix(r), "creme", "prefix %q must be answered as the folded prefix", raw);
    ctx.Equal(acSuggestions(r), {"Crème brûlée", "creme fraiche"}, "prefix %q: the store folds every term, so the prefix must be folded the same way (terms::fold); the suggestions", raw);
  }
  const auto r = acAsk(c, "crème   BR");
  ctx.Assert(acPrefix(r) == "creme br" && acSuggestions(r) == std::vector<std::string>{"Crème brûlée"}, "prefix \\"crème   BR\\" gave %s, expected \\"creme br\\" and Crème brûlée", r.Text());
}

void CheckBoundedPrefix(harness::Ctx& ctx) {
  acSeed(ctx, "acme", {{"kettle", 50}, {"kettlebell", 40}, {"lamp", 20}});
  auto c = acAPI(ctx);
  for (const std::string raw : {std::string(), std::string("   "), std::string(65, 'k')}) {
    ctx.Equal(acAsk(c, raw).Status, 400, "prefix %q (%d characters) must be 400: an empty prefix walks the tenant's whole index", raw, raw.size());
  }
  ctx.Equal(acAsk(c, std::string(64, 'k')).Status, 200, "a 64-character prefix");
  for (const std::string raw : {std::string("ke\\0", 3), std::string("ke\\x1b[2J"), std::string("ke\\x7f"), std::string("ke\\nlamp")}) {
    ctx.Equal(acAsk(c, raw).Status, 400, "prefix %q must be rejected before any lookup (a control character)", raw);
  }
}

void CheckDedupeThenCap(harness::Ctx& ctx) {
  std::map<std::string, int> counts = {{"Café Noir", 200}, {"cafe noir", 199}, {"CAFÉ NOIR", 198}};
  std::vector<std::string> want = {"Café Noir"};
  char term[16];
  for (int n = 1; n <= 12; ++n) {
    std::snprintf(term, sizeof term, "cafe %02d", n);
    counts[term] = 150 - n;
    if (n <= 9) want.push_back(term);
  }
  acSeed(ctx, "acme", counts);
  auto c = acAPI(ctx);
  const auto r = acAsk(c, "caf");
  ctx.Equal(r.Status, 200, "prefix caf (%s)", r.Text());
  ctx.Equal(acSuggestions(r), want, "spellings that fold alike are one suggestion (the first is kept), and the cap of 10 applies after the dedupe; prefix caf");
}
`,
  },
  hints: [
    "Type `CRÈME` into the box: the dropdown stays empty while `creme fraiche` is in the store. Type `caf`: `Café Noir` shows three times. Clear the box: the tenant's top terms come back anyway.",
    'The store compares the folded form of every term with the prefix it is given, and lowercasing keeps the accent. Nothing measures the prefix or looks at its bytes, and the slice to ten runs before any duplicate is dropped.',
    'Answer 400 when the raw prefix has a character below U+0020 or U+007F; fold it with `terms.fold`; 400 unless it is 1 to 64 characters; walk `matching`, skip a term whose `fold` was seen, stop at ten.',
  ],
  debrief: `Folding once, at the boundary, is what makes every later key agree: the cache of step 2, the suggester of step 3 and the prefix hash of step 4 all see one string for \`Crème\`, \`creme\` and \`CREME\`. The bound and the control-character check run on the request before any store work, so an empty prefix cannot turn a keystroke into a scan of the tenant's index and an escape sequence cannot reach a key or a log line. Dedupe before the cap is an ordering rule: cap first and duplicates spend the slots. Production typeaheads fold with full Unicode normalization and locale-aware case folding (Turkish dotless i, German ß), and debounce keystrokes in the client so the server sees one request per pause.`,
};
