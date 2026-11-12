import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/taxonomies/{id}: versioned reads with an audit trail',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'classifier', 'taxonomy'],
  task: `## Task

**Starting point.** \`GET /v1/taxonomies/{taxonomy_id}\` loads the taxonomy with \`taxonomies.by_id\`
and answers \`{taxonomy_id, labels}\` of its latest version; \`publish_version(tenant, taxonomy_id,
labels)\` applies an edit with \`taxonomies.update_labels\`; \`record_classification(tenant,
taxonomy_id, taxonomy_version, labels)\` appends \`{tenant, taxonomy_id, taxonomy_version, labels}\` to
\`classifications:{tenant}\` with the version \`by_id\` reports. The demo shows labels. It hides 4 flaws.

**Failure mode the checks target.** One tenant reads another's taxonomy; an edit rewrites the labels
an old classification was made against, so nobody can say which rules produced it; a read names no
version and no changes; and a record names whatever version was current when it was written.

- A missing \`X-Tenant-Id\` is **401**; \`taxonomies.load(tenant, taxonomy_id, version)\` resolves
  \`?version=\` (the latest when absent), and another tenant's taxonomy is **404**.
- The body is \`{taxonomy_id, version, labels, changelog}\`; with \`?since=n\` the changelog is
  \`taxonomies.changelog(tenant, taxonomy_id, n, version)\`, otherwise \`[]\`.
- \`publish_version\` writes a new version with \`taxonomies.put_version\` and returns its number.
- \`record_classification\` records the \`taxonomy_version\` it was given.`,
  sequence: {
    participants: ['Client', 'Content Classifier', 'taxonomy store'],
    messages: [
      {from: 'Client', to: 'Content Classifier', label: 'GET /v1/taxonomies/{id}?since=1 · X-Tenant-Id', kind: 'sync'},
      {from: 'Content Classifier', to: 'taxonomy store', label: 'load(tenant, id, version)', kind: 'sync'},
      {from: 'taxonomy store', to: 'Content Classifier', label: 'version 3 + labels / none → 404', kind: 'reply'},
      {from: 'Content Classifier', to: 'taxonomy store', label: 'changelog(tenant, id, 1, 3)', kind: 'sync'},
      {from: 'Content Classifier', to: 'Client', label: '200 {version: 3, labels, changelog}', kind: 'reply'},
      {from: 'Content Classifier', to: 'taxonomy store', label: 'put_version(tenant, id, labels) → 4', kind: 'sync'},
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
        go: {all: [/HandleFunc\(\s*"GET \/v1\/taxonomies\/\{id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"taxonomies"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/taxonomies\//]},
      },
    },
    {
      id: 'tenant-scoped-404',
      title: 'Reads are tenant-scoped, another tenant is 404',
      detail:
        'A missing `X-Tenant-Id` is **401**, and the read goes through `taxonomies.load(tenant, …)`, so another tenant’s taxonomy is **404**, not 403 and not its labels. The starter reads with `by_id`.',
      match: {
        python: {all: [/taxonomies\.load\(\s*tenant/, /\b401\b/], none: [/taxonomies\.by_id\(/]},
        typescript: {all: [/taxonomies\.load\(\s*tenant/, /\b401\b/], none: [/taxonomies\.byId\(/]},
        go: {
          all: [/taxonomies\.Load\(r\.Context\(\),\s*tenant/, /StatusUnauthorized|\b401\b/],
          none: [/taxonomies\.ByID\(/],
        },
        scala: {all: [/Taxonomies\.load\(\s*tenant/, /Unauthorized|\b401\b/], none: [/Taxonomies\.byId\(/]},
        cpp: {all: [/taxonomies::load\(\s*tenant/, /\b401\b/], none: [/taxonomies::byId\(/]},
      },
    },
    {
      id: 'immutable-versions',
      title: 'Edits publish a new version, nothing is rewritten',
      detail:
        '`publish_version`/`publishVersion` writes the next version with `put_version`/`putVersion` and returns it; version 1 keeps its labels. The starter rewrites the latest version in place with `update_labels`.',
      match: {
        python: {all: [/taxonomies\.put_version\(/], none: [/update_labels\(/]},
        typescript: {all: [/taxonomies\.putVersion\(/], none: [/updateLabels\(/]},
        go: {all: [/taxonomies\.PutVersion\(/], none: [/UpdateLabels\(/]},
        scala: {all: [/Taxonomies\.putVersion\(/], none: [/updateLabels\(/]},
        cpp: {all: [/taxonomies::putVersion\(/], none: [/updateLabels\(/]},
      },
    },
    {
      id: 'changelog',
      title: 'Names the version and serves the changelog',
      detail:
        'The body carries the resolved `version`, `?version=` selects an old one, and `?since=n` adds the changes of every version after n up to it, from `taxonomies.changelog`. The starter answers the latest labels with no version.',
      match: {
        python: {all: [/taxonomies\.changelog\(/, /["']version["']\s*:\s*taxonomy\[/]},
        typescript: {all: [/taxonomies\.changelog\(/, /version:\s*taxonomy\.version/]},
        go: {all: [/taxonomies\.Changelog\(/, /Version:\s*taxonomy\.Version/]},
        scala: {all: [/Taxonomies\.changelog\(/, /"version"\s*->\s*JsNumber\(taxonomy\.version\)/]},
        cpp: {all: [/taxonomies::changelog\(/, /\{"version",\s*taxonomy->version\}/]},
      },
    },
    {
      id: 'version-named',
      title: 'A classification names the exact version it used',
      detail:
        '`record_classification`/`recordClassification` stores the `taxonomy_version` it was handed, so a version published between the classification and the record does not relabel it. The starter looks the latest version up when it writes.',
      match: {
        python: {all: [/["']taxonomy_version["']\s*:\s*taxonomy_version\b/]},
        typescript: {all: [/taxonomy_version:\s*taxonomyVersion\b/]},
        go: {all: [/TaxonomyVersion:\s*taxonomyVersion\b/]},
        scala: {all: [/"taxonomy_version"\s*->\s*JsNumber\(taxonomyVersion\)/]},
        cpp: {all: [/\{"taxonomy_version",\s*taxonomy_version\}/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI, HTTPException, Request

from classifier import taxonomies
from classifier.config import classifications_key

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/taxonomies/{taxonomy_id}")
def read_taxonomy(taxonomy_id: str, request: Request) -> dict:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    taxonomy = taxonomies.by_id(taxonomy_id)
    if taxonomy is None:
        raise HTTPException(status_code=404, detail="unknown taxonomy")
    return {"taxonomy_id": taxonomy_id, "labels": taxonomy["labels"]}


def publish_version(tenant: str, taxonomy_id: str, labels: list[str]) -> int:
    """Apply an edit to the taxonomy; returns the version that now holds the labels."""
    return taxonomies.update_labels(tenant, taxonomy_id, labels)


def record_classification(tenant: str, taxonomy_id: str, taxonomy_version: int, labels: list[str]) -> dict:
    """Keep the classification so it can be explained later."""
    current = taxonomies.by_id(taxonomy_id)
    record = {"tenant": tenant, "taxonomy_id": taxonomy_id, "taxonomy_version": current["version"], "labels": labels}
    r.rpush(classifications_key(tenant), json.dumps(record))
    return record
`,
      solution: `import json

import redis
from fastapi import FastAPI, HTTPException, Request

from classifier import taxonomies
from classifier.config import classifications_key

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/taxonomies/{taxonomy_id}")
def read_taxonomy(taxonomy_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    version = request.query_params.get("version")
    since = request.query_params.get("since")
    # Scoped to the tenant: another tenant's taxonomy does not exist here.
    taxonomy = taxonomies.load(tenant, taxonomy_id, int(version) if version else None)
    if taxonomy is None:
        raise HTTPException(status_code=404, detail="unknown taxonomy")
    changelog = taxonomies.changelog(tenant, taxonomy_id, int(since), taxonomy["version"]) if since else []
    return {"taxonomy_id": taxonomy_id, "version": taxonomy["version"], "labels": taxonomy["labels"], "changelog": changelog}


def publish_version(tenant: str, taxonomy_id: str, labels: list[str]) -> int:
    """An edit is a new immutable version: what was classified against the old one stays explainable."""
    return taxonomies.put_version(tenant, taxonomy_id, labels)


def record_classification(tenant: str, taxonomy_id: str, taxonomy_version: int, labels: list[str]) -> dict:
    """The record names the version that classified the text, not the one current when it is written."""
    record = {"tenant": tenant, "taxonomy_id": taxonomy_id, "taxonomy_version": taxonomy_version, "labels": labels}
    r.rpush(classifications_key(tenant), json.dumps(record))
    return record
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {classificationsKey} from 'classifier/config';
import * as taxonomies from 'classifier/taxonomies';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/taxonomies/:taxonomyId', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const {taxonomyId} = request.params as {taxonomyId: string};
  const taxonomy = await taxonomies.byId(taxonomyId);
  if (taxonomy === null) return reply.code(404).send({error: 'unknown taxonomy'});
  return {taxonomy_id: taxonomyId, labels: taxonomy.labels};
});

/** Apply an edit to the taxonomy; resolves the version that now holds the labels. */
export async function publishVersion(tenant: string, taxonomyId: string, labels: string[]): Promise<number> {
  return taxonomies.updateLabels(tenant, taxonomyId, labels);
}

/** Keep the classification so it can be explained later. */
export async function recordClassification(tenant: string, taxonomyId: string, taxonomyVersion: number, labels: string[]): Promise<Record<string, unknown>> {
  const current = await taxonomies.byId(taxonomyId);
  const record = {tenant, taxonomy_id: taxonomyId, taxonomy_version: current?.version, labels};
  await redis.rpush(classificationsKey(tenant), JSON.stringify(record));
  return record;
}
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {classificationsKey} from 'classifier/config';
import * as taxonomies from 'classifier/taxonomies';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/taxonomies/:taxonomyId', async (request, reply) => {
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  if (tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {taxonomyId} = request.params as {taxonomyId: string};
  const {version, since} = request.query as {version?: string; since?: string};
  // Scoped to the tenant: another tenant's taxonomy does not exist here.
  const taxonomy = await taxonomies.load(tenant, taxonomyId, version ? Number(version) : null);
  if (taxonomy === null) return reply.code(404).send({error: 'unknown taxonomy'});
  const changelog = since ? await taxonomies.changelog(tenant, taxonomyId, Number(since), taxonomy.version) : [];
  return {taxonomy_id: taxonomyId, version: taxonomy.version, labels: taxonomy.labels, changelog};
});

/** An edit is a new immutable version: what was classified against the old one stays explainable. */
export async function publishVersion(tenant: string, taxonomyId: string, labels: string[]): Promise<number> {
  return taxonomies.putVersion(tenant, taxonomyId, labels);
}

/** The record names the version that classified the text, not the one current when it is written. */
export async function recordClassification(tenant: string, taxonomyId: string, taxonomyVersion: number, labels: string[]): Promise<Record<string, unknown>> {
  const record = {tenant, taxonomy_id: taxonomyId, taxonomy_version: taxonomyVersion, labels};
  await redis.rpush(classificationsKey(tenant), JSON.stringify(record));
  return record;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"

	"classifier/config"
	"classifier/taxonomies" // taxonomies.Load, ByID, PutVersion, UpdateLabels, Changelog
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type classificationRecord struct {
	Tenant          string   \`json:"tenant"\`
	TaxonomyID      string   \`json:"taxonomy_id"\`
	TaxonomyVersion int      \`json:"taxonomy_version"\`
	Labels          []string \`json:"labels"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readTaxonomy(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	taxonomyID := r.PathValue("id")
	taxonomy, err := taxonomies.ByID(r.Context(), taxonomyID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if taxonomy == nil {
		http.Error(rw, "unknown taxonomy", http.StatusNotFound)
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"taxonomy_id": taxonomyID, "labels": taxonomy.Labels})
}

// publishVersion applies an edit to the taxonomy and returns the version that now holds the labels.
func publishVersion(ctx context.Context, tenant, taxonomyID string, labels []string) (int, error) {
	return taxonomies.UpdateLabels(ctx, tenant, taxonomyID, labels)
}

// recordClassification keeps the classification so it can be explained later.
func recordClassification(ctx context.Context, tenant, taxonomyID string, taxonomyVersion int, labels []string) (classificationRecord, error) {
	current, err := taxonomies.ByID(ctx, taxonomyID)
	if err != nil || current == nil {
		return classificationRecord{}, err
	}
	record := classificationRecord{Tenant: tenant, TaxonomyID: taxonomyID, TaxonomyVersion: current.Version, Labels: labels}
	raw, _ := json.Marshal(record)
	return record, rdb.RPush(ctx, config.ClassificationsKey(tenant), string(raw)).Err()
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/taxonomies/{id}", readTaxonomy)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"

	"classifier/config"
	"classifier/taxonomies" // taxonomies.Load, ByID, PutVersion, UpdateLabels, Changelog
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type classificationRecord struct {
	Tenant          string   \`json:"tenant"\`
	TaxonomyID      string   \`json:"taxonomy_id"\`
	TaxonomyVersion int      \`json:"taxonomy_version"\`
	Labels          []string \`json:"labels"\`
}

type taxonomyView struct {
	TaxonomyID string              \`json:"taxonomy_id"\`
	Version    int                 \`json:"version"\`
	Labels     []string            \`json:"labels"\`
	Changelog  []taxonomies.Change \`json:"changelog"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readTaxonomy(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "missing X-Tenant-Id", http.StatusUnauthorized)
		return
	}
	taxonomyID := r.PathValue("id")
	version, _ := strconv.Atoi(r.URL.Query().Get("version"))
	// Scoped to the tenant: another tenant's taxonomy does not exist here.
	taxonomy, err := taxonomies.Load(r.Context(), tenant, taxonomyID, version)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if taxonomy == nil {
		http.Error(rw, "unknown taxonomy", http.StatusNotFound)
		return
	}
	changelog := []taxonomies.Change{}
	if since := r.URL.Query().Get("since"); since != "" {
		n, _ := strconv.Atoi(since)
		if changelog, err = taxonomies.Changelog(r.Context(), tenant, taxonomyID, n, taxonomy.Version); err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	writeJSON(rw, http.StatusOK, taxonomyView{TaxonomyID: taxonomyID, Version: taxonomy.Version, Labels: taxonomy.Labels, Changelog: changelog})
}

// publishVersion writes an edit as a new immutable version: what was classified against the old one stays explainable.
func publishVersion(ctx context.Context, tenant, taxonomyID string, labels []string) (int, error) {
	return taxonomies.PutVersion(ctx, tenant, taxonomyID, labels)
}

// recordClassification names the version that classified the text, not the one current when it is written.
func recordClassification(ctx context.Context, tenant, taxonomyID string, taxonomyVersion int, labels []string) (classificationRecord, error) {
	record := classificationRecord{Tenant: tenant, TaxonomyID: taxonomyID, TaxonomyVersion: taxonomyVersion, Labels: labels}
	raw, _ := json.Marshal(record)
	return record, rdb.RPush(ctx, config.ClassificationsKey(tenant), string(raw)).Err()
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/taxonomies/{id}", readTaxonomy)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import classifier.{Config, Taxonomies}

object TaxonomyApi {
  private val jedis = new JedisPooled("redis", 6379)

  private def json(body: JsValue): HttpResponse =
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "taxonomies" / Segment) { taxonomyId =>
    get {
      // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
      Taxonomies.byId(taxonomyId) match {
        case None => complete(StatusCodes.NotFound -> "unknown taxonomy")
        case Some(taxonomy) => complete(json(JsObject("taxonomy_id" -> JsString(taxonomyId), "labels" -> taxonomy.labels.toJson)))
      }
    }
  }

  /** Apply an edit to the taxonomy; returns the version that now holds the labels. */
  def publishVersion(tenant: String, taxonomyId: String, labels: Seq[String]): Long =
    Taxonomies.updateLabels(tenant, taxonomyId, labels)

  /** Keep the classification so it can be explained later. */
  def recordClassification(tenant: String, taxonomyId: String, taxonomyVersion: Long, labels: Seq[String]): JsObject = {
    val current = Taxonomies.byId(taxonomyId).map(_.version).getOrElse(0L)
    val record = JsObject(
      "tenant" -> JsString(tenant),
      "taxonomy_id" -> JsString(taxonomyId),
      "taxonomy_version" -> JsNumber(current),
      "labels" -> labels.toJson
    )
    jedis.rpush(Config.classificationsKey(tenant), record.compactPrint)
    record
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import classifier.{Config, Taxonomies}

object TaxonomyApi {
  private val jedis = new JedisPooled("redis", 6379)

  private def json(body: JsValue): HttpResponse =
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "taxonomies" / Segment) { taxonomyId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "missing X-Tenant-Id")
        case Some(tenant) =>
          parameters("version".optional, "since".optional) { (version, since) =>
            // Scoped to the tenant: another tenant's taxonomy does not exist here.
            Taxonomies.load(tenant, taxonomyId, version.map(_.toLong).getOrElse(0L)) match {
              case None => complete(StatusCodes.NotFound -> "unknown taxonomy")
              case Some(taxonomy) =>
                val changelog = since.map(n => Taxonomies.changelog(tenant, taxonomyId, n.toLong, taxonomy.version)).getOrElse(Seq.empty)
                complete(
                  json(
                    JsObject(
                      "taxonomy_id" -> JsString(taxonomyId),
                      "version" -> JsNumber(taxonomy.version),
                      "labels" -> taxonomy.labels.toJson,
                      "changelog" -> JsArray(changelog.map(c => JsObject("version" -> JsNumber(c.version), "added" -> c.added.toJson, "removed" -> c.removed.toJson)).toVector)
                    )
                  )
                )
            }
          }
      }
    }
  }

  /** An edit is a new immutable version: what was classified against the old one stays explainable. */
  def publishVersion(tenant: String, taxonomyId: String, labels: Seq[String]): Long =
    Taxonomies.putVersion(tenant, taxonomyId, labels)

  /** The record names the version that classified the text, not the one current when it is written. */
  def recordClassification(tenant: String, taxonomyId: String, taxonomyVersion: Long, labels: Seq[String]): JsObject = {
    val record = JsObject(
      "tenant" -> JsString(tenant),
      "taxonomy_id" -> JsString(taxonomyId),
      "taxonomy_version" -> JsNumber(taxonomyVersion),
      "labels" -> labels.toJson
    )
    jedis.rpush(Config.classificationsKey(tenant), record.compactPrint)
    record
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "classifier/config.h"      // config::classificationsKey, redis()
#include "classifier/taxonomies.h"  // taxonomies::load, byId, putVersion, updateLabels, changelog

using json = nlohmann::json;

void read_taxonomy(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string taxonomy_id = req.matches[1];
  const auto taxonomy = taxonomies::byId(taxonomy_id);
  if (!taxonomy) {
    res.status = 404;
    res.set_content("unknown taxonomy", "text/plain");
    return;
  }
  res.set_content(json{{"taxonomy_id", taxonomy_id}, {"labels", taxonomy->labels}}.dump(), "application/json");
}

// Apply an edit to the taxonomy; returns the version that now holds the labels.
long publishVersion(const std::string& tenant, const std::string& taxonomy_id, const std::vector<std::string>& labels) {
  return taxonomies::updateLabels(tenant, taxonomy_id, labels);
}

// Keep the classification so it can be explained later.
json recordClassification(const std::string& tenant, const std::string& taxonomy_id, long taxonomy_version, const std::vector<std::string>& labels) {
  const auto current = taxonomies::byId(taxonomy_id);
  const json record = {{"tenant", tenant}, {"taxonomy_id", taxonomy_id}, {"taxonomy_version", current ? current->version : 0L}, {"labels", labels}};
  config::redis().rpush(config::classificationsKey(tenant), record.dump());
  return record;
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/taxonomies/([\\w-]+))", read_taxonomy); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "classifier/config.h"      // config::classificationsKey, redis()
#include "classifier/taxonomies.h"  // taxonomies::load, byId, putVersion, updateLabels, changelog

using json = nlohmann::json;

void read_taxonomy(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("missing X-Tenant-Id", "text/plain");
    return;
  }
  const std::string taxonomy_id = req.matches[1];
  const long version = req.has_param("version") ? std::stol(req.get_param_value("version")) : 0;
  // Scoped to the tenant: another tenant's taxonomy does not exist here.
  const auto taxonomy = taxonomies::load(tenant, taxonomy_id, version);
  if (!taxonomy) {
    res.status = 404;
    res.set_content("unknown taxonomy", "text/plain");
    return;
  }
  json changelog = json::array();
  if (req.has_param("since"))
    for (const auto& c : taxonomies::changelog(tenant, taxonomy_id, std::stol(req.get_param_value("since")), taxonomy->version))
      changelog.push_back(json{{"version", c.version}, {"added", c.added}, {"removed", c.removed}});
  res.set_content(json{{"taxonomy_id", taxonomy_id}, {"version", taxonomy->version}, {"labels", taxonomy->labels}, {"changelog", changelog}}.dump(),
                  "application/json");
}

// An edit is a new immutable version: what was classified against the old one stays explainable.
long publishVersion(const std::string& tenant, const std::string& taxonomy_id, const std::vector<std::string>& labels) {
  return taxonomies::putVersion(tenant, taxonomy_id, labels);
}

// The record names the version that classified the text, not the one current when it is written.
json recordClassification(const std::string& tenant, const std::string& taxonomy_id, long taxonomy_version, const std::vector<std::string>& labels) {
  const json record = {{"tenant", tenant}, {"taxonomy_id", taxonomy_id}, {"taxonomy_version", taxonomy_version}, {"labels", labels}};
  config::redis().rpush(config::classificationsKey(tenant), record.dump());
  return record;
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/taxonomies/([\\w-]+))", read_taxonomy); }
`,
    },
  },
  harness: {
    python: `import json

from classifier import config, taxonomies

V1 = ["billing", "support", "security"]
V2 = ["billing", "support", "security", "abuse"]
V3 = ["billing", "support", "abuse"]


def _world(ctx):
    taxonomies.put_version("acme", "tx-support", V1)
    taxonomies.put_version("globex", "tx-legal", ["legal"])
    m = ctx.load("read")
    return m, ctx.client(m.app)


async def _get(c, path, tenant="acme"):
    return await c.get(path, headers={"X-Tenant-Id": tenant} if tenant else {})


async def check_route(ctx):
    _, client = _world(ctx)
    async with client as c:
        r = await _get(c, "/v1/taxonomies/tx-support")
    assert r.status_code == 200, f"GET /v1/taxonomies/tx-support answered {r.status_code}: {r.text}"
    assert r.json().get("labels") == V1, f"the read must answer the taxonomy's labels, got {r.text}"


async def check_tenant_scoped_404(ctx):
    _, client = _world(ctx)
    async with client as c:
        r = await _get(c, "/v1/taxonomies/tx-support", tenant="")
        assert r.status_code == 401, f"a read without X-Tenant-Id answered {r.status_code}, expected 401"
        r = await _get(c, "/v1/taxonomies/tx-support", tenant="globex")
        assert r.status_code == 404, f"tenant globex read acme's taxonomy and got {r.status_code} {r.text}, expected 404"
        r = await _get(c, "/v1/taxonomies/tx-legal", tenant="globex")
    assert r.status_code == 200 and r.json().get("labels") == ["legal"], f"globex reads its own taxonomy, got {r.status_code} {r.text}"


async def check_immutable_versions(ctx):
    m, _ = _world(ctx)
    version = m.publish_version("acme", "tx-support", V2)
    assert version == 2, f"publishing an edit must mint version 2, got {version!r}"
    v1 = taxonomies.load("acme", "tx-support", 1)
    assert v1 is not None and v1["labels"] == V1, f"version 1 now holds {v1}: an edit rewrote the labels old classifications were made against"
    v2 = taxonomies.load("acme", "tx-support", 2)
    assert v2 is not None and v2["labels"] == V2, f"version 2 holds {v2}, expected {V2}"
    assert m.publish_version("acme", "tx-support", V3) == 3, "the next edit must mint version 3"


async def check_changelog(ctx):
    _, client = _world(ctx)
    taxonomies.put_version("acme", "tx-support", V2)
    taxonomies.put_version("acme", "tx-support", V3)
    async with client as c:
        body = (await _get(c, "/v1/taxonomies/tx-support?since=1")).json()
        assert body.get("version") == 3, f"the read must name the version it serves (3), got {body}"
        assert body.get("changelog") == [{"version": 2, "added": ["abuse"], "removed": []}, {"version": 3, "added": [], "removed": ["security"]}], f"?since=1 must list the changes of versions 2 and 3, got {body.get('changelog')}"
        body = (await _get(c, "/v1/taxonomies/tx-support?version=1")).json()
        assert body.get("version") == 1 and body.get("labels") == V1, f"?version=1 must serve version 1 as it was, got {body}"
        body = (await _get(c, "/v1/taxonomies/tx-support?version=2&since=1")).json()
    assert body.get("changelog") == [{"version": 2, "added": ["abuse"], "removed": []}], f"the changelog runs up to the requested version, got {body.get('changelog')}"


async def check_version_named(ctx):
    m, _ = _world(ctx)
    taxonomies.put_version("acme", "tx-support", V2)  # version 2 lands between the classification and its record
    record = m.record_classification("acme", "tx-support", 1, ["billing"])
    rows = [json.loads(row) for row in ctx.redis.lrange(config.classifications_key("acme"), 0, -1)]
    assert len(rows) == 1, f"one record_classification must append one record, {config.classifications_key('acme')} holds {rows}"
    assert rows[0].get("taxonomy_version") == 1, f"the text was classified against version 1, the record says {rows[0].get('taxonomy_version')}: it must name the version it was given"
    assert rows[0].get("taxonomy_id") == "tx-support" and rows[0].get("labels") == ["billing"] and rows[0].get("tenant") == "acme", f"the record is {rows[0]}"
    assert record.get("taxonomy_version") == 1, f"record_classification returned {record}"
`,
    typescript: `const V1 = ['billing', 'support', 'security'];
const V2 = ['billing', 'support', 'security', 'abuse'];
const V3 = ['billing', 'support', 'abuse'];

async function world(ctx) {
  const taxonomies = ctx.load('/support/classifier/taxonomies.ts');
  await taxonomies.putVersion('acme', 'tx-support', V1);
  await taxonomies.putVersion('globex', 'tx-legal', ['legal']);
  const m = ctx.load('read');
  return {m, c: ctx.client(m.app), taxonomies};
}

const get = (c, path: string, tenant = 'acme') => c.get(path, {headers: tenant ? {'X-Tenant-Id': tenant} : {}});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function check_route(ctx) {
  const {c} = await world(ctx);
  const r = await get(c, '/v1/taxonomies/tx-support');
  assert.equal(r.status, 200, \`GET /v1/taxonomies/tx-support answered \${r.status}: \${r.text}\`);
  assert(same(r.json().labels, V1), \`the read must answer the taxonomy's labels, got \${r.text}\`);
}

export async function check_tenant_scoped_404(ctx) {
  const {c} = await world(ctx);
  let r = await get(c, '/v1/taxonomies/tx-support', '');
  assert.equal(r.status, 401, \`a read without X-Tenant-Id answered \${r.status}, expected 401\`);
  r = await get(c, '/v1/taxonomies/tx-support', 'globex');
  assert.equal(r.status, 404, \`tenant globex read acme's taxonomy and got \${r.status} \${r.text}, expected 404\`);
  r = await get(c, '/v1/taxonomies/tx-legal', 'globex');
  assert(r.status === 200 && same(r.json().labels, ['legal']), \`globex reads its own taxonomy, got \${r.status} \${r.text}\`);
}

export async function check_immutable_versions(ctx) {
  const {m, taxonomies} = await world(ctx);
  const version = await m.publishVersion('acme', 'tx-support', V2);
  assert.equal(version, 2, \`publishing an edit must mint version 2, got \${JSON.stringify(version)}\`);
  const v1 = await taxonomies.load('acme', 'tx-support', 1);
  assert(v1 !== null && same(v1.labels, V1), \`version 1 now holds \${JSON.stringify(v1)}: an edit rewrote the labels old classifications were made against\`);
  const v2 = await taxonomies.load('acme', 'tx-support', 2);
  assert(v2 !== null && same(v2.labels, V2), \`version 2 holds \${JSON.stringify(v2)}, expected \${JSON.stringify(V2)}\`);
  assert.equal(await m.publishVersion('acme', 'tx-support', V3), 3, 'the next edit must mint version 3');
}

export async function check_changelog(ctx) {
  const {c, taxonomies} = await world(ctx);
  await taxonomies.putVersion('acme', 'tx-support', V2);
  await taxonomies.putVersion('acme', 'tx-support', V3);
  let body = (await get(c, '/v1/taxonomies/tx-support?since=1')).json();
  assert.equal(body.version, 3, \`the read must name the version it serves (3), got \${JSON.stringify(body)}\`);
  assert(
    same(body.changelog, [{version: 2, added: ['abuse'], removed: []}, {version: 3, added: [], removed: ['security']}]),
    \`?since=1 must list the changes of versions 2 and 3, got \${JSON.stringify(body.changelog)}\`,
  );
  body = (await get(c, '/v1/taxonomies/tx-support?version=1')).json();
  assert(body.version === 1 && same(body.labels, V1), \`?version=1 must serve version 1 as it was, got \${JSON.stringify(body)}\`);
  body = (await get(c, '/v1/taxonomies/tx-support?version=2&since=1')).json();
  assert(same(body.changelog, [{version: 2, added: ['abuse'], removed: []}]), \`the changelog runs up to the requested version, got \${JSON.stringify(body.changelog)}\`);
}

export async function check_version_named(ctx) {
  const {m, taxonomies} = await world(ctx);
  await taxonomies.putVersion('acme', 'tx-support', V2); // version 2 lands between the classification and its record
  const record = await m.recordClassification('acme', 'tx-support', 1, ['billing']);
  const rows = (ctx.redis.lrange('classifications:acme', 0, -1) as string[]).map(row => JSON.parse(row));
  assert.equal(rows.length, 1, \`one recordClassification must append one record, classifications:acme holds \${JSON.stringify(rows)}\`);
  assert.equal(rows[0].taxonomy_version, 1, \`the text was classified against version 1, the record says \${rows[0].taxonomy_version}: it must name the version it was given\`);
  assert(rows[0].taxonomy_id === 'tx-support' && same(rows[0].labels, ['billing']) && rows[0].tenant === 'acme', \`the record is \${JSON.stringify(rows[0])}\`);
  assert.equal(record.taxonomy_version, 1, \`recordClassification resolved \${JSON.stringify(record)}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"classifier/config"
	"classifier/taxonomies"

	"leetbuild/harness"
)

var (
	readV1 = []string{"billing", "support", "security"}
	readV2 = []string{"billing", "support", "security", "abuse"}
	readV3 = []string{"billing", "support", "abuse"}
)

type readBody struct {
	Version   int                 \`json:"version"\`
	Labels    []string            \`json:"labels"\`
	Changelog []taxonomies.Change \`json:"changelog"\`
}

func readWorld(ctx *harness.Ctx) *harness.HTTP {
	_, err := taxonomies.PutVersion(context.Background(), "acme", "tx-support", readV1)
	ctx.NoError(err, "seeding tx-support")
	_, err = taxonomies.PutVersion(context.Background(), "globex", "tx-legal", []string{"legal"})
	ctx.NoError(err, "seeding tx-legal")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readGet(c *harness.HTTP, path, tenant string) *harness.Response {
	if tenant == "" {
		return c.Get(path)
	}
	return c.Get(path, "X-Tenant-Id", tenant)
}

func readDecode(r *harness.Response) readBody {
	var body readBody
	r.Decode(&body)
	return body
}

func readPut(ctx *harness.Ctx, labels []string) {
	_, err := taxonomies.PutVersion(context.Background(), "acme", "tx-support", labels)
	ctx.NoError(err, "publishing a version")
}

func CheckRoute(ctx *harness.Ctx) {
	c := readWorld(ctx)
	r := readGet(c, "/v1/taxonomies/tx-support", "acme")
	ctx.Equal(r.Status, 200, "GET /v1/taxonomies/tx-support (%s)", r.Text())
	ctx.Equal(readDecode(r).Labels, readV1, "the read must answer the taxonomy's labels")
}

func CheckTenantScoped404(ctx *harness.Ctx) {
	c := readWorld(ctx)
	ctx.Equal(readGet(c, "/v1/taxonomies/tx-support", "").Status, 401, "a read without X-Tenant-Id")
	r := readGet(c, "/v1/taxonomies/tx-support", "globex")
	ctx.Equal(r.Status, 404, "tenant globex read acme's taxonomy (%s)", r.Text())
	r = readGet(c, "/v1/taxonomies/tx-legal", "globex")
	ctx.Assert(r.Status == 200 && len(readDecode(r).Labels) == 1, "globex reads its own taxonomy, got %d %s", r.Status, r.Text())
}

func CheckImmutableVersions(ctx *harness.Ctx) {
	readWorld(ctx)
	version, err := publishVersion(context.Background(), "acme", "tx-support", readV2)
	ctx.NoError(err, "publishVersion")
	ctx.Equal(version, 2, "publishing an edit must mint version 2; the version")
	v1, err := taxonomies.Load(context.Background(), "acme", "tx-support", 1)
	ctx.NoError(err, "loading version 1")
	ctx.Assert(v1 != nil, "version 1 is gone")
	ctx.Equal(v1.Labels, readV1, "version 1 must keep its labels: an edit rewrote the labels old classifications were made against")
	v2, err := taxonomies.Load(context.Background(), "acme", "tx-support", 2)
	ctx.NoError(err, "loading version 2")
	ctx.Assert(v2 != nil, "version 2 does not exist")
	ctx.Equal(v2.Labels, readV2, "version 2's labels")
	version, err = publishVersion(context.Background(), "acme", "tx-support", readV3)
	ctx.NoError(err, "publishVersion")
	ctx.Equal(version, 3, "the next edit must mint version 3")
}

func CheckChangelog(ctx *harness.Ctx) {
	c := readWorld(ctx)
	readPut(ctx, readV2)
	readPut(ctx, readV3)
	r := readGet(c, "/v1/taxonomies/tx-support?since=1", "acme")
	body := readDecode(r)
	ctx.Equal(body.Version, 3, "the read must name the version it serves (%s)", r.Text())
	want, _ := json.Marshal([]taxonomies.Change{{Version: 2, Added: []string{"abuse"}, Removed: []string{}}, {Version: 3, Added: []string{}, Removed: []string{"security"}}})
	got, _ := json.Marshal(body.Changelog)
	ctx.Equal(string(got), string(want), "?since=1 must list the changes of versions 2 and 3")
	r = readGet(c, "/v1/taxonomies/tx-support?version=1", "acme")
	body = readDecode(r)
	ctx.Assert(body.Version == 1 && len(body.Labels) == 3 && body.Labels[2] == "security", "?version=1 must serve version 1 as it was, got %s", r.Text())
	body = readDecode(readGet(c, "/v1/taxonomies/tx-support?version=2&since=1", "acme"))
	got, _ = json.Marshal(body.Changelog)
	ctx.Equal(string(got), \`[{"version":2,"added":["abuse"],"removed":[]}]\`, "the changelog runs up to the requested version")
}

func CheckVersionNamed(ctx *harness.Ctx) {
	readWorld(ctx)
	readPut(ctx, readV2) // version 2 lands between the classification and its record
	record, err := recordClassification(context.Background(), "acme", "tx-support", 1, []string{"billing"})
	ctx.NoError(err, "recordClassification")
	rows := ctx.Redis.LRange(config.ClassificationsKey("acme"), 0, -1)
	ctx.Equal(len(rows), 1, "one recordClassification must append one record (%v); the records", rows)
	var row classificationRecord
	ctx.NoError(json.Unmarshal([]byte(rows[0]), &row), "a record must be JSON")
	ctx.Equal(row.TaxonomyVersion, 1, "the text was classified against version 1: the record must name the version it was given; the record's version")
	ctx.Assert(row.TaxonomyID == "tx-support" && row.Tenant == "acme" && len(row.Labels) == 1 && row.Labels[0] == "billing", "the record is %s", rows[0])
	ctx.Equal(record.TaxonomyVersion, 1, "the returned record's version")
}
`,
    cpp: `#include <leetbuild/harness.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

const std::vector<std::string> kV1 = {"billing", "support", "security"};
const std::vector<std::string> kV2 = {"billing", "support", "security", "abuse"};
const std::vector<std::string> kV3 = {"billing", "support", "abuse"};

harness::HTTP readWorld(harness::Ctx& ctx) {
  taxonomies::putVersion("acme", "tx-support", kV1);
  taxonomies::putVersion("globex", "tx-legal", {"legal"});
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response readGet(harness::HTTP& c, const std::string& path, const std::string& tenant = "acme") {
  if (tenant.empty()) return c.Get(path);
  return c.Get(path, "X-Tenant-Id", tenant);
}

nlohmann::json decode(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : nlohmann::json::object();
}

std::vector<std::string> labelsOf(const nlohmann::json& body) { return body.value("labels", std::vector<std::string>{}); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = readWorld(ctx);
  const auto r = readGet(c, "/v1/taxonomies/tx-support");
  ctx.Equal(r.Status, 200, "GET /v1/taxonomies/tx-support (%s)", r.Text());
  ctx.Equal(labelsOf(decode(r)), kV1, "the read must answer the taxonomy's labels");
}

void CheckTenantScoped404(harness::Ctx& ctx) {
  auto c = readWorld(ctx);
  ctx.Equal(readGet(c, "/v1/taxonomies/tx-support", "").Status, 401, "a read without X-Tenant-Id");
  auto r = readGet(c, "/v1/taxonomies/tx-support", "globex");
  ctx.Equal(r.Status, 404, "tenant globex read acme's taxonomy (%s)", r.Text());
  r = readGet(c, "/v1/taxonomies/tx-legal", "globex");
  ctx.Assert(r.Status == 200 && labelsOf(decode(r)) == std::vector<std::string>{"legal"}, "globex reads its own taxonomy, got %d %s", r.Status, r.Text());
}

void CheckImmutableVersions(harness::Ctx& ctx) {
  readWorld(ctx);
  ctx.Equal(publishVersion("acme", "tx-support", kV2), 2, "publishing an edit must mint version 2; the version");
  const auto v1 = taxonomies::load("acme", "tx-support", 1);
  ctx.Assert(v1.has_value(), "version 1 is gone");
  ctx.Equal(v1->labels, kV1, "version 1 must keep its labels: an edit rewrote the labels old classifications were made against");
  const auto v2 = taxonomies::load("acme", "tx-support", 2);
  ctx.Assert(v2.has_value(), "version 2 does not exist");
  ctx.Equal(v2->labels, kV2, "version 2's labels");
  ctx.Equal(publishVersion("acme", "tx-support", kV3), 3, "the next edit must mint version 3");
}

void CheckChangelog(harness::Ctx& ctx) {
  auto c = readWorld(ctx);
  taxonomies::putVersion("acme", "tx-support", kV2);
  taxonomies::putVersion("acme", "tx-support", kV3);
  auto r = readGet(c, "/v1/taxonomies/tx-support?since=1");
  auto body = decode(r);
  ctx.Equal(body.value("version", 0L), 3, "the read must name the version it serves (%s)", r.Text());
  const auto want = nlohmann::json::parse(R"([{"version":2,"added":["abuse"],"removed":[]},{"version":3,"added":[],"removed":["security"]}])");
  ctx.Equal(body.value("changelog", nlohmann::json::array()).dump(), want.dump(), "?since=1 must list the changes of versions 2 and 3");
  r = readGet(c, "/v1/taxonomies/tx-support?version=1");
  body = decode(r);
  ctx.Assert(body.value("version", 0L) == 1 && labelsOf(body) == kV1, "?version=1 must serve version 1 as it was, got %s", r.Text());
  body = decode(readGet(c, "/v1/taxonomies/tx-support?version=2&since=1"));
  ctx.Equal(body.value("changelog", nlohmann::json::array()).dump(), R"([{"added":["abuse"],"removed":[],"version":2}])",
            "the changelog runs up to the requested version");
}

void CheckVersionNamed(harness::Ctx& ctx) {
  readWorld(ctx);
  taxonomies::putVersion("acme", "tx-support", kV2);  // version 2 lands between the classification and its record
  const auto record = recordClassification("acme", "tx-support", 1, {"billing"});
  const auto rows = ctx.Redis.LRange(config::classificationsKey("acme"), 0, -1);
  ctx.Equal(rows.size(), 1, "one recordClassification must append one record; the records");
  const auto row = nlohmann::json::parse(rows[0], nullptr, false);
  ctx.Assert(row.is_object(), "a record must be JSON, got %s", rows[0]);
  ctx.Equal(row.value("taxonomy_version", 0L), 1, "the text was classified against version 1: the record must name the version it was given; the record's version");
  ctx.Assert(row.value("taxonomy_id", "") == "tx-support" && row.value("tenant", "") == "acme" && labelsOf(row) == std::vector<std::string>{"billing"},
             "the record is %s", rows[0]);
  ctx.Equal(record.value("taxonomy_version", 0L), 1, "the returned record's version");
}
`,
  },
  hints: [
    'Tenant globex reads acme’s taxonomy, a read never says which version it shows, an edit changes the labels yesterday’s classifications were made against, and a record names a version it was never made with.',
    'The read uses `by_id`, which ignores the tenant and answers the latest; `publish_version` goes through `update_labels`, which rewrites the latest version in place; `record_classification` looks the version up when it writes instead of taking the one it was given.',
    '401 without a tenant; `taxonomies.load(tenant, taxonomy_id, version)` or 404; `version` and `taxonomies.changelog(tenant, taxonomy_id, since, version)` in the body; `taxonomies.put_version` in `publish_version`; record the `taxonomy_version` argument.',
  ],
  debrief: `Immutability is what makes a label explainable: a classification names a version, and the version still holds the labels it held then, so the decision can be replayed against the rules that made it. That is why the edit path appends a version and the record takes the version it was handed; looking it up at write time records whatever was published in between. The changelog is the read side of the same model, computed from the versions instead of kept beside them. The 404 for another tenant’s taxonomy keeps ids from revealing that they exist. Production taxonomy services also retire versions on a schedule, refuse to retire one that recent classifications still name, and index records by version so the results of a bad version can be found and reclassified.`,
};
