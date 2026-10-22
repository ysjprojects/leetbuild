import type {Step} from '@/lib/types';

export const glossaryReadStep: Step = {
  id: 'read',
  title: 'GET /v1/glossaries/{locale}: terms that apply to exactly one tenant',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'glossary'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated read endpoint: it resolves a locale,
returns that glossary and caches the response. It compiles, the dashboard shows terms, and it hides
three production flaws. Review it, fix it, and prove the fix with the checks below.

Implement \`GET /v1/glossaries/{locale}\` for the authenticated tenant.

- The glossary is read **by tenant**: the lookup is \`(tenant, locale)\` at the tenant's active
  version. A lookup that resolves to another tenant's glossary is **403** — a glossary is customer
  terminology, not a shared dictionary.
- A missing \`X-Tenant-Id\` is **401**; a locale with no glossary for that tenant is **404**.
- Every response carries the glossary's **version** and its **term count**, so a caller can pin the
  exact glossary a translation used and a client can tell an empty glossary from a missing one.
- The response is cacheable for **at most one second** (\`Cache-Control: max-age=1\`), so a glossary
  update is visible on the very next read.

**Failure mode the checks target.** The draft serves a global map keyed by locale alone, so tenant B
reads tenant A's terminology; it returns terms with no version, so a caller cannot pin what it saw
and a translator cannot reproduce a translation; and it lets caches hold the response for an hour, so
a corrected term takes an hour to appear. The version is the field candidates forget: without it the
read is a snapshot nobody can name.`,
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
        'The response is checked against the authenticated tenant and a glossary owned by someone else is **403**. The draft serves one global map by locale, so every tenant reads every glossary.',
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
        'Every 200 carries `version` and `term_count` so a caller can pin the glossary it saw. The draft returns bare terms with no version to pin.',
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
        'The response is cacheable for at most **one second** (`Cache-Control: max-age=1`). The draft hands out an hour of staleness, so a corrected term stays wrong long after the glossary changed.',
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
        'The store lookup is keyed by `(tenant, locale)`, so two tenants with the same locale get their own terms. The draft reads a module-level map keyed by locale alone.',
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
    # TODO: this draft serves any tenant's glossary by locale, returns terms without the pinned
    # glossary version, and lets caches hold the response past the next glossary update. Review all
    # three.
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
      starter: `/** The model-generated glossary read: a global locale map, no version, hour-long caching. */
import Fastify from 'fastify';

export const app = Fastify();

const GLOSSARIES: Record<string, Term[]> = {
  en: [{source: 'Invoice', target: 'Facture'}],
  fr: [{source: 'Facture', target: 'Invoice'}],
};

app.get('/v1/glossaries/:locale', async (request, reply) => {
  // TODO: this draft serves any tenant's glossary by locale, returns terms without the pinned
  // glossary version, and lets caches hold the response past the next glossary update. Review all
  // three.
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
	// TODO: this draft serves any tenant's glossary by locale, returns terms without the pinned
	// glossary version, and lets caches hold the response past the next glossary update. Review all
	// three.
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
        // TODO: this draft serves any tenant's glossary by locale, returns terms without the pinned
        // glossary version, and lets caches hold the response past the next glossary update.
        // Review all three.
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
    // TODO: this draft serves any tenant's glossary by locale, returns terms without the pinned
    // glossary version, and lets caches hold the response past the next glossary update. Review all
    // three.
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
    "The tenant is the first dimension of the lookup, not a filter applied afterwards: `glossaryStore.get(tenant, locale)` at the tenant's active version. A shared `GLOSSARIES[locale]` map is a data leak with a friendly API.",
    'Return the version with the terms. A caller that cannot name the glossary it read cannot pin it, reproduce a translation, or tell you which terms were live when a bug was reported — and an `ETag` on that version makes the cache correct instead of merely short.',
    "Freshness is a product decision: `max-age=1` means a corrected term appears on the next read. The draft's hour is chosen for hit rate, and it makes the glossary look broken for the rest of the hour after every update.",
  ],
  debrief: `The interviewer is testing whether the read path is designed with the same care as the write path. Three defects are checked: the lookup key (a shared locale map serves one customer's terminology to another), the response shape (terms without a version cannot be pinned or reproduced), and the cache lifetime (an hour of staleness after every glossary update). The owner check is the subtle one: even a tenant-scoped key needs a guard, because the store is shared infrastructure and the endpoint is the place where a foreign entry must become a 403 rather than a silent answer. Real services add per-locale ETag revalidation, an audit row per read for terminology that is legally binding, and a diff endpoint so a translator can see what changed between versions.`,
};
