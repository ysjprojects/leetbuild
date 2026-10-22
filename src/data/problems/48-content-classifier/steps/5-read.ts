import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/taxonomies/{id}: versioned reads with an audit trail',
  concept: 'http',
  file: 'read',
  focus: ['client', 'classifier', 'taxonomy'],
  task: `## Task

The starter is a plausible model-generated draft: it returns the taxonomy and the demo shows labels,
so it passes. It hides three production flaws. Find them, fix them, and prove the fix.

Implement \`GET /v1/taxonomies/{taxonomy_id}\` — the read side of the taxonomy, and the contract the
classifier depends on to explain a past result.

- The tenant comes from \`X-Tenant-Id\` (missing is **401**) and the read is **scoped to that
  tenant**: another tenant's taxonomy does not exist here and answers **404**, not 403 and not a
  filtered view.
- The response carries the **immutable version** of the taxonomy, its labels, and — when \`since\` is
  given — the **changelog** between that version and the requested one, so a reader can see what
  changed without diffing two snapshots by hand.
- Versions are **immutable**: publishing an edit writes a *new* version row and never rewrites the
  labels of an existing version. The draft's in-place update is what makes an old classification
  unexplainable — the labels it was produced from no longer exist anywhere.
- Every classification records the **exact taxonomy version** it used, so a result can always be
  reproduced against the rules that were live when it was produced.

**Failure mode the checks target.** Returning the mutable latest without a version makes "which
rules produced this label?" unanswerable once an edit lands; an in-place edit silently rewrites
history; and resolving the taxonomy by id alone exposes one tenant's edits to another tenant.`,
  sequence: {
    participants: ['Client', 'Content Classifier', 'taxonomy store'],
    messages: [
      {from: 'Client', to: 'Content Classifier', label: 'GET /v1/taxonomies/{id} · X-Tenant-Id · since', kind: 'sync'},
      {
        from: 'Content Classifier',
        to: 'Content Classifier',
        label: 'tenant required · read scoped to tenant',
        kind: 'sync',
      },
      {from: 'Content Classifier', to: 'taxonomy store', label: 'load(tenant, taxonomy_id)', kind: 'sync'},
      {from: 'taxonomy store', to: 'Content Classifier', label: 'version + labels + history / 404', kind: 'reply'},
      {
        from: 'Content Classifier',
        to: 'Client',
        label: '200 {version, labels, changelog} · immutable, never the mutable latest',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/taxonomies/{taxonomy_id}',
      detail: 'Register the versioned taxonomy read on `GET /v1/taxonomies/{taxonomy_id}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/taxonomies\/\{taxonomy_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/taxonomies\/:taxonomyId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/taxonomies\//]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"taxonomies"\s*\/\s*Segment\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(/, /v1\/taxonomies/]},
      },
    },
    {
      id: 'immutable-versions',
      title: 'Edits publish a new version, nothing is rewritten',
      detail:
        'An edit calls `put_version`/`putVersion`/`PutVersion` and never rewrites an existing version’s labels. The draft calls `update_labels`, which mutates the version old classifications were produced from.',
      match: {
        python: {all: [/put_version\(/], none: [/update_labels\(/]},
        typescript: {all: [/putVersion\(/], none: [/updateLabels\(/]},
        go: {all: [/PutVersion\(/], none: [/UpdateLabels\(/]},
        scala: {all: [/putVersion\(/], none: [/updateLabels\(/]},
        cpp: {all: [/putVersion\(/], none: [/updateLabels\(/]},
      },
    },
    {
      id: 'tenant-scoped-404',
      title: 'Reads are tenant-scoped, another tenant is 404',
      detail:
        'The taxonomy is loaded with the authenticated tenant, so a taxonomy the tenant does not own answers **404**. The draft resolves it by id alone and returns another tenant’s taxonomy.',
      match: {
        python: {all: [/status_code\s*=\s*404/, /load\(tenant/]},
        typescript: {all: [/code\(\s*404\s*\)/, /load\(tenant/]},
        go: {all: [/StatusNotFound/, /Load\(r\.Context\(\), tenant/]},
        scala: {all: [/StatusCodes\.NotFound/, /load\(tenant/]},
        cpp: {all: [/\b404\b/, /load\(tenant/]},
      },
    },
    {
      id: 'changelog',
      title: 'Publishing versions and serving the changelog',
      detail:
        'The read returns the changelog between versions when `since` is supplied, and publishing a version is the only way labels change. The draft has no version write path and no changelog.',
      match: {
        python: {all: [/def publish_version\(/, /\.changelog\(/, /since/]},
        typescript: {all: [/function publishVersion\(/, /\.changelog\(/, /since/]},
        go: {all: [/func PublishVersion\(/, /Changelog\(/, /since/]},
        scala: {all: [/def publishVersion\(/, /\.changelog\(/, /since/]},
        cpp: {all: [/publishVersion\(/, /changelogBetween\(/, /since/]},
      },
    },
    {
      id: 'version-named',
      title: 'A classification names the exact version it used',
      detail:
        'Classifying records the taxonomy version that produced the labels, so a past result stays explainable after the taxonomy moves on. The draft records nothing.',
      match: {
        python: {all: [/record_classification\(/, /taxonomy_version/]},
        typescript: {all: [/recordClassification\(/, /taxonomyVersion/]},
        go: {all: [/RecordClassification\(/, /taxonomyVersion/]},
        scala: {all: [/recordClassification\(/, /taxonomyVersion/]},
        cpp: {all: [/recordClassification\(/, /taxonomyVersion/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()


@app.get("/v1/taxonomies/{taxonomy_id}")
def read_taxonomy(
    taxonomy_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    # TODO: this draft answers with the mutable latest and no version, resolves the taxonomy by id
    # alone so another tenant's edits are visible, and rewrites labels in place so an old
    # classification can no longer be explained. Review all three.
    taxonomy = taxonomy_store.load(taxonomy_id)
    return JSONResponse(
        {"taxonomy_id": taxonomy_id, "labels": taxonomy.latest.labels},
        status_code=200,
    )


def edit_taxonomy(taxonomy_id: str, labels: list[str]) -> None:
    taxonomy_store.update_labels(taxonomy_id, labels)
`,
      solution: `from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()


@app.get("/v1/taxonomies/{taxonomy_id}")
def read_taxonomy(
    taxonomy_id: str,
    version: str | None = None,
    since: str | None = None,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    # A read is scoped to the tenant: another tenant's taxonomy does not exist here.
    taxonomy = taxonomy_store.load(tenant, taxonomy_id)
    if taxonomy is None:
        raise HTTPException(status_code=404, detail="unknown taxonomy for this tenant")
    resolved = taxonomy.version(version) if version is not None else taxonomy.latest
    return JSONResponse(
        {
            "taxonomy_id": taxonomy_id,
            "version": resolved.version,
            "labels": resolved.labels,
            "changelog": taxonomy.changelog(since=since) if since is not None else [],
        },
        status_code=200,
    )


def publish_version(tenant: str, taxonomy_id: str, labels: list[str]) -> str:
    """An edit publishes a new immutable version; an existing version is never rewritten."""
    return taxonomy_store.put_version(tenant, taxonomy_id, labels)


def record_classification(tenant: str, taxonomy_id: str, taxonomy_version: str, labels: list[str]) -> dict:
    """Every classification names the exact version it used, so old results stay explainable."""
    return taxonomy_store.record(
        tenant=tenant,
        taxonomy_id=taxonomy_id,
        taxonomy_version=taxonomy_version,
        labels=labels,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/taxonomies/{id}: a model-generated draft that serves the mutable latest. */
import Fastify from 'fastify';

export const app = Fastify();

app.get('/v1/taxonomies/:taxonomyId', async (request, reply) => {
  // TODO: this draft answers with the mutable latest and no version, resolves the taxonomy by id
  // alone so another tenant's edits are visible, and rewrites labels in place so an old
  // classification can no longer be explained. Review all three.
  const {taxonomyId} = request.params as {taxonomyId: string};
  const taxonomy = await taxonomyStore.load(taxonomyId);
  return reply.code(200).send({taxonomy_id: taxonomyId, labels: taxonomy.latest.labels});
});

export function editTaxonomy(taxonomyId: string, labels: string[]): void {
  taxonomyStore.updateLabels(taxonomyId, labels);
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/taxonomies/{id}: an immutable version and its changelog, scoped to the tenant. */
import Fastify from 'fastify';

import {taxonomyStore} from './taxonomy_store';

export const app = Fastify();

app.get('/v1/taxonomies/:taxonomyId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {taxonomyId} = request.params as {taxonomyId: string};
  const query = request.query as {version?: string; since?: string};
  // A read is scoped to the tenant: another tenant's taxonomy does not exist here.
  const taxonomy = await taxonomyStore.load(tenant, taxonomyId);
  if (taxonomy === null) return reply.code(404).send({error: 'unknown taxonomy for this tenant'});
  const resolved = query.version === undefined ? taxonomy.latest : taxonomy.version(query.version);
  return reply.code(200).send({
    taxonomy_id: taxonomyId,
    version: resolved.version,
    labels: resolved.labels,
    changelog: query.since === undefined ? [] : taxonomy.changelog(query.since),
  });
});

/** An edit publishes a new immutable version; an existing version is never rewritten. */
export async function publishVersion(tenant: string, taxonomyId: string, labels: string[]): Promise<string> {
  return taxonomyStore.putVersion(tenant, taxonomyId, labels);
}

/** Every classification names the exact version it used, so old results stay explainable. */
export async function recordClassification(
  tenant: string,
  taxonomyId: string,
  taxonomyVersion: string,
  labels: string[],
): Promise<void> {
  await taxonomyStore.record({tenant, taxonomyId, taxonomyVersion, labels});
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package taxonomyapi

import (
	"encoding/json"
	"log"
	"net/http"
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readTaxonomy(rw http.ResponseWriter, r *http.Request) {
	taxonomyID := r.PathValue("taxonomy_id")
	// TODO: this draft answers with the mutable latest and no version, resolves the taxonomy by id
	// alone so another tenant's edits are visible, and rewrites labels in place so an old
	// classification can no longer be explained. Review all three.
	taxonomy, _ := taxonomyStore.Load(taxonomyID)
	writeJSON(rw, http.StatusOK, map[string]any{"taxonomy_id": taxonomyID, "labels": taxonomy.Latest().Labels})
}

func editTaxonomy(taxonomyID string, labels []string) {
	taxonomyStore.UpdateLabels(taxonomyID, labels)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/taxonomies/{taxonomy_id}", readTaxonomy)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package taxonomyapi

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readTaxonomy(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	taxonomyID := r.PathValue("taxonomy_id")
	// A read is scoped to the tenant: another tenant's taxonomy does not exist here.
	taxonomy, err := taxonomyStore.Load(r.Context(), tenant, taxonomyID)
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown taxonomy for this tenant"})
		return
	}
	resolved := taxonomy.Latest
	if version := r.URL.Query().Get("version"); version != "" {
		resolved = taxonomy.Version(version)
	}
	since := r.URL.Query().Get("since")
	changelog := []ChangelogEntry{}
	if since != "" {
		changelog = taxonomy.Changelog(since)
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"taxonomy_id": taxonomyID,
		"version":     resolved.Version,
		"labels":      resolved.Labels,
		"changelog":   changelog,
	})
}

// PublishVersion writes a new immutable version; an existing version is never rewritten.
func PublishVersion(ctx context.Context, tenant, taxonomyID string, labels []string) (string, error) {
	return taxonomyStore.PutVersion(ctx, tenant, taxonomyID, labels)
}

// RecordClassification pins the exact version that produced a result.
func RecordClassification(ctx context.Context, tenant, taxonomyID, taxonomyVersion string, labels []string) error {
	return taxonomyStore.Record(ctx, tenant, taxonomyID, taxonomyVersion, labels)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/taxonomies/{taxonomy_id}", readTaxonomy)
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

object TaxonomyApi {
  implicit val system: ActorSystem = ActorSystem("content-classifier")

  val route: Route =
    path("v1" / "taxonomies" / Segment) { taxonomyId =>
      get {
        // TODO: this draft answers with the mutable latest and no version, resolves the taxonomy by
        // id alone so another tenant's edits are visible, and rewrites labels in place so an old
        // classification can no longer be explained. Review all three.
        val taxonomy = TaxonomyStore.load(taxonomyId)
        val labels = taxonomy.latest.labels.mkString("[", ",", "]")
        complete(StatusCodes.OK, s"""{"taxonomy_id":"$taxonomyId","labels":$labels}""")
      }
    }

  def editTaxonomy(taxonomyId: String, labels: Seq[String]): Unit =
    TaxonomyStore.updateLabels(taxonomyId, labels)

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

final case class TaxonomyVersion(version: String, labels: Seq[String])
final case class TaxonomyResponse(taxonomy_id: String, version: String, labels: Seq[String], changelog: Seq[String])

object TaxonomyApi {
  implicit val system: ActorSystem = ActorSystem("content-classifier")
  implicit val versionFormat: RootJsonFormat[TaxonomyVersion] = jsonFormat2(TaxonomyVersion)
  implicit val responseFormat: RootJsonFormat[TaxonomyResponse] = jsonFormat4(TaxonomyResponse)

  val route: Route =
    path("v1" / "taxonomies" / Segment) { taxonomyId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          parameter("version".?, "since".?) { (versionOpt, sinceOpt) =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else {
              val tenant = tenantOpt.get
              // A read is scoped to the tenant: another tenant's taxonomy does not exist here.
              TaxonomyStore.load(tenant, taxonomyId) match {
                case None =>
                  complete(StatusCodes.NotFound, """{"error":"unknown taxonomy for this tenant"}""")
                case Some(taxonomy) =>
                  val resolved = versionOpt.map(v => taxonomy.version(v)).getOrElse(taxonomy.latest)
                  val changelog = sinceOpt.map(since => taxonomy.changelog(since)).getOrElse(Seq.empty)
                  complete(StatusCodes.OK, TaxonomyResponse(taxonomyId, resolved.version, resolved.labels, changelog))
              }
            }
          }
        }
      }
    }

  /** An edit publishes a new immutable version; an existing version is never rewritten. */
  def publishVersion(tenant: String, taxonomyId: String, labels: Seq[String]): String =
    TaxonomyStore.putVersion(tenant, taxonomyId, labels)

  /** Every classification names the exact version it used, so old results stay explainable. */
  def recordClassification(
      tenant: String,
      taxonomyId: String,
      taxonomyVersion: String,
      labels: Seq[String]
  ): Unit =
    TaxonomyStore.record(tenant = tenant, taxonomyId = taxonomyId, taxonomyVersion = taxonomyVersion, labels = labels)

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

struct TaxonomyStore {
  Taxonomy load(const std::string& taxonomyId);
  void updateLabels(const std::string& taxonomyId, const std::vector<std::string>& labels);
};

TaxonomyStore taxonomyStore;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/taxonomies/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto taxonomyId = req.matches[1];
    // TODO: this draft answers with the mutable latest and no version, resolves the taxonomy by id
    // alone so another tenant's edits are visible, and rewrites labels in place so an old
    // classification can no longer be explained. Review all three.
    const auto taxonomy = taxonomyStore.load(taxonomyId);
    res.status = 200;
    res.set_content(json{{"taxonomy_id", taxonomyId}, {"labels", taxonomy.latest().labels}}.dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

using json = nlohmann::json;

struct TaxonomyStore {
  std::optional<Taxonomy> load(const std::string& tenant, const std::string& taxonomyId);
  std::string putVersion(const std::string& tenant, const std::string& taxonomyId,
                         const std::vector<std::string>& labels);
  void record(const std::string& tenant, const std::string& taxonomyId, const std::string& taxonomyVersion,
              const std::vector<std::string>& labels);
};

TaxonomyStore taxonomyStore;

json changelogBetween(const Taxonomy& taxonomy, const std::string& since);

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/taxonomies/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto taxonomyId = req.matches[1];
    // A read is scoped to the tenant: another tenant's taxonomy does not exist here.
    const auto taxonomy = taxonomyStore.load(tenant, taxonomyId);
    if (!taxonomy) {
      res.status = 404;
      res.set_content(R"({"error":"unknown taxonomy for this tenant"})", "application/json");
      return;
    }
    const auto version = req.get_param_value("version");
    const auto since = req.get_param_value("since");
    const auto resolved = version.empty() ? taxonomy->latest() : taxonomy->version(version);
    res.status = 200;
    res.set_content(
        json{{"taxonomy_id", taxonomyId},
             {"version", resolved.version},
             {"labels", resolved.labels},
             {"changelog", since.empty() ? json::array() : changelogBetween(*taxonomy, since)}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}

// An edit publishes a new immutable version; an existing version is never rewritten.
std::string publishVersion(const std::string& tenant, const std::string& taxonomyId,
                           const std::vector<std::string>& labels) {
  return taxonomyStore.putVersion(tenant, taxonomyId, labels);
}

// Every classification names the exact version it used, so old results stay explainable.
void recordClassification(const std::string& tenant, const std::string& taxonomyId,
                          const std::string& taxonomyVersion, const std::vector<std::string>& labels) {
  taxonomyStore.record(tenant, taxonomyId, taxonomyVersion, labels);
}
`,
    },
  },
  hints: [
    'The response is a version, not a document: `{"taxonomy_id", "version", "labels", "changelog"}`. Every consumer of this read — a reviewer, a dashboard, a re-classification job — needs the version in order to say which rules were live.',
    'Immutability is a write rule: an edit calls `putVersion`/`put_version` and creates a new row. An in-place `updateLabels` rewrites the labels that old classifications were produced from, which is how a result becomes unexplainable without anyone deleting anything.',
    'Tenant scoping is the same rule as the classify path: `load(tenant, taxonomy_id)` and 404 for anything else. Returning 403 leaks the existence of another tenant’s taxonomy, and returning a filtered view hides an authorization bug instead of failing the request.',
  ],
  debrief: `The interviewer is testing whether you can review the read side of a generated service, where correctness is about history rather than the current request. Three defects are being checked: version identity (a read without a version cannot support an explanation of the past), immutability (an edit is a new version, never a mutation of an old one, so old results stay reproducible), and tenant scoping (the same boundary as the write path, enforced on every read). The classification record naming its version is the fourth idea: provenance is only useful if the version it names still exists and can be read back. Real taxonomy services add signed version manifests, a deprecation window before a version is retired, and an index from classification id to version so a reviewer can pull up the exact label set behind any historical result.`,
};
