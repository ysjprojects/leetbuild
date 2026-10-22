import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'GET /v1/autocomplete: prefixes with boundaries',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, reads
\`prefix\` from the query string, asks the index for matches and returns them. It compiles, it serves
the demo — a three-letter prefix from one tenant — and it hides three production flaws. Review it
like the service owner, fix it, and prove the fix with the checks below.

Implement \`GET /v1/autocomplete?prefix=…\` for the typeahead box.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`prefix\` is normalized before it is used: case is folded and accents are folded to their base
  letter, so \`Café\`, \`cafe\` and \`CAFÉ\` are one prefix. Whitespace is collapsed.
- After normalization the prefix must be **1 to 64 characters** (**400** when empty or longer). The
  limit is on the *normalized* prefix, so an oversized raw prefix cannot slip through as a shorter
  one, and a prefix longer than 64 characters is a scrape, not a search.
- A prefix containing a **control character** (any C0 control or DEL) is **400**, before any index
  work: those characters corrupt cache keys and log lines.
- The response carries **at most 10 suggestions**, deduplicated by the normalized term so two
  spellings of the same term do not both appear. Order is the index's ranking; the cap is applied
  after dedupe.
- The response shape is \`{"prefix": <normalized>, "suggestions": [...]}\`.

**Failure mode the checks target.** Matching on the unbounded raw prefix lets one request walk the
whole index — \`prefix=\` empty returns thousands of terms — and it turns a case or accent difference
into a second entry. Lowercasing without Unicode folding is the subtle one: \`Café\` and \`cafe\`
survive as two suggestions because \`str.lower()\` never touches the accent, so the list "works" in
English and duplicates the moment the catalog is not.`,
  sequence: {
    participants: ['Client', 'Autocomplete API', 'Suggestion index'],
    messages: [
      {from: 'Client', to: 'Autocomplete API', label: 'GET /v1/autocomplete?prefix=caf · X-Tenant-Id', kind: 'sync'},
      {from: 'Autocomplete API', to: 'Autocomplete API', label: 'normalize · bounds · control chars', kind: 'sync'},
      {from: 'Autocomplete API', to: 'Suggestion index', label: 'matching(tenant, "caf")', kind: 'sync'},
      {from: 'Suggestion index', to: 'Autocomplete API', label: 'ranked terms', kind: 'reply'},
      {from: 'Autocomplete API', to: 'Autocomplete API', label: 'fold · dedupe · take 10', kind: 'sync'},
      {from: 'Autocomplete API', to: 'Client', label: '200 {prefix, suggestions[≤10]}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/autocomplete',
      detail: 'Register the typeahead route on `GET /v1/autocomplete`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/autocomplete["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/autocomplete['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/autocomplete"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"autocomplete"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/autocomplete"/]},
      },
    },
    {
      id: 'prefix-bounds',
      title: 'Bounds the normalized prefix at 64 characters',
      detail:
        'The normalized prefix must be 1..64 characters; an empty or oversized prefix is **400**. The draft matches on the raw prefix with no bound, so `prefix=` returns the whole index.',
      match: {
        python: {all: [/MIN_PREFIX_CHARS/, /MAX_PREFIX_CHARS/, /status_code\s*=\s*400/]},
        typescript: {all: [/MIN_PREFIX_CHARS/, /MAX_PREFIX_CHARS/, /code\(\s*400\s*\)/]},
        go: {all: [/minPrefixChars/, /maxPrefixChars/, /StatusBadRequest/]},
        scala: {all: [/MinPrefixChars/, /MaxPrefixChars/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMinPrefixChars/, /kMaxPrefixChars/, /\b400\b/]},
      },
    },
    {
      id: 'control-chars',
      title: 'Rejects control characters in the prefix',
      detail:
        'A prefix containing a control character is **400** before any index work. The draft forwards the raw prefix to the index and the cache key.',
      match: {
        python: {all: [/CONTROL_CHARS/, /status_code\s*=\s*400/]},
        typescript: {all: [/CONTROL_CHARS/, /code\(\s*400\s*\)/]},
        go: {all: [/controlChars/, /StatusBadRequest/]},
        scala: {all: [/ControlChars/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kControlChars/, /\b400\b/]},
      },
    },
    {
      id: 'suggestion-cap',
      title: 'Returns at most 10 suggestions',
      detail:
        'The endpoint owns the contract: it folds, dedupes by the normalized term, and returns at most 10. The draft returns every match in the index — thousands for a short prefix.',
      match: {
        python: {all: [/MAX_SUGGESTIONS/, /\[:MAX_SUGGESTIONS\]/]},
        typescript: {all: [/MAX_SUGGESTIONS/, /slice\(\s*0\s*,\s*MAX_SUGGESTIONS\s*\)/]},
        go: {all: [/maxSuggestions/, /\[\s*:\s*maxSuggestions\s*\]/]},
        scala: {all: [/MaxSuggestions/, /take\(\s*MaxSuggestions\s*\)/]},
        cpp: {all: [/kMaxSuggestions/, /resize\(/]},
      },
    },
    {
      id: 'normalize',
      title: 'Folds case and accents so duplicates collapse',
      detail:
        'Normalization folds case *and* accents, and suggestions are deduplicated by the normalized term. The draft calls `lower()` only, so `Café` and `cafe` both appear.',
      match: {
        python: {all: [/def fold\(/, /unicodedata/, /seen\s*=\s*set\(/]},
        typescript: {all: [/function fold\(/, /\.normalize\(/, /new Set\b/]},
        go: {all: [/func fold\(/, /norm\.NFD/, /seen\s*:?=/]},
        scala: {all: [/def fold\(/, /Normalizer/, /mutable\.Set/]},
        cpp: {all: [/fold\(/, /kAccentMap/, /std::set/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header

app = FastAPI()


class SuggestionIndex:
    def matching(self, tenant: str, prefix: str):
        """Terms whose text starts with the prefix, ranked by count."""
        raise NotImplementedError


index = SuggestionIndex()


@app.get("/v1/autocomplete")
def autocomplete(prefix: str = "", x_tenant_id: str = Header(default="")):
    # TODO: this draft matches on the raw prefix with no bounds, returns every match in the
    # index (thousands for a short prefix), and lowercases without Unicode folding, so "Café"
    # and "cafe" both appear as separate suggestions. Review all three.
    return {"prefix": prefix.lower(), "suggestions": index.matching(x_tenant_id, prefix.lower())}
`,
      solution: `import unicodedata

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()

MIN_PREFIX_CHARS = 1
MAX_PREFIX_CHARS = 64
MAX_SUGGESTIONS = 10
CONTROL_CHARS = frozenset(chr(code) for code in range(32)) | {"\\x7f"}


class SuggestionIndex:
    def matching(self, tenant: str, prefix: str):
        """Terms whose text starts with the prefix, ranked by count."""
        raise NotImplementedError


index = SuggestionIndex()


def fold(text: str) -> str:
    """Case- and accent-fold so "Café" and "cafe" collapse to one key."""
    decomposed = unicodedata.normalize("NFKD", text)
    base = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return base.casefold()


def normalize(prefix: str) -> str:
    return " ".join(fold(prefix).split())


@app.get("/v1/autocomplete")
def autocomplete(prefix: str = "", x_tenant_id: str = Header(default="")):
    if not x_tenant_id:
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    if any(ch in CONTROL_CHARS for ch in prefix):
        return JSONResponse({"error": "prefix contains control characters"}, status_code=400)
    normalized = normalize(prefix)
    if len(normalized) < MIN_PREFIX_CHARS or len(normalized) > MAX_PREFIX_CHARS:
        return JSONResponse({"error": "prefix must be 1..64 characters"}, status_code=400)
    ranked = []
    seen = set()
    for term in index.matching(x_tenant_id, normalized):
        key = normalize(term)
        if key in seen:
            continue
        seen.add(key)
        ranked.append(term)
    return {"prefix": normalized, "suggestions": ranked[:MAX_SUGGESTIONS]}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

export const app = Fastify();

interface SuggestionIndex {
  matching(tenant: string, prefix: string): Promise<string[]>;
}

const index: SuggestionIndex = {
  async matching(tenant, prefix) {
    throw new Error('not implemented');
  },
};

app.get('/v1/autocomplete', async (request, reply) => {
  // TODO: this draft matches on the raw prefix with no bounds, returns every match in the
  // index (thousands for a short prefix), and lowercases without Unicode folding, so "Café"
  // and "cafe" both appear as separate suggestions. Review all three.
  const tenant = request.headers['x-tenant-id'] as string;
  const prefix = String((request.query as Record<string, unknown>).prefix ?? '');
  return {prefix: prefix.toLowerCase(), suggestions: await index.matching(tenant, prefix.toLowerCase())};
});
`,
      solution: `import Fastify from 'fastify';

export const app = Fastify();

const MIN_PREFIX_CHARS = 1;
const MAX_PREFIX_CHARS = 64;
const MAX_SUGGESTIONS = 10;
const CONTROL_CHARS = /[\\u0000-\\u001f\\u007f]/;

interface SuggestionIndex {
  matching(tenant: string, prefix: string): Promise<string[]>;
}

const index: SuggestionIndex = {
  async matching(tenant, prefix) {
    throw new Error('not implemented');
  },
};

function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .toLowerCase();
}

function normalize(prefix: string): string {
  return fold(prefix).trim().replace(/\\s+/g, ' ');
}

app.get('/v1/autocomplete', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const raw = String((request.query as Record<string, unknown>).prefix ?? '');
  if (CONTROL_CHARS.test(raw)) return reply.code(400).send({error: 'prefix contains control characters'});
  const normalized = normalize(raw);
  if (normalized.length < MIN_PREFIX_CHARS || normalized.length > MAX_PREFIX_CHARS)
    return reply.code(400).send({error: 'prefix must be 1..64 characters'});
  const seen = new Set<string>();
  const ranked: string[] = [];
  for (const term of await index.matching(tenant, normalized)) {
    const key = normalize(term);
    if (seen.has(key)) continue;
    seen.add(key);
    ranked.push(term);
  }
  return {prefix: normalized, suggestions: ranked.slice(0, MAX_SUGGESTIONS)};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

type SuggestionIndex interface {
	Matching(tenant, prefix string) ([]string, error)
}

func autocomplete(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	prefix := r.URL.Query().Get("prefix")
	// TODO: this draft matches on the raw prefix with no bounds, returns every match in the
	// index (thousands for a short prefix), and lowercases without Unicode folding, so "Café"
	// and "cafe" both appear as separate suggestions. Review all three.
	terms, _ := index.Matching(tenant, strings.ToLower(prefix))
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{"prefix": strings.ToLower(prefix), "suggestions": terms})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/autocomplete", autocomplete)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

const (
	minPrefixChars = 1
	maxPrefixChars = 64
	maxSuggestions = 10
)

var controlChars = func() map[rune]bool {
	m := map[rune]bool{}
	for r := rune(0); r < 32; r++ {
		m[r] = true
	}
	m[127] = true
	return m
}()

type SuggestionIndex interface {
	Matching(tenant, prefix string) ([]string, error)
}

func fold(text string) string {
	var b strings.Builder
	for _, r := range norm.NFD.String(text) {
		if unicode.Is(unicode.Mn, r) {
			continue
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}

func normalize(prefix string) string {
	return strings.Join(strings.Fields(fold(prefix)), " ")
}

func hasControlChars(prefix string) bool {
	for _, r := range prefix {
		if controlChars[r] {
			return true
		}
	}
	return false
}

func autocomplete(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeError(rw, http.StatusUnauthorized, "missing X-Tenant-Id")
		return
	}
	raw := r.URL.Query().Get("prefix")
	if hasControlChars(raw) {
		writeError(rw, http.StatusBadRequest, "prefix contains control characters")
		return
	}
	normalized := normalize(raw)
	if len([]rune(normalized)) < minPrefixChars || len([]rune(normalized)) > maxPrefixChars {
		writeError(rw, http.StatusBadRequest, "prefix must be 1..64 characters")
		return
	}
	terms, err := index.Matching(tenant, normalized)
	if err != nil {
		writeError(rw, http.StatusServiceUnavailable, "index unavailable")
		return
	}
	seen := map[string]bool{}
	ranked := []string{}
	for _, term := range terms {
		key := normalize(term)
		if seen[key] {
			continue
		}
		seen[key] = true
		ranked = append(ranked, term)
	}
	if len(ranked) > maxSuggestions {
		ranked = ranked[:maxSuggestions]
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{"prefix": normalized, "suggestions": ranked})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/autocomplete", autocomplete)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

trait SuggestionIndex {
  def matching(tenant: String, prefix: String): List[String]
}

object Api {
  implicit val system: ActorSystem = ActorSystem("autocomplete")

  val index: SuggestionIndex = new SuggestionIndex {
    def matching(tenant: String, prefix: String): List[String] = throw new NotImplementedError()
  }

  val route: Route =
    path("v1" / "autocomplete") {
      get {
        parameter("prefix".?) { prefixOpt =>
          headerValueByName("X-Tenant-Id") { tenant =>
            // TODO: this draft matches on the raw prefix with no bounds, returns every match in
            // the index (thousands for a short prefix), and lowercases without Unicode folding,
            // so "Café" and "cafe" both appear as separate suggestions. Review all three.
            val prefix = prefixOpt.getOrElse("").toLowerCase
            complete(StatusCodes.OK, s"""{"prefix":"$prefix","suggestions":[]}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.text.Normalizer

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

trait SuggestionIndex {
  def matching(tenant: String, prefix: String): List[String]
}

object Api {
  implicit val system: ActorSystem = ActorSystem("autocomplete")

  val MinPrefixChars = 1
  val MaxPrefixChars = 64
  val MaxSuggestions = 10
  val ControlChars: Set[Char] = (0.toChar to 31.toChar).toSet + 127.toChar

  val index: SuggestionIndex = new SuggestionIndex {
    def matching(tenant: String, prefix: String): List[String] = throw new NotImplementedError()
  }

  def fold(text: String): String =
    Normalizer
      .normalize(text, Normalizer.Form.NFKD)
      .replaceAll("\\\\p{M}", "")
      .toLowerCase

  def normalize(prefix: String): String =
    fold(prefix).trim.replaceAll("\\\\s+", " ")

  val route: Route =
    path("v1" / "autocomplete") {
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          parameter("prefix".?) { prefixOpt =>
            val raw = prefixOpt.getOrElse("")
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else if (raw.exists(ControlChars.contains)) {
              complete(StatusCodes.BadRequest, """{"error":"prefix contains control characters"}""")
            } else {
              val normalized = normalize(raw)
              if (normalized.length < MinPrefixChars || normalized.length > MaxPrefixChars) {
                complete(StatusCodes.BadRequest, """{"error":"prefix must be 1..64 characters"}""")
              } else {
                val seen = scala.collection.mutable.Set.empty[String]
                val ranked = scala.collection.mutable.ListBuffer.empty[String]
                for (term <- index.matching(tenantOpt.get, normalized)) {
                  val key = normalize(term)
                  if (!seen.contains(key)) {
                    seen += key
                    ranked += term
                  }
                }
                val capped = ranked.take(MaxSuggestions)
                val body = capped.map(t => "\\"" + t.replace("\\\\", "\\\\\\\\").replace("\\"", "\\\\\\"") + "\\"").mkString(",")
                complete(StatusCodes.OK, s"""{"prefix":"$normalized","suggestions":[$body]}""")
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
#include <vector>

using json = nlohmann::json;

std::vector<std::string> matching(const std::string& tenant, const std::string& prefix);

int main() {
  httplib::Server svr;

  svr.Get("/v1/autocomplete", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto prefix = req.get_param_value("prefix");
    // TODO: this draft matches on the raw prefix with no bounds, returns every match in the
    // index (thousands for a short prefix), and lowercases without Unicode folding, so "Café"
    // and "cafe" both appear as separate suggestions. Review all three.
    const auto terms = matching(tenant, prefix);
    res.status = 200;
    res.set_content(json{{"prefix", prefix}, {"suggestions", terms}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>
#include <unordered_map>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMinPrefixChars = 1;
constexpr std::size_t kMaxPrefixChars = 64;
constexpr std::size_t kMaxSuggestions = 10;

const std::set<char> kControlChars = [] {
  std::set<char> s;
  for (int code = 0; code < 32; ++code) s.insert(static_cast<char>(code));
  s.insert(127);
  return s;
}();

const std::unordered_map<std::string, std::string> kAccentMap = {
    {"á", "a"}, {"à", "a"}, {"â", "a"}, {"ä", "a"}, {"ã", "a"}, {"é", "e"}, {"è", "e"},
    {"ê", "e"}, {"ë", "e"}, {"í", "i"}, {"ì", "i"}, {"î", "i"}, {"ï", "i"}, {"ó", "o"},
    {"ò", "o"}, {"ô", "o"}, {"ö", "o"}, {"õ", "o"}, {"ú", "u"}, {"ù", "u"}, {"û", "u"},
    {"ü", "u"}, {"ñ", "n"}, {"ç", "c"}, {"Á", "a"}, {"É", "e"}, {"Í", "i"}, {"Ó", "o"},
    {"Ú", "u"}, {"Ñ", "n"}, {"Ç", "c"},
};

std::vector<std::string> matching(const std::string& tenant, const std::string& prefix);

std::string fold(const std::string& text) {
  std::string out;
  for (std::size_t i = 0; i < text.size();) {
    bool matched = false;
    for (std::size_t len = 2; len <= 2; ++len) {
      if (i + len <= text.size()) {
        const auto slice = text.substr(i, len);
        const auto it = kAccentMap.find(slice);
        if (it != kAccentMap.end()) {
          out += it->second;
          i += len;
          matched = true;
          break;
        }
      }
    }
    if (matched) continue;
    const unsigned char ch = static_cast<unsigned char>(text[i]);
    out += static_cast<char>(std::tolower(ch));
    i += 1;
  }
  return out;
}

std::string normalize(const std::string& prefix) {
  const auto folded = fold(prefix);
  std::string out;
  bool pending = false;
  for (const char ch : folded) {
    if (std::isspace(static_cast<unsigned char>(ch))) {
      pending = !out.empty();
      continue;
    }
    if (pending) {
      out += ' ';
      pending = false;
    }
    out += ch;
  }
  return out;
}

bool hasControlChars(const std::string& prefix) {
  for (const char ch : prefix) {
    if (kControlChars.count(ch) != 0) return true;
  }
  return false;
}

int main() {
  httplib::Server svr;

  svr.Get("/v1/autocomplete", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto raw = req.get_param_value("prefix");
    if (hasControlChars(raw)) {
      res.status = 400;
      res.set_content(R"({"error":"prefix contains control characters"})", "application/json");
      return;
    }
    const auto normalized = normalize(raw);
    if (normalized.size() < kMinPrefixChars || normalized.size() > kMaxPrefixChars) {
      res.status = 400;
      res.set_content(R"({"error":"prefix must be 1..64 characters"})", "application/json");
      return;
    }
    const auto terms = matching(tenant, normalized);
    std::set<std::string> seen;
    std::vector<std::string> ranked;
    for (const auto& term : terms) {
      const auto key = normalize(term);
      if (seen.count(key) != 0) continue;
      seen.insert(key);
      ranked.push_back(term);
    }
    ranked.resize(std::min(ranked.size(), kMaxSuggestions));
    res.status = 200;
    res.set_content(json{{"prefix", normalized}, {"suggestions", ranked}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Normalize before you bound. The prefix arrives as user text, so fold case and accents first and then check the 1..64 limit on the folded string — an oversized raw prefix that folds to 64 characters is still fine, a folded prefix over 64 is not.',
    'Reject control characters explicitly, before the index: a newline or a NUL in a prefix corrupts cache keys and log lines. The cost order is normalize, reject control characters, bound the length, then look up.',
    'The index returns everything that matches; the endpoint owns the ten-suggestion contract. Fold each term, keep the first spelling you see per normalized key, and slice the ranked list to ten after dedupe — never truncate the raw list first.',
  ],
  debrief: `The interviewer is testing whether you can review a generated typeahead handler at the trust boundary. The draft reads fine because the demo sends a short ASCII prefix from one tenant. Three defects are being checked. Unbounded matching turns the endpoint into a bulk export: an empty prefix returns the whole index, and a 64-character cap makes a scrape expensive instead of free. Control characters are the second: they never belong in a cache key or a log line, so they are rejected before the lookup. The subtle one is Unicode folding: \`lower()\` is not normalization, so \`Café\` and \`cafe\` survive as two suggestions and the "duplicate" bug only appears once the catalog is not English. Real endpoints keep the ranking server-side, return a stable list per normalized prefix so the client can cache it, and hash the prefix in analytics rather than sending it raw.`,
};
