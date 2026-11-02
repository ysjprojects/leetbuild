import type {Step} from '@/lib/types';

export const glossaryReadStep: Step = {
  id: 'read',
  title: 'GET /v1/glossaries/{locale}: terms that apply to exactly one tenant',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'glossary'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/glossaries/{locale}\`: it looks the locale up in a
module-level \`GLOSSARIES\` map, returns \`{"terms": [...]}\` and sets \`Cache-Control: max-age=3600\`.
It compiles, the dashboard shows terms, and it hides four flaws.

**Failure mode the checks target.** Tenant B opens the glossary page and sees tenant A's product
names, because the map has no tenant dimension and nothing checks who owns the entry; a translator
investigating a bad translation cannot say which glossary was live, because the response names no
version; and after a term is corrected the old one keeps showing for an hour, because the response
told every cache it could.

Requirements:

- The glossary is read **by tenant**: the lookup is \`(tenant, locale)\` at the tenant's active
  version. A lookup that resolves to another tenant's glossary is **403**; a glossary is customer
  terminology, not a shared dictionary.
- A missing \`X-Tenant-Id\` is **401**; a locale with no glossary for that tenant is **404**.
- Every response carries the glossary's **version** and its **term count**, so a caller can pin the
  exact glossary a translation used and tell an empty glossary from a missing one.
- The response is cacheable for **at most one second** (\`Cache-Control: max-age=1\`), so a glossary
  update is visible on the next read.`,
  sequence: {
    participants: ['Client', 'Translation API', 'Glossary store'],
    messages: [
      {from: 'Client', to: 'Translation API', label: 'GET /v1/glossaries/fr · X-Tenant-Id', kind: 'sync'},
      {from: 'Translation API', to: 'Translation API', label: 'require tenant', kind: 'sync'},
      {from: 'Translation API', to: 'Glossary store', label: 'get(tenant, fr) @ active version', kind: 'sync'},
      {from: 'Glossary store', to: 'Translation API', label: 'terms + owner + version', kind: 'reply'},
      {from: 'Translation API', to: 'Translation API', label: 'assert owner == tenant', kind: 'sync'},
      {from: 'Client', to: 'Translation API', label: '403 when another tenant owns it', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/glossaries/{locale}',
      detail: 'Register the glossary read on `GET /v1/glossaries/{locale}` with the locale as a path parameter.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/glossaries\/\{locale\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/glossaries\/:locale['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/glossaries\/\{locale\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"glossaries"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(/, /glossaries/]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Refuses another tenant's glossary with 403",
      detail:
        'The response is checked against the authenticated tenant and a glossary owned by someone else is **403**. The starter serves one global map by locale, so every tenant reads every glossary.',
      match: {
        python: {all: [/assert_glossary_owner/, /status_code\s*=\s*403/]},
        typescript: {all: [/assertGlossaryOwner/, /statusCode\s*=\s*403/]},
        go: {all: [/assertGlossaryOwner/, /StatusForbidden/]},
        scala: {all: [/assertGlossaryOwner/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/assertGlossaryOwner/, /\b403\b/]},
      },
    },
    {
      id: 'version',
      title: 'Carries the glossary version and term count in every response',
      detail:
        'Every 200 carries `version` and `term_count` so a caller can pin the glossary it saw. The starter returns bare terms with no version to pin.',
      match: {
        python: {all: [/term_count/, /"version"/]},
        typescript: {all: [/term_count/, /version/]},
        go: {all: [/termCount/, /version/]},
        scala: {all: [/termCount/, /version/]},
        cpp: {all: [/term_count/, /version/]},
      },
    },
    {
      id: 'freshness',
      title: 'Never caches the read past the next update',
      detail:
        'The response is cacheable for at most **one second** (`Cache-Control: max-age=1`). The starter hands out an hour of staleness, so a corrected term stays wrong long after the glossary changed.',
      match: {
        python: {all: [/GLOSSARY_READ_TTL_SECONDS/, /max-age=/]},
        typescript: {all: [/GLOSSARY_READ_TTL_SECONDS/, /max-age=/]},
        go: {all: [/glossaryReadTtlSeconds/, /max-age=/]},
        scala: {all: [/GlossaryReadTtlSeconds/, /max-age=/]},
        cpp: {all: [/kGlossaryReadTtlSeconds/, /max-age=/]},
      },
    },
    {
      id: 'tenant-keyed-read',
      title: 'Reads the glossary by tenant, not from a global locale map',
      detail:
        'The store lookup is keyed by `(tenant, locale)`, so two tenants with the same locale get their own terms. The starter reads a module-level map keyed by locale alone.',
      match: {
        python: {all: [/glossary_store\.get\(tenant/]},
        typescript: {all: [/glossaryStore\.get\(tenant/]},
        go: {all: [/glossaryStore\.Get\(/]},
        scala: {all: [/glossaryStore\.get\(tenant/]},
        cpp: {all: [/glossaryStore\.get\(tenant/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("glossary")

GLOSSARIES = {
    "en": [{"source": "Invoice", "target": "Facture"}],
    "fr": [{"source": "Facture", "target": "Invoice"}],
}


@app.get("/v1/glossaries/{locale}")
def read_glossary(locale: str) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    terms = GLOSSARIES.get(locale, [])
    logger.info("glossary locale=%s terms=%d", locale, len(terms))
    return JSONResponse({"terms": terms}, headers={"Cache-Control": "max-age=3600"})
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("glossary")

GLOSSARY_READ_TTL_SECONDS = 1


class GlossaryStore:
    def get(self, owner: str, locale: str, version: str) -> dict | None:
        """The tenant's glossary at its active version, or None when the locale has none."""
        raise NotImplementedError


glossary_store = GlossaryStore()


def active_glossary_version(tenant: str, locale: str) -> str:
    """The version a translation must pin when it resolves this glossary at start time."""
    raise NotImplementedError


def assert_glossary_owner(tenant: str, owner: str) -> None:
    """A glossary belongs to exactly one tenant; another tenant's terms are not readable."""
    if owner != tenant:
        raise HTTPException(status_code=403, detail="glossary belongs to another tenant")


@app.get("/v1/glossaries/{locale}")
def read_glossary(
    locale: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    version = active_glossary_version(tenant, locale)
    entry = glossary_store.get(tenant, locale, version)
    if entry is None:
        raise HTTPException(status_code=404, detail="no glossary for this locale")
    assert_glossary_owner(tenant, entry["owner"])
    logger.info("glossary tenant=%s locale=%s version=%s", tenant, locale, entry["version"])
    return JSONResponse(
        {
            "tenant": tenant,
            "locale": locale,
            "version": entry["version"],
            "term_count": len(entry["terms"]),
            "terms": entry["terms"],
        },
        headers={
            "Cache-Control": f"max-age={GLOSSARY_READ_TTL_SECONDS}",
            "ETag": entry["version"],
        },
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/glossaries/{locale}. */
import Fastify from 'fastify';

export const app = Fastify();

const GLOSSARIES: Record<string, Term[]> = {
  en: [{source: 'Invoice', target: 'Facture'}],
  fr: [{source: 'Facture', target: 'Invoice'}],
};

app.get('/v1/glossaries/:locale', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const {locale} = request.params as {locale: string};
  const terms = GLOSSARIES[locale] ?? [];
  request.log.info({locale, terms: terms.length}, 'glossary read');
  reply.header('Cache-Control', 'max-age=3600');
  return reply.code(200).send({terms});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/glossaries/{locale}: one tenant's active glossary, with the version to pin. */
import Fastify from 'fastify';

import {glossaryStore} from './glossary';

export const app = Fastify();

const GLOSSARY_READ_TTL_SECONDS = 1;

export function assertGlossaryOwner(tenant: string, owner: string): void {
  if (owner !== tenant) {
    const error = new Error('glossary belongs to another tenant') as Error & {statusCode: number};
    error.statusCode = 403;
    throw error;
  }
}

app.get('/v1/glossaries/:locale', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {locale} = request.params as {locale: string};
  const entry = await glossaryStore.get(tenant, locale);
  if (entry === null) return reply.code(404).send({error: 'no glossary for this locale'});
  assertGlossaryOwner(tenant, entry.owner);
  reply.header('Cache-Control', 'max-age=' + GLOSSARY_READ_TTL_SECONDS);
  reply.header('ETag', entry.version);
  request.log.info({tenant, locale, version: entry.version}, 'glossary read');
  return reply.code(200).send({
    tenant,
    locale,
    version: entry.version,
    term_count: entry.terms.length,
    terms: entry.terms,
  });
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

type GlossaryEntry struct {
	Terms []Term
}

var glossaries = map[string]GlossaryEntry{
	"en": {Terms: []Term{{Source: "Invoice", Target: "Facture"}}},
	"fr": {Terms: []Term{{Source: "Facture", Target: "Invoice"}}},
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readGlossary(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	locale := r.PathValue("locale")
	entry := glossaries[locale]
	rw.Header().Set("Cache-Control", "max-age=3600")
	log.Printf("glossary locale=%s terms=%d", locale, len(entry.Terms))
	writeJSON(rw, http.StatusOK, map[string]any{"terms": entry.Terms})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/glossaries/{locale}", readGlossary)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
)

const glossaryReadTtlSeconds = 1

var errForeignGlossary = errors.New("glossary belongs to another tenant")

type GlossaryEntry struct {
	Owner   string
	Version string
	Terms   []Term
}

type GlossaryStore struct{}

func (s *GlossaryStore) Get(ctx context.Context, tenant, locale string) (*GlossaryEntry, error) {
	return nil, nil
}

var glossaryStore = &GlossaryStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func assertGlossaryOwner(tenant, owner string) error {
	if owner != tenant {
		return errForeignGlossary
	}
	return nil
}

func readGlossary(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	locale := r.PathValue("locale")
	entry, err := glossaryStore.Get(r.Context(), tenant, locale)
	if err != nil || entry == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no glossary for this locale"})
		return
	}
	if err := assertGlossaryOwner(tenant, entry.Owner); err != nil {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "glossary belongs to another tenant"})
		return
	}
	rw.Header().Set("Cache-Control", "max-age="+strconv.Itoa(glossaryReadTtlSeconds))
	rw.Header().Set("ETag", entry.Version)
	log.Printf("glossary tenant=%s locale=%s version=%s", tenant, locale, entry.Version)
	writeJSON(rw, http.StatusOK, map[string]any{
		"tenant":     tenant,
		"locale":     locale,
		"version":    entry.Version,
		"termCount":  len(entry.Terms),
		"terms":      entry.Terms,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/glossaries/{locale}", readGlossary)
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

final case class GlossaryEntry(terms: List[Term])

object GlossaryRead {
  implicit val system: ActorSystem = ActorSystem("translation-service")
  implicit val entryFormat: RootJsonFormat[GlossaryEntry] = jsonFormat1(GlossaryEntry)

  val glossaries = Map(
    "en" -> GlossaryEntry(List(Term("Invoice", "Facture"))),
    "fr" -> GlossaryEntry(List(Term("Facture", "Invoice"))),
  )

  val route: Route =
    path("v1" / "glossaries" / Segment) { locale =>
      get {
        // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
        respondWithHeader(headers.CacheControl(DateTime.now, 3600.seconds)) {
          complete(StatusCodes.OK, glossaries.getOrElse(locale, GlossaryEntry(Nil)))
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class GlossaryEntry(owner: String, version: String, terms: List[Term])

object GlossaryRead {
  implicit val system: ActorSystem = ActorSystem("translation-service")

  val GlossaryReadTtlSeconds = 1

  val glossaryStore = GlossaryStore.open()

  def assertGlossaryOwner(tenant: String, owner: String): Unit =
    if (owner != tenant) throw new GlossariesForbidden(owner)

  val route: Route =
    path("v1" / "glossaries" / Segment) { locale =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            val tenant = tenantOpt.get
            glossaryStore.get(tenant, locale) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"no glossary for this locale"}""")
              case Some(entry) =>
                try {
                  assertGlossaryOwner(tenant, entry.owner)
                  respondWithHeader(headers.RawHeader("Cache-Control", "max-age=" + GlossaryReadTtlSeconds)) {
                    system.log.info(s"glossary tenant=$tenant locale=$locale version=\${entry.version}")
                    complete(
                      StatusCodes.OK,
                      s"""{"tenant":"$tenant","locale":"$locale","version":"\${entry.version}","termCount":\${entry.terms.size}}""")
                  }
                } catch {
                  case _: GlossariesForbidden =>
                    complete(StatusCodes.Forbidden, """{"error":"glossary belongs to another tenant"}""")
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

struct Term {
  std::string source;
  std::string target;
};

const std::vector<Term> kEnglishGlossary = {{"Invoice", "Facture"}};
const std::vector<Term> kFrenchGlossary = {{"Facture", "Invoice"}};

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/glossaries/([a-z-]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const auto locale = req.matches[1];
    const auto& terms = locale == "fr" ? kFrenchGlossary : kEnglishGlossary;
    res.set_header("Cache-Control", "max-age=3600");
    res.status = 200;
    res.set_content(json{{"terms", terms}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

using json = nlohmann::json;

struct Term {
  std::string source;
  std::string target;
};

struct GlossaryEntry {
  std::string owner;
  std::string version;
  std::vector<Term> terms;
};

struct GlossaryStore {
  std::optional<GlossaryEntry> get(const std::string& tenant, const std::string& locale);
};

GlossaryStore glossaryStore;

constexpr int kGlossaryReadTtlSeconds = 1;

void assertGlossaryOwner(const std::string& tenant, const std::string& owner) {
  if (owner != tenant) throw std::runtime_error("glossary belongs to another tenant");
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/glossaries/([a-z-]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto locale = req.matches[1];
    const auto entry = glossaryStore.get(tenant, locale);
    if (!entry) {
      res.status = 404;
      res.set_content(R"({"error":"no glossary for this locale"})", "application/json");
      return;
    }
    try {
      assertGlossaryOwner(tenant, entry->owner);
    } catch (const std::runtime_error&) {
      res.status = 403;
      res.set_content(R"({"error":"glossary belongs to another tenant"})", "application/json");
      return;
    }
    res.set_header("Cache-Control", "max-age=" + std::to_string(kGlossaryReadTtlSeconds));
    res.set_header("ETag", entry->version);
    res.status = 200;
    res.set_content(json{{"tenant", tenant},
                         {"locale", locale},
                         {"version", entry->version},
                         {"term_count", entry->terms.size()},
                         {"terms", entry->terms}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Two tenants with a French glossary see the same terms on their glossary page, the page cannot say which version it is showing, and a corrected term takes an hour to appear.',
    'The handler ignores `X-Tenant-Id`, reads `GLOSSARIES[locale]` from a map with no tenant dimension, returns bare `terms`, and sends `max-age=3600` so every cache keeps the stale response.',
    'Require the tenant (401), read `glossary_store.get(tenant, locale)` (404 when missing), run `assert_glossary_owner` (403), return `version` and `term_count`, and set `max-age=` from `GLOSSARY_READ_TTL_SECONDS = 1`.',
  ],
  debrief: `The tenant is the first dimension of the lookup rather than a filter applied afterwards, because a store keyed by locale alone has already leaked by the time a filter runs. The owner check stays even with a tenant-scoped key: the store is shared infrastructure, and the endpoint is the place where a foreign entry becomes a 403 instead of a silent answer. The version travels in the response because a glossary nobody can name cannot be pinned or reproduced when a translation is questioned. One second of cache is the freshness the product needs after a term correction. Production read paths add an \`ETag\` derived from the version so caches revalidate instead of expiring, an audit row per read where terminology is legally binding, and a diff between versions for translators.`,
};
