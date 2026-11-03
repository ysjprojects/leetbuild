import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/crawl/targets: decide before anything is fetched',
  concept: 'http',
  file: 'api',
  focus: ['client', 'crawler', 'registry', 'robots'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/crawl/targets\` with body
\`{"job_id": "nightly", "url": "https://blog.example.com/posts"}\` and the tenant in \`X-Tenant-Id\`
(401 without it): it parses the URL with \`web.split_url\`, fetches it with \`web.fetch_page\`,
registers it with \`registry.insert\`, queues it with \`frontier.enqueue\` and answers
\`{"target_id", "status": "accepted"}\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A crawler that fetches before it decides is an SSRF with a
queue in front of it: the cluster's metadata address gets fetched because a caller typed it.
Skipping robots makes the crawl impolite from its first request, and an unconditional insert turns
every client retry into a second copy in the frontier.

- Only \`http\` and \`https\` URLs (\`ALLOWED_SCHEMES\`) on an allowlisted host (\`ALLOWED_HOSTS\`:
  blog.example.com, docs.example.com, example.com) are accepted; anything else is **400**, decided
  before anything is fetched.
- Registration fetches \`robots.txt\` (\`web.fetch_robots(host)\`) and nothing else. A path under a
  \`Disallow\` prefix is **403** quoting the rule: \`disallowed by robots: /private\`.
- One target per \`(job_id, url)\`: \`registry.find\` it first and answer a replay with its
  \`target_id\`, without enqueuing it again.`,
  sequence: {
    participants: ['Operator', 'crawld', 'robots.txt', 'Target registry', 'Redis frontier'],
    messages: [
      {from: 'Operator', to: 'crawld', label: 'POST /v1/crawl/targets · {job_id, url}', kind: 'sync'},
      {from: 'crawld', to: 'crawld', label: 'split_url · scheme · ALLOWED_HOSTS → 400', kind: 'sync'},
      {from: 'crawld', to: 'Target registry', label: 'find(job_id, url)', kind: 'sync'},
      {from: 'Target registry', to: 'crawld', label: 'target → answer its id', kind: 'reply'},
      {from: 'crawld', to: 'robots.txt', label: 'fetch_robots(host)', kind: 'sync'},
      {from: 'robots.txt', to: 'crawld', label: 'Disallow prefixes → 403 quoting the rule', kind: 'reply'},
      {from: 'crawld', to: 'Target registry', label: 'insert(job_id, url, tenant)', kind: 'sync'},
      {from: 'crawld', to: 'Redis frontier', label: 'enqueue(job_id, host, url)', kind: 'sync'},
      {from: 'crawld', to: 'Operator', label: '200 {target_id, status: "accepted"}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/crawl/targets',
      detail:
        'Register `POST /v1/crawl/targets`: an accepted target answers `{target_id, status: "accepted"}` and is queued on its host; a request without `X-Tenant-Id` is 401.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/crawl\/targets["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/crawl\/targets['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/crawl\/targets"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"crawl"\s*\/\s*"targets"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/crawl\/targets"/]},
      },
    },
    {
      id: 'host-policy',
      title: 'Accepts only http(s) URLs on an allowlisted host',
      detail:
        'The scheme must be in `ALLOWED_SCHEMES` and the host in `ALLOWED_HOSTS`; anything else, the metadata address and `localhost` included, is **400** and registers nothing. The starter accepts any absolute URL.',
      match: {
        python: {all: [/ALLOWED_SCHEMES/, /ALLOWED_HOSTS/, /status_code\s*=\s*400/]},
        typescript: {all: [/ALLOWED_SCHEMES/, /ALLOWED_HOSTS/, /code\(\s*400\s*\)/]},
        go: {all: [/allowedSchemes/, /allowedHosts/, /StatusBadRequest/]},
        scala: {all: [/AllowedSchemes/, /AllowedHosts/, /BadRequest/]},
        cpp: {all: [/kAllowedSchemes/, /kAllowedHosts/, /\b400\b/]},
      },
    },
    {
      id: 'reject-before-fetch',
      title: 'Fetches nothing for a refused target, only robots.txt for an accepted one',
      detail:
        "The host test runs before `fetch_robots`, and registration never calls `fetch_page`: the page is the fetcher's job. The starter fetches whatever URL the caller sent before it decides anything.",
      match: {
        python: {order: [/in ALLOWED_HOSTS/, /web\.fetch_robots\(/], none: [/fetch_page\(/]},
        typescript: {order: [/ALLOWED_HOSTS(\.(has|includes)\(|\[)/, /fetchRobots\(/], none: [/fetchPage\(/]},
        go: {order: [/allowedHosts\[/, /web\.FetchRobots\(/], none: [/FetchPage\(/]},
        scala: {order: [/AllowedHosts(\.contains)?\(/, /Web\.fetchRobots\(/], none: [/fetchPage\(/]},
        cpp: {order: [/kAllowedHosts\.(count|find|contains)\(/, /web::fetchRobots\(/], none: [/fetchPage\(/]},
      },
    },
    {
      id: 'robots',
      title: 'A disallowed path is 403 quoting the robots rule',
      detail:
        "The host's robots rules are read before the insert, and a path under a `Disallow` prefix answers **403** `disallowed by robots: <rule>` and registers nothing. The starter never reads `robots.txt`.",
      match: {
        python: {
          all: [/status_code\s*=\s*403/, /disallowed by robots/],
          order: [/web\.fetch_robots\(/, /registry\.insert\(/],
        },
        typescript: {
          all: [/code\(\s*403\s*\)/, /disallowed by robots/],
          order: [/fetchRobots\(/, /(?<![.\w])insert\(|registry\.insert\(/],
        },
        go: {all: [/StatusForbidden/, /disallowed by robots/], order: [/web\.FetchRobots\(/, /registry\.Insert\(/]},
        scala: {all: [/Forbidden/, /disallowed by robots/], order: [/Web\.fetchRobots\(/, /Registry\.insert\(/]},
        cpp: {all: [/\b403\b/, /disallowed by robots/], order: [/web::fetchRobots\(/, /registry::insert\(/]},
      },
    },
    {
      id: 'dedupe',
      title: 'One target per (job_id, url)',
      detail:
        'The registry is looked up (`find`) before the insert and a replay answers the stored `target_id` without enqueuing the URL again. The starter inserts and enqueues on every request.',
      match: {
        python: {order: [/registry\.find\(/, /registry\.insert\(/]},
        typescript: {order: [/(?<![.\w])find\(|registry\.find\(/, /(?<![.\w])insert\(|registry\.insert\(/]},
        go: {order: [/registry\.Find\(/, /registry\.Insert\(/]},
        scala: {order: [/Registry\.find\(/, /Registry\.insert\(/]},
        cpp: {order: [/registry::find\(/, /registry::insert\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from crawl import frontier, registry, web  # web.split_url, fetch_robots, fetch_page; registry.find, insert; frontier.enqueue

app = FastAPI()


class TargetRequest(BaseModel):
    job_id: str
    url: str


@app.post("/v1/crawl/targets")
def register_target(body: TargetRequest, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    parts = web.split_url(body.url)
    if parts is None:
        raise HTTPException(status_code=400, detail="not an absolute URL")
    web.fetch_page(body.url)  # make sure the seed answers before it is queued
    target = registry.insert(body.job_id, body.url, tenant)
    frontier.enqueue(body.job_id, parts["host"], body.url)
    return {"target_id": target["target_id"], "status": "accepted"}
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from crawl import frontier, registry, web  # web.split_url, fetch_robots, fetch_page; registry.find, insert; frontier.enqueue

app = FastAPI()

ALLOWED_SCHEMES = {"http", "https"}
ALLOWED_HOSTS = {"blog.example.com", "docs.example.com", "example.com"}


class TargetRequest(BaseModel):
    job_id: str
    url: str


def robots_rule(path: str, rules: list[str]) -> str | None:
    """The first Disallow prefix the path falls under, or None."""
    return next((rule for rule in rules if rule and path.startswith(rule)), None)


@app.post("/v1/crawl/targets")
def register_target(body: TargetRequest, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    parts = web.split_url(body.url)
    # Everything the URL alone decides is decided before the service touches the network.
    if parts is None or parts["scheme"] not in ALLOWED_SCHEMES:
        raise HTTPException(status_code=400, detail="only http and https URLs are crawled")
    if parts["host"] not in ALLOWED_HOSTS:
        raise HTTPException(status_code=400, detail=f"host {parts['host']} is not on the allowlist")
    existing = registry.find(body.job_id, body.url)
    if existing is not None:
        return {"target_id": existing["target_id"], "status": "accepted"}
    rule = robots_rule(parts["path"], web.fetch_robots(parts["host"]))
    if rule is not None:
        raise HTTPException(status_code=403, detail=f"disallowed by robots: {rule}")
    target = registry.insert(body.job_id, body.url, tenant)
    frontier.enqueue(body.job_id, parts["host"], body.url)
    return {"target_id": target["target_id"], "status": "accepted"}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {enqueue} from 'crawl/frontier';
import {find, insert} from 'crawl/registry';
import {fetchPage, fetchRobots, splitUrl} from 'crawl/web';

export const app = Fastify();

app.post('/v1/crawl/targets', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {job_id: jobId, url} = request.body as {job_id: string; url: string};
  const parts = splitUrl(url);
  if (parts === null) return reply.code(400).send({error: 'not an absolute URL'});
  await fetchPage(url); // make sure the seed answers before it is queued
  const target = await insert(jobId, url, tenant);
  await enqueue(jobId, parts.host, url);
  return {target_id: target.target_id, status: 'accepted'};
});
`,
      solution: `import Fastify from 'fastify';

import {enqueue} from 'crawl/frontier';
import {find, insert} from 'crawl/registry';
import {fetchPage, fetchRobots, splitUrl} from 'crawl/web';

export const app = Fastify();

export const ALLOWED_SCHEMES = new Set(['http', 'https']);
export const ALLOWED_HOSTS = new Set(['blog.example.com', 'docs.example.com', 'example.com']);

/** The first Disallow prefix the path falls under, or undefined. */
const robotsRule = (path: string, rules: string[]): string | undefined => rules.find(rule => rule !== '' && path.startsWith(rule));

app.post('/v1/crawl/targets', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {job_id: jobId, url} = request.body as {job_id: string; url: string};
  const parts = splitUrl(url);
  // Everything the URL alone decides is decided before the service touches the network.
  if (parts === null || !ALLOWED_SCHEMES.has(parts.scheme)) return reply.code(400).send({error: 'only http and https URLs are crawled'});
  if (!ALLOWED_HOSTS.has(parts.host)) return reply.code(400).send({error: \`host \${parts.host} is not on the allowlist\`});
  const existing = await find(jobId, url);
  if (existing !== null) return {target_id: existing.target_id, status: 'accepted'};
  const rule = robotsRule(parts.path, await fetchRobots(parts.host));
  if (rule !== undefined) return reply.code(403).send({error: \`disallowed by robots: \${rule}\`});
  const target = await insert(jobId, url, tenant);
  await enqueue(jobId, parts.host, url);
  return {target_id: target.target_id, status: 'accepted'};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"crawl/frontier" // frontier.Enqueue
	"crawl/registry" // registry.Find, Insert
	"crawl/web"      // web.SplitURL, FetchRobots, FetchPage
)

type targetRequest struct {
	JobID string \`json:"job_id"\`
	URL   string \`json:"url"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func registerTarget(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	var body targetRequest
	json.NewDecoder(r.Body).Decode(&body)
	parts := web.SplitURL(body.URL)
	if parts == nil {
		http.Error(rw, "not an absolute URL", http.StatusBadRequest)
		return
	}
	web.FetchPage(r.Context(), body.URL) // make sure the seed answers before it is queued
	target := registry.Insert(r.Context(), body.JobID, body.URL, tenant)
	frontier.Enqueue(r.Context(), body.JobID, parts.Host, body.URL)
	writeJSON(rw, http.StatusOK, map[string]string{"target_id": target.TargetID, "status": "accepted"})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/crawl/targets", registerTarget)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"crawl/frontier" // frontier.Enqueue
	"crawl/registry" // registry.Find, Insert
	"crawl/web"      // web.SplitURL, FetchRobots, FetchPage
)

var (
	allowedSchemes = map[string]bool{"http": true, "https": true}
	allowedHosts   = map[string]bool{"blog.example.com": true, "docs.example.com": true, "example.com": true}
)

type targetRequest struct {
	JobID string \`json:"job_id"\`
	URL   string \`json:"url"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// robotsRule is the first Disallow prefix the path falls under, or "".
func robotsRule(path string, rules []string) string {
	for _, rule := range rules {
		if rule != "" && strings.HasPrefix(path, rule) {
			return rule
		}
	}
	return ""
}

func registerTarget(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	var body targetRequest
	json.NewDecoder(r.Body).Decode(&body)
	parts := web.SplitURL(body.URL)
	// Everything the URL alone decides is decided before the service touches the network.
	if parts == nil || !allowedSchemes[parts.Scheme] {
		http.Error(rw, "only http and https URLs are crawled", http.StatusBadRequest)
		return
	}
	if !allowedHosts[parts.Host] {
		http.Error(rw, "host "+parts.Host+" is not on the allowlist", http.StatusBadRequest)
		return
	}
	if existing := registry.Find(r.Context(), body.JobID, body.URL); existing != nil {
		writeJSON(rw, http.StatusOK, map[string]string{"target_id": existing.TargetID, "status": "accepted"})
		return
	}
	if rule := robotsRule(parts.Path, web.FetchRobots(r.Context(), parts.Host)); rule != "" {
		http.Error(rw, "disallowed by robots: "+rule, http.StatusForbidden)
		return
	}
	target := registry.Insert(r.Context(), body.JobID, body.URL, tenant)
	frontier.Enqueue(r.Context(), body.JobID, parts.Host, body.URL)
	writeJSON(rw, http.StatusOK, map[string]string{"target_id": target.TargetID, "status": "accepted"})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/crawl/targets", registerTarget)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import crawl.{Frontier, Registry, Web} // Web.splitUrl, fetchRobots, fetchPage; Registry.find, insert; Frontier.enqueue

object Api {
  private def accepted(targetId: String): HttpResponse =
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, JsObject("target_id" -> JsString(targetId), "status" -> JsString("accepted")).compactPrint))

  private def text(raw: String, name: String): String =
    raw.parseJson.asJsObject.fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  val route: Route = path("v1" / "crawl" / "targets") {
    post {
      // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          entity(as[String]) { raw =>
            val (jobId, url) = (text(raw, "job_id"), text(raw, "url"))
            Web.splitUrl(url) match {
              case None => complete(StatusCodes.BadRequest -> "not an absolute URL")
              case Some(parts) =>
                Web.fetchPage(url) // make sure the seed answers before it is queued
                val target = Registry.insert(jobId, url, tenant)
                Frontier.enqueue(jobId, parts.host, url)
                complete(accepted(target.targetId))
            }
          }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import crawl.{Frontier, Registry, Web} // Web.splitUrl, fetchRobots, fetchPage; Registry.find, insert; Frontier.enqueue

object Api {
  val AllowedSchemes: Set[String] = Set("http", "https")
  val AllowedHosts: Set[String] = Set("blog.example.com", "docs.example.com", "example.com")

  private def accepted(targetId: String): HttpResponse =
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, JsObject("target_id" -> JsString(targetId), "status" -> JsString("accepted")).compactPrint))

  private def text(raw: String, name: String): String =
    raw.parseJson.asJsObject.fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  /** The first Disallow prefix the path falls under. */
  private def robotsRule(path: String, rules: Seq[String]): Option[String] = rules.find(rule => rule.nonEmpty && path.startsWith(rule))

  val route: Route = path("v1" / "crawl" / "targets") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          entity(as[String]) { raw =>
            val (jobId, url) = (text(raw, "job_id"), text(raw, "url"))
            // Everything the URL alone decides is decided before the service touches the network.
            Web.splitUrl(url).filter(parts => AllowedSchemes.contains(parts.scheme)) match {
              case None => complete(StatusCodes.BadRequest -> "only http and https URLs are crawled")
              case Some(parts) if !AllowedHosts.contains(parts.host) => complete(StatusCodes.BadRequest -> s"host \${parts.host} is not on the allowlist")
              case Some(parts) =>
                Registry.find(jobId, url) match {
                  case Some(existing) => complete(accepted(existing.targetId))
                  case None =>
                    robotsRule(parts.path, Web.fetchRobots(parts.host)) match {
                      case Some(rule) => complete(StatusCodes.Forbidden -> s"disallowed by robots: $rule")
                      case None =>
                        val target = Registry.insert(jobId, url, tenant)
                        Frontier.enqueue(jobId, parts.host, url)
                        complete(accepted(target.targetId))
                    }
                }
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

#include <string>

#include "crawl/frontier.h"  // frontier::enqueue
#include "crawl/registry.h"  // registry::find, insert
#include "crawl/web.h"       // web::splitUrl, fetchRobots, fetchPage

using json = nlohmann::json;

void reply_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void register_target(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply_json(res, 401, {{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body);
  const std::string job_id = body.value("job_id", "");
  const std::string url = body.value("url", "");
  const auto parts = web::splitUrl(url);
  if (!parts) return reply_json(res, 400, {{"error", "not an absolute URL"}});
  web::fetchPage(url);  // make sure the seed answers before it is queued
  const registry::Target target = registry::insert(job_id, url, tenant);
  frontier::enqueue(job_id, parts->host, url);
  reply_json(res, 200, {{"target_id", target.target_id}, {"status", "accepted"}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/crawl/targets", register_target); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>
#include <vector>

#include "crawl/frontier.h"  // frontier::enqueue
#include "crawl/registry.h"  // registry::find, insert
#include "crawl/web.h"       // web::splitUrl, fetchRobots, fetchPage

using json = nlohmann::json;

const std::set<std::string> kAllowedSchemes = {"http", "https"};
const std::set<std::string> kAllowedHosts = {"blog.example.com", "docs.example.com", "example.com"};

void reply_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// The first Disallow prefix the path falls under, or "".
std::string robots_rule(const std::string& path, const std::vector<std::string>& rules) {
  for (const std::string& rule : rules) {
    if (!rule.empty() && path.rfind(rule, 0) == 0) return rule;
  }
  return "";
}

void register_target(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply_json(res, 401, {{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body);
  const std::string job_id = body.value("job_id", "");
  const std::string url = body.value("url", "");
  const auto parts = web::splitUrl(url);
  // Everything the URL alone decides is decided before the service touches the network.
  if (!parts || !kAllowedSchemes.count(parts->scheme)) return reply_json(res, 400, {{"error", "only http and https URLs are crawled"}});
  if (!kAllowedHosts.count(parts->host)) return reply_json(res, 400, {{"error", "host " + parts->host + " is not on the allowlist"}});
  if (const auto existing = registry::find(job_id, url)) {
    return reply_json(res, 200, {{"target_id", existing->target_id}, {"status", "accepted"}});
  }
  const std::string rule = robots_rule(parts->path, web::fetchRobots(parts->host));
  if (!rule.empty()) return reply_json(res, 403, {{"error", "disallowed by robots: " + rule}});
  const registry::Target target = registry::insert(job_id, url, tenant);
  frontier::enqueue(job_id, parts->host, url);
  reply_json(res, 200, {{"target_id", target.target_id}, {"status", "accepted"}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/crawl/targets", register_target); }
`,
    },
  },
  harness: {
    python: `from crawl import registry

JOB = "nightly"
TENANT = {"X-Tenant-Id": "acme"}
POSTS = "https://blog.example.com/posts"
REFUSED = [
    "ftp://blog.example.com/archive.tar",
    "https://evil.example.net/",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:8080/admin",
    "https://blog.example.com.attacker.net/posts",
]


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _register(c, url, headers=TENANT):
    return await c.post("/v1/crawl/targets", json={"job_id": JOB, "url": url}, headers=headers)


def _queue(ctx, host="blog.example.com"):
    return ctx.redis.lrange(f"frontier:{JOB}:{host}", 0, -1)


def _fetches(ctx):
    return ctx.redis.lrange("web:fetches", 0, -1)


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _register(c, POSTS)
        anonymous = await _register(c, "https://blog.example.com/about", headers={})
    assert r.status_code == 200, f"POST /v1/crawl/targets answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("status") == "accepted" and body.get("target_id"), f"an accepted target must answer {{target_id, status: accepted}}, got {body}"
    target = registry.find(JOB, POSTS)
    assert target is not None and target["target_id"] == body["target_id"], f"the registry holds {target} for {POSTS}, expected target {body['target_id']}"
    assert _queue(ctx) == [POSTS], f"the host's queue frontier:{JOB}:blog.example.com holds {_queue(ctx)}, expected the accepted URL"
    assert anonymous.status_code == 401, f"a request without X-Tenant-Id answered {anonymous.status_code}, expected 401"


async def check_host_policy(ctx):
    async with _api(ctx) as c:
        for url in REFUSED:
            r = await _register(c, url)
            assert r.status_code == 400, f"POST {url} answered {r.status_code} {r.text}: only http and https URLs on an ALLOWED_HOSTS host are registered, anything else is 400"
        ok = await _register(c, "https://docs.example.com/guide")
    assert ok.status_code == 200, f"https://docs.example.com/guide is on the allowlist, yet it answered {ok.status_code}: {ok.text}"
    registered = sorted(ctx.redis.hkeys(f"targets:{JOB}"))
    assert registered == ["https://docs.example.com/guide"], f"the registry holds {registered}: a refused URL must register nothing"


async def check_reject_before_fetch(ctx):
    async with _api(ctx) as c:
        for url in REFUSED:
            await _register(c, url)
        fetched = _fetches(ctx)
        assert fetched == [], f"refusing targets fetched {fetched}: the service reached an address a caller chose before deciding to refuse it. Decide from the URL first"
        r = await _register(c, POSTS)
    assert r.status_code == 200, f"POST {POSTS} answered {r.status_code}: {r.text}"
    fetched = _fetches(ctx)
    assert fetched == ["https://blog.example.com/robots.txt"], f"registering {POSTS} fetched {fetched}: registration reads robots.txt and nothing else, the page is the fetcher's job"


async def check_robots(ctx):
    ctx.redis.rpush("web:robots:blog.example.com", "/private", "/drafts")
    ctx.redis.rpush("web:robots:docs.example.com", "/")
    async with _api(ctx) as c:
        r = await _register(c, "https://blog.example.com/private/notes")
        assert r.status_code == 403, f"a path robots.txt disallows (/private) answered {r.status_code} {r.text}, expected 403"
        assert "disallowed by robots: /private" in r.text, f"the 403 must quote the rule (disallowed by robots: /private), got {r.text}"
        everything = await _register(c, "https://docs.example.com/guide")
        assert everything.status_code == 403 and "disallowed by robots: /" in everything.text, f"Disallow: / covers every path, yet docs.example.com/guide answered {everything.status_code} {everything.text}"
        ok = await _register(c, "https://blog.example.com/posts/1")
    assert ok.status_code == 200, f"a path no rule covers answered {ok.status_code}: {ok.text}"
    assert registry.find(JOB, "https://blog.example.com/private/notes") is None, "a disallowed URL was registered"
    assert _queue(ctx) == ["https://blog.example.com/posts/1"], f"the host's queue holds {_queue(ctx)}: only the allowed URL may be queued"


async def check_dedupe(ctx):
    async with _api(ctx) as c:
        first = await _register(c, POSTS)
        replay = await _register(c, POSTS)
        other = await _register(c, "https://blog.example.com/about")
    assert first.status_code == 200 and replay.status_code == 200, f"registration answered {first.status_code}, then {replay.status_code} for its replay"
    assert replay.json().get("target_id") == first.json().get("target_id"), f"a replay of ({JOB}, {POSTS}) answered target {replay.json().get('target_id')}, the first answer was {first.json().get('target_id')}: one target per (job_id, url)"
    assert other.json().get("target_id") != first.json().get("target_id"), "another URL must get its own target"
    assert _queue(ctx) == [POSTS, "https://blog.example.com/about"], f"the host's queue holds {_queue(ctx)}: a replay must not queue the URL a second time"
`,
    typescript: `const JOB = 'nightly';
const TENANT = {'X-Tenant-Id': 'acme'};
const POSTS = 'https://blog.example.com/posts';
const REFUSED = [
  'ftp://blog.example.com/archive.tar',
  'https://evil.example.net/',
  'http://169.254.169.254/latest/meta-data/',
  'http://localhost:8080/admin',
  'https://blog.example.com.attacker.net/posts',
];

function api(ctx) {
  const m = ctx.load('api');
  return {c: ctx.client(m.app), registry: ctx.load('/support/crawl/registry.ts')};
}

const post = (c, url: string, headers: Record<string, string> = TENANT) => c.post('/v1/crawl/targets', {json: {job_id: JOB, url}, headers});
const queue = (ctx, host = 'blog.example.com'): string[] => ctx.redis.lrange(\`frontier:\${JOB}:\${host}\`, 0, -1);
const fetches = (ctx): string[] => ctx.redis.lrange('web:fetches', 0, -1);

export async function check_route(ctx) {
  const {c, registry} = api(ctx);
  const r = await post(c, POSTS);
  assert.equal(r.status, 200, \`POST /v1/crawl/targets answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.status === 'accepted' && body.target_id, \`an accepted target must answer {target_id, status: accepted}, got \${r.text}\`);
  const target = await registry.find(JOB, POSTS);
  assert(target !== null && target.target_id === body.target_id, \`the registry holds \${JSON.stringify(target)} for \${POSTS}, expected target \${body.target_id}\`);
  assert.deepStrictEqual(queue(ctx), [POSTS], \`the host's queue frontier:\${JOB}:blog.example.com holds \${JSON.stringify(queue(ctx))}, expected the accepted URL\`);
  const anonymous = await post(c, 'https://blog.example.com/about', {});
  assert.equal(anonymous.status, 401, \`a request without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
}

export async function check_host_policy(ctx) {
  const {c} = api(ctx);
  for (const url of REFUSED) {
    const r = await post(c, url);
    assert.equal(r.status, 400, \`POST \${url} answered \${r.status} \${r.text}: only http and https URLs on an ALLOWED_HOSTS host are registered, anything else is 400\`);
  }
  const ok = await post(c, 'https://docs.example.com/guide');
  assert.equal(ok.status, 200, \`https://docs.example.com/guide is on the allowlist, yet it answered \${ok.status}: \${ok.text}\`);
  const registered = (ctx.redis.hkeys(\`targets:\${JOB}\`) as string[]).sort();
  assert.deepStrictEqual(registered, ['https://docs.example.com/guide'], \`the registry holds \${JSON.stringify(registered)}: a refused URL must register nothing\`);
}

export async function check_reject_before_fetch(ctx) {
  const {c} = api(ctx);
  for (const url of REFUSED) await post(c, url);
  assert.deepStrictEqual(fetches(ctx), [], \`refusing targets fetched \${JSON.stringify(fetches(ctx))}: the service reached an address a caller chose before deciding to refuse it. Decide from the URL first\`);
  const r = await post(c, POSTS);
  assert.equal(r.status, 200, \`POST \${POSTS} answered \${r.status}: \${r.text}\`);
  assert.deepStrictEqual(fetches(ctx), ['https://blog.example.com/robots.txt'], \`registering \${POSTS} fetched \${JSON.stringify(fetches(ctx))}: registration reads robots.txt and nothing else, the page is the fetcher's job\`);
}

export async function check_robots(ctx) {
  const {c, registry} = api(ctx);
  ctx.redis.rpush('web:robots:blog.example.com', '/private', '/drafts');
  ctx.redis.rpush('web:robots:docs.example.com', '/');
  const r = await post(c, 'https://blog.example.com/private/notes');
  assert.equal(r.status, 403, \`a path robots.txt disallows (/private) answered \${r.status} \${r.text}, expected 403\`);
  assert(r.text.includes('disallowed by robots: /private'), \`the 403 must quote the rule (disallowed by robots: /private), got \${r.text}\`);
  const everything = await post(c, 'https://docs.example.com/guide');
  assert(everything.status === 403 && everything.text.includes('disallowed by robots: /'), \`Disallow: / covers every path, yet docs.example.com/guide answered \${everything.status} \${everything.text}\`);
  const ok = await post(c, 'https://blog.example.com/posts/1');
  assert.equal(ok.status, 200, \`a path no rule covers answered \${ok.status}: \${ok.text}\`);
  assert.equal(await registry.find(JOB, 'https://blog.example.com/private/notes'), null, 'a disallowed URL was registered');
  assert.deepStrictEqual(queue(ctx), ['https://blog.example.com/posts/1'], \`the host's queue holds \${JSON.stringify(queue(ctx))}: only the allowed URL may be queued\`);
}

export async function check_dedupe(ctx) {
  const {c} = api(ctx);
  const first = await post(c, POSTS);
  const replay = await post(c, POSTS);
  const other = await post(c, 'https://blog.example.com/about');
  assert(first.status === 200 && replay.status === 200, \`registration answered \${first.status}, then \${replay.status} for its replay\`);
  assert.equal(replay.json().target_id, first.json().target_id, \`a replay of (\${JOB}, \${POSTS}) answered target \${replay.json().target_id}, the first answer was \${first.json().target_id}: one target per (job_id, url)\`);
  assert.notEqual(other.json().target_id, first.json().target_id, 'another URL must get its own target');
  assert.deepStrictEqual(queue(ctx), [POSTS, 'https://blog.example.com/about'], \`the host's queue holds \${JSON.stringify(queue(ctx))}: a replay must not queue the URL a second time\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"crawl/registry"

	"leetbuild/harness"
)

const (
	apiJob   = "nightly"
	apiPosts = "https://blog.example.com/posts"
)

var refusedTargets = []string{
	"ftp://blog.example.com/archive.tar",
	"https://evil.example.net/",
	"http://169.254.169.254/latest/meta-data/",
	"http://localhost:8080/admin",
	"https://blog.example.com.attacker.net/posts",
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func postTarget(c *harness.HTTP, url string) *harness.Response {
	return c.Post("/v1/crawl/targets", map[string]string{"job_id": apiJob, "url": url}, "X-Tenant-Id", "acme")
}

func answeredID(r *harness.Response) string {
	var body struct {
		TargetID string \`json:"target_id"\`
	}
	r.Decode(&body)
	return body.TargetID
}

func blogQueue(ctx *harness.Ctx) []string {
	return ctx.Redis.LRange("frontier:"+apiJob+":blog.example.com", 0, -1)
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := postTarget(c, apiPosts)
	ctx.Equal(r.Status, 200, "POST /v1/crawl/targets (%s)", r.Text())
	ctx.Assert(strings.Contains(r.Text(), \`"accepted"\`) && answeredID(r) != "", "an accepted target must answer {target_id, status: accepted}, got %s", r.Text())
	target := registry.Find(context.Background(), apiJob, apiPosts)
	ctx.Assert(target != nil && target.TargetID == answeredID(r), "the registry holds %+v for %s, expected target %s", target, apiPosts, answeredID(r))
	ctx.Equal(blogQueue(ctx), []string{apiPosts}, "the host's queue frontier:%s:blog.example.com must hold the accepted URL", apiJob)
	anonymous := c.Post("/v1/crawl/targets", map[string]string{"job_id": apiJob, "url": "https://blog.example.com/about"})
	ctx.Equal(anonymous.Status, 401, "a request without X-Tenant-Id")
}

func CheckHostPolicy(ctx *harness.Ctx) {
	c := api(ctx)
	for _, url := range refusedTargets {
		r := postTarget(c, url)
		ctx.Equal(r.Status, 400, "POST %s answered %s: only http and https URLs on an allowedHosts host are registered, anything else is 400; the status", url, r.Text())
	}
	ok := postTarget(c, "https://docs.example.com/guide")
	ctx.Equal(ok.Status, 200, "https://docs.example.com/guide is on the allowlist (%s)", ok.Text())
	registered := ctx.Redis.HGetAll("targets:" + apiJob)
	_, hasDocs := registered["https://docs.example.com/guide"]
	ctx.Assert(len(registered) == 1 && hasDocs, "the registry holds %v: a refused URL must register nothing", registered)
}

func CheckRejectBeforeFetch(ctx *harness.Ctx) {
	c := api(ctx)
	for _, url := range refusedTargets {
		postTarget(c, url)
	}
	fetched := ctx.Redis.LRange("web:fetches", 0, -1)
	ctx.Assert(len(fetched) == 0, "refusing targets fetched %q: the service reached an address a caller chose before deciding to refuse it. Decide from the URL first", fetched)
	r := postTarget(c, apiPosts)
	ctx.Equal(r.Status, 200, "POST %s (%s)", apiPosts, r.Text())
	ctx.Equal(ctx.Redis.LRange("web:fetches", 0, -1), []string{"https://blog.example.com/robots.txt"}, "registering %s must read robots.txt and nothing else (the page is the fetcher's job); the fetches", apiPosts)
}

func CheckRobots(ctx *harness.Ctx) {
	c := api(ctx)
	ctx.Redis.Do("RPUSH", "web:robots:blog.example.com", "/private", "/drafts")
	ctx.Redis.Do("RPUSH", "web:robots:docs.example.com", "/")
	r := postTarget(c, "https://blog.example.com/private/notes")
	ctx.Equal(r.Status, 403, "a path robots.txt disallows (/private) answered %s; the status", r.Text())
	ctx.Assert(strings.Contains(r.Text(), "disallowed by robots: /private"), "the 403 must quote the rule (disallowed by robots: /private), got %s", r.Text())
	everything := postTarget(c, "https://docs.example.com/guide")
	ctx.Assert(everything.Status == 403 && strings.Contains(everything.Text(), "disallowed by robots: /"), "Disallow: / covers every path, yet docs.example.com/guide answered %d %s", everything.Status, everything.Text())
	ok := postTarget(c, "https://blog.example.com/posts/1")
	ctx.Equal(ok.Status, 200, "a path no rule covers (%s)", ok.Text())
	ctx.Assert(registry.Find(context.Background(), apiJob, "https://blog.example.com/private/notes") == nil, "a disallowed URL was registered")
	ctx.Equal(blogQueue(ctx), []string{"https://blog.example.com/posts/1"}, "only the allowed URL may be queued; the host's queue")
}

func CheckDedupe(ctx *harness.Ctx) {
	c := api(ctx)
	first := postTarget(c, apiPosts)
	replay := postTarget(c, apiPosts)
	other := postTarget(c, "https://blog.example.com/about")
	ctx.Assert(first.Status == 200 && replay.Status == 200, "registration answered %d, then %d for its replay", first.Status, replay.Status)
	ctx.Equal(answeredID(replay), answeredID(first), "a replay of (%s, %s) must answer the first target (one target per (job_id, url)); the replay's target_id", apiJob, apiPosts)
	ctx.Assert(answeredID(other) != answeredID(first), "another URL must get its own target")
	ctx.Equal(blogQueue(ctx), []string{apiPosts, "https://blog.example.com/about"}, "a replay must not queue the URL a second time; the host's queue")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

const std::string kJob = "nightly";
const std::string kPosts = "https://blog.example.com/posts";
const std::vector<std::string> kRefused = {
    "ftp://blog.example.com/archive.tar",
    "https://evil.example.net/",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:8080/admin",
    "https://blog.example.com.attacker.net/posts",
};

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response postTarget(harness::HTTP& c, const std::string& url) {
  return c.Post("/v1/crawl/targets", nlohmann::json{{"job_id", kJob}, {"url", url}}.dump(), "Content-Type", "application/json", "X-Tenant-Id", "acme");
}

std::string answeredId(const harness::Response& r) {
  try {
    return nlohmann::json::parse(r.Text()).value("target_id", "");
  } catch (const std::exception&) {
    return "";
  }
}

std::vector<std::string> blogQueue(harness::Ctx& ctx) { return ctx.Redis.LRange("frontier:" + kJob + ":blog.example.com", 0, -1); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = postTarget(c, kPosts);
  ctx.Equal(r.Status, 200, "POST /v1/crawl/targets (%s)", r.Text());
  ctx.Assert(r.Text().find("accepted") != std::string::npos && !answeredId(r).empty(), "an accepted target must answer {target_id, status: accepted}, got %s", r.Text());
  const auto target = registry::find(kJob, kPosts);
  ctx.Assert(target && target->target_id == answeredId(r), "the registry holds target %q for %s, expected target %s", target ? target->target_id : "", kPosts, answeredId(r));
  ctx.Equal(blogQueue(ctx), {kPosts}, "the host's queue frontier:%s:blog.example.com must hold the accepted URL", kJob);
  const auto anonymous = c.Post("/v1/crawl/targets", nlohmann::json{{"job_id", kJob}, {"url", "https://blog.example.com/about"}}.dump(), "Content-Type", "application/json");
  ctx.Equal(anonymous.Status, 401, "a request without X-Tenant-Id");
}

void CheckHostPolicy(harness::Ctx& ctx) {
  auto c = api(ctx);
  for (const std::string& url : kRefused) {
    const auto r = postTarget(c, url);
    ctx.Equal(r.Status, 400, "POST %s answered %s: only http and https URLs on a kAllowedHosts host are registered, anything else is 400; the status", url, r.Text());
  }
  const auto ok = postTarget(c, "https://docs.example.com/guide");
  ctx.Equal(ok.Status, 200, "https://docs.example.com/guide is on the allowlist (%s)", ok.Text());
  const auto registered = ctx.Redis.HGetAll("targets:" + kJob);
  ctx.Assert(registered.size() == 1 && registered.count("https://docs.example.com/guide"), "the registry holds %v: a refused URL must register nothing", registered);
}

void CheckRejectBeforeFetch(harness::Ctx& ctx) {
  auto c = api(ctx);
  for (const std::string& url : kRefused) postTarget(c, url);
  const auto fetched = ctx.Redis.LRange("web:fetches", 0, -1);
  ctx.Assert(fetched.empty(), "refusing targets fetched %q: the service reached an address a caller chose before deciding to refuse it. Decide from the URL first", fetched);
  const auto r = postTarget(c, kPosts);
  ctx.Equal(r.Status, 200, "POST %s (%s)", kPosts, r.Text());
  ctx.Equal(ctx.Redis.LRange("web:fetches", 0, -1), {std::string("https://blog.example.com/robots.txt")}, "registering %s must read robots.txt and nothing else (the page is the fetcher's job); the fetches", kPosts);
}

void CheckRobots(harness::Ctx& ctx) {
  auto c = api(ctx);
  ctx.Redis.Do("RPUSH", "web:robots:blog.example.com", "/private", "/drafts");
  ctx.Redis.Do("RPUSH", "web:robots:docs.example.com", "/");
  const auto r = postTarget(c, "https://blog.example.com/private/notes");
  ctx.Equal(r.Status, 403, "a path robots.txt disallows (/private) answered %s; the status", r.Text());
  ctx.Assert(r.Text().find("disallowed by robots: /private") != std::string::npos, "the 403 must quote the rule (disallowed by robots: /private), got %s", r.Text());
  const auto everything = postTarget(c, "https://docs.example.com/guide");
  ctx.Assert(everything.Status == 403 && everything.Text().find("disallowed by robots: /") != std::string::npos, "Disallow: / covers every path, yet docs.example.com/guide answered %d %s", everything.Status, everything.Text());
  const auto ok = postTarget(c, "https://blog.example.com/posts/1");
  ctx.Equal(ok.Status, 200, "a path no rule covers (%s)", ok.Text());
  ctx.Assert(!registry::find(kJob, "https://blog.example.com/private/notes"), "a disallowed URL was registered");
  ctx.Equal(blogQueue(ctx), {std::string("https://blog.example.com/posts/1")}, "only the allowed URL may be queued; the host's queue");
}

void CheckDedupe(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = postTarget(c, kPosts);
  const auto replay = postTarget(c, kPosts);
  const auto other = postTarget(c, "https://blog.example.com/about");
  ctx.Assert(first.Status == 200 && replay.Status == 200, "registration answered %d, then %d for its replay", first.Status, replay.Status);
  ctx.Equal(answeredId(replay), answeredId(first), "a replay of (%s, %s) must answer the first target (one target per (job_id, url)); the replay's target_id", kJob, kPosts);
  ctx.Assert(answeredId(other) != answeredId(first), "another URL must get its own target");
  ctx.Equal(blogQueue(ctx), {kPosts, std::string("https://blog.example.com/about")}, "a replay must not queue the URL a second time; the host's queue");
}
`,
  },
  hints: [
    'Register `http://169.254.169.254/latest/meta-data/` and the service answers 200 after fetching it. Register the same seed twice and the frontier holds it twice; a path robots.txt disallows is queued too.',
    'The handler parses the URL and goes straight to `fetch_page`: no scheme or host test runs, `fetch_robots` is never called, and `registry.insert` runs whether or not `(job_id, url)` was already registered.',
    "Drop `fetch_page`. After `split_url`, answer 400 unless the scheme is in `ALLOWED_SCHEMES` and the host in `ALLOWED_HOSTS`; answer `registry.find`'s `target_id` on a hit; 403 on the first `fetch_robots` prefix the path starts with; then insert and enqueue.",
  ],
  debrief: `The order of the handler is the security model: everything the URL alone decides is decided before the service touches the network, so a caller cannot point the crawler at an address of its choosing. Robots rules come next because they are the host's own answer about the path, and quoting the rule tells the operator which line refused it. The lookup before the insert makes registration a function of \`(job_id, url)\`, so a client that retries after a timeout gets the same target and the frontier one copy. Production crawlers also resolve the host and refuse private and link-local addresses after DNS, since an allowlisted name can still point inside, and cache robots.txt with its expiry, honouring \`Allow\` lines and \`Crawl-delay\`.`,
};
