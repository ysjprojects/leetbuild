import type {Step} from '@/lib/types';

export const verifyEndpointStep: Step = {
  id: 'verify-endpoint',
  title: 'POST /v1/entities/{id}/verify: owner-only, tier derived server-side, audited',
  concept: 'http',
  file: 'verify_api',
  focus: ['owner', 'metasense', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route,
reads the caller and the body, stores the tags and returns the tier. It compiles, it serves the demo,
and it hides four production flaws. Review it like the data governance office, fix it, and prove
the fix.

Implement \`POST /v1/entities/{entity_id}/verify\` with body
\`{"action": "ack" | "edit", "tags": {"merchant_id": "None", "passport_no": "Personal.ID"}}\`.

- The caller comes from the authenticated \`X-User-Id\` header; a missing caller is **401**.
- Only the entity's **owner** may verify: look the owner up with \`store.owner_of(entity_id)\`
  (**404** when the entity is unknown) and answer **403** for anyone else. The source's whole
  verification step exists because the owner is the person who knows what the column holds.
- \`action\` is \`ack\` (the pending tags are confirmed as they are) or \`edit\` (the body's \`tags\`
  replace them, column by column); anything else is **400**. On \`edit\`, every tag must be in the
  taxonomy (\`Personal.ID\`, \`Personal.Name\`, \`Personal.Contact_Info\`, \`Geo.Geohash\`,
  \`None\`) — **400** otherwise.
- The **sensitivity tier is derived on the server** from the verified tags and the privacy rules:
  any \`Personal.ID\` → **Tier 1**; else any \`Personal.Name\` or \`Personal.Contact_Info\` →
  **Tier 2**; else any \`Geo.Geohash\` → **Tier 3**; else **Tier 4**. A \`tier\` in the request body is
  ignored. The tier is what access control reads; it is never an input.
- Record the verification with \`store.record_verification(entity_id, tags, tier, user, action)\`
  and write an audit row with \`store.audit(entity_id, user, action)\`; the response carries
  \`entity\`, \`tier\`, \`tags\`, \`verified_by\` and the new \`version\`.

**Failure mode the checks target.** Any caller with a user id can verify any table; a tier copied
from the body lets a producer mark a passport table Tier 4 and open it; a tag outside the taxonomy
is a tier nobody defined; and a verification with no audit row is a classification nobody can be
asked about later — which, in a regulated review, is the same as none.`,
  sequence: {
    participants: ['Data owner', 'metasense', 'store'],
    messages: [
      {from: 'Data owner', to: 'metasense', label: 'POST /v1/entities/deliveries/verify · X-User-Id', kind: 'sync'},
      {from: 'metasense', to: 'store', label: 'owner_of(deliveries)', kind: 'sync'},
      {from: 'store', to: 'metasense', label: 'team-logistics / none → 404 · mismatch → 403', kind: 'reply'},
      {
        from: 'metasense',
        to: 'metasense',
        label: 'validate action · tags ∈ TAXONOMY · derive_tier(tags)',
        kind: 'sync',
      },
      {from: 'metasense', to: 'store', label: 'record_verification(...) · audit(entity, user, action)', kind: 'sync'},
      {from: 'store', to: 'metasense', label: 'version', kind: 'reply'},
      {from: 'metasense', to: 'Data owner', label: '200 {entity, tier, tags, verified_by, version}', kind: 'reply'},
    ],
  },
  hints: [
    'Guard clauses first, cheapest first: caller header (401), owner lookup (404, then 403), action whitelist (400), tags against `TAXONOMY` (400). Nothing is written until all four have passed.',
    'The tier is a pure function of the tags: `derive_tier(tags)` walks `PRIVACY_RULES` — an ordered list of (tag, tier) pairs — and returns the first tier whose tag appears, else 4. The body may carry a `tier` field; the handler never reads it.',
    '`record_verification` stores the verified tags, tier and version; `audit` stores who did what. Both calls are part of the handler, not an afterthought, and the response echoes `verified_by` so the client can show it.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/entities/{entity_id}/verify',
      detail: 'Register the verification route on `POST /v1/entities/{entity_id}/verify`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/entities\/\{entity_id\}\/verify["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/entities\/:entityId\/verify['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/entities\/\{entity_id\}\/verify"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"entities"\s*\/\s*Segment\s*\/\s*"verify"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*R"\(\/v1\/entities\/\(\[\^\/\]\+\)\/verify\)"/]},
      },
    },
    {
      id: 'owner-only',
      title: 'Authenticates the caller and allows only the owner',
      detail:
        'A missing `X-User-Id` is **401**; the owner comes from `store.owner_of(entity_id)` and any other caller gets **403**. The draft lets any caller verify any entity.',
      match: {
        python: {all: [/status_code\s*=\s*401/, /status_code\s*=\s*403/, /store\.owner_of\(/]},
        typescript: {all: [/code\(\s*401\s*\)/, /code\(\s*403\s*\)/, /store\.ownerOf\(/]},
        go: {all: [/StatusUnauthorized/, /StatusForbidden/, /store\.OwnerOf\(/]},
        scala: {all: [/StatusCodes\.Unauthorized/, /StatusCodes\.Forbidden/, /store\.ownerOf\(/]},
        cpp: {all: [/\b401\b/, /\b403\b/, /store\.ownerOf\(/]},
      },
    },
    {
      id: 'tier-server-side',
      title: 'Derives the tier from tags and privacy rules, never from the body',
      detail:
        'A `derive_tier(tags)` function over `PRIVACY_RULES` computes the tier; the handler never reads a `tier` from the request. The draft stores whatever tier the caller sent.',
      match: {
        python: {all: [/PRIVACY_RULES/, /derive_tier\(/], none: [/body\.tier/]},
        typescript: {all: [/PRIVACY_RULES/, /deriveTier\(/], none: [/body\.tier/]},
        go: {all: [/privacyRules/, /deriveTier\(/], none: [/body\.Tier/]},
        scala: {all: [/PrivacyRules/, /deriveTier\(/], none: [/body\.tier/]},
        cpp: {all: [/kPrivacyRules/, /deriveTier\(/], none: [/value\(\s*"tier"/, /body\["tier"\]/]},
      },
    },
    {
      id: 'tag-whitelist',
      title: 'Rejects tags outside the taxonomy with 400',
      detail:
        'On `edit`, every tag is checked against `TAXONOMY` and an unknown tag (or an unknown `action`) is **400**. The draft stores any string as a tag.',
      match: {
        python: {all: [/TAXONOMY/, /status_code\s*=\s*400/]},
        typescript: {all: [/TAXONOMY/, /code\(\s*400\s*\)/]},
        go: {all: [/taxonomy\[/, /StatusBadRequest/]},
        scala: {all: [/Taxonomy\.contains\(/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kTaxonomy\.count\(/, /\b400\b/]},
      },
    },
    {
      id: 'audit',
      title: 'Audits who verified and returns verified_by',
      detail:
        'The handler calls `store.audit(entity_id, user, action)` and the response carries `verified_by`. The draft stores the tags and forgets who confirmed them.',
      match: {
        python: {all: [/store\.audit\(/, /verified_by/]},
        typescript: {all: [/store\.audit\(/, /verified_by/]},
        go: {all: [/store\.Audit\(/, /verified_by/]},
        scala: {all: [/store\.audit\(/, /verified_by/]},
        cpp: {all: [/store\.audit\(/, /verified_by/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class VerifyRequest(BaseModel):
    action: str = "ack"
    tags: dict[str, str] = {}
    tier: int = 4


class VerificationStore:
    def pending_tags(self, entity_id: str) -> dict[str, str]:
        """The model's tags awaiting verification, column → tag."""
        raise NotImplementedError

    def record_verification(self, entity_id: str, tags: dict[str, str], tier: int) -> int:
        """Store the verified tags and tier; returns the new version."""
        raise NotImplementedError


store = VerificationStore()


@app.post("/v1/entities/{entity_id}/verify")
def verify(entity_id: str, body: VerifyRequest, user: str = Header(alias="X-User-Id")) -> JSONResponse:
    # TODO: this draft lets any caller verify any entity, takes the tier from the body, accepts
    # any tag string, and records nothing about who verified. Review all four.
    tags = body.tags if body.action == "edit" else store.pending_tags(entity_id)
    version = store.record_verification(entity_id, tags, body.tier)
    return JSONResponse({"entity": entity_id, "tier": body.tier, "tags": tags, "version": version}, status_code=200)
`,
      solution: `from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

TAXONOMY = {"Personal.ID", "Personal.Name", "Personal.Contact_Info", "Geo.Geohash", "None"}
ALLOWED_ACTIONS = {"ack", "edit"}
PRIVACY_RULES: list[tuple[str, int]] = [
    ("Personal.ID", 1),
    ("Personal.Name", 2),
    ("Personal.Contact_Info", 2),
    ("Geo.Geohash", 3),
]
DEFAULT_TIER = 4


class VerifyRequest(BaseModel):
    action: str = "ack"
    tags: dict[str, str] = {}


class VerificationStore:
    def owner_of(self, entity_id: str) -> str | None:
        """The owner registered for the entity, if it exists."""
        raise NotImplementedError

    def pending_tags(self, entity_id: str) -> dict[str, str]:
        """The model's tags awaiting verification, column → tag."""
        raise NotImplementedError

    def record_verification(self, entity_id: str, tags: dict[str, str], tier: int, user: str, action: str) -> int:
        """Store the verified tags and tier; returns the new version."""
        raise NotImplementedError

    def audit(self, entity_id: str, user: str, action: str) -> None:
        """Append one audit row: who verified which entity, and how."""
        raise NotImplementedError


store = VerificationStore()


def derive_tier(tags: dict[str, str]) -> int:
    present = set(tags.values())
    tiers = [tier for tag, tier in PRIVACY_RULES if tag in present]
    return min(tiers) if tiers else DEFAULT_TIER


@app.post("/v1/entities/{entity_id}/verify")
def verify(
    entity_id: str,
    body: VerifyRequest,
    user: str | None = Header(default=None, alias="X-User-Id"),
) -> JSONResponse:
    if user is None or user == "":
        raise HTTPException(status_code=401, detail="missing X-User-Id")
    owner = store.owner_of(entity_id)
    if owner is None:
        raise HTTPException(status_code=404, detail="unknown entity")
    if owner != user:
        raise HTTPException(status_code=403, detail="only the owner may verify")
    if body.action not in ALLOWED_ACTIONS:
        raise HTTPException(status_code=400, detail="action must be ack or edit")
    if body.action == "edit":
        if not body.tags:
            raise HTTPException(status_code=400, detail="edit requires tags")
        for column, tag in body.tags.items():
            if column == "" or tag not in TAXONOMY:
                raise HTTPException(status_code=400, detail=f"unknown tag for {column}")
        tags = body.tags
    else:
        tags = store.pending_tags(entity_id)

    tier = derive_tier(tags)
    version = store.record_verification(entity_id, tags, tier, user, body.action)
    store.audit(entity_id, user, body.action)
    return JSONResponse(
        {"entity": entity_id, "tier": tier, "tags": tags, "verified_by": user, "version": version},
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/entities/:entityId/verify: a model-generated draft that trusts the caller's tier. */
import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

interface VerifyBody {
  action?: string;
  tags?: Record<string, string>;
  tier?: number;
}

app.post('/v1/entities/:entityId/verify', async (request, reply) => {
  // TODO: this draft lets any caller verify any entity, takes the tier from the body, accepts
  // any tag string, and records nothing about who verified. Review all four.
  const {entityId} = request.params as {entityId: string};
  const body = request.body as VerifyBody;
  const tags = body.action === 'edit' ? (body.tags ?? {}) : await store.pendingTags(entityId);
  const tier = body.tier ?? 4;
  const version = await store.recordVerification(entityId, tags, tier);
  return reply.code(200).send({entity: entityId, tier, tags, version});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/entities/:entityId/verify: owner-only, tier derived from tags and rules, audited. */
import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

const TAXONOMY: Record<string, true> = {
  'Personal.ID': true,
  'Personal.Name': true,
  'Personal.Contact_Info': true,
  'Geo.Geohash': true,
  None: true,
};
const ALLOWED_ACTIONS: Record<string, true> = {ack: true, edit: true};
const PRIVACY_RULES: [string, number][] = [
  ['Personal.ID', 1],
  ['Personal.Name', 2],
  ['Personal.Contact_Info', 2],
  ['Geo.Geohash', 3],
];
const DEFAULT_TIER = 4;

interface VerifyBody {
  action?: string;
  tags?: Record<string, string>;
}

function deriveTier(tags: Record<string, string>): number {
  const present = new Set(Object.values(tags));
  let tier = DEFAULT_TIER;
  for (const [tag, ruleTier] of PRIVACY_RULES) if (present.has(tag) && ruleTier < tier) tier = ruleTier;
  return tier;
}

app.post('/v1/entities/:entityId/verify', async (request, reply) => {
  const user = request.headers['x-user-id'];
  if (typeof user !== 'string' || user === '') return reply.code(401).send({error: 'missing X-User-Id'});
  const {entityId} = request.params as {entityId: string};
  const owner = await store.ownerOf(entityId);
  if (owner === null) return reply.code(404).send({error: 'unknown entity'});
  if (owner !== user) return reply.code(403).send({error: 'only the owner may verify'});

  const body = (request.body ?? {}) as VerifyBody;
  const action = body.action ?? 'ack';
  if (ALLOWED_ACTIONS[action] !== true) return reply.code(400).send({error: 'action must be ack or edit'});
  let tags: Record<string, string>;
  if (action === 'edit') {
    if (body.tags === undefined || Object.keys(body.tags).length === 0)
      return reply.code(400).send({error: 'edit requires tags'});
    for (const [column, tag] of Object.entries(body.tags))
      if (column === '' || typeof tag !== 'string' || TAXONOMY[tag] !== true)
        return reply.code(400).send({error: \`unknown tag for \${column}\`});
    tags = body.tags;
  } else {
    tags = await store.pendingTags(entityId);
  }

  const tier = deriveTier(tags);
  const version = await store.recordVerification(entityId, tags, tier, user, action);
  await store.audit(entityId, user, action);
  return reply.code(200).send({entity: entityId, tier, tags, verified_by: user, version});
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

type VerifyRequest struct {
	Action string            \`json:"action"\`
	Tags   map[string]string \`json:"tags"\`
	Tier   int               \`json:"tier"\`
}

type VerificationStore struct{}

// PendingTags returns the model's tags awaiting verification, column → tag.
func (s *VerificationStore) PendingTags(entityID string) (map[string]string, error) { return nil, nil }

// RecordVerification stores the verified tags and tier and returns the new version.
func (s *VerificationStore) RecordVerification(entityID string, tags map[string]string, tier int) (int, error) {
	return 0, nil
}

var store = &VerificationStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func verify(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft lets any caller verify any entity, takes the tier from the body, accepts
	// any tag string, and records nothing about who verified. Review all four.
	entityID := r.PathValue("entity_id")
	var body VerifyRequest
	_ = json.NewDecoder(r.Body).Decode(&body)
	tags := body.Tags
	if body.Action != "edit" {
		tags, _ = store.PendingTags(entityID)
	}
	tier := body.Tier
	if tier == 0 {
		tier = 4
	}
	version, _ := store.RecordVerification(entityID, tags, tier)
	writeJSON(rw, http.StatusOK, map[string]any{"entity": entityID, "tier": tier, "tags": tags, "version": version})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/entities/{entity_id}/verify", verify)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

const defaultTier = 4

var taxonomy = map[string]bool{
	"Personal.ID":           true,
	"Personal.Name":         true,
	"Personal.Contact_Info": true,
	"Geo.Geohash":           true,
	"None":                  true,
}

var allowedActions = map[string]bool{"ack": true, "edit": true}

type privacyRule struct {
	tag  string
	tier int
}

var privacyRules = []privacyRule{
	{"Personal.ID", 1},
	{"Personal.Name", 2},
	{"Personal.Contact_Info", 2},
	{"Geo.Geohash", 3},
}

type VerifyRequest struct {
	Action string            \`json:"action"\`
	Tags   map[string]string \`json:"tags"\`
}

type VerificationStore struct{}

// OwnerOf returns the owner registered for the entity, or "" when it does not exist.
func (s *VerificationStore) OwnerOf(entityID string) (string, error) { return "", nil }

// PendingTags returns the model's tags awaiting verification, column → tag.
func (s *VerificationStore) PendingTags(entityID string) (map[string]string, error) { return nil, nil }

// RecordVerification stores the verified tags and tier and returns the new version.
func (s *VerificationStore) RecordVerification(entityID string, tags map[string]string, tier int, user, action string) (int, error) {
	return 0, nil
}

// Audit appends one row: who verified which entity, and how.
func (s *VerificationStore) Audit(entityID, user, action string) error { return nil }

var store = &VerificationStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func deriveTier(tags map[string]string) int {
	present := make(map[string]bool, len(tags))
	for _, tag := range tags {
		present[tag] = true
	}
	tier := defaultTier
	for _, rule := range privacyRules {
		if present[rule.tag] && rule.tier < tier {
			tier = rule.tier
		}
	}
	return tier
}

func verify(rw http.ResponseWriter, r *http.Request) {
	user := r.Header.Get("X-User-Id")
	if user == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-User-Id"})
		return
	}
	entityID := r.PathValue("entity_id")
	owner, err := store.OwnerOf(entityID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if owner == "" {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown entity"})
		return
	}
	if owner != user {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "only the owner may verify"})
		return
	}
	var body VerifyRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	action := body.Action
	if action == "" {
		action = "ack"
	}
	if !allowedActions[action] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "action must be ack or edit"})
		return
	}
	var tags map[string]string
	if action == "edit" {
		if len(body.Tags) == 0 {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "edit requires tags"})
			return
		}
		for column, tag := range body.Tags {
			if column == "" || !taxonomy[tag] {
				writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown tag for " + column})
				return
			}
		}
		tags = body.Tags
	} else {
		tags, err = store.PendingTags(entityID)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
	}
	tier := deriveTier(tags)
	version, err := store.RecordVerification(entityID, tags, tier, user, action)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if err := store.Audit(entityID, user, action); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"entity":      entityID,
		"tier":        tier,
		"tags":        tags,
		"verified_by": user,
		"version":     version,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/entities/{entity_id}/verify", verify)
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

final case class VerifyRequest(action: Option[String], tags: Option[Map[String, String]], tier: Option[Int])

object VerifyApi {
  implicit val system: ActorSystem = ActorSystem("metasense")
  implicit val requestFormat: RootJsonFormat[VerifyRequest] = jsonFormat3(VerifyRequest)

  val store = VerificationStore.open()

  val route: Route =
    path("v1" / "entities" / Segment / "verify") { entityId =>
      post {
        headerValueByName("X-User-Id") { user =>
          entity(as[VerifyRequest]) { body =>
            // TODO: this draft lets any caller verify any entity, takes the tier from the body,
            // accepts any tag string, and records nothing about who verified. Review all four.
            val tags = if (body.action.contains("edit")) body.tags.getOrElse(Map.empty) else store.pendingTags(entityId)
            val tier = body.tier.getOrElse(4)
            val version = store.recordVerification(entityId, tags, tier)
            val tagsJson = tags.map { case (k, v) => s""""$k":"$v"""" }.mkString("{", ",", "}")
            complete(StatusCodes.OK, s"""{"entity":"$entityId","tier":$tier,"tags":$tagsJson,"version":$version}""")
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

final case class VerifyRequest(action: Option[String], tags: Option[Map[String, String]])
final case class Verified(entity: String, tier: Int, tags: Map[String, String], verified_by: String, version: Int)

object VerifyApi {
  implicit val system: ActorSystem = ActorSystem("metasense")
  implicit val requestFormat: RootJsonFormat[VerifyRequest] = jsonFormat2(VerifyRequest)
  implicit val verifiedFormat: RootJsonFormat[Verified] = jsonFormat5(Verified)

  val Taxonomy = Set("Personal.ID", "Personal.Name", "Personal.Contact_Info", "Geo.Geohash", "None")
  val AllowedActions = Set("ack", "edit")
  val PrivacyRules: List[(String, Int)] =
    List("Personal.ID" -> 1, "Personal.Name" -> 2, "Personal.Contact_Info" -> 2, "Geo.Geohash" -> 3)
  val DefaultTier = 4

  val store = VerificationStore.open()

  def deriveTier(tags: Map[String, String]): Int = {
    val present = tags.values.toSet
    val tiers = PrivacyRules.collect { case (tag, tier) if present.contains(tag) => tier }
    if (tiers.isEmpty) DefaultTier else tiers.min
  }

  val route: Route =
    path("v1" / "entities" / Segment / "verify") { entityId =>
      post {
        optionalHeaderValueByName("X-User-Id") { userOpt =>
          entity(as[VerifyRequest]) { body =>
            val action = body.action.getOrElse("ack")
            val editTags = body.tags.getOrElse(Map.empty)
            userOpt.filter(_.nonEmpty) match {
              case None =>
                complete(StatusCodes.Unauthorized, """{"error":"missing X-User-Id"}""")
              case Some(user) =>
                store.ownerOf(entityId) match {
                  case None =>
                    complete(StatusCodes.NotFound, """{"error":"unknown entity"}""")
                  case Some(owner) if owner != user =>
                    complete(StatusCodes.Forbidden, """{"error":"only the owner may verify"}""")
                  case Some(_) if !AllowedActions.contains(action) =>
                    complete(StatusCodes.BadRequest, """{"error":"action must be ack or edit"}""")
                  case Some(_) if action == "edit" && editTags.isEmpty =>
                    complete(StatusCodes.BadRequest, """{"error":"edit requires tags"}""")
                  case Some(_) if action == "edit" && editTags.exists { case (c, t) => c.isEmpty || !Taxonomy.contains(t) } =>
                    complete(StatusCodes.BadRequest, """{"error":"unknown tag"}""")
                  case Some(_) =>
                    val tags = if (action == "edit") editTags else store.pendingTags(entityId)
                    val tier = deriveTier(tags)
                    val version = store.recordVerification(entityId, tags, tier, user, action)
                    store.audit(entityId, user, action)
                    complete(StatusCodes.OK, Verified(entityId, tier, tags, user, version))
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

#include <map>
#include <string>

using json = nlohmann::json;

struct VerificationStore {
  std::map<std::string, std::string> pendingTags(const std::string& entityId);
  int recordVerification(const std::string& entityId, const std::map<std::string, std::string>& tags, int tier);
};

VerificationStore store;

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post(R"(/v1/entities/([^/]+)/verify)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft lets any caller verify any entity, takes the tier from the body, accepts
    // any tag string, and records nothing about who verified. Review all four.
    const std::string entityId = req.matches[1];
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    std::map<std::string, std::string> tags;
    if (body.value("action", std::string("ack")) == "edit" && body.contains("tags")) {
      tags = body["tags"].get<std::map<std::string, std::string>>();
    } else {
      tags = store.pendingTags(entityId);
    }
    const int tier = body.value("tier", 4);
    const int version = store.recordVerification(entityId, tags, tier);
    res.status = 200;
    res.set_content(json{{"entity", entityId}, {"tier", tier}, {"tags", tags}, {"version", version}}.dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

const std::set<std::string> kTaxonomy = {"Personal.ID", "Personal.Name", "Personal.Contact_Info", "Geo.Geohash",
                                         "None"};
const std::set<std::string> kAllowedActions = {"ack", "edit"};
const std::vector<std::pair<std::string, int>> kPrivacyRules = {
    {"Personal.ID", 1}, {"Personal.Name", 2}, {"Personal.Contact_Info", 2}, {"Geo.Geohash", 3}};
constexpr int kDefaultTier = 4;

struct VerificationStore {
  std::optional<std::string> ownerOf(const std::string& entityId);
  std::map<std::string, std::string> pendingTags(const std::string& entityId);
  int recordVerification(const std::string& entityId, const std::map<std::string, std::string>& tags, int tier,
                         const std::string& user, const std::string& action);
  void audit(const std::string& entityId, const std::string& user, const std::string& action);
};

VerificationStore store;

int deriveTier(const std::map<std::string, std::string>& tags) {
  std::set<std::string> present;
  for (const auto& [column, tag] : tags) present.insert(tag);
  int tier = kDefaultTier;
  for (const auto& [tag, ruleTier] : kPrivacyRules) {
    if (present.count(tag) > 0 && ruleTier < tier) tier = ruleTier;
  }
  return tier;
}

void fail(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post(R"(/v1/entities/([^/]+)/verify)", [](const httplib::Request& req, httplib::Response& res) {
    const auto user = req.get_header_value("X-User-Id");
    if (user.empty()) return fail(res, 401, "missing X-User-Id");
    const std::string entityId = req.matches[1];
    const auto owner = store.ownerOf(entityId);
    if (!owner) return fail(res, 404, "unknown entity");
    if (*owner != user) return fail(res, 403, "only the owner may verify");

    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto action = body.value("action", std::string("ack"));
    if (kAllowedActions.count(action) == 0) return fail(res, 400, "action must be ack or edit");
    std::map<std::string, std::string> tags;
    if (action == "edit") {
      if (!body.contains("tags") || !body["tags"].is_object() || body["tags"].empty())
        return fail(res, 400, "edit requires tags");
      for (const auto& [column, tag] : body["tags"].items()) {
        if (column.empty() || !tag.is_string() || kTaxonomy.count(tag.get<std::string>()) == 0)
          return fail(res, 400, "unknown tag for " + column);
        tags[column] = tag.get<std::string>();
      }
    } else {
      tags = store.pendingTags(entityId);
    }

    const int tier = deriveTier(tags);
    const int version = store.recordVerification(entityId, tags, tier, user, action);
    store.audit(entityId, user, action);
    res.status = 200;
    res.set_content(
        json{{"entity", entityId}, {"tier", tier}, {"tags", tags}, {"verified_by", user}, {"version", version}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you know which fields of a request are inputs and which are conclusions. The tier is a conclusion: it is what access control and masking read, and the source is explicit that it is *derived* from the tags and the privacy office's rules. A handler that copies it from the body has turned the governance system into a self-service form. Four separate defects are being checked: authorization (the owner, found server-side, is the only verifier — the source's verification step exists because the owner is the one who knows the data), the server-side tier, the taxonomy whitelist on edits (an unknown tag has no rule and therefore no tier), and the audit row with \`verified_by\`, without which the verification cannot be defended in a review. Real services add a four-eyes rule for downgrades (an edit that lowers the tier needs a second approver), a diff of what the owner changed fed back to prompt evaluation as Metasense V2 describes, and a confidence threshold that decides whether the owner is asked to verify at all.`,
};
