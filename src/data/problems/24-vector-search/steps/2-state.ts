import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis result cache with tenant-safe keys',
  concept: 'redis',
  file: 'state',
  focus: ['search', 'cache', 'index'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the second identical query is
fast and the demo looks great. The cache hides a leak, a stale entry and the wrong expiry
discipline. Find them, fix them, and prove the fix with the checks below.

Identical lookups must be served from a Redis cache in front of the index.

- The key is \`search:{tenant}:{index_version}:{query_digest}:{k}\` — built from the authenticated
  tenant, the active index version, a stable digest of the query vector and the cap that was
  actually searched. The draft hashes the query and appends \`k\`, so the first tenant to run a
  query populates an entry that the next tenant reads.
- The digest must be stable across processes: pack the vector's IEEE-754 bytes (or quantize them)
  and hash that. \`str(vector)\` (or any float formatting) is not a key — the same floats print
  differently in another runtime and the hit rate silently drops to zero.
- Entries **expire**: write with a **60-second TTL** in the same \`SET\` (\`ex=TTL_S\`, \`EX\`,
  \`setex\`, \`std::chrono::seconds\`). The draft deletes entries by hand before writing, which
  leaves a window where the entry is gone for every tenant and never bounds staleness.
- The read path keys by the authenticated tenant only and never trusts a body tenant for the cache.

**Failure mode the checks target.** A key without the tenant is a cross-tenant read: the query hash
is identical for two tenants who embed similar text, so the cache serves one tenant's private hits
to another. A key without the index version serves results from a snapshot the tenant no longer
sees. Manual invalidation has no bound on staleness — the TTL is the bound — and float formatting
as a key makes the cache miss forever.`,
  sequence: {
    participants: ['Search API', 'Result cache', 'Index shards'],
    messages: [
      {from: 'Search API', to: 'Search API', label: 'key = search:{tenant}:{version}:{digest}:{k}', kind: 'sync'},
      {from: 'Search API', to: 'Result cache', label: 'GET key', kind: 'sync'},
      {from: 'Result cache', to: 'Search API', label: 'hit → 200 (no shard is touched)', kind: 'reply'},
      {from: 'Search API', to: 'Index shards', label: 'Search(...) only on a miss', kind: 'sync'},
      {from: 'Index shards', to: 'Search API', label: 'hits', kind: 'reply'},
      {from: 'Search API', to: 'Result cache', label: 'SET key payload EX 60', kind: 'async'},
    ],
  },
  hints: [
    'Build the key from four inputs, not two: `cache_key(tenant, version, digest, k)`. The tenant and the index version are the isolation half; the digest and `k` are what make the entry *this* query. If any of the four is missing, the entry answers a question nobody asked.',
    'The digest is a fingerprint, not a serialization: `struct.pack(">f", v)` over the floats, `Buffer.writeFloatBE`, `math.Float64bits` into a `sha256`, a `ByteBuffer.putDouble`, an FNV-1a walk over the bits. All of them are stable across processes and machines; `str([0.1, 0.2])` is not.',
    'Expiry is the invalidation strategy: `SET ... EX 60` (or `setex`, `SETEX`, the `ex=` keyword, `std::chrono::seconds(60)`). Never `DEL` before a write — that is a stampede with a stale-data tail, and the 60-second TTL is the only staleness bound the tenant agreed to.',
  ],
  checks: [
    {
      id: 'cache-key',
      title: 'Key carries tenant, version, digest and k',
      detail:
        'The key is `search:{tenant}:{version}:{digest}:{k}`. The draft builds it from the digest and `k` alone, so a hit one tenant wrote is served to the next tenant that runs the same query.',
      match: {
        python: {all: [/def cache_key\(/, /\{tenant\}/, /\{version\}/, /\{digest\}/, /\{k\}/]},
        typescript: {all: [/function cacheKey\(/, /\$\{tenant\}/, /\$\{version\}/, /\$\{digest\}/, /\$\{k\}/]},
        go: {all: [/func cacheKey\(/, /search:%s:%s:%s:%d/, /tenant, version, digest/]},
        scala: {all: [/def cacheKey\(/, /search:\$tenant:\$version:\$digest:\$k/]},
        cpp: {all: [/cacheKey\(/, /"search:"\s*\+\s*tenant/, /std::to_string\(k\)/]},
      },
    },
    {
      id: 'query-digest',
      title: 'Digest is stable across processes',
      detail:
        'The query is fingerprinted over its bytes (`struct.pack`, `writeFloatBE`, `math.Float64bits` + `sha256`, `ByteBuffer.putDouble`, an FNV-1a walk), not by formatting the floats. A formatted-float key never hits in another runtime.',
      match: {
        python: {all: [/sha256/, /struct\.pack/, /query_digest/]},
        typescript: {all: [/createHash\(\s*['"]sha256['"]\s*\)/, /Buffer\.alloc/, /queryDigest/]},
        go: {all: [/sha256\.Sum256/, /Float64bits/, /queryDigest/]},
        scala: {all: [/MessageDigest\.getInstance\("SHA-256"\)/, /putDouble/, /queryDigest/]},
        cpp: {all: [/kFnvOffsetBasis/, /queryDigest/]},
      },
    },
    {
      id: 'ttl',
      title: 'Entries expire with a 60-second TTL',
      detail:
        'Writes carry a 60-second expiry — `ex=TTL_S`, `SET ... EX TTL_S`, `setex(key, TtlSeconds, …)`, `std::chrono::seconds(kCacheTtlSeconds)`. The draft writes without an expiry and deletes by hand, so staleness is unbounded.',
      match: {
        python: {all: [/TTL_S\s*=\s*60/, /ex\s*=\s*TTL_S/]},
        typescript: {all: [/TTL_S\s*=\s*60/, /['"]EX['"],\s*TTL_S/]},
        go: {all: [/cacheTTL\s*=\s*60\s*\*\s*time\.Second/, /cache\.Set\(.*cacheTTL\)/]},
        scala: {all: [/TtlSeconds\s*=\s*60/, /setex\(/]},
        cpp: {all: [/kCacheTtlSeconds\s*=\s*60/, /std::chrono::seconds\(kCacheTtlSeconds\)/]},
      },
    },
    {
      id: 'no-manual-invalidation',
      title: 'Expires, never invalidates by hand',
      detail:
        'No `DEL`/`delete`/`.del(` call anywhere: the 60-second TTL is the only invalidation. The draft deletes the key before writing, which opens a window where every tenant misses and leaves entries with no staleness bound.',
      match: {
        python: {none: [/\.del\(/, /\bDEL\b/, /\.delete\(/]},
        typescript: {none: [/\.del\(/, /\bDEL\b/, /\.delete\(/]},
        go: {none: [/\.Del\(/, /\bDEL\b/, /\.Delete\(/]},
        scala: {none: [/\.del\(/, /\bDEL\b/, /\.delete\(/]},
        cpp: {none: [/\.del\(/, /\bDEL\b/, /\.delete\(/]},
      },
    },
    {
      id: 'tenant-isolation',
      title: 'Reads and writes are scoped by the authenticated tenant',
      detail:
        'The tenant that builds the key is the authenticated `X-Tenant-Id` one; a body tenant that contradicts it is **403**. The draft passes the body tenant straight into the search and the key, so tenant isolation is only as good as the caller.',
      match: {
        python: {all: [/X-Tenant-Id/, /cache_key\(tenant,/, /status_code\s*=\s*403/]},
        typescript: {all: [/x-tenant-id/, /cacheKey\(tenant,/, /code\(\s*403\s*\)/]},
        go: {all: [/X-Tenant-Id/, /cacheKey\(tenant,/, /StatusForbidden/]},
        scala: {all: [/X-Tenant-Id/, /cacheKey\(tenant,/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/X-Tenant-Id/, /cacheKey\(tenant,/, /\b403\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib
import json
import logging

import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("search")
cache = redis.Redis(host="redis", port=6379, decode_responses=True)

ACTIVE_INDEX_VERSION = "idx-42"


class SearchRequest(BaseModel):
    query: list[float]
    k: int = 10
    tenant: str


class Index:
    def search(self, tenant: str, query: list[float], k: int, version: str) -> list[dict]:
        raise NotImplementedError


index = Index()


def query_digest(query: list[float]) -> str:
    return hashlib.sha256(str(query).encode("utf-8")).hexdigest()[:32]


@app.post("/v1/search")
def search(body: SearchRequest) -> JSONResponse:
    # TODO: the key is the digest and k alone, so the first tenant to run a query populates an entry
    # that every other tenant then reads. The draft also deletes entries by hand instead of giving
    # them a TTL, and it takes the tenant straight from the body.
    tenant = body.tenant
    key = f"search:{query_digest(body.query)}:{body.k}"
    cached = cache.get(key)
    if cached is not None:
        return JSONResponse(json.loads(cached), status_code=200)
    cache.delete(key)
    hits = index.search(tenant, body.query, body.k, ACTIVE_INDEX_VERSION)
    payload = {"hits": hits, "k": body.k, "index_version": ACTIVE_INDEX_VERSION}
    cache.set(key, json.dumps(payload))
    return JSONResponse(payload, status_code=200)
`,
      solution: `import hashlib
import json
import logging
import struct

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("search")
cache = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_S = 60
MAX_K = 100
INDEX_DIMENSIONS = 768
ACTIVE_INDEX_VERSION = "idx-42"


class SearchRequest(BaseModel):
    query: list[float]
    k: int = 10
    tenant: str | None = None
    index_version: str | None = None


class Index:
    def search(self, tenant: str, query: list[float], k: int, version: str) -> list[dict]:
        raise NotImplementedError


index = Index()


def query_digest(query: list[float]) -> str:
    """A fingerprint of one query: the same bytes hash the same in every process."""
    packed = b"".join(struct.pack(">f", value) for value in query)
    return hashlib.sha256(packed).hexdigest()[:32]


def cache_key(tenant: str, version: str, digest: str, k: int) -> str:
    """Tenant and index version are part of the key: a shared key is a cross-tenant leak."""
    return f"search:{tenant}:{version}:{digest}:{k}"


@app.post("/v1/search")
def search(
    body: SearchRequest,
    tenant_header: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant_header is None or tenant_header == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if body.tenant is not None and body.tenant != tenant_header:
        raise HTTPException(status_code=403, detail="body tenant does not match the authenticated tenant")
    if body.index_version is not None and body.index_version != ACTIVE_INDEX_VERSION:
        raise HTTPException(status_code=409, detail={"error": "index version is not active"})
    if len(body.query) != INDEX_DIMENSIONS:
        raise HTTPException(status_code=400, detail={"error": "query vector has the wrong dimension"})
    if not 1 <= body.k <= MAX_K:
        raise HTTPException(status_code=400, detail={"error": "k must be between 1 and 100"})

    tenant = tenant_header
    version = ACTIVE_INDEX_VERSION
    key = cache_key(tenant, version, query_digest(body.query), body.k)
    cached = cache.get(key)
    if cached is not None:
        logger.info("search cache=hit tenant=%s k=%d version=%s", tenant, body.k, version)
        return JSONResponse(json.loads(cached), status_code=200)

    logger.info("search cache=miss tenant=%s k=%d version=%s", tenant, body.k, version)
    hits = index.search(tenant, body.query, body.k, version)
    payload = {"hits": hits, "k": body.k, "index_version": version}
    cache.set(key, json.dumps(payload), ex=TTL_S)
    return JSONResponse(payload, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/search: a model-generated draft whose cache key forgot the tenant. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {index} from './index_store';

export const app = Fastify();
const cache = new Redis('redis://redis:6379');

const ACTIVE_INDEX_VERSION = 'idx-42';

interface SearchBody {
  query: number[];
  k?: number;
  tenant: string;
}

function queryDigest(query: number[]): string {
  return createHash('sha256').update(JSON.stringify(query)).digest('hex').slice(0, 32);
}

app.post('/v1/search', async (request, reply) => {
  // TODO: the key is the digest and k alone, so the first tenant to run a query populates an entry
  // that every other tenant then reads. The draft also deletes entries by hand instead of giving
  // them a TTL, and it takes the tenant straight from the body.
  const body = request.body as SearchBody;
  const k = body.k ?? 10;
  const key = \`search:\${queryDigest(body.query)}:\${k}\`;
  const cached = await cache.get(key);
  if (cached !== null) return reply.code(200).send(JSON.parse(cached));
  await cache.del(key);
  const hits = await index.search(body.tenant, body.query, k, ACTIVE_INDEX_VERSION);
  const payload = {hits, k, index_version: ACTIVE_INDEX_VERSION};
  await cache.set(key, JSON.stringify(payload));
  return reply.code(200).send(payload);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/search: a cache entry belongs to one tenant and one index version. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {index} from './index_store';

export const app = Fastify();
const cache = new Redis('redis://redis:6379');

const TTL_S = 60;
const MAX_K = 100;
const INDEX_DIMENSIONS = 768;
const ACTIVE_INDEX_VERSION = 'idx-42';

interface SearchBody {
  query?: number[];
  k?: number;
  tenant?: string;
  index_version?: string;
}

function queryDigest(query: number[]): string {
  const packed = Buffer.alloc(query.length * 4);
  query.forEach((value, position) => packed.writeFloatBE(value, position * 4));
  return createHash('sha256').update(packed).digest('hex').slice(0, 32);
}

function cacheKey(tenant: string, version: string, digest: string, k: number): string {
  return \`search:\${tenant}:\${version}:\${digest}:\${k}\`;
}

app.post('/v1/search', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const body = (request.body ?? {}) as SearchBody;
  if (body.tenant !== undefined && body.tenant !== tenant)
    return reply.code(403).send({error: 'body tenant does not match the authenticated tenant'});
  if (body.index_version !== undefined && body.index_version !== ACTIVE_INDEX_VERSION)
    return reply.code(409).send({error: 'index version is not active'});
  const vector = body.query;
  if (!Array.isArray(vector) || vector.length !== INDEX_DIMENSIONS)
    return reply.code(400).send({error: 'query vector has the wrong dimension'});
  const k = body.k ?? 10;
  if (!Number.isInteger(k) || k < 1 || k > MAX_K) return reply.code(400).send({error: 'k must be between 1 and 100'});

  const key = cacheKey(tenant, ACTIVE_INDEX_VERSION, queryDigest(vector), k);
  const cached = await cache.get(key);
  if (cached !== null) {
    request.log.info({tenant, k, cache: 'hit'}, 'served from cache');
    return reply.code(200).send(JSON.parse(cached));
  }

  const hits = await index.search(tenant, vector, k, ACTIVE_INDEX_VERSION);
  const payload = {hits, k, index_version: ACTIVE_INDEX_VERSION};
  await cache.set(key, JSON.stringify(payload), 'EX', TTL_S);
  return reply.code(200).send(payload);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"
)

const activeIndexVersion = "idx-42"

type SearchRequest struct {
	Query  []float64 \`json:"query"\`
	K      int       \`json:"k"\`
	Tenant string    \`json:"tenant"\`
}

type Hit struct {
	ID    string  \`json:"id"\`
	Score float64 \`json:"score"\`
}

type Index struct{}

func (i *Index) Search(ctx context.Context, tenant string, query []float64, k int, version string) ([]Hit, error) {
	return nil, nil
}

var (
	index = &Index{}
	cache = redis.NewClient(&redis.Options{Addr: "redis:6379"})
)

func queryDigest(query []float64) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%v", query)))
	return hex.EncodeToString(sum[:])[:32]
}

func search(rw http.ResponseWriter, r *http.Request) {
	var body SearchRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "invalid json", http.StatusBadRequest)
		return
	}
	// TODO: the key is the digest and k alone, so the first tenant to run a query populates an entry
	// that every other tenant then reads. The draft also deletes entries by hand instead of giving
	// them a TTL, and it takes the tenant straight from the body.
	k := body.K
	if k == 0 {
		k = 10
	}
	key := fmt.Sprintf("search:%s:%d", queryDigest(body.Query), k)
	if cached, err := cache.Get(r.Context(), key).Result(); err == nil {
		rw.Header().Set("Content-Type", "application/json")
		rw.Write([]byte(cached))
		return
	}
	cache.Del(r.Context(), key)
	hits, err := index.Search(r.Context(), body.Tenant, body.Query, k, activeIndexVersion)
	if err != nil {
		http.Error(rw, "index unavailable", http.StatusServiceUnavailable)
		return
	}
	payload, _ := json.Marshal(map[string]any{"hits": hits, "k": k, "index_version": activeIndexVersion})
	cache.Set(r.Context(), key, payload, 0)
	log.Printf("search cache=miss tenant=%s k=%d version=%s", body.Tenant, k, activeIndexVersion)
	rw.Header().Set("Content-Type", "application/json")
	rw.Write(payload)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/search", search)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	maxK               = 100
	indexDimensions    = 768
	activeIndexVersion = "idx-42"
	cacheTTL           = 60 * time.Second
)

type SearchRequest struct {
	Query        []float64 \`json:"query"\`
	K            int       \`json:"k"\`
	Tenant       string    \`json:"tenant,omitempty"\`
	IndexVersion string    \`json:"index_version,omitempty"\`
}

type Hit struct {
	ID    string  \`json:"id"\`
	Score float64 \`json:"score"\`
}

type Index struct{}

func (i *Index) Search(ctx context.Context, tenant string, query []float64, k int, version string) ([]Hit, error) {
	return nil, nil
}

var (
	index = &Index{}
	cache = redis.NewClient(&redis.Options{Addr: "redis:6379"})
)

func queryDigest(query []float64) string {
	buffer := make([]byte, len(query)*8)
	for position, value := range query {
		binary.BigEndian.PutUint64(buffer[position*8:], math.Float64bits(value))
	}
	sum := sha256.Sum256(buffer)
	return hex.EncodeToString(sum[:])[:32]
}

func cacheKey(tenant, version, digest string, k int) string {
	return fmt.Sprintf("search:%s:%s:%s:%d", tenant, version, digest, k)
}

func search(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "missing X-Tenant-Id", http.StatusUnauthorized)
		return
	}
	var body SearchRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "invalid json", http.StatusBadRequest)
		return
	}
	if body.Tenant != "" && body.Tenant != tenant {
		http.Error(rw, "body tenant does not match the authenticated tenant", http.StatusForbidden)
		return
	}
	if body.IndexVersion != "" && body.IndexVersion != activeIndexVersion {
		http.Error(rw, "index version is not active", http.StatusConflict)
		return
	}
	if len(body.Query) != indexDimensions {
		http.Error(rw, "query vector has the wrong dimension", http.StatusBadRequest)
		return
	}
	k := body.K
	if k == 0 {
		k = 10
	}
	if k < 1 || k > maxK {
		http.Error(rw, "k must be between 1 and 100", http.StatusBadRequest)
		return
	}

	key := cacheKey(tenant, activeIndexVersion, queryDigest(body.Query), k)
	if cached, err := cache.Get(r.Context(), key).Result(); err == nil {
		log.Printf("search cache=hit tenant=%s k=%d version=%s", tenant, k, activeIndexVersion)
		rw.Header().Set("Content-Type", "application/json")
		rw.Write([]byte(cached))
		return
	}

	hits, err := index.Search(r.Context(), tenant, body.Query, k, activeIndexVersion)
	if err != nil {
		http.Error(rw, "index unavailable", http.StatusServiceUnavailable)
		return
	}
	payload, _ := json.Marshal(map[string]any{"hits": hits, "k": k, "index_version": activeIndexVersion})
	cache.Set(r.Context(), key, payload, cacheTTL)
	log.Printf("search cache=miss tenant=%s k=%d version=%s", tenant, k, activeIndexVersion)
	rw.Header().Set("Content-Type", "application/json")
	rw.Write(payload)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/search", search)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.nio.charset.StandardCharsets

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class SearchRequest(query: List[Double], k: Int, tenant: String)

trait Index {
  def search(tenant: String, query: List[Double], k: Int, version: String): List[String]
}

object Index {
  def open(): Index = new Index {
    def search(tenant: String, query: List[Double], k: Int, version: String): List[String] = Nil
  }
}

object SearchApi {
  implicit val system: ActorSystem = ActorSystem("vector-search")
  implicit val searchFormat: RootJsonFormat[SearchRequest] = jsonFormat3(SearchRequest)

  val ActiveIndexVersion = "idx-42"
  val index: Index = Index.open()
  val cache = new Jedis("redis", 6379)

  def queryDigest(query: List[Double]): String = query.mkString(",").getBytes(StandardCharsets.UTF_8).hashCode.toString

  val route: Route =
    path("v1" / "search") {
      post {
        entity(as[SearchRequest]) { body =>
          // TODO: the key is the digest and k alone, so the first tenant to run a query populates an
          // entry that every other tenant then reads. The draft also deletes entries by hand instead
          // of giving them a TTL, and it takes the tenant straight from the body.
          val k = math.max(1, math.min(body.k, 100))
          val key = s"search:\${queryDigest(body.query)}:$k"
          val cached = cache.get(key)
          if (cached != null) {
            complete(StatusCodes.OK, cached)
          } else {
            cache.del(key)
            val hits = index.search(body.tenant, body.query, k, ActiveIndexVersion)
            val payload = s"""{"k":$k,"index_version":"$ActiveIndexVersion","hits":\${hits.size}}"""
            cache.set(key, payload)
            complete(StatusCodes.OK, payload)
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.ByteBuffer
import java.security.MessageDigest

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class SearchRequest(query: List[Double], k: Int, tenant: Option[String], index_version: Option[String])

trait Index {
  def search(tenant: String, query: List[Double], k: Int, version: String): List[String]
}

object Index {
  def open(): Index = new Index {
    def search(tenant: String, query: List[Double], k: Int, version: String): List[String] = Nil
  }
}

object SearchApi {
  implicit val system: ActorSystem = ActorSystem("vector-search")
  implicit val searchFormat: RootJsonFormat[SearchRequest] = jsonFormat4(SearchRequest)

  val TtlSeconds = 60
  val MaxK = 100
  val IndexDimensions = 768
  val ActiveIndexVersion = "idx-42"

  val index: Index = Index.open()
  val cache = new Jedis("redis", 6379)

  def queryDigest(query: List[Double]): String = {
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteBuffer.allocate(query.length * 8)
    query.foreach(value => buffer.putDouble(value))
    digest.digest(buffer.array()).take(16).map("%02x".format(_)).mkString
  }

  def cacheKey(tenant: String, version: String, digest: String, k: Int): String =
    s"search:$tenant:$version:$digest:$k"

  val route: Route =
    path("v1" / "search") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[SearchRequest]) { body =>
            tenantOpt.filter(_.nonEmpty) match {
              case None =>
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              case Some(tenant) if body.tenant.exists(_ != tenant) =>
                complete(StatusCodes.Forbidden, """{"error":"body tenant does not match the authenticated tenant"}""")
              case Some(_) if body.index_version.exists(_ != ActiveIndexVersion) =>
                complete(StatusCodes.Conflict, """{"error":"index version is not active"}""")
              case Some(_) if body.query.length != IndexDimensions =>
                complete(StatusCodes.BadRequest, """{"error":"query vector has the wrong dimension"}""")
              case Some(_) if body.k < 1 || body.k > MaxK =>
                complete(StatusCodes.BadRequest, """{"error":"k must be between 1 and 100"}""")
              case Some(tenant) =>
                val key = cacheKey(tenant, ActiveIndexVersion, queryDigest(body.query), body.k)
                val cached = cache.get(key)
                if (cached != null) {
                  system.log.info(s"search cache=hit tenant=$tenant k=\${body.k}")
                  complete(StatusCodes.OK, cached)
                } else {
                  val hits = index.search(tenant, body.query, body.k, ActiveIndexVersion)
                  val payload = s"""{"k":\${body.k},"index_version":"$ActiveIndexVersion","hits":\${hits.size}}"""
                  cache.setex(key, TtlSeconds, payload)
                  system.log.info(s"search cache=miss tenant=$tenant k=\${body.k}")
                  complete(StatusCodes.OK, payload)
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

#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kActiveIndexVersion = "idx-42";

auto cache = sw::redis::Redis("redis://redis:6379");

struct Index {
  json search(const std::string& tenant, const std::vector<double>& query, int k, const std::string& version);
};

Index index;

std::string queryDigest(const std::vector<double>& query) {
  std::ostringstream out;
  out << std::setprecision(17);
  for (double value : query) {
    out << value << ',';
  }
  return out.str();
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/search", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: the key is the digest and k alone, so the first tenant to run a query populates an entry
    // that every other tenant then reads. The draft also deletes entries by hand instead of giving
    // them a TTL, and it takes the tenant straight from the body.
    const auto tenant = body.value("tenant", std::string());
    const auto query = body.value("query", std::vector<double>());
    const int k = body.value("k", 10);
    const std::string key = "search:" + queryDigest(query) + ":" + std::to_string(k);
    const auto cached = cache.get(key);
    if (cached) {
      res.status = 200;
      res.set_content(*cached, "application/json");
      return;
    }
    cache.del(key);
    const json hits = index.search(tenant, query, k, kActiveIndexVersion);
    const std::string payload = json{{"hits", hits}, {"k", k}, {"index_version", kActiveIndexVersion}}.dump();
    cache.set(key, payload);
    res.status = 200;
    res.set_content(payload, "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kMaxK = 100;
constexpr std::size_t kIndexDimensions = 768;
const std::string kActiveIndexVersion = "idx-42";
constexpr int kCacheTtlSeconds = 60;
constexpr uint64_t kFnvOffsetBasis = 14695981039346656037ULL;
constexpr uint64_t kFnvPrime = 1099511628211ULL;

auto cache = sw::redis::Redis("redis://redis:6379");

struct Index {
  json search(const std::string& tenant, const std::vector<double>& query, int k, const std::string& version);
};

Index index;

std::string queryDigest(const std::vector<double>& query) {
  uint64_t digest = kFnvOffsetBasis;
  for (double value : query) {
    uint64_t bits;
    std::memcpy(&bits, &value, sizeof(bits));
    for (int shift = 0; shift < 64; shift += 8) {
      digest ^= (bits >> shift) & 0xFFULL;
      digest *= kFnvPrime;
    }
  }
  std::ostringstream out;
  out << std::hex << std::setfill('0') << std::setw(16) << digest;
  return out.str();
}

std::string cacheKey(const std::string& tenant, const std::string& version, const std::string& digest, int k) {
  return "search:" + tenant + ":" + version + ":" + digest + ":" + std::to_string(k);
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/search", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto bodyTenant = body.value("tenant", std::string());
    if (!bodyTenant.empty() && bodyTenant != tenant) {
      res.status = 403;
      res.set_content(R"({"error":"body tenant does not match the authenticated tenant"})", "application/json");
      return;
    }
    const auto requestedVersion = body.value("index_version", std::string());
    if (!requestedVersion.empty() && requestedVersion != kActiveIndexVersion) {
      res.status = 409;
      res.set_content(R"({"error":"index version is not active"})", "application/json");
      return;
    }
    const auto query = body.value("query", std::vector<double>());
    if (query.size() != kIndexDimensions) {
      res.status = 400;
      res.set_content(R"({"error":"query vector has the wrong dimension"})", "application/json");
      return;
    }
    const int k = body.value("k", 10);
    if (k < 1 || k > kMaxK) {
      res.status = 400;
      res.set_content(R"({"error":"k must be between 1 and 100"})", "application/json");
      return;
    }

    const std::string key = cacheKey(tenant, kActiveIndexVersion, queryDigest(query), k);
    const auto cached = cache.get(key);
    if (cached) {
      std::clog << "search cache=hit tenant=" << tenant << " k=" << k << "\\n";
      res.status = 200;
      res.set_content(*cached, "application/json");
      return;
    }

    const json hits = index.search(tenant, query, k, kActiveIndexVersion);
    const std::string payload =
        json{{"hits", hits}, {"k", k}, {"index_version", kActiveIndexVersion}}.dump();
    cache.set(key, payload, std::chrono::seconds(kCacheTtlSeconds));
    std::clog << "search cache=miss tenant=" << tenant << " k=" << k << "\\n";
    res.status = 200;
    res.set_content(payload, "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The cache key is the security boundary of a tenant-scoped service, and the draft's key is a
model-generated sentence that reads fine: hash the query, append the cap, cache the hits. The four
things a reviewer has to notice are that the key must name the tenant (otherwise one tenant's
popular query populates an entry another tenant reads), the index version (otherwise a hit can outlive
the snapshot it came from), the digest must be built from the vector's bytes rather than its formatted
text, and expiry — not deletion — is what bounds staleness. Two tenants embedding different private
corpora can produce the very same vector, so a tenant-less key is not a cache miss waiting to happen,
it is a cross-tenant read waiting to happen. Real services add a per-tenant hit-rate metric so a
missing key component shows up as a traffic spike rather than a support ticket, and a key-version bump
so a bad cache can be drained without flushing everyone's entries.
`,
};
