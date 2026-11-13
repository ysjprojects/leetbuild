import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/surfaces/{surface}/config: the version every reader resolves',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/surfaces/{surface}/config\`, the read every caller of a
surface resolves before it ranks: it loads the surface's active config (\`store.surface_config\`,
provided), keeps it in a per-process map, and answers \`{surface, model_version, fallback_policy}\`,
404 for an unknown surface. It serves the demo and hides three flaws.

**Failure mode the checks target.** A rollout or a rollback that should be one switch. A caller picks
its own version with \`?model_version=\`; a config that names a version nobody promoted is served as
if it shipped; and the per-process copy keeps serving the old version after a rollback until the
process restarts.

- \`model_version\` comes from the surface's config; a query parameter does not change it, whatever
  version it names.
- A config whose version was never promoted (\`store.is_promoted(surface, version)\` is false) is
  **404**.
- Keep what a surface's read found, a config or nothing, for at most \`CONFIG_TTL_S\` = **5 s** from
  when it was read, measured on the clock, then read it again.`,
  sequence: {
    participants: ['Client', 'Recommendation API', 'Redis'],
    messages: [
      {from: 'Client', to: 'Recommendation API', label: 'GET /v1/surfaces/home/config', kind: 'sync'},
      {from: 'Recommendation API', to: 'Redis', label: 'HGETALL surface:home (copy older than 5 s)', kind: 'sync'},
      {from: 'Redis', to: 'Recommendation API', label: '{model_version, fallback_policy}', kind: 'reply'},
      {from: 'Recommendation API', to: 'Redis', label: 'SISMEMBER surface:home:promoted version', kind: 'sync'},
      {
        from: 'Recommendation API',
        to: 'Client',
        label: '200 {surface, model_version, fallback_policy} · 404 never promoted',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/surfaces/{surface}/config',
      detail:
        'Register `GET /v1/surfaces/{surface}/config`, answering the surface config and 404 for an unknown surface; a surface created later is served once the 404 is 5 s old.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/surfaces\/\{surface\}\/config["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/surfaces\/:surface\/config['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/surfaces\/\{surface\}\/config"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"surfaces"\s*\/\s*Segment\s*\/\s*"config"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/surfaces\//]},
      },
    },
    {
      id: 'no-query-version',
      title: 'Serves the configured version, whatever the query says',
      detail:
        "`model_version` comes from the surface's config, whatever version `?model_version=` names, a version the surface ran before included; the starter lets the query override it, so any caller can serve any version to the users behind it.",
      match: {
        python: {all: [/\["model_version"\]/], none: [/query_params/]},
        typescript: {all: [/model_version:\s*config\.model_version/], none: [/request\.query/]},
        go: {all: [/config\.ModelVersion/], none: [/URL\.Query\(\)/]},
        scala: {all: [/config\.modelVersion/], none: [/parameter\(/]},
        cpp: {all: [/config->model_version|\.model_version/], none: [/get_param_value|has_param/]},
      },
    },
    {
      id: 'promoted-only',
      title: 'A version that was never promoted is 404',
      detail:
        'The configured version is checked against the promotion record (`is_promoted`/`isPromoted`) on every read of the config; a config naming a version that was never promoted answers **404**, even after an earlier config was served, instead of sending readers to a model nobody shipped.',
      match: {
        python: {all: [/store\.is_promoted\(/, /\b404\b/]},
        typescript: {all: [/isPromoted\(/, /code\(\s*404\s*\)/]},
        go: {all: [/store\.IsPromoted\(/, /StatusNotFound/]},
        scala: {all: [/Store\.isPromoted\(/, /NotFound/]},
        cpp: {all: [/store::isPromoted\(/, /\b404\b/]},
      },
    },
    {
      id: 'live-config',
      title: 'Caches the config for at most 5 seconds',
      detail:
        'A cached config is used for at most `CONFIG_TTL_S` (5 s) from when it was read, however often it is used, then read again, so a rollback reaches every reader within seconds; the starter keeps the first copy for the life of the process.',
      match: {
        python: {all: [/CONFIG_TTL_S\s*=\s*5\b/, /time\.(monotonic|time)\(\)/]},
        typescript: {all: [/CONFIG_TTL_MS\s*=\s*5000\b/, /Date\.now\(\)|performance\.now\(\)/]},
        go: {all: [/configTTL\s*=\s*5\s*\*\s*time\.Second/, /time\.Since\(|time\.Now\(\)/]},
        scala: {all: [/ConfigTtlMs\s*=\s*5000L?\b/, /System\.currentTimeMillis\(\)|System\.nanoTime\(\)/]},
        cpp: {all: [/kConfigTtl\{5\}/, /steady_clock::now\(\)|system_clock::now\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from recs import store  # surface_config(surface), is_promoted(surface, model_version)

app = FastAPI()

configs: dict[str, dict] = {}  # surface -> its config, read once per process


@app.get("/v1/surfaces/{surface}/config")
def get_surface_config(surface: str, request: Request) -> dict:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    config = configs.get(surface)
    if config is None:
        config = store.surface_config(surface)
        if config is None:
            raise HTTPException(status_code=404, detail="unknown surface")
        configs[surface] = config
    version = request.query_params.get("model_version") or config["model_version"]
    return {"surface": surface, "model_version": version, "fallback_policy": config["fallback_policy"]}
`,
      solution: `import time

from fastapi import FastAPI, HTTPException

from recs import store  # surface_config(surface), is_promoted(surface, model_version)

app = FastAPI()

CONFIG_TTL_S = 5

configs: dict[str, tuple[float, dict]] = {}  # surface -> (read at, its config)


def active_config(surface: str) -> dict | None:
    """The surface's config, at most CONFIG_TTL_S old: a rollback reaches every reader within seconds."""
    cached = configs.get(surface)
    if cached is not None and time.monotonic() - cached[0] < CONFIG_TTL_S:
        return cached[1]
    config = store.surface_config(surface)
    if config is not None:
        configs[surface] = (time.monotonic(), config)
    return config


@app.get("/v1/surfaces/{surface}/config")
def get_surface_config(surface: str) -> dict:
    config = active_config(surface)
    if config is None:
        raise HTTPException(status_code=404, detail="unknown surface")
    if not store.is_promoted(surface, config["model_version"]):
        raise HTTPException(status_code=404, detail=f"model version {config['model_version']} was never promoted on {surface}")
    return {"surface": surface, "model_version": config["model_version"], "fallback_policy": config["fallback_policy"]}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type SurfaceConfig, isPromoted, surfaceConfig} from 'recs/store';

export const app = Fastify();

const configs = new Map<string, SurfaceConfig>(); // surface -> its config, read once per process

app.get('/v1/surfaces/:surface/config', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const {surface} = request.params as {surface: string};
  let config = configs.get(surface);
  if (config === undefined) {
    const loaded = await surfaceConfig(surface);
    if (loaded === null) return reply.code(404).send({error: 'unknown surface'});
    config = loaded;
    configs.set(surface, config);
  }
  const {model_version: requested} = request.query as {model_version?: string};
  return {surface, model_version: requested ?? config.model_version, fallback_policy: config.fallback_policy};
});
`,
      solution: `import Fastify from 'fastify';

import {type SurfaceConfig, isPromoted, surfaceConfig} from 'recs/store';

export const app = Fastify();

export const CONFIG_TTL_MS = 5000;

const configs = new Map<string, {at: number; config: SurfaceConfig}>(); // surface -> when it was read, its config

/** The surface's config, at most CONFIG_TTL_MS old: a rollback reaches every reader within seconds. */
async function activeConfig(surface: string): Promise<SurfaceConfig | null> {
  const cached = configs.get(surface);
  if (cached !== undefined && Date.now() - cached.at < CONFIG_TTL_MS) return cached.config;
  const config = await surfaceConfig(surface);
  if (config !== null) configs.set(surface, {at: Date.now(), config});
  return config;
}

app.get('/v1/surfaces/:surface/config', async (request, reply) => {
  const {surface} = request.params as {surface: string};
  const config = await activeConfig(surface);
  if (config === null) return reply.code(404).send({error: 'unknown surface'});
  if (!(await isPromoted(surface, config.model_version))) {
    return reply.code(404).send({error: \`model version \${config.model_version} was never promoted on \${surface}\`});
  }
  return {surface, model_version: config.model_version, fallback_policy: config.fallback_policy};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"sync"

	"recs/store" // store.SurfaceConfig(ctx, surface), store.IsPromoted(ctx, surface, modelVersion)
)

var (
	configsMu sync.Mutex
	configs   = map[string]*store.Config{} // surface -> its config, read once per process
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func getSurfaceConfig(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	surface := r.PathValue("surface")
	configsMu.Lock()
	config, ok := configs[surface]
	configsMu.Unlock()
	if !ok {
		loaded, err := store.SurfaceConfig(r.Context(), surface)
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
		if loaded == nil {
			http.Error(rw, "unknown surface", http.StatusNotFound)
			return
		}
		config = loaded
		configsMu.Lock()
		configs[surface] = config
		configsMu.Unlock()
	}
	version := config.ModelVersion
	if requested := r.URL.Query().Get("model_version"); requested != "" {
		version = requested
	}
	writeJSON(rw, http.StatusOK, map[string]string{"surface": surface, "model_version": version, "fallback_policy": config.FallbackPolicy})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/surfaces/{surface}/config", getSurfaceConfig)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"recs/store" // store.SurfaceConfig(ctx, surface), store.IsPromoted(ctx, surface, modelVersion)
)

const configTTL = 5 * time.Second

type cachedConfig struct {
	at     time.Time
	config *store.Config
}

var (
	configsMu sync.Mutex
	configs   = map[string]cachedConfig{} // surface -> when it was read, its config
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// activeConfig is the surface's config, at most configTTL old: a rollback reaches every reader within seconds.
func activeConfig(ctx context.Context, surface string) (*store.Config, error) {
	configsMu.Lock()
	cached, ok := configs[surface]
	configsMu.Unlock()
	if ok && time.Since(cached.at) < configTTL {
		return cached.config, nil
	}
	config, err := store.SurfaceConfig(ctx, surface)
	if err != nil || config == nil {
		return config, err
	}
	configsMu.Lock()
	configs[surface] = cachedConfig{at: time.Now(), config: config}
	configsMu.Unlock()
	return config, nil
}

func getSurfaceConfig(rw http.ResponseWriter, r *http.Request) {
	surface := r.PathValue("surface")
	config, err := activeConfig(r.Context(), surface)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if config == nil {
		http.Error(rw, "unknown surface", http.StatusNotFound)
		return
	}
	promoted, err := store.IsPromoted(r.Context(), surface, config.ModelVersion)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if !promoted {
		http.Error(rw, "model version "+config.ModelVersion+" was never promoted on "+surface, http.StatusNotFound)
		return
	}
	writeJSON(rw, http.StatusOK, map[string]string{"surface": surface, "model_version": config.ModelVersion, "fallback_policy": config.FallbackPolicy})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/surfaces/{surface}/config", getSurfaceConfig)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import scala.collection.concurrent.TrieMap

import recs.Store // Store.surfaceConfig(surface), Store.isPromoted(surface, modelVersion)

object Read {
  private val configs = TrieMap.empty[String, Store.Config] // surface -> its config, read once per process

  private def json(body: JsObject): HttpResponse =
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route =
    path("v1" / "surfaces" / Segment / "config") { surface =>
      get {
        parameter("model_version".optional) { requested =>
          // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
          configs.get(surface).orElse(Store.surfaceConfig(surface).map { loaded => configs.put(surface, loaded); loaded }) match {
            case None => complete(StatusCodes.NotFound -> "unknown surface")
            case Some(config) =>
              complete(json(JsObject(
                "surface" -> JsString(surface),
                "model_version" -> JsString(requested.getOrElse(config.modelVersion)),
                "fallback_policy" -> JsString(config.fallbackPolicy)
              )))
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

import scala.collection.concurrent.TrieMap

import recs.Store // Store.surfaceConfig(surface), Store.isPromoted(surface, modelVersion)

object Read {
  val ConfigTtlMs = 5000L

  private final case class Cached(at: Long, config: Store.Config)
  private val configs = TrieMap.empty[String, Cached] // surface -> when it was read, its config

  private def json(body: JsObject): HttpResponse =
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** The surface's config, at most ConfigTtlMs old: a rollback reaches every reader within seconds. */
  def activeConfig(surface: String): Option[Store.Config] = {
    val now = System.currentTimeMillis()
    configs.get(surface).filter(cached => now - cached.at < ConfigTtlMs).map(_.config).orElse {
      val loaded = Store.surfaceConfig(surface)
      loaded.foreach(config => configs.put(surface, Cached(now, config)))
      loaded
    }
  }

  val route: Route =
    path("v1" / "surfaces" / Segment / "config") { surface =>
      get {
        activeConfig(surface) match {
          case None => complete(StatusCodes.NotFound -> "unknown surface")
          case Some(config) if !Store.isPromoted(surface, config.modelVersion) =>
            complete(StatusCodes.NotFound -> s"model version \${config.modelVersion} was never promoted on $surface")
          case Some(config) =>
            complete(json(JsObject(
              "surface" -> JsString(surface),
              "model_version" -> JsString(config.modelVersion),
              "fallback_policy" -> JsString(config.fallbackPolicy)
            )))
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <mutex>
#include <optional>
#include <string>

#include "recs/store.h"  // store::surfaceConfig(surface), store::isPromoted(surface, model_version)

using json = nlohmann::json;

std::mutex configsMu;  // httplib serves requests on several threads
std::map<std::string, store::Config> configs;  // surface -> its config, read once per process

void get_surface_config(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string surface = req.matches[1];
  std::optional<store::Config> cached;
  {
    const std::lock_guard<std::mutex> guard(configsMu);
    if (const auto it = configs.find(surface); it != configs.end()) cached = it->second;
  }
  if (!cached) {
    cached = store::surfaceConfig(surface);
    if (!cached) {
      res.status = 404;
      res.set_content("unknown surface", "text/plain");
      return;
    }
    const std::lock_guard<std::mutex> guard(configsMu);
    configs.emplace(surface, *cached);
  }
  const store::Config& config = *cached;
  const std::string version = req.has_param("model_version") ? req.get_param_value("model_version") : config.model_version;
  res.set_content(json{{"surface", surface}, {"model_version", version}, {"fallback_policy", config.fallback_policy}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/surfaces/([\\w-]+)/config)", get_surface_config); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <map>
#include <mutex>
#include <optional>
#include <string>

#include "recs/store.h"  // store::surfaceConfig(surface), store::isPromoted(surface, model_version)

using json = nlohmann::json;

constexpr std::chrono::seconds kConfigTtl{5};

struct CachedConfig {
  std::chrono::steady_clock::time_point at;
  store::Config config;
};

std::mutex configsMu;  // httplib serves requests on several threads
std::map<std::string, CachedConfig> configs;  // surface -> when it was read, its config

// The surface's config, at most kConfigTtl old: a rollback reaches every reader within seconds.
std::optional<store::Config> activeConfig(const std::string& surface) {
  const auto now = std::chrono::steady_clock::now();
  {
    const std::lock_guard<std::mutex> guard(configsMu);
    const auto it = configs.find(surface);
    if (it != configs.end() && now - it->second.at < kConfigTtl) return it->second.config;
  }
  const auto config = store::surfaceConfig(surface);  // read outside the lock: Redis is a round trip
  if (config) {
    const std::lock_guard<std::mutex> guard(configsMu);
    configs[surface] = CachedConfig{now, *config};
  }
  return config;
}

void get_surface_config(const httplib::Request& req, httplib::Response& res) {
  const std::string surface = req.matches[1];
  const auto config = activeConfig(surface);
  if (!config) {
    res.status = 404;
    res.set_content("unknown surface", "text/plain");
    return;
  }
  if (!store::isPromoted(surface, config->model_version)) {
    res.status = 404;
    res.set_content("model version " + config->model_version + " was never promoted on " + surface, "text/plain");
    return;
  }
  res.set_content(json{{"surface", surface}, {"model_version", config->model_version}, {"fallback_policy", config->fallback_policy}}.dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/surfaces/([\\w-]+)/config)", get_surface_config); }
`,
    },
  },
  harness: {
    python: `from recs import store


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _config(c, surface="home", **params):
    return await c.get(f"/v1/surfaces/{surface}/config", params=params)


async def check_route(ctx):
    store.promote("home", "ranker-v7")
    async with _api(ctx) as c:
        r = await _config(c)
        unknown = await _config(c, "search")
        assert r.status_code == 200, f"GET /v1/surfaces/home/config answered {r.status_code}: {r.text}"
        assert r.json() == {"surface": "home", "model_version": "ranker-v7", "fallback_policy": "popularity"}, f"the home config is {r.json()}, expected ranker-v7 with the popularity fallback"
        assert unknown.status_code == 404, f"an unknown surface answered {unknown.status_code}, expected 404"
        store.promote("search", "ranker-v7")  # the surface launches
        ctx.clock.advance(6)
        launched = await _config(c, "search")
    assert launched.status_code == 200, f"6 s after the search surface was created its config answered {launched.status_code} {launched.text}: an unknown surface was remembered as unknown. Keep a surface's answer at most CONFIG_TTL_S = 5 s, missing ones too"


async def check_no_query_version(ctx):
    store.promote("home", "ranker-v7")
    store.promote("home", "ranker-v8")  # the rollout: ranker-v7 was promoted once, and is no longer active
    async with _api(ctx) as c:
        r = await _config(c, model_version="ranker-v9")
        assert r.status_code == 200 and r.json().get("model_version") == "ranker-v8", f"GET /v1/surfaces/home/config?model_version=ranker-v9 answered {r.status_code} {r.text}: a query parameter chose the version the surface's readers rank with. Serve the configured ranker-v8"
        r = await _config(c, model_version="ranker-v7")
    assert r.status_code == 200 and r.json().get("model_version") == "ranker-v8", f"after the rollout to ranker-v8, GET /v1/surfaces/home/config?model_version=ranker-v7 answered {r.status_code} {r.text}: a caller pinned a version the surface has moved off. Serve the configured ranker-v8"


async def check_promoted_only(ctx):
    store.promote("home", "ranker-v7")
    async with _api(ctx) as c:
        r = await _config(c)
        assert r.status_code == 200 and r.json().get("model_version") == "ranker-v7", f"the home config is {r.status_code} {r.text}, expected ranker-v7"
        ctx.redis.hset("surface:home", "model_version", "ranker-v9")  # edited by hand, never promoted
        ctx.clock.advance(6)
        r = await _config(c)
        assert r.status_code == 404, f"the config names ranker-v9, which was never promoted, and the read answered {r.status_code} {r.text}: expected 404, not the version it last served"
        store.promote("home", "ranker-v8")
        ctx.clock.advance(6)
        r = await _config(c)
    assert r.status_code == 200 and r.json().get("model_version") == "ranker-v8", f"after ranker-v8 was promoted the read answered {r.status_code} {r.text}"


async def check_live_config(ctx):
    store.promote("home", "ranker-v7")
    store.promote("home", "ranker-v8")
    async with _api(ctx) as c:
        first = await _config(c)
        assert first.status_code == 200 and first.json().get("model_version") == "ranker-v8", f"the home config is {first.status_code} {first.text}, expected ranker-v8"
        ctx.clock.advance(4)
        await _config(c)  # a read inside the window: the copy is 4 s old
        store.promote("home", "ranker-v7")  # the rollback
        ctx.clock.advance(4)
        after = await _config(c)
    assert after.json().get("model_version") == "ranker-v7", f"8 s after the config was read, and 4 s after the rollback to ranker-v7, the read still answers {after.json().get('model_version')}: the copy must be read again once it is CONFIG_TTL_S = 5 s old, however often it is used"
`,
    typescript: `function api(ctx) {
  const m = ctx.load('read');
  return {c: ctx.client(m.app), store: ctx.load('/support/recs/store.ts')};
}

const config = (c, surface = 'home', query?: Record<string, string>) => c.get(\`/v1/surfaces/\${surface}/config\`, {query});

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  await store.promote('home', 'ranker-v7');
  const r = await config(c);
  assert.equal(r.status, 200, \`GET /v1/surfaces/home/config answered \${r.status}: \${r.text}\`);
  assert.deepStrictEqual(r.json(), {surface: 'home', model_version: 'ranker-v7', fallback_policy: 'popularity'}, \`the home config is \${r.text}, expected ranker-v7 with the popularity fallback\`);
  const unknown = await config(c, 'search');
  assert.equal(unknown.status, 404, \`an unknown surface answered \${unknown.status}, expected 404\`);
  await store.promote('search', 'ranker-v7'); // the surface launches
  ctx.clock.advance(6);
  const launched = await config(c, 'search');
  assert.equal(launched.status, 200, \`6 s after the search surface was created its config answered \${launched.status} \${launched.text}: an unknown surface was remembered as unknown. Keep a surface's answer at most CONFIG_TTL_MS = 5000, missing ones too\`);
}

export async function check_no_query_version(ctx) {
  const {c, store} = api(ctx);
  await store.promote('home', 'ranker-v7');
  await store.promote('home', 'ranker-v8'); // the rollout: ranker-v7 was promoted once, and is no longer active
  let r = await config(c, 'home', {model_version: 'ranker-v9'});
  assert(r.status === 200 && r.json().model_version === 'ranker-v8', \`GET /v1/surfaces/home/config?model_version=ranker-v9 answered \${r.status} \${r.text}: a query parameter chose the version the surface's readers rank with. Serve the configured ranker-v8\`);
  r = await config(c, 'home', {model_version: 'ranker-v7'});
  assert(r.status === 200 && r.json().model_version === 'ranker-v8', \`after the rollout to ranker-v8, GET /v1/surfaces/home/config?model_version=ranker-v7 answered \${r.status} \${r.text}: a caller pinned a version the surface has moved off. Serve the configured ranker-v8\`);
}

export async function check_promoted_only(ctx) {
  const {c, store} = api(ctx);
  await store.promote('home', 'ranker-v7');
  let r = await config(c);
  assert(r.status === 200 && r.json().model_version === 'ranker-v7', \`the home config is \${r.status} \${r.text}, expected ranker-v7\`);
  ctx.redis.hset('surface:home', 'model_version', 'ranker-v9'); // edited by hand, never promoted
  ctx.clock.advance(6);
  r = await config(c);
  assert.equal(r.status, 404, \`the config names ranker-v9, which was never promoted, and the read answered \${r.status} \${r.text}: expected 404, not the version it last served\`);
  await store.promote('home', 'ranker-v8');
  ctx.clock.advance(6);
  r = await config(c);
  assert(r.status === 200 && r.json().model_version === 'ranker-v8', \`after ranker-v8 was promoted the read answered \${r.status} \${r.text}\`);
}

export async function check_live_config(ctx) {
  const {c, store} = api(ctx);
  await store.promote('home', 'ranker-v7');
  await store.promote('home', 'ranker-v8');
  const first = await config(c);
  assert(first.status === 200 && first.json().model_version === 'ranker-v8', \`the home config is \${first.status} \${first.text}, expected ranker-v8\`);
  ctx.clock.advance(4);
  await config(c); // a read inside the window: the copy is 4 s old
  await store.promote('home', 'ranker-v7'); // the rollback
  ctx.clock.advance(4);
  const after = await config(c);
  assert.equal(after.json().model_version, 'ranker-v7', \`8 s after the config was read, and 4 s after the rollback to ranker-v7, the read still answers \${after.json().model_version}: the copy must be read again once it is CONFIG_TTL_MS = 5000 old, however often it is used\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"recs/store"

	"leetbuild/harness"
)

var readBg = context.Background()

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func promote(ctx *harness.Ctx, surface, version string) {
	ctx.NoError(store.Promote(readBg, surface, version, "popularity"), "promote %s on %s", version, surface)
}

func versionOf(r *harness.Response) string {
	var body struct {
		ModelVersion string \`json:"model_version"\`
	}
	r.Decode(&body)
	return body.ModelVersion
}

func CheckRoute(ctx *harness.Ctx) {
	promote(ctx, "home", "ranker-v7")
	c := api(ctx)
	r := c.Get("/v1/surfaces/home/config")
	ctx.Equal(r.Status, 200, "GET /v1/surfaces/home/config (%s)", r.Text())
	var body map[string]string
	r.Decode(&body)
	ctx.Equal(body, map[string]string{"surface": "home", "model_version": "ranker-v7", "fallback_policy": "popularity"}, "the home config")
	ctx.Equal(c.Get("/v1/surfaces/search/config").Status, 404, "an unknown surface")
	promote(ctx, "search", "ranker-v7") // the surface launches
	ctx.Clock.Advance(6)
	launched := c.Get("/v1/surfaces/search/config")
	ctx.Assert(launched.Status == 200, "6 s after the search surface was created its config answered %d %s: an unknown surface was remembered as unknown. Keep a surface's answer at most configTTL = 5 s, missing ones too", launched.Status, launched.Text())
}

func CheckNoQueryVersion(ctx *harness.Ctx) {
	promote(ctx, "home", "ranker-v7")
	promote(ctx, "home", "ranker-v8") // the rollout: ranker-v7 was promoted once, and is no longer active
	c := api(ctx)
	r := c.Get("/v1/surfaces/home/config?model_version=ranker-v9")
	ctx.Assert(r.Status == 200 && versionOf(r) == "ranker-v8", "GET /v1/surfaces/home/config?model_version=ranker-v9 answered %d %s: a query parameter chose the version the surface's readers rank with. Serve the configured ranker-v8", r.Status, r.Text())
	r = c.Get("/v1/surfaces/home/config?model_version=ranker-v7")
	ctx.Assert(r.Status == 200 && versionOf(r) == "ranker-v8", "after the rollout to ranker-v8, GET /v1/surfaces/home/config?model_version=ranker-v7 answered %d %s: a caller pinned a version the surface has moved off. Serve the configured ranker-v8", r.Status, r.Text())
}

func CheckPromotedOnly(ctx *harness.Ctx) {
	promote(ctx, "home", "ranker-v7")
	c := api(ctx)
	r := c.Get("/v1/surfaces/home/config")
	ctx.Assert(r.Status == 200 && versionOf(r) == "ranker-v7", "the home config is %d %s, expected ranker-v7", r.Status, r.Text())
	ctx.Redis.Do("HSET", "surface:home", "model_version", "ranker-v9") // edited by hand, never promoted
	ctx.Clock.Advance(6)
	r = c.Get("/v1/surfaces/home/config")
	ctx.Equal(r.Status, 404, "the config names ranker-v9, which was never promoted: expected 404, not the version it last served (%s)", r.Text())
	promote(ctx, "home", "ranker-v8")
	ctx.Clock.Advance(6)
	r = c.Get("/v1/surfaces/home/config")
	ctx.Assert(r.Status == 200 && versionOf(r) == "ranker-v8", "after ranker-v8 was promoted the read answered %d %s", r.Status, r.Text())
}

func CheckLiveConfig(ctx *harness.Ctx) {
	promote(ctx, "home", "ranker-v7")
	promote(ctx, "home", "ranker-v8")
	c := api(ctx)
	first := c.Get("/v1/surfaces/home/config")
	ctx.Assert(first.Status == 200 && versionOf(first) == "ranker-v8", "the home config is %d %s, expected ranker-v8", first.Status, first.Text())
	ctx.Clock.Advance(4)
	c.Get("/v1/surfaces/home/config") // a read inside the window: the copy is 4 s old
	promote(ctx, "home", "ranker-v7") // the rollback
	ctx.Clock.Advance(4)
	after := c.Get("/v1/surfaces/home/config")
	ctx.Equal(versionOf(after), "ranker-v7", "8 s after the config was read, and 4 s after the rollback, the copy must have been read again once it was configTTL = 5 s old, however often it was used; the version served")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

namespace {

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string versionOf(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body.value("model_version", "") : "";
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  store::promote("home", "ranker-v7");
  auto c = api(ctx);
  const auto r = c.Get("/v1/surfaces/home/config");
  ctx.Equal(r.Status, 200, "GET /v1/surfaces/home/config (%s)", r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body == nlohmann::json{{"surface", "home"}, {"model_version", "ranker-v7"}, {"fallback_policy", "popularity"}}, "the home config is %s, expected ranker-v7 with the popularity fallback", r.Text());
  ctx.Equal(c.Get("/v1/surfaces/search/config").Status, 404, "an unknown surface");
  store::promote("search", "ranker-v7");  // the surface launches
  ctx.Clock.Advance(6);
  const auto launched = c.Get("/v1/surfaces/search/config");
  ctx.Assert(launched.Status == 200, "6 s after the search surface was created its config answered %d %s: an unknown surface was remembered as unknown. Keep a surface's answer at most kConfigTtl = 5 s, missing ones too", launched.Status, launched.Text());
}

void CheckNoQueryVersion(harness::Ctx& ctx) {
  store::promote("home", "ranker-v7");
  store::promote("home", "ranker-v8");  // the rollout: ranker-v7 was promoted once, and is no longer active
  auto c = api(ctx);
  auto r = c.Get("/v1/surfaces/home/config?model_version=ranker-v9");
  ctx.Assert(r.Status == 200 && versionOf(r) == "ranker-v8", "GET /v1/surfaces/home/config?model_version=ranker-v9 answered %d %s: a query parameter chose the version the surface's readers rank with. Serve the configured ranker-v8", r.Status, r.Text());
  r = c.Get("/v1/surfaces/home/config?model_version=ranker-v7");
  ctx.Assert(r.Status == 200 && versionOf(r) == "ranker-v8", "after the rollout to ranker-v8, GET /v1/surfaces/home/config?model_version=ranker-v7 answered %d %s: a caller pinned a version the surface has moved off. Serve the configured ranker-v8", r.Status, r.Text());
}

void CheckPromotedOnly(harness::Ctx& ctx) {
  store::promote("home", "ranker-v7");
  auto c = api(ctx);
  auto r = c.Get("/v1/surfaces/home/config");
  ctx.Assert(r.Status == 200 && versionOf(r) == "ranker-v7", "the home config is %d %s, expected ranker-v7", r.Status, r.Text());
  ctx.Redis.Do("HSET", "surface:home", "model_version", "ranker-v9");  // edited by hand, never promoted
  ctx.Clock.Advance(6);
  r = c.Get("/v1/surfaces/home/config");
  ctx.Equal(r.Status, 404, "the config names ranker-v9, which was never promoted: expected 404, not the version it last served (%s)", r.Text());
  store::promote("home", "ranker-v8");
  ctx.Clock.Advance(6);
  r = c.Get("/v1/surfaces/home/config");
  ctx.Assert(r.Status == 200 && versionOf(r) == "ranker-v8", "after ranker-v8 was promoted the read answered %d %s", r.Status, r.Text());
}

void CheckLiveConfig(harness::Ctx& ctx) {
  store::promote("home", "ranker-v7");
  store::promote("home", "ranker-v8");
  auto c = api(ctx);
  const auto first = c.Get("/v1/surfaces/home/config");
  ctx.Assert(first.Status == 200 && versionOf(first) == "ranker-v8", "the home config is %d %s, expected ranker-v8", first.Status, first.Text());
  ctx.Clock.Advance(4);
  c.Get("/v1/surfaces/home/config");  // a read inside the window: the copy is 4 s old
  store::promote("home", "ranker-v7");  // the rollback
  ctx.Clock.Advance(4);
  const auto after = c.Get("/v1/surfaces/home/config");
  ctx.Equal(versionOf(after), "ranker-v7", "8 s after the config was read, and 4 s after the rollback, the copy must have been read again once it was kConfigTtl = 5 s old, however often it was used; the version served");
}
`,
  },
  hints: [
    'Roll the home surface back and read its config: the old version keeps coming back. Add `?model_version=` with any name and that name is served.',
    'The handler reads the version from the query before the config, never asks whether the configured version was promoted, and its per-process map has no notion of age.',
    'Drop the query read; after loading, 404 unless `store.is_promoted(surface, version)`; store `(time.monotonic(), config)` and reload when it is `CONFIG_TTL_S` (5) seconds old.',
  ],
  debrief: `The config read is the switch a rollout and a rollback both flip, so it has one input, the surface's stored config, and the query parameter that let a caller pick another version had to go. The promotion check is what makes "active" mean "shipped": a hand-edited or half-written config pointing at an unreleased model answers 404 instead of quietly routing traffic to it. The five-second cache keeps the read cheap while bounding how long a rollback stays invisible, which a process-lifetime cache cannot. Production config services push changes to readers instead of waiting out a TTL, version the whole config so a reader can tell which one it holds, and keep an audit trail of who promoted what.`,
};
