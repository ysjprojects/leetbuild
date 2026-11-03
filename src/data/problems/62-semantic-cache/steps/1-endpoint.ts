import type {Step} from '@/lib/types';

export const lookupEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/semantic-cache/lookup: a floor the caller cannot lower',
  concept: 'http',
  file: 'api',
  focus: ['client', 'cache', 'policy', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/semantic-cache/lookup\` with body
\`{"query_embedding": [..], "model_version": "2024-06", "threshold": 0.9}\`: it reads the tenant
from \`X-Tenant-Id\` (**401** without one), asks the store for the nearest entry above the caller's
threshold, publishes a result event and answers \`{"answer": ...}\`. It serves the demo and hides
four flaws.

**Failure mode the checks target.** A caller's threshold of zero makes the nearest entry a hit
whatever it says, so the cache keeps "working" while answering the wrong question. An entry past
its expiry is still served. And a bare \`answer\` gives the caller no way to tell a hit from a miss or
to judge the hit.

- \`effective_threshold(requested)\` clamps the caller's value into \`[SIMILARITY_FLOOR,
  MAX_SIMILARITY_THRESHOLD]\` = \`[0.82, 0.99]\` before it reaches \`search_entries\`.
- \`is_live(entry, now)\`: an entry is served only while \`expires_at > now\`; otherwise the lookup
  is a miss. The store returns the nearest entry expired or not, and a hash restored from a dump
  may carry no TTL.
- A hit answers \`{"hit": true, "answer", "entry_id", "similarity", "age_seconds",
  "policy_version"}\` with \`age_seconds = now - created_at\`.
- A miss answers \`{"hit": false, "similarity": null}\` and nothing else.
- Every lookup still publishes one result event (\`publish_result\`, step 4) with the outcome, the
  entry id, the similarity, the entry's policy version, the \`X-Client-Class\` (\`human\` by default)
  and the entry's age.`,
  sequence: {
    participants: ['Client', 'Semantic Cache', 'Redis', 'Kafka'],
    messages: [
      {
        from: 'Client',
        to: 'Semantic Cache',
        label: 'POST /v1/semantic-cache/lookup · X-Tenant-Id · threshold 0',
        kind: 'sync',
      },
      {from: 'Semantic Cache', to: 'Semantic Cache', label: 'effective_threshold(0) = 0.82', kind: 'sync'},
      {
        from: 'Semantic Cache',
        to: 'Redis',
        label: 'search_entries(tenant, model_version, embedding, 0.82)',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Semantic Cache', label: 'nearest entry · similarity · expires_at', kind: 'reply'},
      {from: 'Semantic Cache', to: 'Semantic Cache', label: 'is_live(entry, now)', kind: 'sync'},
      {
        from: 'Semantic Cache',
        to: 'Kafka',
        label: 'publish_result(tenant, {outcome, entry_id, similarity, …})',
        kind: 'async',
      },
      {
        from: 'Semantic Cache',
        to: 'Client',
        label: '200 {hit, answer, similarity, age_seconds} or {hit: false, similarity: null}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'A question about delivery gets the refund answer, a lookup made the day after the entry expired still gets it, and the client cannot tell either hit from a miss.',
    'The threshold goes to the store as the caller sent it, so 0 means "the nearest entry, whatever it is"; nothing compares `expires_at` to the clock; and the response is the same shape on a hit and on a miss.',
    'Clamp with `effective_threshold` before the search, drop an entry that fails `is_live(entry, now)`, answer a hit with `hit`, `answer`, `entry_id`, `similarity`, `age_seconds`, `policy_version`, and a miss with `hit: false, similarity: null`.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Serves POST /v1/semantic-cache/lookup for an authenticated tenant',
      detail: 'The route answers 200 for a tenant with `X-Tenant-Id` and 401 without one.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/semantic-cache\/lookup["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/semantic-cache\/lookup['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/semantic-cache\/lookup"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"semantic-cache"\s*\/\s*"lookup"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/semantic-cache\/lookup"/]},
      },
    },
    {
      id: 'floor',
      title: 'Clamps the caller threshold into the service range',
      detail:
        'The requested threshold is clamped into `[0.82, 0.99]` before the search, so a caller-sent 0 cannot make an unrelated entry a hit and a caller-sent 1.0 cannot reject every hit. The starter passes the value straight through.',
      match: {
        python: {all: [/SIMILARITY_FLOOR|0\.82/], none: [/,\s*body\.threshold\s*\)/]},
        typescript: {all: [/SIMILARITY_FLOOR|0\.82/], none: [/,\s*body\.threshold(\s*\?\?\s*[\d.]+)?\s*\)/]},
        go: {all: [/similarityFloor|0\.82/], none: [/,\s*threshold\s*\)/]},
        scala: {all: [/SimilarityFloor|0\.82/], none: [/,\s*threshold\s*\)/]},
        cpp: {all: [/kSimilarityFloor|0\.82/], none: [/,\s*threshold\s*\)/]},
      },
    },
    {
      id: 'expiry',
      title: 'An entry past its expiry is a miss',
      detail:
        'An entry is served only while `expires_at > now` (`is_live`). The store hands back the nearest entry whatever its age, and a hash without a TTL (restored, migrated) outlives its expiry; the starter serves it.',
      match: {
        python: {all: [/\bexpires_at\b/]},
        typescript: {all: [/\bexpires_at\b/]},
        go: {all: [/\.ExpiresAt\b/]},
        scala: {all: [/\bexpiresAt\b/]},
        cpp: {all: [/\bexpires_at\b/]},
      },
    },
    {
      id: 'hit-shape',
      title: 'A hit reports its similarity and the entry age',
      detail:
        'A hit is `{"hit": true, "answer", "entry_id", "similarity", "age_seconds", "policy_version"}`: the similarity and the age let the caller judge the hit. The starter answers only the text.',
      match: {
        python: {all: [/["']age_seconds["']/, /["']hit["']\s*:\s*True/]},
        typescript: {all: [/\bage_seconds\b/, /\bhit:\s*true\b/]},
        go: {all: [/"age_seconds"/, /"hit":\s*true/]},
        scala: {all: [/"age_seconds"/, /"hit"\s*->\s*true/]},
        cpp: {all: [/"age_seconds"/, /\{"hit",\s*true\}/]},
      },
    },
    {
      id: 'miss',
      title: 'A miss is a miss, not an empty answer',
      detail:
        'A miss answers `{"hit": false, "similarity": null}`; the starter answers `{"answer": null}`, which a client cannot tell from a hit whose answer is empty.',
      match: {
        python: {all: [/["']hit["']\s*:\s*False/], none: [/["']answer["']\s*:\s*None/]},
        typescript: {all: [/\bhit:\s*false\b/], none: [/\banswer:\s*null\b/]},
        go: {all: [/"hit":\s*false/], none: [/"answer":\s*nil/]},
        scala: {all: [/"hit"\s*->\s*false/], none: [/"answer"\s*->\s*ujson\.Null/]},
        cpp: {all: [/\{"hit",\s*false\}/], none: [/\{"answer",\s*nullptr\}/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""POST /v1/semantic-cache/lookup: the nearest stored answer for a query embedding."""
import logging
import time

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import events  # publish_result(tenant, result): one semantic-cache.result event per lookup (step 4)
import state  # search_entries(tenant, model_version, embedding, threshold): the nearest entry or None (step 2)

app = FastAPI()
logger = logging.getLogger("semantic-cache")


class LookupRequest(BaseModel):
    query_embedding: list[float]
    model_version: str = "2024-06"
    threshold: float = 0.9


@app.post("/v1/semantic-cache/lookup")
def lookup(
    body: LookupRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    client_class: str = Header(default="human", alias="X-Client-Class"),
) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    if not tenant:
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    now = time.time()
    entry = state.search_entries(tenant, body.model_version, body.query_embedding, body.threshold)
    if entry is None:
        logger.info("lookup tenant=%s miss", tenant)
        events.publish_result(tenant, {"outcome": "miss", "entry_id": "", "similarity": None, "policy_version": "", "model_version": body.model_version, "client_class": client_class, "entry_age_seconds": 0})
        return JSONResponse({"answer": None})
    age = max(0, int(now - entry["created_at"]))
    logger.info("lookup tenant=%s entry_id=%s similarity=%.3f", tenant, entry["entry_id"], entry["similarity"])
    events.publish_result(tenant, {"outcome": "hit", "entry_id": entry["entry_id"], "similarity": entry["similarity"], "policy_version": entry["policy_version"], "model_version": body.model_version, "client_class": client_class, "entry_age_seconds": age})
    return JSONResponse({"answer": entry["answer"]})
`,
      solution: `"""POST /v1/semantic-cache/lookup: the nearest stored answer, above a floor the caller cannot lower."""
import logging
import time

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import events  # publish_result(tenant, result): one semantic-cache.result event per lookup (step 4)
import state  # search_entries(tenant, model_version, embedding, threshold): the nearest entry or None (step 2)

app = FastAPI()
logger = logging.getLogger("semantic-cache")

SIMILARITY_FLOOR = 0.82
MAX_SIMILARITY_THRESHOLD = 0.99


class LookupRequest(BaseModel):
    query_embedding: list[float]
    model_version: str = "2024-06"
    threshold: float = 0.9


def effective_threshold(requested: float) -> float:
    """The caller's threshold is a hint: the service decides the range."""
    return min(max(requested, SIMILARITY_FLOOR), MAX_SIMILARITY_THRESHOLD)


def is_live(entry: dict, now: float) -> bool:
    return entry["expires_at"] > now


@app.post("/v1/semantic-cache/lookup")
def lookup(
    body: LookupRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    client_class: str = Header(default="human", alias="X-Client-Class"),
) -> JSONResponse:
    if not tenant:
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    now = time.time()
    entry = state.search_entries(tenant, body.model_version, body.query_embedding, effective_threshold(body.threshold))
    if entry is None or not is_live(entry, now):
        logger.info("lookup tenant=%s miss", tenant)
        events.publish_result(tenant, {"outcome": "miss", "entry_id": "", "similarity": None, "policy_version": "", "model_version": body.model_version, "client_class": client_class, "entry_age_seconds": 0})
        return JSONResponse({"hit": False, "similarity": None})
    age = max(0, int(now - entry["created_at"]))
    logger.info("lookup tenant=%s entry_id=%s similarity=%.3f", tenant, entry["entry_id"], entry["similarity"])
    events.publish_result(tenant, {"outcome": "hit", "entry_id": entry["entry_id"], "similarity": entry["similarity"], "policy_version": entry["policy_version"], "model_version": body.model_version, "client_class": client_class, "entry_age_seconds": age})
    return JSONResponse(
        {
            "hit": True,
            "answer": entry["answer"],
            "entry_id": entry["entry_id"],
            "similarity": entry["similarity"],
            "age_seconds": age,
            "policy_version": entry["policy_version"],
        }
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/semantic-cache/lookup: the nearest stored answer for a query embedding. */
import Fastify from 'fastify';

import {publishResult} from './events'; // one semantic-cache.result event per lookup (step 4)
import {searchEntries} from './state'; // the nearest entry at or above a threshold, or null (step 2)

export const app = Fastify();

interface LookupBody {
  query_embedding: number[];
  model_version?: string;
  threshold?: number;
}

app.post('/v1/semantic-cache/lookup', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const clientClass = (request.headers['x-client-class'] as string | undefined) ?? 'human';
  const body = request.body as LookupBody;
  const modelVersion = body.model_version ?? '2024-06';
  const now = Date.now() / 1000;
  const entry = await searchEntries(tenant, modelVersion, body.query_embedding, body.threshold ?? 0.9);
  if (entry === null) {
    request.log.info({tenant}, 'lookup miss');
    await publishResult(tenant, {outcome: 'miss', entry_id: '', similarity: null, policy_version: '', model_version: modelVersion, client_class: clientClass, entry_age_seconds: 0});
    return reply.send({answer: null});
  }
  const age = Math.max(0, Math.floor(now - entry.created_at));
  request.log.info({tenant, entry_id: entry.entry_id, similarity: entry.similarity}, 'lookup hit');
  await publishResult(tenant, {outcome: 'hit', entry_id: entry.entry_id, similarity: entry.similarity, policy_version: entry.policy_version, model_version: modelVersion, client_class: clientClass, entry_age_seconds: age});
  return reply.send({answer: entry.answer});
});
`,
      solution: `/** POST /v1/semantic-cache/lookup: the nearest stored answer, above a floor the caller cannot lower. */
import Fastify from 'fastify';

import {publishResult} from './events'; // one semantic-cache.result event per lookup (step 4)
import {type CacheEntry, searchEntries} from './state'; // the nearest entry at or above a threshold, or null (step 2)

export const app = Fastify();

export const SIMILARITY_FLOOR = 0.82;
export const MAX_SIMILARITY_THRESHOLD = 0.99;

interface LookupBody {
  query_embedding: number[];
  model_version?: string;
  threshold?: number;
}

/** The caller's threshold is a hint: the service decides the range. */
export function effectiveThreshold(requested: number): number {
  return Math.min(Math.max(requested, SIMILARITY_FLOOR), MAX_SIMILARITY_THRESHOLD);
}

export function isLive(entry: CacheEntry, now: number): boolean {
  return entry.expires_at > now;
}

app.post('/v1/semantic-cache/lookup', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const clientClass = (request.headers['x-client-class'] as string | undefined) ?? 'human';
  const body = request.body as LookupBody;
  const modelVersion = body.model_version ?? '2024-06';
  const now = Date.now() / 1000;
  const entry = await searchEntries(tenant, modelVersion, body.query_embedding, effectiveThreshold(body.threshold ?? 0.9));
  if (entry === null || !isLive(entry, now)) {
    request.log.info({tenant}, 'lookup miss');
    await publishResult(tenant, {outcome: 'miss', entry_id: '', similarity: null, policy_version: '', model_version: modelVersion, client_class: clientClass, entry_age_seconds: 0});
    return reply.send({hit: false, similarity: null});
  }
  const age = Math.max(0, Math.floor(now - entry.created_at));
  request.log.info({tenant, entry_id: entry.entry_id, similarity: entry.similarity}, 'lookup hit');
  await publishResult(tenant, {outcome: 'hit', entry_id: entry.entry_id, similarity: entry.similarity, policy_version: entry.policy_version, model_version: modelVersion, client_class: clientClass, entry_age_seconds: age});
  return reply.send({
    hit: true,
    answer: entry.answer,
    entry_id: entry.entry_id,
    similarity: entry.similarity,
    age_seconds: age,
    policy_version: entry.policy_version,
  });
});
`,
    },
    go: {
      starter: `// POST /v1/semantic-cache/lookup: the nearest stored answer for a query embedding.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

type lookupBody struct {
	QueryEmbedding []float64 \`json:"query_embedding"\`
	ModelVersion   string    \`json:"model_version"\`
	Threshold      *float64  \`json:"threshold"\`
}

// Entry is one stored answer as the store (step 2) returns it.
type Entry struct {
	EntryID       string
	Answer        string
	Similarity    float64
	CreatedAt     float64
	ExpiresAt     float64
	PolicyVersion string
}

// ResultEvent is what the lookup knows when it answers; the result stream (step 4) puts it on the wire.
type ResultEvent struct {
	Outcome         string   // "hit" or "miss"
	EntryID         string   // "" on a miss
	Similarity      *float64 // nil on a miss
	PolicyVersion   string   // the entry's; "" on a miss
	ModelVersion    string
	ClientClass     string // "human" or "automated", from X-Client-Class
	EntryAgeSeconds int64  // 0 on a miss
}

var (
	// searchEntries is the nearest entry at or above threshold, expired or not, or nil (state, step 2).
	searchEntries = func(ctx context.Context, tenant, modelVersion string, embedding []float64, threshold float64) (*Entry, error) {
		panic("provided by state (step 2)")
	}
	// publishResult puts one semantic-cache.result event on the topic, keyed by tenant (events, step 4).
	publishResult = func(ctx context.Context, tenant string, result ResultEvent) error { panic("provided by events (step 4)") }
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func lookup(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]any{"error": "missing X-Tenant-Id"})
		return
	}
	var body lookupBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]any{"error": "invalid JSON"})
		return
	}
	if body.ModelVersion == "" {
		body.ModelVersion = "2024-06"
	}
	threshold := 0.9
	if body.Threshold != nil {
		threshold = *body.Threshold
	}
	clientClass := r.Header.Get("X-Client-Class")
	if clientClass == "" {
		clientClass = "human"
	}
	now := float64(time.Now().UnixMilli()) / 1000
	entry, err := searchEntries(r.Context(), tenant, body.ModelVersion, body.QueryEmbedding, threshold)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if entry == nil {
		log.Printf("lookup tenant=%s miss", tenant)
		publishResult(r.Context(), tenant, ResultEvent{Outcome: "miss", ModelVersion: body.ModelVersion, ClientClass: clientClass})
		writeJSON(rw, http.StatusOK, map[string]any{"answer": nil})
		return
	}
	age := int64(max(0, now-entry.CreatedAt))
	log.Printf("lookup tenant=%s entry_id=%s similarity=%.3f", tenant, entry.EntryID, entry.Similarity)
	publishResult(r.Context(), tenant, ResultEvent{Outcome: "hit", EntryID: entry.EntryID, Similarity: &entry.Similarity, PolicyVersion: entry.PolicyVersion, ModelVersion: body.ModelVersion, ClientClass: clientClass, EntryAgeSeconds: age})
	writeJSON(rw, http.StatusOK, map[string]any{"answer": entry.Answer})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/semantic-cache/lookup", lookup)
}
`,
      solution: `// POST /v1/semantic-cache/lookup: the nearest stored answer, above a floor the caller cannot lower.
package main

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"time"
)

const (
	similarityFloor        = 0.82
	maxSimilarityThreshold = 0.99
)

type lookupBody struct {
	QueryEmbedding []float64 \`json:"query_embedding"\`
	ModelVersion   string    \`json:"model_version"\`
	Threshold      *float64  \`json:"threshold"\`
}

// Entry is one stored answer as the store (step 2) returns it.
type Entry struct {
	EntryID       string
	Answer        string
	Similarity    float64
	CreatedAt     float64
	ExpiresAt     float64
	PolicyVersion string
}

// ResultEvent is what the lookup knows when it answers; the result stream (step 4) puts it on the wire.
type ResultEvent struct {
	Outcome         string   // "hit" or "miss"
	EntryID         string   // "" on a miss
	Similarity      *float64 // nil on a miss
	PolicyVersion   string   // the entry's; "" on a miss
	ModelVersion    string
	ClientClass     string // "human" or "automated", from X-Client-Class
	EntryAgeSeconds int64  // 0 on a miss
}

var (
	// searchEntries is the nearest entry at or above threshold, expired or not, or nil (state, step 2).
	searchEntries = func(ctx context.Context, tenant, modelVersion string, embedding []float64, threshold float64) (*Entry, error) {
		panic("provided by state (step 2)")
	}
	// publishResult puts one semantic-cache.result event on the topic, keyed by tenant (events, step 4).
	publishResult = func(ctx context.Context, tenant string, result ResultEvent) error { panic("provided by events (step 4)") }
)

// effectiveThreshold clamps the caller's hint into the range the service decides.
func effectiveThreshold(requested float64) float64 {
	return math.Min(math.Max(requested, similarityFloor), maxSimilarityThreshold)
}

func isLive(entry *Entry, now float64) bool {
	return entry.ExpiresAt > now
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func lookup(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]any{"error": "missing X-Tenant-Id"})
		return
	}
	var body lookupBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]any{"error": "invalid JSON"})
		return
	}
	if body.ModelVersion == "" {
		body.ModelVersion = "2024-06"
	}
	threshold := 0.9
	if body.Threshold != nil {
		threshold = *body.Threshold
	}
	clientClass := r.Header.Get("X-Client-Class")
	if clientClass == "" {
		clientClass = "human"
	}
	now := float64(time.Now().UnixMilli()) / 1000
	entry, err := searchEntries(r.Context(), tenant, body.ModelVersion, body.QueryEmbedding, effectiveThreshold(threshold))
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if entry == nil || !isLive(entry, now) {
		log.Printf("lookup tenant=%s miss", tenant)
		publishResult(r.Context(), tenant, ResultEvent{Outcome: "miss", ModelVersion: body.ModelVersion, ClientClass: clientClass})
		writeJSON(rw, http.StatusOK, map[string]any{"hit": false, "similarity": nil})
		return
	}
	age := int64(max(0, now-entry.CreatedAt))
	log.Printf("lookup tenant=%s entry_id=%s similarity=%.3f", tenant, entry.EntryID, entry.Similarity)
	publishResult(r.Context(), tenant, ResultEvent{Outcome: "hit", EntryID: entry.EntryID, Similarity: &entry.Similarity, PolicyVersion: entry.PolicyVersion, ModelVersion: body.ModelVersion, ClientClass: clientClass, EntryAgeSeconds: age})
	writeJSON(rw, http.StatusOK, map[string]any{
		"hit":            true,
		"answer":         entry.Answer,
		"entry_id":       entry.EntryID,
		"similarity":     entry.Similarity,
		"age_seconds":    age,
		"policy_version": entry.PolicyVersion,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/semantic-cache/lookup", lookup)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

/** POST /v1/semantic-cache/lookup: the nearest stored answer for a query embedding. */
object Api {
  private def json(status: StatusCode, value: ujson.Value): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(value)))

  val route: Route =
    path("v1" / "semantic-cache" / "lookup") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
          optionalHeaderValueByName("X-Client-Class") { clientClass =>
            entity(as[String]) { raw =>
              // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
              tenantHeader.filter(_.nonEmpty) match {
                case None => complete(json(StatusCodes.Unauthorized, ujson.Obj("error" -> "missing X-Tenant-Id")))
                case Some(tenant) =>
                  val body = ujson.read(raw)
                  val embedding = body("query_embedding").arr.map(_.num).toSeq
                  val modelVersion = body.obj.get("model_version").map(_.str).getOrElse("2024-06")
                  val threshold = body.obj.get("threshold").map(_.num).getOrElse(0.9)
                  val cls = clientClass.getOrElse("human")
                  val now = System.currentTimeMillis() / 1000.0
                  State.searchEntries(tenant, modelVersion, embedding, threshold) match {
                    case None =>
                      Events.publishResult(tenant, Events.ResultEvent("miss", "", None, "", modelVersion, cls, 0L))
                      complete(json(StatusCodes.OK, ujson.Obj("answer" -> ujson.Null)))
                    case Some(entry) =>
                      val age = math.max(0L, (now - entry.createdAt).toLong)
                      Events.publishResult(tenant, Events.ResultEvent("hit", entry.entryId, Some(entry.similarity), entry.policyVersion, modelVersion, cls, age))
                      complete(json(StatusCodes.OK, ujson.Obj("answer" -> entry.answer)))
                  }
              }
            }
          }
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

/** POST /v1/semantic-cache/lookup: the nearest stored answer, above a floor the caller cannot lower. */
object Api {
  val SimilarityFloor = 0.82
  val MaxSimilarityThreshold = 0.99

  /** The caller's threshold is a hint: the service decides the range. */
  def effectiveThreshold(requested: Double): Double = math.min(math.max(requested, SimilarityFloor), MaxSimilarityThreshold)

  def isLive(entry: State.Entry, now: Double): Boolean = entry.expiresAt > now

  private def json(status: StatusCode, value: ujson.Value): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(value)))

  val route: Route =
    path("v1" / "semantic-cache" / "lookup") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
          optionalHeaderValueByName("X-Client-Class") { clientClass =>
            entity(as[String]) { raw =>
              tenantHeader.filter(_.nonEmpty) match {
                case None => complete(json(StatusCodes.Unauthorized, ujson.Obj("error" -> "missing X-Tenant-Id")))
                case Some(tenant) =>
                  val body = ujson.read(raw)
                  val embedding = body("query_embedding").arr.map(_.num).toSeq
                  val modelVersion = body.obj.get("model_version").map(_.str).getOrElse("2024-06")
                  val threshold = body.obj.get("threshold").map(_.num).getOrElse(0.9)
                  val cls = clientClass.getOrElse("human")
                  val now = System.currentTimeMillis() / 1000.0
                  State.searchEntries(tenant, modelVersion, embedding, effectiveThreshold(threshold)).filter(isLive(_, now)) match {
                    case None =>
                      Events.publishResult(tenant, Events.ResultEvent("miss", "", None, "", modelVersion, cls, 0L))
                      complete(json(StatusCodes.OK, ujson.Obj("hit" -> false, "similarity" -> ujson.Null)))
                    case Some(entry) =>
                      val age = math.max(0L, (now - entry.createdAt).toLong)
                      Events.publishResult(tenant, Events.ResultEvent("hit", entry.entryId, Some(entry.similarity), entry.policyVersion, modelVersion, cls, age))
                      complete(json(StatusCodes.OK, ujson.Obj(
                        "hit" -> true,
                        "answer" -> entry.answer,
                        "entry_id" -> entry.entryId,
                        "similarity" -> entry.similarity,
                        "age_seconds" -> age.toInt,
                        "policy_version" -> entry.policyVersion)))
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
      starter: `// POST /v1/semantic-cache/lookup: the nearest stored answer for a query embedding.
#include <httplib.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <iostream>
#include <string>
#include <vector>

#include "events.h"  // publish_result(tenant, ResultEvent): one semantic-cache.result event per lookup (step 4)
#include "state.h"   // search_entries(tenant, model_version, embedding, threshold): the nearest entry or nullopt (step 2)

using json = nlohmann::json;

void lookup(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(json{{"error", "missing X-Tenant-Id"}}.dump(), "application/json");
    return;
  }
  json body;
  try {
    body = json::parse(req.body);
  } catch (const json::exception&) {
    res.status = 400;
    res.set_content(json{{"error", "invalid JSON"}}.dump(), "application/json");
    return;
  }
  const std::vector<double> embedding = body.value("query_embedding", std::vector<double>{});
  const std::string model_version = body.value("model_version", std::string("2024-06"));
  const double threshold = body.value("threshold", 0.9);
  const std::string client_class = req.has_header("X-Client-Class") ? req.get_header_value("X-Client-Class") : "human";
  const double now = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::optional<Entry> entry = search_entries(tenant, model_version, embedding, threshold);
  if (!entry) {
    std::cerr << "lookup tenant=" << tenant << " miss\\n";
    publish_result(tenant, ResultEvent{"miss", "", std::nullopt, "", model_version, client_class, 0});
    res.set_content(json{{"answer", nullptr}}.dump(), "application/json");
    return;
  }
  const long age = std::max(0L, static_cast<long>(now - entry->created_at));
  std::cerr << "lookup tenant=" << tenant << " entry_id=" << entry->entry_id << " similarity=" << entry->similarity << "\\n";
  publish_result(tenant, ResultEvent{"hit", entry->entry_id, entry->similarity, entry->policy_version, model_version, client_class, age});
  res.set_content(json{{"answer", entry->answer}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/semantic-cache/lookup", lookup); }
`,
      solution: `// POST /v1/semantic-cache/lookup: the nearest stored answer, above a floor the caller cannot lower.
#include <httplib.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <iostream>
#include <string>
#include <vector>

#include "events.h"  // publish_result(tenant, ResultEvent): one semantic-cache.result event per lookup (step 4)
#include "state.h"   // search_entries(tenant, model_version, embedding, threshold): the nearest entry or nullopt (step 2)

using json = nlohmann::json;

constexpr double kSimilarityFloor = 0.82;
constexpr double kMaxSimilarityThreshold = 0.99;

// The caller's threshold is a hint: the service decides the range.
double effective_threshold(double requested) {
  return std::min(std::max(requested, kSimilarityFloor), kMaxSimilarityThreshold);
}

bool is_live(const Entry& entry, double now) { return entry.expires_at > now; }

void lookup(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(json{{"error", "missing X-Tenant-Id"}}.dump(), "application/json");
    return;
  }
  json body;
  try {
    body = json::parse(req.body);
  } catch (const json::exception&) {
    res.status = 400;
    res.set_content(json{{"error", "invalid JSON"}}.dump(), "application/json");
    return;
  }
  const std::vector<double> embedding = body.value("query_embedding", std::vector<double>{});
  const std::string model_version = body.value("model_version", std::string("2024-06"));
  const double threshold = body.value("threshold", 0.9);
  const std::string client_class = req.has_header("X-Client-Class") ? req.get_header_value("X-Client-Class") : "human";
  const double now = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::optional<Entry> entry = search_entries(tenant, model_version, embedding, effective_threshold(threshold));
  if (!entry || !is_live(*entry, now)) {
    std::cerr << "lookup tenant=" << tenant << " miss\\n";
    publish_result(tenant, ResultEvent{"miss", "", std::nullopt, "", model_version, client_class, 0});
    res.set_content(json{{"hit", false}, {"similarity", nullptr}}.dump(), "application/json");
    return;
  }
  const long age = std::max(0L, static_cast<long>(now - entry->created_at));
  std::cerr << "lookup tenant=" << tenant << " entry_id=" << entry->entry_id << " similarity=" << entry->similarity << "\\n";
  publish_result(tenant, ResultEvent{"hit", entry->entry_id, entry->similarity, entry->policy_version, model_version, client_class, age});
  res.set_content(json{{"hit", true},
                       {"answer", entry->answer},
                       {"entry_id", entry->entry_id},
                       {"similarity", entry->similarity},
                       {"age_seconds", age},
                       {"policy_version", entry->policy_version}}
                      .dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/semantic-cache/lookup", lookup); }
`,
    },
  },
  harness: {
    python: `import json

MV = "2024-06"
V = [1.0, 0.0, 0.0, 0.0]
NEAR = [0.9, 0.1, 0.0, 0.0]  # cosine 0.994 to V
SO_SO = [0.6, 0.8, 0.0, 0.0]  # cosine 0.6 to V
ANSWER = "Refunds take five business days."
ACME = {"X-Tenant-Id": "acme"}


def _seed(ctx, entry_id, embedding, answer=ANSWER, age=0, expires_in=86400, tenant="acme"):
    """An entry as the store writes it, from another worker: created age seconds ago, no TTL on the key."""
    key = f"entry:{tenant}:{MV}:{entry_id}"
    now = ctx.clock.time()
    ctx.redis.hset(key, mapping={"embedding": json.dumps(embedding), "answer": answer, "created_at": now - age, "expires_at": now + expires_in, "policy_version": "2024-06-1"})
    ctx.redis.sadd(f"semantic:{tenant}:{MV}", key)


async def _lookup(c, embedding, threshold=0.9, headers=ACME):
    return await c.post("/v1/semantic-cache/lookup", json={"query_embedding": embedding, "model_version": MV, "threshold": threshold}, headers=headers)


async def check_route(ctx):
    m = ctx.load("api")
    _seed(ctx, "e1", V)
    async with ctx.client(m.app) as c:
        r = await _lookup(c, V)
        assert r.status_code == 200, f"POST /v1/semantic-cache/lookup answered {r.status_code}: {r.text}"
        assert r.headers.get("content-type", "").startswith("application/json"), f"the answer must be JSON, got Content-Type {r.headers.get('content-type')!r}"
        assert r.json().get("answer") == ANSWER, f"a lookup of the stored question answered {r.json()}, expected the stored answer"
        r = await _lookup(c, V, headers={})
        assert r.status_code == 401, f"a lookup without X-Tenant-Id answered {r.status_code}, expected 401"


async def check_floor(ctx):
    m = ctx.load("api")
    _seed(ctx, "e1", SO_SO)  # cosine 0.6 to the question
    async with ctx.client(m.app) as c:
        r = await _lookup(c, V, threshold=0)
        assert r.status_code == 200, f"lookup answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("hit") is not True and body.get("answer") in (None, ""), f"with threshold 0 an entry at similarity 0.6 was served: {body}. The caller's threshold is a hint; clamp it to the floor (0.82)"
        _seed(ctx, "e2", NEAR)  # cosine 0.994
        r = await _lookup(c, V, threshold=0)
        assert r.json().get("answer") == ANSWER, f"with threshold 0 an entry at similarity 0.994 must still hit (the floor is 0.82, not 1): {r.json()}"
        r = await _lookup(c, V, threshold=0.9995)
        assert r.json().get("answer") == ANSWER, f"with threshold 0.9995 an entry at similarity 0.994 must still hit (the ceiling is 0.99): {r.json()}"


async def check_expiry(ctx):
    m = ctx.load("api")
    _seed(ctx, "e1", V, expires_in=100)  # restored from a dump: expires_at in 100 s, no TTL on the key
    async with ctx.client(m.app) as c:
        r = await _lookup(c, V)
        assert r.json().get("answer") == ANSWER, f"a live entry must be served: {r.json()}"
        ctx.clock.advance(101)
        assert ctx.redis.exists("entry:acme:2024-06:e1") == 1, "the hash is still there: nothing but expires_at says the entry is over"
        r = await _lookup(c, V)
        assert r.status_code == 200, f"lookup answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("hit") is not True and body.get("answer") in (None, ""), f"an entry whose expires_at passed one second ago was served: {body}. Compare expires_at to now before serving"


async def check_hit_shape(ctx):
    m = ctx.load("api")
    _seed(ctx, "e1", V, age=41)
    async with ctx.client(m.app) as c:
        r = await _lookup(c, V)
    assert r.status_code == 200, f"lookup answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("hit") is True, f"a hit must say hit: true, got {body}"
    assert body.get("answer") == ANSWER and body.get("entry_id") == "e1", f"a hit carries the answer and its entry_id: {body}"
    assert isinstance(body.get("similarity"), (int, float)) and 0.99 <= body["similarity"] <= 1.0, f"similarity is {body.get('similarity')!r}, expected the cosine (1.0) so the caller can judge the hit"
    assert body.get("age_seconds") == 41, f"age_seconds is {body.get('age_seconds')!r}, expected 41 (now - created_at)"
    assert body.get("policy_version") == "2024-06-1", f"policy_version is {body.get('policy_version')!r}, expected the entry's 2024-06-1"


async def check_miss(ctx):
    m = ctx.load("api")
    async with ctx.client(m.app) as c:
        r = await _lookup(c, V)
    assert r.status_code == 200, f"a lookup with nothing stored answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("hit") is False, f"a miss must say hit: false, got {body}"
    assert "similarity" in body and body["similarity"] is None, f"a miss carries similarity: null, got {body}"
    assert "answer" not in body, f"a miss carries no answer field, got {body}: a client cannot tell an empty answer from a hit"
`,
    typescript: `const MV = '2024-06';
const V = [1, 0, 0, 0];
const NEAR = [0.9, 0.1, 0, 0]; // cosine 0.994 to V
const SO_SO = [0.6, 0.8, 0, 0]; // cosine 0.6 to V
const ANSWER = 'Refunds take five business days.';
const ACME = {'X-Tenant-Id': 'acme'};

/** An entry as the store writes it, from another worker: created age seconds ago, no TTL on the key. */
function seed(ctx, entryId: string, embedding: number[], {answer = ANSWER, age = 0, expiresIn = 86400, tenant = 'acme'} = {}) {
  const key = \`entry:\${tenant}:\${MV}:\${entryId}\`;
  const now = ctx.clock.now() / 1000;
  ctx.redis.hset(key, 'embedding', JSON.stringify(embedding), 'answer', answer, 'created_at', now - age, 'expires_at', now + expiresIn, 'policy_version', '2024-06-1');
  ctx.redis.sadd(\`semantic:\${tenant}:\${MV}\`, key);
}

function lookup(c, embedding: number[], threshold = 0.9, headers: Record<string, string> = ACME) {
  return c.post('/v1/semantic-cache/lookup', {json: {query_embedding: embedding, model_version: MV, threshold}, headers});
}

export async function check_route(ctx) {
  const m = ctx.load('api');
  const c = ctx.client(m.app);
  seed(ctx, 'e1', V);
  let r = await lookup(c, V);
  assert.equal(r.status, 200, \`POST /v1/semantic-cache/lookup answered \${r.status}: \${r.text}\`);
  assert((r.headers['content-type'] ?? '').startsWith('application/json'), \`the answer must be JSON, got Content-Type \${JSON.stringify(r.headers['content-type'])}\`);
  assert.equal(r.json().answer, ANSWER, \`a lookup of the stored question answered \${r.text}, expected the stored answer\`);
  r = await lookup(c, V, 0.9, {});
  assert.equal(r.status, 401, \`a lookup without X-Tenant-Id answered \${r.status}, expected 401\`);
}

export async function check_floor(ctx) {
  const m = ctx.load('api');
  const c = ctx.client(m.app);
  seed(ctx, 'e1', SO_SO); // cosine 0.6 to the question
  let r = await lookup(c, V, 0);
  assert.equal(r.status, 200, \`lookup answered \${r.status}: \${r.text}\`);
  let body = r.json();
  assert(body.hit !== true && (body.answer === undefined || body.answer === null || body.answer === ''), \`with threshold 0 an entry at similarity 0.6 was served: \${r.text}. The caller's threshold is a hint; clamp it to the floor (0.82)\`);
  seed(ctx, 'e2', NEAR); // cosine 0.994
  r = await lookup(c, V, 0);
  assert.equal(r.json().answer, ANSWER, \`with threshold 0 an entry at similarity 0.994 must still hit (the floor is 0.82, not 1): \${r.text}\`);
  r = await lookup(c, V, 0.9995);
  body = r.json();
  assert.equal(body.answer, ANSWER, \`with threshold 0.9995 an entry at similarity 0.994 must still hit (the ceiling is 0.99): \${r.text}\`);
}

export async function check_expiry(ctx) {
  const m = ctx.load('api');
  const c = ctx.client(m.app);
  seed(ctx, 'e1', V, {expiresIn: 100}); // restored from a dump: expires_at in 100 s, no TTL on the key
  let r = await lookup(c, V);
  assert.equal(r.json().answer, ANSWER, \`a live entry must be served: \${r.text}\`);
  ctx.clock.advance(101);
  assert.equal(ctx.redis.exists('entry:acme:2024-06:e1'), 1, 'the hash is still there: nothing but expires_at says the entry is over');
  r = await lookup(c, V);
  assert.equal(r.status, 200, \`lookup answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.hit !== true && (body.answer === undefined || body.answer === null || body.answer === ''), \`an entry whose expires_at passed one second ago was served: \${r.text}. Compare expires_at to now before serving\`);
}

export async function check_hit_shape(ctx) {
  const m = ctx.load('api');
  const c = ctx.client(m.app);
  seed(ctx, 'e1', V, {age: 41});
  const r = await lookup(c, V);
  assert.equal(r.status, 200, \`lookup answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert.equal(body.hit, true, \`a hit must say hit: true, got \${r.text}\`);
  assert(body.answer === ANSWER && body.entry_id === 'e1', \`a hit carries the answer and its entry_id: \${r.text}\`);
  assert(typeof body.similarity === 'number' && 0.99 <= body.similarity && body.similarity <= 1, \`similarity is \${JSON.stringify(body.similarity)}, expected the cosine (1.0) so the caller can judge the hit\`);
  assert.equal(body.age_seconds, 41, \`age_seconds is \${JSON.stringify(body.age_seconds)}, expected 41 (now - created_at)\`);
  assert.equal(body.policy_version, '2024-06-1', \`policy_version is \${JSON.stringify(body.policy_version)}, expected the entry's 2024-06-1\`);
}

export async function check_miss(ctx) {
  const m = ctx.load('api');
  const c = ctx.client(m.app);
  const r = await lookup(c, V);
  assert.equal(r.status, 200, \`a lookup with nothing stored answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert.equal(body.hit, false, \`a miss must say hit: false, got \${r.text}\`);
  assert('similarity' in body && body.similarity === null, \`a miss carries similarity: null, got \${r.text}\`);
  assert(!('answer' in body), \`a miss carries no answer field, got \${r.text}: a client cannot tell an empty answer from a hit\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"leetbuild/harness"

	"semcache/vectors"
)

const (
	apiMV     = "2024-06"
	apiAnswer = "Refunds take five business days."
)

var (
	apiV    = []float64{1, 0, 0, 0}
	apiNear = []float64{0.9, 0.1, 0, 0} // cosine 0.994 to apiV
	apiSoSo = []float64{0.6, 0.8, 0, 0} // cosine 0.6 to apiV
)

type seedOptions struct {
	age, expiresIn float64
}

// seedEntry writes an entry as the store writes it, from another worker: created age seconds ago, no TTL on the key.
func seedEntry(ctx *harness.Ctx, entryID string, embedding []float64, o seedOptions) {
	if o.expiresIn == 0 {
		o.expiresIn = 86400
	}
	key := fmt.Sprintf("entry:acme:%s:%s", apiMV, entryID)
	now := float64(ctx.Clock.Now()) / 1000
	vec, _ := json.Marshal(embedding)
	ctx.Redis.Do("HSET", key, "embedding", string(vec), "answer", apiAnswer, "created_at", now-o.age, "expires_at", now+o.expiresIn, "policy_version", "2024-06-1")
	ctx.Redis.Do("SADD", "semantic:acme:"+apiMV, key)
}

// apiNeighbours stands in for the store (step 2) and the result stream (step 4): the nearest entry
// in the tenant's set, expired or not, and a publish that records the event.
func apiNeighbours(ctx *harness.Ctx) *harness.HTTP {
	searchEntries = func(_ context.Context, tenant, modelVersion string, embedding []float64, threshold float64) (*Entry, error) {
		var best *Entry
		for _, key := range ctx.Redis.SMembers("semantic:" + tenant + ":" + modelVersion) {
			raw := ctx.Redis.HGetAll(key)
			if _, ok := raw["answer"]; len(raw) == 0 || !ok {
				continue
			}
			var stored []float64
			_ = json.Unmarshal([]byte(raw["embedding"]), &stored)
			similarity := vectors.Cosine(embedding, stored)
			if similarity >= threshold && (best == nil || similarity > best.Similarity) {
				var createdAt, expiresAt float64
				fmt.Sscan(raw["created_at"], &createdAt)
				fmt.Sscan(raw["expires_at"], &expiresAt)
				best = &Entry{EntryID: key[strings.LastIndex(key, ":")+1:], Answer: raw["answer"], Similarity: similarity, CreatedAt: createdAt, ExpiresAt: expiresAt, PolicyVersion: raw["policy_version"]}
			}
		}
		return best, nil
	}
	publishResult = func(_ context.Context, tenant string, result ResultEvent) error { return nil }
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiLookup(c *harness.HTTP, embedding []float64, threshold float64, header ...string) *harness.Response {
	return c.Post("/v1/semantic-cache/lookup", map[string]any{"query_embedding": embedding, "model_version": apiMV, "threshold": threshold}, header...)
}

func apiBody(ctx *harness.Ctx, r *harness.Response) map[string]any {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the lookup must answer a JSON object, got %s", r.Text())
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiNeighbours(ctx)
	seedEntry(ctx, "e1", apiV, seedOptions{})
	r := apiLookup(c, apiV, 0.9, "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 200, "POST /v1/semantic-cache/lookup (%s)", r.Text())
	ctx.Assert(strings.HasPrefix(r.Header.Get("Content-Type"), "application/json"), "the answer must be JSON, got Content-Type %q", r.Header.Get("Content-Type"))
	ctx.Equal(apiBody(ctx, r)["answer"], apiAnswer, "a lookup of the stored question must answer the stored answer")
	r = apiLookup(c, apiV, 0.9)
	ctx.Equal(r.Status, 401, "a lookup without X-Tenant-Id")
}

func CheckFloor(ctx *harness.Ctx) {
	c := apiNeighbours(ctx)
	seedEntry(ctx, "e1", apiSoSo, seedOptions{}) // cosine 0.6 to the question
	r := apiLookup(c, apiV, 0, "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 200, "lookup (%s)", r.Text())
	body := apiBody(ctx, r)
	answer, _ := body["answer"].(string)
	ctx.Assert(body["hit"] != true && answer == "", "with threshold 0 an entry at similarity 0.6 was served: %s. The caller's threshold is a hint; clamp it to the floor (0.82)", r.Text())
	seedEntry(ctx, "e2", apiNear, seedOptions{}) // cosine 0.994
	r = apiLookup(c, apiV, 0, "X-Tenant-Id", "acme")
	ctx.Equal(apiBody(ctx, r)["answer"], apiAnswer, "with threshold 0 an entry at similarity 0.994 must still hit (the floor is 0.82, not 1)")
	r = apiLookup(c, apiV, 0.9995, "X-Tenant-Id", "acme")
	ctx.Equal(apiBody(ctx, r)["answer"], apiAnswer, "with threshold 0.9995 an entry at similarity 0.994 must still hit (the ceiling is 0.99)")
}

func CheckExpiry(ctx *harness.Ctx) {
	c := apiNeighbours(ctx)
	seedEntry(ctx, "e1", apiV, seedOptions{expiresIn: 100}) // restored from a dump: expires_at in 100 s, no TTL on the key
	r := apiLookup(c, apiV, 0.9, "X-Tenant-Id", "acme")
	ctx.Equal(apiBody(ctx, r)["answer"], apiAnswer, "a live entry must be served")
	ctx.Clock.Advance(101)
	ctx.Equal(ctx.Redis.Exists("entry:acme:2024-06:e1"), 1, "the hash is still there: nothing but expires_at says the entry is over; EXISTS")
	r = apiLookup(c, apiV, 0.9, "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 200, "lookup (%s)", r.Text())
	body := apiBody(ctx, r)
	answer, _ := body["answer"].(string)
	ctx.Assert(body["hit"] != true && answer == "", "an entry whose expires_at passed one second ago was served: %s. Compare expires_at to now before serving", r.Text())
}

func CheckHitShape(ctx *harness.Ctx) {
	c := apiNeighbours(ctx)
	seedEntry(ctx, "e1", apiV, seedOptions{age: 41})
	r := apiLookup(c, apiV, 0.9, "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 200, "lookup (%s)", r.Text())
	body := apiBody(ctx, r)
	ctx.Equal(body["hit"], true, "a hit must say hit: true (%s)", r.Text())
	ctx.Assert(body["answer"] == apiAnswer && body["entry_id"] == "e1", "a hit carries the answer and its entry_id: %s", r.Text())
	similarity, ok := body["similarity"].(float64)
	ctx.Assert(ok && 0.99 <= similarity && similarity <= 1, "similarity is %v, expected the cosine (1.0) so the caller can judge the hit", body["similarity"])
	ctx.Equal(body["age_seconds"], 41, "age_seconds (now - created_at)")
	ctx.Equal(body["policy_version"], "2024-06-1", "policy_version must be the entry's")
}

func CheckMiss(ctx *harness.Ctx) {
	c := apiNeighbours(ctx)
	r := apiLookup(c, apiV, 0.9, "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 200, "a lookup with nothing stored (%s)", r.Text())
	body := apiBody(ctx, r)
	ctx.Equal(body["hit"], false, "a miss must say hit: false (%s)", r.Text())
	similarity, has := body["similarity"]
	ctx.Assert(has && similarity == nil, "a miss carries similarity: null, got %s", r.Text())
	_, hasAnswer := body["answer"]
	ctx.Assert(!hasAnswer, "a miss carries no answer field, got %s: a client cannot tell an empty answer from a hit", r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

#include "semcache/vectors.h"

namespace {

const std::string kMV = "2024-06";
const std::string kAnswer = "Refunds take five business days.";
const std::vector<double> kV = {1, 0, 0, 0};
const std::vector<double> kNear = {0.9, 0.1, 0, 0};  // cosine 0.994 to kV
const std::vector<double> kSoSo = {0.6, 0.8, 0, 0};  // cosine 0.6 to kV

harness::Ctx* world = nullptr;

// An entry as the store writes it, from another worker: created age seconds ago, no TTL on the key.
void seedEntry(harness::Ctx& ctx, const std::string& entryId, const std::vector<double>& embedding, double age = 0,
               double expiresIn = 86400) {
  const std::string key = "entry:acme:" + kMV + ":" + entryId;
  const double now = static_cast<double>(ctx.Clock.Now()) / 1000;
  ctx.Redis.Do("HSET", key, "embedding", nlohmann::json(embedding).dump(), "answer", kAnswer, "created_at", harness::Value(now - age),
               "expires_at", harness::Value(now + expiresIn), "policy_version", "2024-06-1");
  ctx.Redis.Do("SADD", "semantic:acme:" + kMV, key);
}

struct ApiServer {
  httplib::Server svr;
};

harness::HTTP api(harness::Ctx& ctx) {
  static ApiServer* server = nullptr;
  delete server;
  server = new ApiServer;
  world = &ctx;
  register_routes(server->svr);
  return ctx.HTTP(server->svr);
}

harness::Response lookup(harness::HTTP& c, const std::vector<double>& embedding, double threshold = 0.9, bool tenant = true) {
  const std::string body = nlohmann::json{{"query_embedding", embedding}, {"model_version", kMV}, {"threshold", threshold}}.dump();
  if (!tenant) return c.Post("/v1/semantic-cache/lookup", body, "Content-Type", "application/json");
  return c.Post("/v1/semantic-cache/lookup", body, "Content-Type", "application/json", "X-Tenant-Id", "acme");
}

nlohmann::json bodyOf(harness::Ctx& ctx, const harness::Response& r) {
  nlohmann::json body;
  try {
    body = nlohmann::json::parse(r.Text());
  } catch (const std::exception&) {
  }
  ctx.Assert(body.is_object(), "the lookup must answer a JSON object, got %s", r.Text());
  return body;
}

bool servedNothing(const nlohmann::json& body) {
  const bool hit = body.contains("hit") && body["hit"].is_boolean() && body["hit"].get<bool>();
  const bool answer = body.contains("answer") && body["answer"].is_string() && !body["answer"].get<std::string>().empty();
  return !hit && !answer;
}

}  // namespace

// The stand-ins for the store (step 2) and the result stream (step 4): the nearest entry in the
// tenant's set, expired or not, and a publish that records nothing.
std::optional<Entry> search_entries(const std::string& tenant, const std::string& model_version,
                                    const std::vector<double>& embedding, double threshold) {
  std::optional<Entry> best;
  for (const std::string& key : world->Redis.SMembers("semantic:" + tenant + ":" + model_version)) {
    const auto raw = world->Redis.HGetAll(key);
    if (raw.empty() || !raw.count("answer")) continue;
    const auto stored = nlohmann::json::parse(raw.at("embedding")).get<std::vector<double>>();
    const double similarity = semcache::cosine(embedding, stored);
    if (similarity >= threshold && (!best || similarity > best->similarity)) {
      Entry e;
      e.entry_id = key.substr(key.rfind(':') + 1);
      e.answer = raw.at("answer");
      e.similarity = similarity;
      e.created_at = std::stod(raw.at("created_at"));
      e.expires_at = std::stod(raw.at("expires_at"));
      e.policy_version = raw.count("policy_version") ? raw.at("policy_version") : "";
      best = e;
    }
  }
  return best;
}

void publish_result(const std::string&, const ResultEvent&) {}

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  seedEntry(ctx, "e1", kV);
  auto r = lookup(c, kV);
  ctx.Equal(r.Status, 200, "POST /v1/semantic-cache/lookup (%s)", r.Text());
  ctx.Assert(r.HeaderValue("Content-Type").rfind("application/json", 0) == 0, "the answer must be JSON, got Content-Type %q",
             r.HeaderValue("Content-Type"));
  ctx.Equal(bodyOf(ctx, r).value("answer", ""), kAnswer, "a lookup of the stored question must answer the stored answer");
  r = lookup(c, kV, 0.9, false);
  ctx.Equal(r.Status, 401, "a lookup without X-Tenant-Id");
}

void CheckFloor(harness::Ctx& ctx) {
  auto c = api(ctx);
  seedEntry(ctx, "e1", kSoSo);  // cosine 0.6 to the question
  auto r = lookup(c, kV, 0);
  ctx.Equal(r.Status, 200, "lookup (%s)", r.Text());
  ctx.Assert(servedNothing(bodyOf(ctx, r)),
             "with threshold 0 an entry at similarity 0.6 was served: %s. The caller's threshold is a hint; clamp it to the floor (0.82)",
             r.Text());
  seedEntry(ctx, "e2", kNear);  // cosine 0.994
  r = lookup(c, kV, 0);
  ctx.Equal(bodyOf(ctx, r).value("answer", ""), kAnswer, "with threshold 0 an entry at similarity 0.994 must still hit (the floor is 0.82, not 1)");
  r = lookup(c, kV, 0.9995);
  ctx.Equal(bodyOf(ctx, r).value("answer", ""), kAnswer, "with threshold 0.9995 an entry at similarity 0.994 must still hit (the ceiling is 0.99)");
}

void CheckExpiry(harness::Ctx& ctx) {
  auto c = api(ctx);
  seedEntry(ctx, "e1", kV, 0, 100);  // restored from a dump: expires_at in 100 s, no TTL on the key
  auto r = lookup(c, kV);
  ctx.Equal(bodyOf(ctx, r).value("answer", ""), kAnswer, "a live entry must be served");
  ctx.Clock.Advance(101);
  ctx.Equal(ctx.Redis.Exists("entry:acme:2024-06:e1"), 1, "the hash is still there: nothing but expires_at says the entry is over; EXISTS");
  r = lookup(c, kV);
  ctx.Equal(r.Status, 200, "lookup (%s)", r.Text());
  ctx.Assert(servedNothing(bodyOf(ctx, r)), "an entry whose expires_at passed one second ago was served: %s. Compare expires_at to now before serving",
             r.Text());
}

void CheckHitShape(harness::Ctx& ctx) {
  auto c = api(ctx);
  seedEntry(ctx, "e1", kV, 41);
  auto r = lookup(c, kV);
  ctx.Equal(r.Status, 200, "lookup (%s)", r.Text());
  const auto body = bodyOf(ctx, r);
  ctx.Assert(body.contains("hit") && body["hit"] == true, "a hit must say hit: true (%s)", r.Text());
  ctx.Assert(body.value("answer", "") == kAnswer && body.value("entry_id", "") == "e1", "a hit carries the answer and its entry_id: %s", r.Text());
  ctx.Assert(body.contains("similarity") && body["similarity"].is_number() && 0.99 <= body["similarity"].get<double>() &&
                 body["similarity"].get<double>() <= 1,
             "similarity is %s, expected the cosine (1.0) so the caller can judge the hit", body.value("similarity", nlohmann::json()).dump());
  ctx.Assert(body.contains("age_seconds") && body["age_seconds"] == 41, "age_seconds is %s, expected 41 (now - created_at)",
             body.value("age_seconds", nlohmann::json()).dump());
  ctx.Equal(body.value("policy_version", ""), "2024-06-1", "policy_version must be the entry's");
}

void CheckMiss(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = lookup(c, kV);
  ctx.Equal(r.Status, 200, "a lookup with nothing stored (%s)", r.Text());
  const auto body = bodyOf(ctx, r);
  ctx.Assert(body.contains("hit") && body["hit"] == false, "a miss must say hit: false (%s)", r.Text());
  ctx.Assert(body.contains("similarity") && body["similarity"].is_null(), "a miss carries similarity: null, got %s", r.Text());
  ctx.Assert(!body.contains("answer"), "a miss carries no answer field, got %s: a client cannot tell an empty answer from a hit", r.Text());
}
`,
  },
  debrief: `The threshold is clamped on the server because the caller's number is a preference and the floor is a property of the embedding space: below 0.82 the nearest neighbour of a question is routinely a different question. Expiry is checked at serving time, not trusted to the key's TTL, because the store returns whatever its index lists and a hash can arrive without a TTL (a restore, a migration). The hit shape carries the similarity and the age so the caller can set its own stricter bar or re-ask when the entry is old; \`hit: false\` with a null similarity is what makes a miss unambiguous. A production lookup also calibrates the floor per model version from labelled pairs and rate-limits per tenant, and would return the top few candidates rather than one.`,
};
