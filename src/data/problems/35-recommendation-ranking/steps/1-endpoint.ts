import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/recommendations: candidates in, ranked list out',
  concept: 'http',
  file: 'api',
  focus: ['client', 'recsvc', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route,
decodes the body and answers \`200\` with a ranked list. It compiles, it serves the demo, and it
lets the caller pick whose recommendations come back. Review it like the service owner, fix it, and
prove the fix with the checks below.

Implement \`POST /v1/recommendations\` with body
\`{"surface": "home", "candidate_ids": ["…"]}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header and the user from \`X-User-Id\`; a
  missing header is **401**. \`user_id\` is not a request field: a body that carries one is ignored,
  never preferred, because the personalized list belongs to the caller and to nobody else.
- \`surface\` is a required non-empty name and must exist in the catalog, so an unknown surface is
  **404** before the ranker is called — a surface nobody configured would rank with the wrong
  version and the wrong fallback anyway.
- \`candidate_ids\` is required and bounded by \`MAX_CANDIDATES = 500\`; an empty or oversized list is
  **400**. The draft caps nothing, so one request can hand the ranking pool a list big enough to
  stall it.
- The response holds at most \`MAX_ITEMS = 30\` items — the top of the order, trimmed after ranking —
  and each item carries its \`id\`, its \`score\` and its zero-based \`position\`.
- The response carries \`model_version\`: the ranking model version that produced this order, read
  from the ranking result. Without it an A/B read of the list cannot attribute the ranking.
- Validate everything before the ranker is called: headers, body shape, surface, candidate list,
  catalog. A rejected request never reaches the ranking pool.
- Log the decision with tenant, user, surface and counts — not the candidate array.

**Failure mode the checks target.** The draft resolves the user from the body, so any caller can ask
for another user's personalized list and the mistake stays invisible until someone reads the
impressions; it accepts an unbounded candidate list, so one request can stall ranking for everyone
behind it; it returns as many items as the ranker produced, so a demo list becomes a 500-item
payload; and it never says which model version ranked, so two releases are indistinguishable in the
numbers the release gate reads.`,
  sequence: {
    participants: ['Client', 'Recommendation API', 'surface catalog', 'Ranking model'],
    messages: [
      {
        from: 'Client',
        to: 'Recommendation API',
        label: 'POST /v1/recommendations · X-Tenant-Id · X-User-Id',
        kind: 'sync',
      },
      {
        from: 'Recommendation API',
        to: 'Recommendation API',
        label: 'resolve user from X-User-Id · validate surface · cap candidates',
        kind: 'sync',
      },
      {from: 'Recommendation API', to: 'surface catalog', label: 'known(surface)', kind: 'sync'},
      {from: 'surface catalog', to: 'Recommendation API', label: 'yes / unknown → 404', kind: 'reply'},
      {
        from: 'Recommendation API',
        to: 'Ranking model',
        label: 'Rank(tenant, user, surface, at most 500 candidates)',
        kind: 'sync',
      },
      {from: 'Ranking model', to: 'Recommendation API', label: 'scored items · model_version', kind: 'reply'},
      {from: 'Recommendation API', to: 'Client', label: '200 {items at most 30, model_version}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/recommendations',
      detail: 'Register the recommendation route on `POST /v1/recommendations`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/recommendations["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/recommendations['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/recommendations"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"recommendations"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/recommendations"/]},
      },
    },
    {
      id: 'auth-user',
      title: 'Resolves the user from the X-User-Id header, never the body',
      detail:
        'The user comes from the authenticated `X-User-Id` header and a missing header is **401**; a `user_id` in the body is never trusted, so one caller cannot request another user’s personalized list. The draft prefers `body.user_id` over the header and rejects nothing.',
      match: {
        python: {all: [/X-User-Id/, /status_code\s*=\s*401/], none: [/body\.user_id/]},
        typescript: {all: [/X-User-Id/, /code\(\s*401\s*\)/], none: [/body\.user_id/]},
        go: {all: [/X-User-Id/, /StatusUnauthorized/], none: [/body\.UserID/]},
        scala: {all: [/X-User-Id/, /StatusCodes\.Unauthorized/], none: [/body\.user_id/]},
        cpp: {all: [/X-User-Id/, /\b401\b/], none: [/body\.value\(\s*"user_id"/]},
      },
    },
    {
      id: 'candidate-cap',
      title: 'Rejects an empty or oversized candidate list',
      detail:
        '`candidate_ids` must hold between 1 and `MAX_CANDIDATES = 500` ids; an empty or oversized list is **400** before anything is ranked. The draft caps nothing, so one request can stall the ranking pool with a list of any size.',
      match: {
        python: {all: [/MAX_CANDIDATES\s*=\s*500/, /candidate_ids/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_CANDIDATES\s*=\s*500/, /candidate_ids/, /code\(\s*400\s*\)/]},
        go: {all: [/maxCandidates\s*=\s*500/, /CandidateIDs/, /StatusBadRequest/]},
        scala: {all: [/MaxCandidates\s*=\s*500/, /candidate_ids/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxCandidates\s*=\s*500/, /candidate_ids/, /\b400\b/]},
      },
    },
    {
      id: 'top-k',
      title: 'Returns at most MAX_ITEMS = 30 items with id, score and position',
      detail:
        'The ranked list is trimmed to `MAX_ITEMS = 30` after ranking and every item carries its `id`, `score` and zero-based `position`. The draft returns whatever the ranker produced, so a 500-candidate request becomes a 500-item payload.',
      match: {
        python: {all: [/MAX_ITEMS\s*=\s*30/, /\[:\s*MAX_ITEMS\]/, /"position"/, /"score"/]},
        typescript: {all: [/MAX_ITEMS\s*=\s*30/, /slice\(\s*0\s*,\s*MAX_ITEMS\s*\)/, /\bposition\b/, /\bscore\b/]},
        go: {all: [/maxItems\s*=\s*30/, /items\[:maxItems\]/, /"position"/, /"score"/]},
        scala: {all: [/MaxItems\s*=\s*30/, /take\(MaxItems\)/, /position\s*:\s*Int/, /score\s*:\s*Double/]},
        cpp: {all: [/kMaxItems\s*=\s*30/, /position\s*<\s*kMaxItems/, /"position"/, /"score"/]},
      },
    },
    {
      id: 'model-version',
      title: 'Stamps the response with the version that produced the order',
      detail:
        'The response carries `model_version`, taken from the ranking result that produced this order. The draft answers with items only, so an A/B read of two releases sees different lists and no way to attribute which model ranked them.',
      match: {
        python: {all: [/model_version/, /result\.model_version/]},
        typescript: {all: [/model_version/, /result\.model_version/]},
        go: {all: [/model_version/, /result\.ModelVersion/]},
        scala: {all: [/model_version/, /result\.model_version/]},
        cpp: {all: [/model_version/, /result\.model_version/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("recsvc")


class RecommendRequest(BaseModel):
    surface: str
    candidate_ids: list[str]
    user_id: str | None = None


class Ranker:
    def rank(self, tenant: str, user_id: str, surface: str, candidate_ids: list[str]) -> list[dict]:
        """Rank the candidates for one user."""
        raise NotImplementedError


ranker = Ranker()


@app.post("/v1/recommendations")
def recommend(
    body: RecommendRequest,
    tenant: str = Header(alias="X-Tenant-Id"),
    header_user: str | None = Header(default=None, alias="X-User-Id"),
) -> JSONResponse:
    # TODO: this draft lets the body pick the user, caps neither the candidate list nor the result,
    # and never says which model produced the order. Review it before it ships.
    user_id = body.user_id or header_user or tenant
    items = ranker.rank(tenant, user_id, body.surface, body.candidate_ids)
    return JSONResponse({"items": items}, status_code=200)
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("recsvc")

MAX_CANDIDATES = 500
MAX_ITEMS = 30


class RecommendRequest(BaseModel):
    surface: str
    candidate_ids: list[str]


class ScoredItem(BaseModel):
    id: str
    score: float


class RankedResult(BaseModel):
    items: list[ScoredItem]
    model_version: str


class SurfaceCatalog:
    def exists(self, surface: str) -> bool:
        """Whether the catalog knows this surface at all."""
        raise NotImplementedError


class Ranker:
    def rank(
        self, tenant: str, user_id: str, surface: str, candidate_ids: list[str]
    ) -> RankedResult:
        """Rank the candidates for one user; the order comes back with the version that made it."""
        raise NotImplementedError


surfaces = SurfaceCatalog()
ranker = Ranker()


def to_ranked(items: list[ScoredItem]) -> list[dict]:
    """Trim to MAX_ITEMS and number what remains, so the response is a ranked list, not a dump."""
    return [
        {"id": item.id, "score": item.score, "position": position}
        for position, item in enumerate(items[:MAX_ITEMS])
    ]


@app.post("/v1/recommendations")
def recommend(
    body: RecommendRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    user_id: str | None = Header(default=None, alias="X-User-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if user_id is None or user_id == "":
        raise HTTPException(status_code=401, detail="missing X-User-Id")
    if not body.surface.strip():
        raise HTTPException(status_code=400, detail="surface is required")
    if not body.candidate_ids:
        raise HTTPException(status_code=400, detail="candidate_ids must not be empty")
    if len(body.candidate_ids) > MAX_CANDIDATES:
        raise HTTPException(status_code=400, detail="more than 500 candidates")
    if not surfaces.exists(body.surface):
        raise HTTPException(status_code=404, detail="unknown surface")

    result = ranker.rank(tenant, user_id, body.surface, body.candidate_ids)
    items = to_ranked(result.items)
    logger.info(
        "ranked tenant=%s user=%s surface=%s candidates=%d items=%d model_version=%s",
        tenant,
        user_id,
        body.surface,
        len(body.candidate_ids),
        len(items),
        result.model_version,
    )
    return JSONResponse({"items": items, "model_version": result.model_version}, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/recommendations: a model-generated draft that trusts whatever the caller sends. */
import Fastify from 'fastify';

export const app = Fastify();

interface RecommendBody {
  surface: string;
  candidate_ids: string[];
  user_id?: string;
}

interface ScoredItem {
  id: string;
  score: number;
}

async function rank(
  tenant: string,
  userId: string,
  surface: string,
  candidateIds: string[],
): Promise<ScoredItem[]> {
  void tenant;
  void userId;
  void surface;
  void candidateIds;
  return [];
}

app.post('/v1/recommendations', async (request, reply) => {
  // TODO: this draft lets the body pick the user, caps neither the candidate list nor the result,
  // and never says which model produced the order. Review it before it ships.
  const tenant = request.headers['x-tenant-id'] as string;
  const headerUser = request.headers['x-user-id'] as string | undefined;
  const body = request.body as RecommendBody;
  const userId = body.user_id ?? headerUser ?? tenant;
  const items = await rank(tenant, userId, body.surface, body.candidate_ids);
  return reply.code(200).send({items});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/recommendations: identity from the headers, bounded candidates, attributed order. */
import Fastify from 'fastify';

export const app = Fastify();

const MAX_CANDIDATES = 500;
const MAX_ITEMS = 30;

interface RecommendBody {
  surface?: string;
  candidate_ids?: string[];
}

interface ScoredItem {
  id: string;
  score: number;
}

interface RankedItem {
  id: string;
  score: number;
  position: number;
}

interface RankedResult {
  items: ScoredItem[];
  model_version: string;
}

export interface SurfaceCatalog {
  exists(surface: string): Promise<boolean>;
}

export interface Ranker {
  rank(tenant: string, userId: string, surface: string, candidateIds: string[]): Promise<RankedResult>;
}

export const surfaces: SurfaceCatalog = {
  async exists(surface: string): Promise<boolean> {
    void surface;
    return false;
  },
};

export const ranker: Ranker = {
  async rank(tenant, userId, surface, candidateIds): Promise<RankedResult> {
    void tenant;
    void userId;
    void surface;
    void candidateIds;
    return {items: [], model_version: ''};
  },
};

/** Trim to MAX_ITEMS and number what remains, so the response is a ranked list, not a dump. */
function toRanked(items: ScoredItem[]): RankedItem[] {
  return items.slice(0, MAX_ITEMS).map((item, position) => ({id: item.id, score: item.score, position}));
}

app.post('/v1/recommendations', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const userId = request.headers['x-user-id'];
  if (typeof userId !== 'string' || userId === '')
    return reply.code(401).send({error: 'missing X-User-Id'});

  const body = request.body as RecommendBody | null;
  if (body === null || typeof body !== 'object') return reply.code(400).send({error: 'invalid body'});
  const surface = body.surface;
  if (typeof surface !== 'string' || surface.trim() === '')
    return reply.code(400).send({error: 'surface is required'});
  const candidateIds = body.candidate_ids;
  if (!Array.isArray(candidateIds) || candidateIds.length === 0)
    return reply.code(400).send({error: 'candidate_ids must not be empty'});
  if (candidateIds.length > MAX_CANDIDATES)
    return reply.code(400).send({error: 'more than 500 candidates'});
  if (!(await surfaces.exists(surface))) return reply.code(404).send({error: 'unknown surface'});

  const result = await ranker.rank(tenant, userId, surface, candidateIds);
  const items = toRanked(result.items);
  request.log.info(
    {
      tenant,
      user: userId,
      surface,
      candidates: candidateIds.length,
      items: items.length,
      model_version: result.model_version,
    },
    'ranked',
  );
  return reply.code(200).send({items, model_version: result.model_version});
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

type RecommendRequest struct {
	Surface      string   \`json:"surface"\`
	CandidateIDs []string \`json:"candidate_ids"\`
	UserID       string   \`json:"user_id"\`
}

type ScoredItem struct {
	ID    string  \`json:"id"\`
	Score float64 \`json:"score"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func rank(tenant, userID, surface string, candidateIDs []string) []ScoredItem {
	return nil
}

func recommend(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body RecommendRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft lets the body pick the user, caps neither the candidate list nor the result,
	// and never says which model produced the order. Review it before it ships.
	userID := r.Header.Get("X-User-Id")
	if body.UserID != "" {
		userID = body.UserID
	}
	items := rank(tenant, userID, body.Surface, body.CandidateIDs)
	writeJSON(rw, http.StatusOK, map[string]any{"items": items})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/recommendations", recommend)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

const (
	maxCandidates = 500
	maxItems      = 30
)

type RecommendRequest struct {
	Surface      string   \`json:"surface"\`
	CandidateIDs []string \`json:"candidate_ids"\`
}

type ScoredItem struct {
	ID    string  \`json:"id"\`
	Score float64 \`json:"score"\`
}

type RankedItem struct {
	ID       string  \`json:"id"\`
	Score    float64 \`json:"score"\`
	Position int     \`json:"position"\`
}

type RankedResult struct {
	Items        []ScoredItem \`json:"items"\`
	ModelVersion string       \`json:"model_version"\`
}

type SurfaceCatalog struct{}

func (s *SurfaceCatalog) Exists(ctx context.Context, surface string) bool {
	return false
}

type Ranker struct{}

func (r *Ranker) Rank(ctx context.Context, tenant, userID, surface string, candidateIDs []string) (*RankedResult, error) {
	return nil, nil
}

var (
	surfaces = &SurfaceCatalog{}
	ranker   = &Ranker{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// toRanked trims to maxItems and numbers what remains, so the response is a ranked list, not a dump.
func toRanked(items []ScoredItem) []RankedItem {
	if len(items) > maxItems {
		items = items[:maxItems]
	}
	ranked := make([]RankedItem, 0, len(items))
	for position, item := range items {
		ranked = append(ranked, RankedItem{ID: item.ID, Score: item.Score, Position: position})
	}
	return ranked
}

func recommend(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	userID := r.Header.Get("X-User-Id")
	if userID == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-User-Id"})
		return
	}
	var body RecommendRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if strings.TrimSpace(body.Surface) == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "surface is required"})
		return
	}
	if len(body.CandidateIDs) == 0 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "candidate_ids must not be empty"})
		return
	}
	if len(body.CandidateIDs) > maxCandidates {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "more than 500 candidates"})
		return
	}
	if !surfaces.Exists(r.Context(), body.Surface) {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown surface"})
		return
	}
	result, err := ranker.Rank(r.Context(), tenant, userID, body.Surface, body.CandidateIDs)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "ranking unavailable"})
		return
	}
	items := toRanked(result.Items)
	log.Printf("ranked tenant=%s user=%s surface=%s candidates=%d items=%d model_version=%s",
		tenant, userID, body.Surface, len(body.CandidateIDs), len(items), result.ModelVersion)
	writeJSON(rw, http.StatusOK, map[string]any{"items": items, "model_version": result.ModelVersion})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/recommendations", recommend)
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

final case class RecommendRequest(surface: String, candidate_ids: List[String], user_id: Option[String])
final case class ScoredItem(id: String, score: Double)
final case class DraftRanking(items: List[ScoredItem])

object RecApi {
  implicit val system: ActorSystem = ActorSystem("recsvc")
  implicit val requestFormat: RootJsonFormat[RecommendRequest] = jsonFormat3(RecommendRequest)
  implicit val itemFormat: RootJsonFormat[ScoredItem] = jsonFormat2(ScoredItem)
  implicit val draftFormat: RootJsonFormat[DraftRanking] = jsonFormat1(DraftRanking)

  def rank(tenant: String, userId: String, surface: String, candidateIds: List[String]): List[ScoredItem] =
    Nil

  val route: Route =
    path("v1" / "recommendations") {
      post {
        optionalHeaderValueByName("X-User-Id") { headerUser =>
          entity(as[RecommendRequest]) { body =>
            // TODO: this draft lets the body pick the user, caps neither the candidate list nor the
            // result, and never says which model produced the order. Review it before it ships.
            val userId = body.user_id.getOrElse(headerUser.getOrElse(""))
            complete(StatusCodes.OK, DraftRanking(rank("", userId, body.surface, body.candidate_ids)))
          }
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

final case class RecommendRequest(surface: String, candidate_ids: List[String])
final case class ScoredItem(id: String, score: Double)
final case class RankedItem(id: String, score: Double, position: Int)
final case class RankedResult(items: List[ScoredItem], model_version: String)
final case class RankingResponse(items: List[RankedItem], model_version: String)

object SurfaceCatalog {
  def exists(surface: String): Boolean = false
}

object Ranker {
  def rank(tenant: String, userId: String, surface: String, candidateIds: List[String]): RankedResult =
    throw new UnsupportedOperationException("Ranker.rank is not implemented")
}

object RecApi {
  implicit val system: ActorSystem = ActorSystem("recsvc")
  implicit val requestFormat: RootJsonFormat[RecommendRequest] = jsonFormat2(RecommendRequest)
  implicit val itemFormat: RootJsonFormat[ScoredItem] = jsonFormat2(ScoredItem)
  implicit val rankedFormat: RootJsonFormat[RankedItem] = jsonFormat3(RankedItem)
  implicit val responseFormat: RootJsonFormat[RankingResponse] = jsonFormat2(RankingResponse)

  val MaxCandidates = 500
  val MaxItems = 30

  /** Trim to MaxItems and number what remains, so the response is a ranked list, not a dump. */
  def toRanked(items: List[ScoredItem]): List[RankedItem] =
    items.take(MaxItems).zipWithIndex.map { case (item, position) =>
      RankedItem(item.id, item.score, position)
    }

  val route: Route =
    path("v1" / "recommendations") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("X-User-Id") { userOpt =>
            entity(as[RecommendRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!userOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-User-Id"}""")
              } else if (body.surface.trim.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"surface is required"}""")
              } else if (body.candidate_ids.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"candidate_ids must not be empty"}""")
              } else if (body.candidate_ids.length > MaxCandidates) {
                complete(StatusCodes.BadRequest, """{"error":"more than 500 candidates"}""")
              } else if (!SurfaceCatalog.exists(body.surface)) {
                complete(StatusCodes.NotFound, """{"error":"unknown surface"}""")
              } else {
                val result = Ranker.rank(tenantOpt.get, userOpt.get, body.surface, body.candidate_ids)
                complete(StatusCodes.OK, RankingResponse(toRanked(result.items), result.model_version))
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

#include <iostream>
#include <string>
#include <vector>

using json = nlohmann::json;

std::string rank(const std::string& tenant, const std::string& userId, const std::string& surface,
                 const std::vector<std::string>& candidateIds);

int main() {
  httplib::Server svr;

  svr.Post("/v1/recommendations", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto headerUser = req.get_header_value("X-User-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft lets the body pick the user, caps neither the candidate list nor the result,
    // and never says which model produced the order. Review it before it ships.
    auto userId = body.value("user_id", std::string());
    if (userId.empty()) userId = headerUser;
    const auto items = rank(tenant, userId, body.value("surface", std::string()),
                            body.value("candidate_ids", std::vector<std::string>{}));
    std::cerr << "ranked tenant=" << tenant << " user=" << userId << "\\n";
    res.status = 200;
    res.set_content(items, "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cstddef>
#include <iostream>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kMaxCandidates = 500;
constexpr int kMaxItems = 30;

struct ScoredItem {
  std::string id;
  double score = 0.0;
};

struct RankedResult {
  std::vector<ScoredItem> items;
  std::string model_version;
};

struct SurfaceCatalog {
  bool exists(const std::string& surface);
};

struct Ranker {
  RankedResult rank(const std::string& tenant, const std::string& userId, const std::string& surface,
                    const std::vector<std::string>& candidateIds);
};

SurfaceCatalog surfaces;
Ranker ranker;

// Trim to kMaxItems and number what remains, so the response is a ranked list, not a dump.
json toRanked(const std::vector<ScoredItem>& items) {
  json ranked = json::array();
  for (std::size_t position = 0; position < items.size() && position < kMaxItems; ++position) {
    ranked.push_back({{"id", items[position].id},
                      {"score", items[position].score},
                      {"position", static_cast<int>(position)}});
  }
  return ranked;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/recommendations", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto userId = req.get_header_value("X-User-Id");
    if (userId.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-User-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto surface = body.value("surface", std::string());
    if (surface.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"surface is required"})", "application/json");
      return;
    }
    const auto candidateIds = body.value("candidate_ids", std::vector<std::string>{});
    if (candidateIds.empty() || candidateIds.size() > static_cast<std::size_t>(kMaxCandidates)) {
      res.status = 400;
      res.set_content(R"({"error":"candidate_ids must hold 1..500 ids"})", "application/json");
      return;
    }
    if (!surfaces.exists(surface)) {
      res.status = 404;
      res.set_content(R"({"error":"unknown surface"})", "application/json");
      return;
    }
    const auto result = ranker.rank(tenant, userId, surface, candidateIds);
    const auto items = toRanked(result.items);
    std::cerr << "ranked tenant=" << tenant << " user=" << userId << " surface=" << surface
              << " items=" << items.size() << " model_version=" << result.model_version << "\\n";
    res.status = 200;
    res.set_content(json{{"items", items}, {"model_version", result.model_version}}.dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses first, cheapest rejection first: `X-Tenant-Id`, then `X-User-Id`, then the body shape, the surface, the candidate cap and the catalog lookup. Each one returns before the ranker is called, so a rejected request never occupies the ranking pool.',
    'Identity is the whole point of this endpoint: the user is `X-User-Id` and nothing else. Do not "prefer the header over the body" — drop `user_id` from the request model entirely, so a body that carries one cannot reach the ranking call even by accident.',
    'Trim on the way out, not before ranking: rank all accepted candidates, then `items[:MAX_ITEMS]` (or the language equivalent) and number what remains. Stamp `model_version` from the ranking result into the same response — the trimmed order plus its version is the record the A/B read compares.',
  ],
  debrief: `The interviewer is testing the intake boundary of a personalization service, where the caller is untrusted and the expensive thing is one call away. The draft reads fine because the demo always posts the caller's own id and a short candidate list. Four defects are being checked: identity (the user comes from the authenticated \`X-User-Id\` header, and a body \`user_id\` is not a weaker source but no source at all), intake caps (an unbounded candidate list lets one request stall the ranking pool for everyone behind it), output caps (the product contract is at most 30 items, and truncating after ranking keeps the top of the order instead of the first 30 candidates), and attribution (\`model_version\` in the response is what makes two releases comparable offline). Real services add candidate dedupe before ranking, per-tenant surface grants, a request-level deadline shared with the ranker (step 3), and surfacing the caps through the surface config (step 5) instead of hardcoding them — but the guard order at the edge is the part that never moves.`,
};
