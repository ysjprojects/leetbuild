import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/surfaces/{surface}/config: the assignment every reader resolves',
  concept: 'http',
  file: 'read',
  focus: ['client', 'recsvc', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, reads
the surface row and answers \`200\` with a \`model_version\`. It compiles, it serves the demo, and it
lets the caller name the version it is served — which makes the one read every other reader trusts
the one read that can be pointed at a model nobody shipped. Review it like the service owner, fix
it, and prove the fix with the checks below.

Implement \`GET /v1/surfaces/{surface}/config\`, the read every caller of the surface resolves before
it ranks, so a rollout or a rollback is one switch instead of per-reader drift.

- The body is \`{surface, model_version, fallback_policy}\` plus the promotion state
  (\`promoted_at\`), served from the surface config in Redis under \`surface:{surface}:config\`.
- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`surface\` must match \`^[a-z0-9][a-z0-9_-]{1,31}$\`; anything else is **400**, rejected before
  Redis or the catalog is touched.
- \`model_version\` comes from the surface config — never from a \`model_version\` query parameter.
  The caller does not get to choose the version it is served; a version on the query string is
  ignored, not honoured.
- The served version must be a **promoted** one: the handler consults the promotion record for
  \`(surface, version)\` and answers **404** when that version was never promoted. A version that
  exists in the registry but never shipped has to be as unreadable as one that does not exist, and
  the read must never promote anything on its own.
- An unknown surface is **404** too, before the promotion lookup.
- The config is cached for **5 seconds** (\`CONFIG_TTL_S\`): long enough to absorb a burst, short
  enough that a rollback is visible within seconds. A copy that lives until the process restarts
  turns every rollback into a release train.
- The version reported here is the assignment the ranking call plans against, resolved through the
  same accessor (\`active_model_version(surface)\`), so this read and the next ranking call cannot
  disagree about which model is live. An exposure is stamped from the rank result itself — the
  version that actually produced the order — which is a different question from which version is
  live.
- Log the read with tenant, surface and version — nothing else.

**Failure mode the checks target.** The draft echoes whatever \`model_version\` the query string
names, so whoever reaches the endpoint is served a version that was never promoted and the only
record of what a user actually saw points at a model the team never shipped. It also caches the
surface row for the life of the process: the operator flips the switch, ranking keeps serving the
old version, and the rollback takes effect at the next deploy — the moment nobody is watching. The
drift is the quiet one: if this read and the ranking call each resolve the version themselves, an
experiment report can attribute an outcome to a version that was never served.`,
  sequence: {
    participants: ['Client', 'Recommendation API', 'Redis', 'catalog'],
    messages: [
      {from: 'Client', to: 'Recommendation API', label: 'GET /v1/surfaces/home/config · X-Tenant-Id', kind: 'sync'},
      {from: 'Recommendation API', to: 'Redis', label: 'GET surface:home:config', kind: 'sync'},
      {from: 'Redis', to: 'Recommendation API', label: 'cached config / nil', kind: 'reply'},
      {from: 'Recommendation API', to: 'catalog', label: 'surface_config(home) on a miss', kind: 'sync'},
      {from: 'catalog', to: 'Recommendation API', label: '{model_version, fallback_policy}', kind: 'reply'},
      {
        from: 'Recommendation API',
        to: 'Recommendation API',
        label: 'version = active_model_version(home)',
        kind: 'sync',
      },
      {from: 'Recommendation API', to: 'catalog', label: 'promotions.get(home, v3)', kind: 'sync'},
      {from: 'catalog', to: 'Recommendation API', label: 'promoted_at / none → 404', kind: 'reply'},
      {from: 'Recommendation API', to: 'Redis', label: 'SET surface:home:config · EX 5', kind: 'async'},
      {
        from: 'Recommendation API',
        to: 'Client',
        label: '{surface, model_version, fallback_policy, promoted_at}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/surfaces/{surface}/config',
      detail: 'Register the parameterised read route on `GET /v1/surfaces/{surface}/config`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/surfaces\/\{surface\}\/config["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/surfaces\/:surface\/config['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/surfaces\/\{surface\}\/config"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"surfaces"\s*\/\s*Segment\s*\/\s*"config"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/surfaces\/:surface\/config"/]},
      },
    },
    {
      id: 'promoted-only',
      title: 'Serves promoted versions only',
      detail:
        'The handler consults the promotion record for `(surface, version)` and answers **404** when the version was never promoted. The draft serves any version string it is handed, so a caller can read a model the team never shipped — and the promotion table is never consulted at all.',
      match: {
        python: {all: [/promotions\.get\(\s*surface\s*,\s*version\s*\)/, /status_code\s*=\s*404/]},
        typescript: {all: [/promotions\.get\(\s*surface\s*,\s*version\s*\)/, /code\(\s*404\s*\)/]},
        go: {all: [/promotions\.Get\(ctx, surface, version\)/, /StatusNotFound/]},
        scala: {all: [/promotions\.get\(\s*surface\s*,\s*version\s*\)/, /StatusCodes\.NotFound/]},
        cpp: {all: [/promotions\.get\(surface, version\)/, /\b404\b/]},
      },
    },
    {
      id: 'no-query-version',
      title: 'Takes the version from the config, not the query string',
      detail:
        'The served `model_version` is the one in `surface:{surface}:config`; a `model_version` on the query string is ignored. The draft reads the query parameter and answers with it, so the assignment every reader resolves becomes a caller-supplied value.',
      match: {
        python: {all: [/surface:\{surface\}:config/], none: [/Query\(default=None\)/, /query_params\.get\(/]},
        typescript: {all: [/surface:\$\{surface\}:config/], none: [/query[^;\n]*model_version/]},
        go: {all: [/surface:" \+ surface \+ ":config/], none: [/Query\(\)\.Get\("model_version"\)/]},
        scala: {all: [/surface:\$surface:config/], none: [/parameter\("model_version"/]},
        cpp: {all: [/"surface:" \+ surface \+ ":config"/], none: [/get_param_value\("model_version"\)/]},
      },
    },
    {
      id: 'live-config',
      title: 'Expires the config in seconds, not at the next deploy',
      detail:
        'The config is written back with `CONFIG_TTL_S = 5`, so the switch is re-read within seconds and a rollback lands without a deploy. The draft caches the surface row in process memory for the life of the process, so a rollback only takes effect after a restart.',
      match: {
        python: {all: [/CONFIG_TTL_S\s*=\s*5/, /ex=CONFIG_TTL_S/]},
        typescript: {all: [/CONFIG_TTL_S\s*=\s*5/, /['"]EX['"]/]},
        go: {all: [/configTTLS\s*=\s*5/, /configTTLS\s*\*\s*time\.Second/]},
        scala: {all: [/ConfigTtlS\s*=\s*5/, /setex\(/]},
        cpp: {all: [/kConfigTtlS\s*=\s*5/, /setex\(\s*key\s*,\s*kConfigTtlS/]},
      },
    },
    {
      id: 'consistent-version',
      title: 'Reports the version the ranking call resolves',
      detail:
        'The response `model_version` comes from the shared `active_model_version(surface)` accessor — the same one the ranking call resolves through — so the config read and the next ranking call cannot disagree. The draft resolves its own copy straight out of the cached row.',
      match: {
        python: {all: [/version = active_model_version\(surface\)/, /"model_version": version/]},
        typescript: {all: [/const version = await activeModelVersion\(surface\)/, /model_version: version/]},
        go: {all: [/version, err := activeModelVersion\(ctx, surface\)/, /"model_version":\s+version/]},
        scala: {all: [/val version = activeModelVersion\(surface\)/, /SurfaceConfigView\(surface, version/]},
        cpp: {all: [/const auto version = active_model_version\(redis, surface\)/, /"model_version", version/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""GET /v1/surfaces/{surface}/config: a model-generated draft that serves a stale switch."""
import json
import logging

import redis
from fastapi import FastAPI, Header, Query

app = FastAPI()
logger = logging.getLogger("recsvc")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# Filled on the first read and kept for the life of the process.
config_cache: dict[str, dict] = {}


@app.get("/v1/surfaces/{surface}/config")
def read_surface_config(
    surface: str,
    tenant: str = Header(alias="X-Tenant-Id"),
    model_version: str | None = Query(default=None),
) -> dict:
    # TODO: serve the version from the surface config instead of the query string, refuse a version
    # that was never promoted, expire the cache in seconds rather than at the next deploy, and
    # resolve the version through the same accessor the ranking call uses.
    config = config_cache.get(surface)
    if config is None:
        config = json.loads(r.get(f"surface:{surface}:config") or "{}")
        config_cache[surface] = config
    version = model_version or config.get("model_version")
    logger.info("surface config read tenant=%s surface=%s version=%s", tenant, surface, version)
    return {
        "surface": surface,
        "model_version": version,
        "fallback_policy": config.get("fallback_policy"),
    }
`,
      solution: `import json
import logging
import re

import redis
from fastapi import FastAPI, Header, HTTPException

app = FastAPI()
logger = logging.getLogger("recsvc")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

CONFIG_TTL_S = 5
SURFACE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,31}$")


class Catalog:
    def surface_config(self, surface: str) -> dict | None:
        """The surface row: its fallback policy and the version that is currently active."""
        raise NotImplementedError


class Promotions:
    def get(self, surface: str, model_version: str) -> dict | None:
        """The promotion record for (surface, model_version), or None if it never shipped."""
        raise NotImplementedError


catalog = Catalog()
promotions = Promotions()


def load_surface_config(surface: str) -> dict:
    """The surface config, cached for CONFIG_TTL_S so a rollback lands in seconds."""
    key = f"surface:{surface}:config"
    cached = r.get(key)
    if cached is not None:
        return json.loads(cached)
    config = catalog.surface_config(surface)
    if config is None:
        raise HTTPException(status_code=404, detail="unknown surface")
    r.set(key, json.dumps(config), ex=CONFIG_TTL_S)
    return config


def active_model_version(surface: str) -> str:
    """The ranking call resolves its version through this accessor too — one switch, no drift."""
    return load_surface_config(surface)["model_version"]


@app.get("/v1/surfaces/{surface}/config")
def read_surface_config(surface: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> dict:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if SURFACE_RE.fullmatch(surface) is None:
        raise HTTPException(status_code=400, detail="invalid surface name")
    config = load_surface_config(surface)
    version = active_model_version(surface)
    promotion = promotions.get(surface, version)
    if promotion is None:
        raise HTTPException(status_code=404, detail="version not promoted")
    logger.info("surface config read tenant=%s surface=%s version=%s", tenant, surface, version)
    return {
        "surface": surface,
        "model_version": version,
        "fallback_policy": config["fallback_policy"],
        "promoted_at": promotion["promoted_at"],
    }
`,
    },
    typescript: {
      starter: `/** GET /v1/surfaces/:surface/config: a model-generated draft that serves a stale switch. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

// Filled on the first read and kept for the life of the process.
const configCache = new Map<string, {model_version: string; fallback_policy: string}>();

app.get('/v1/surfaces/:surface/config', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const {surface} = request.params as {surface: string};
  const query = request.query as {model_version?: string};
  // TODO: serve the version from the surface config instead of the query string, refuse a version
  // that was never promoted, expire the cache in seconds rather than at the next deploy, and
  // resolve the version through the same accessor the ranking call uses.
  let config = configCache.get(surface);
  if (config === undefined) {
    config = JSON.parse(
      (await r.get(\`surface:\${surface}:config\`)) ?? '{"model_version":"","fallback_policy":""}',
    ) as {model_version: string; fallback_policy: string};
    configCache.set(surface, config);
  }
  const version = query.model_version ?? config.model_version;
  request.log.info({tenant, surface, version}, 'surface config read');
  return reply.code(200).send({
    surface,
    model_version: version,
    fallback_policy: config.fallback_policy,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/surfaces/:surface/config: one promoted version, read live, shared by every reader. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const CONFIG_TTL_S = 5;
const SURFACE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

interface SurfaceConfig {
  model_version: string;
  fallback_policy: string;
}

interface Promotion {
  model_version: string;
  promoted_at: string;
}

/** The surface row and the promotions table live in the service's own database. */
export const catalog = {
  async surfaceConfig(surface: string): Promise<SurfaceConfig | null> {
    void surface;
    return null;
  },
};

export const promotions = {
  async get(surface: string, modelVersion: string): Promise<Promotion | null> {
    void surface;
    void modelVersion;
    return null;
  },
};

/** The surface config, cached for CONFIG_TTL_S so a rollback lands in seconds. */
async function loadSurfaceConfig(surface: string): Promise<SurfaceConfig | null> {
  const key = \`surface:\${surface}:config\`;
  const cached = await r.get(key);
  if (cached !== null) return JSON.parse(cached) as SurfaceConfig;
  const config = await catalog.surfaceConfig(surface);
  if (config === null) return null;
  await r.set(key, JSON.stringify(config), 'EX', CONFIG_TTL_S);
  return config;
}

/** The ranking call resolves its version through this accessor too — one switch, no drift. */
export async function activeModelVersion(surface: string): Promise<string | null> {
  const config = await loadSurfaceConfig(surface);
  return config === null ? null : config.model_version;
}

app.get('/v1/surfaces/:surface/config', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {surface} = request.params as {surface: string};
  if (!SURFACE_RE.test(surface)) return reply.code(400).send({error: 'invalid surface name'});
  const config = await loadSurfaceConfig(surface);
  if (config === null) return reply.code(404).send({error: 'unknown surface'});
  const version = await activeModelVersion(surface);
  if (version === null) return reply.code(404).send({error: 'unknown surface'});
  const promotion = await promotions.get(surface, version);
  if (promotion === null) return reply.code(404).send({error: 'version not promoted'});
  request.log.info({tenant, surface, version}, 'surface config read');
  return reply.code(200).send({
    surface,
    model_version: version,
    fallback_policy: config.fallback_policy,
    promoted_at: promotion.promoted_at,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

// Filled on the first read and kept for the life of the process.
var configCache = map[string]map[string]string{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readSurfaceConfig(rw http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	tenant := r.Header.Get("X-Tenant-Id")
	surface := r.PathValue("surface")
	// TODO: serve the version from the surface config instead of the query string, refuse a version
	// that was never promoted, expire the cache in seconds rather than at the next deploy, and
	// resolve the version through the same accessor the ranking call uses.
	overridden := r.URL.Query().Get("model_version")
	config, ok := configCache[surface]
	if !ok {
		if raw, err := rdb.Get(ctx, "surface:"+surface+":config").Result(); err == nil {
			_ = json.Unmarshal([]byte(raw), &config)
		}
		configCache[surface] = config
	}
	version := overridden
	if version == "" {
		version = config["model_version"]
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"surface":         surface,
		"model_version":   version,
		"fallback_policy": config["fallback_policy"],
		"tenant":          tenant,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/surfaces/{surface}/config", readSurfaceConfig)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"time"

	"github.com/redis/go-redis/v9"
)

const configTTLS = 5

var rdb *redis.Client

var surfaceRe = regexp.MustCompile("^[a-z0-9][a-z0-9_-]{1,31}$")

type SurfaceConfig struct {
	ModelVersion   string \`json:"model_version"\`
	FallbackPolicy string \`json:"fallback_policy"\`
}

type Promotion struct {
	ModelVersion string \`json:"model_version"\`
	PromotedAt   string \`json:"promoted_at"\`
}

type Catalog struct{}

func (c *Catalog) SurfaceConfig(ctx context.Context, surface string) (*SurfaceConfig, error) {
	return nil, nil
}

type Promotions struct{}

func (p *Promotions) Get(ctx context.Context, surface, modelVersion string) (*Promotion, error) {
	return nil, nil
}

var (
	catalog    = &Catalog{}
	promotions = &Promotions{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// loadSurfaceConfig caches the surface config for configTTLS seconds, so a rollback lands in
// seconds instead of at the next deploy.
func loadSurfaceConfig(ctx context.Context, surface string) (*SurfaceConfig, error) {
	key := "surface:" + surface + ":config"
	if cached, err := rdb.Get(ctx, key).Result(); err == nil {
		var config SurfaceConfig
		if err := json.Unmarshal([]byte(cached), &config); err != nil {
			return nil, err
		}
		return &config, nil
	}
	config, err := catalog.SurfaceConfig(ctx, surface)
	if err != nil {
		return nil, err
	}
	if config == nil {
		return nil, nil
	}
	encoded, _ := json.Marshal(config)
	rdb.Set(ctx, key, encoded, configTTLS*time.Second)
	return config, nil
}

// activeModelVersion is the accessor the ranking call resolves through too: one switch, no drift.
func activeModelVersion(ctx context.Context, surface string) (string, error) {
	config, err := loadSurfaceConfig(ctx, surface)
	if err != nil {
		return "", err
	}
	if config == nil {
		return "", nil
	}
	return config.ModelVersion, nil
}

func readSurfaceConfig(rw http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	surface := r.PathValue("surface")
	if !surfaceRe.MatchString(surface) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid surface name"})
		return
	}
	config, err := loadSurfaceConfig(ctx, surface)
	if err != nil || config == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown surface"})
		return
	}
	version, err := activeModelVersion(ctx, surface)
	if err != nil || version == "" {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown surface"})
		return
	}
	promotion, err := promotions.Get(ctx, surface, version)
	if err != nil || promotion == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "version not promoted"})
		return
	}
	log.Printf("surface config read tenant=%s surface=%s version=%s", tenant, surface, version)
	writeJSON(rw, http.StatusOK, map[string]any{
		"surface":         surface,
		"model_version":   version,
		"fallback_policy": config.FallbackPolicy,
		"promoted_at":     promotion.PromotedAt,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/surfaces/{surface}/config", readSurfaceConfig)
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
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class SurfaceConfig(model_version: String, fallback_policy: String)

object SurfaceApi {
  implicit val system: ActorSystem = ActorSystem("recsvc")
  implicit val configFormat: RootJsonFormat[SurfaceConfig] = jsonFormat2(SurfaceConfig)
  val r = new Jedis("redis", 6379)

  // Filled on the first read and kept for the life of the process.
  private val configCache = scala.collection.mutable.Map.empty[String, SurfaceConfig]

  val route: Route =
    path("v1" / "surfaces" / Segment / "config") { surface =>
      get {
        parameter("model_version".?) { versionOpt =>
          // TODO: serve the version from the surface config instead of the query string, refuse a
          // version that was never promoted, expire the cache in seconds rather than at the next
          // deploy, and resolve the version through the same accessor the ranking call uses.
          val config = configCache.getOrElseUpdate(
            surface,
            configFormat.read(
              Option(r.get(s"surface:$surface:config"))
                .getOrElse("""{"model_version":"","fallback_policy":""}""")
                .parseJson
            )
          )
          val version = versionOpt.filter(_.nonEmpty).getOrElse(config.model_version)
          val fallback = config.fallback_policy
          val body = s"""{"surface":"$surface","model_version":"$version","fallback_policy":"$fallback"}"""
          complete(StatusCodes.OK, body)
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
import org.slf4j.LoggerFactory
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class SurfaceConfig(model_version: String, fallback_policy: String)
final case class Promotion(model_version: String, promoted_at: String)
final case class SurfaceConfigView(surface: String, model_version: String, fallback_policy: String, promoted_at: String)

object Catalog {
  /** The surface row: its fallback policy and the version that is currently active. */
  def surface_config(surface: String): Option[SurfaceConfig] = None
}

object Promotions {
  /** The promotion record for (surface, version); None means that version never shipped. */
  def get(surface: String, modelVersion: String): Option[Promotion] = None
}

object SurfaceApi {
  implicit val system: ActorSystem = ActorSystem("recsvc")
  implicit val configFormat: RootJsonFormat[SurfaceConfig] = jsonFormat2(SurfaceConfig)
  implicit val promotionFormat: RootJsonFormat[Promotion] = jsonFormat2(Promotion)
  implicit val viewFormat: RootJsonFormat[SurfaceConfigView] = jsonFormat4(SurfaceConfigView)
  private val log = LoggerFactory.getLogger("recsvc")
  val r = new Jedis("redis", 6379)

  val ConfigTtlS = 5
  val SurfaceRe = """^[a-z0-9][a-z0-9_-]{1,31}$""".r

  val catalog = Catalog
  val promotions = Promotions

  /** The surface config, cached for ConfigTtlS seconds so a rollback lands in seconds. */
  def loadSurfaceConfig(surface: String): Option[SurfaceConfig] = {
    val key = s"surface:$surface:config"
    Option(r.get(key)) match {
      case Some(cached) => Some(configFormat.read(cached.parseJson))
      case None =>
        catalog.surface_config(surface).map { config =>
          r.setex(key, ConfigTtlS, configFormat.write(config).compactPrint)
          config
        }
    }
  }

  /** The ranking call resolves its version through this accessor too: one switch, no drift. */
  def activeModelVersion(surface: String): Option[String] =
    loadSurfaceConfig(surface).map(_.model_version)

  val route: Route =
    path("v1" / "surfaces" / Segment / "config") { surface =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          complete {
            if (!tenantOpt.exists(_.nonEmpty)) {
              HttpResponse(StatusCodes.Unauthorized, entity = """{"error":"missing X-Tenant-Id"}""")
            } else if (SurfaceRe.findFirstIn(surface).isEmpty) {
              HttpResponse(StatusCodes.BadRequest, entity = """{"error":"invalid surface name"}""")
            } else {
              loadSurfaceConfig(surface) match {
                case None => HttpResponse(StatusCodes.NotFound, entity = """{"error":"unknown surface"}""")
                case Some(config) =>
                  val version = activeModelVersion(surface).getOrElse("")
                  promotions.get(surface, version) match {
                    case None => HttpResponse(StatusCodes.NotFound, entity = """{"error":"version not promoted"}""")
                    case Some(promotion) =>
                      log.info(s"surface config read tenant=$tenant surface=$surface version=$version")
                      val view = SurfaceConfigView(surface, version, config.fallback_policy, promotion.promoted_at)
                      HttpResponse(StatusCodes.OK, entity = viewFormat.write(view).compactPrint)
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
#include <sw/redis++/redis++.h>

#include <iostream>
#include <map>
#include <string>

using json = nlohmann::json;

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  // Filled on the first read and kept for the life of the process.
  std::map<std::string, json> config_cache;

  svr.Get("/v1/surfaces/:surface/config", [&redis, &config_cache](const httplib::Request& req, httplib::Response& res) {
    const auto surface = req.path_params.at("surface");
    // TODO: serve the version from the surface config instead of the query string, refuse a version
    // that was never promoted, expire the cache in seconds rather than at the next deploy, and
    // resolve the version through the same accessor the ranking call uses.
    const auto overridden = req.has_param("model_version") ? req.get_param_value("model_version") : std::string();
    auto it = config_cache.find(surface);
    if (it == config_cache.end()) {
      auto raw = redis.get("surface:" + surface + ":config");
      it = config_cache.emplace(surface, raw ? json::parse(*raw, nullptr, false) : json::object()).first;
    }
    const json& config = it->second;
    const json body = {
        {"surface", surface},
        {"model_version", overridden.empty() ? config.value("model_version", std::string()) : overridden},
        {"fallback_policy", config.value("fallback_policy", std::string())},
    };
    std::cerr << "surface config read surface=" << surface << "\\n";
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <optional>
#include <regex>
#include <string>

using json = nlohmann::json;

constexpr long long kConfigTtlS = 5;
const std::regex kSurfaceRe("^[a-z0-9][a-z0-9_-]{1,31}$");

struct SurfaceConfig {
  std::string model_version;
  std::string fallback_policy;
};

struct Promotion {
  std::string model_version;
  std::string promoted_at;
};

struct Catalog {
  /** The surface row: its fallback policy and the version that is currently active. */
  std::optional<SurfaceConfig> surface_config(const std::string& surface);
};

struct Promotions {
  /** The promotion record for (surface, version); nullopt means that version never shipped. */
  std::optional<Promotion> get(const std::string& surface, const std::string& version);
};

Catalog catalog;
Promotions promotions;

/** The surface config, cached for kConfigTtlS seconds so a rollback lands in seconds. */
std::optional<SurfaceConfig> load_surface_config(sw::redis::Redis& redis, const std::string& surface) {
  const auto key = "surface:" + surface + ":config";
  if (auto cached = redis.get(key)) {
    const auto parsed = json::parse(*cached, nullptr, false);
    if (parsed.is_object()) {
      SurfaceConfig config;
      config.model_version = parsed.value("model_version", std::string());
      config.fallback_policy = parsed.value("fallback_policy", std::string());
      return config;
    }
  }
  auto config = catalog.surface_config(surface);
  if (!config) return std::nullopt;
  const json encoded = {
      {"model_version", config->model_version},
      {"fallback_policy", config->fallback_policy},
  };
  redis.setex(key, kConfigTtlS, encoded.dump());
  return config;
}

/** The ranking call resolves its version through this accessor too: one switch, no drift. */
std::optional<std::string> active_model_version(sw::redis::Redis& redis, const std::string& surface) {
  auto config = load_surface_config(redis, surface);
  if (!config) return std::nullopt;
  return config->model_version;
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get("/v1/surfaces/:surface/config", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto surface = req.path_params.at("surface");
    if (!std::regex_match(surface, kSurfaceRe)) {
      res.status = 400;
      res.set_content(R"({"error":"invalid surface name"})", "application/json");
      return;
    }
    const auto config = load_surface_config(redis, surface);
    if (!config) {
      res.status = 404;
      res.set_content(R"({"error":"unknown surface"})", "application/json");
      return;
    }
    const auto version = active_model_version(redis, surface).value_or("");
    const auto promotion = promotions.get(surface, version);
    if (!promotion) {
      res.status = 404;
      res.set_content(R"({"error":"version not promoted"})", "application/json");
      return;
    }
    std::cerr << "surface config read tenant=" << tenant << " surface=" << surface << " version=" << version << "\\n";
    const json body = {
        {"surface", surface},
        {"model_version", version},
        {"fallback_policy", config->fallback_policy},
        {"promoted_at", promotion->promoted_at},
    };
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Serve the version, do not accept it: the response `model_version` is the one in `surface:{surface}:config`, so delete the query parameter the draft reads and answer with the config’s own version. A caller that names the version can be served a model that was never promoted.',
    'Promotion is the second gate: call `promotions.get(surface, version)` for the version you are about to serve and answer **404** when the record is missing — the same answer an unknown surface gets, so a reader cannot tell a version that never shipped from one that does not exist. A read never promotes.',
    'The TTL is the point of the endpoint: write the config back with `CONFIG_TTL_S = 5` (`setex` / `ex=CONFIG_TTL_S` / `EX` / `configTTLS*time.Second`) so a rollback lands within seconds, and have both this handler and the ranking call resolve through `active_model_version(surface)` so the two can never disagree.',
  ],
  debrief: `The interviewer is testing whether you can review a read that other services trust. This endpoint looks like a lookup, but it is the assignment every reader resolves before it ranks: the ranking call, the offline comparison, the analytics job that stamps impressions with a version. That makes two things release-critical. First, the version must be a promoted one — an unpromoted version is a model nobody shipped, and serving it silently turns an experiment into an unexplained incident, so the read consults the promotion record and answers 404 exactly as it would for a surface that does not exist. Second, the version must be read live: a five-second TTL in Redis is the difference between a rollback that lands in seconds and a rollback that waits for the next deploy of every process that cached the row in memory. The third contract is the shared accessor. If the config read and the ranking call each resolve the version themselves, two reads of the same key can straddle a rollback and the response can carry a version the ranking never used; one accessor — \`active_model_version(surface)\` — makes that impossible and keeps the switch a single write. Real systems add an audit trail for promotions, staged percentages so a switch is not all-or-nothing, pushes (Pub/Sub or a watched key) so readers invalidate ahead of the TTL, per-tenant pins for the callers still mid-session, and an \`ETag\`/short \`Cache-Control\` on the response so well-behaved clients re-read instead of holding an assignment for hours. They also keep a last-known-good copy of the config so a Redis outage degrades to the previous assignment rather than to no answer at all.`,
};
