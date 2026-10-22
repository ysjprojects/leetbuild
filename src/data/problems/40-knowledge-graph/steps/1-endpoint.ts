import type {Step} from '@/lib/types';

export const entityUpsertStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/entities: upsert with an explicit merge policy',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers
\`POST /v1/entities\`, parses the body and returns the entity. It compiles, it serves the demo, and it
hides four production flaws. Review it like the graph owner, fix it, and prove the fix with the
checks below.

Implement \`POST /v1/entities\` with body
\`{"type": "person", "canonical_name": "…", "aliases": ["…"], "labels": {"…": "…"}}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`Idempotency-Key\` is required (**400** when missing). A replayed upsert returns the entity that
  the first call produced and applies **no** second edge, so a retried batch cannot duplicate graph
  edges.
- \`type\` and \`canonical_name\` are required non-empty strings; \`aliases\` is an optional list of at
  most **32** non-empty strings (**400** otherwise).
- The merge policy is the tenant's and resolved server-side (\`SERVER_MERGE_POLICY\`). A caller may
  send any authority flag it likes (\`authority\`, \`force\`, \`allow_merge\`, \`merge_policy\`) — the
  endpoint refuses the request with **400** and never lets the body decide whether two entities
  merge.
- An alias already claimed by an entity of a **different type** is **409**: the response carries both
  candidates under \`candidates\`, nothing is written, and no edge is created.
- Labels are merged by the server policy (\`merge_labels\`) between the stored entity and the
  request; the request never overwrites the stored labels wholesale.
- Log ids, types and the policy — never the raw labels.

**Failure mode the checks target.** The draft lets the request body carry \`authority: true\` or
\`merge_policy: "force"\` and acts on it, so any caller can force a merge; it folds two entities
together whenever their aliases intersect even when their types differ, so a \`person\` and an
\`company\` sharing a domain-shaped alias silently become one node; it copies \`labels\` from the
request over the stored ones; and it ignores \`Idempotency-Key\`, so a retried batch writes every
edge again. The quiet one is the cross-type merge: it is a data-loss bug that only shows up when a
second tenant reuses an alias.`,
  sequence: {
    participants: ['Client', 'graph-api', 'Graph store'],
    messages: [
      {from: 'Client', to: 'graph-api', label: 'POST /v1/entities · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'graph-api', to: 'graph-api', label: 'reject authority flags · validate aliases', kind: 'sync'},
      {from: 'graph-api', to: 'Graph store', label: 'get(tenant, idem_key)', kind: 'sync'},
      {from: 'Graph store', to: 'graph-api', label: 'stored entity / none', kind: 'reply'},
      {from: 'graph-api', to: 'Graph store', label: 'find_by_alias(tenant, alias…)', kind: 'sync'},
      {from: 'Graph store', to: 'graph-api', label: 'candidates per alias', kind: 'reply'},
      {from: 'graph-api', to: 'Client', label: '409 candidates / 200 entity', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/entities',
      detail: 'Register the upsert route on `POST /v1/entities`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/entities["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/entities['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/entities"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"entities"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/entities"/]},
      },
    },
    {
      id: 'merge-policy',
      title: 'Resolves the merge policy server-side and refuses authority flags',
      detail:
        'The tenant’s policy is a server constant (`SERVER_MERGE_POLICY`) and any caller-supplied authority flag is rejected rather than honoured. The draft reads `merge_policy`/`authority` straight from the body.',
      match: {
        python: {all: [/SERVER_MERGE_POLICY/, /AUTHORITY_FIELDS/]},
        typescript: {all: [/SERVER_MERGE_POLICY/, /AUTHORITY_FIELDS/]},
        go: {all: [/serverMergePolicy/, /authorityFields/]},
        scala: {all: [/ServerMergePolicy/, /AuthorityFields/]},
        cpp: {all: [/kServerMergePolicy/, /kAuthorityFields/]},
      },
    },
    {
      id: 'cross-type-409',
      title: 'Cross-type alias collision is 409 with both candidates',
      detail:
        'When one alias is already claimed by an entity of a different type, the request is **409** and the body names both candidates (`candidates`); nothing is written. The draft merges them.',
      match: {
        python: {all: [/status_code\s*=\s*409/, /AliasCollision/, /candidates/]},
        typescript: {all: [/code\(\s*409\s*\)/, /AliasCollision/, /candidates/]},
        go: {all: [/StatusConflict/, /AliasCollision/, /candidates/]},
        scala: {all: [/StatusCodes\.Conflict/, /AliasCollision/, /candidates/]},
        cpp: {all: [/\b409\b/, /AliasCollision/, /candidates/]},
      },
    },
    {
      id: 'idempotency',
      title: 'Keys the upsert by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required and the entity is stored under `(tenant, key)`; a replay returns the stored entity and writes no edge. The draft ignores the header so a retried batch double-writes edges.',
      match: {
        python: {all: [/Idempotency-Key/, /idem_key/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/idempotency-key/, /idemKey/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/Idempotency-Key/, /idemKey/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /idemKey/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /idemKey/, /store\.get\(/, /store\.put\(/]},
      },
    },
    {
      id: 'label-merge',
      title: 'Merges labels under the policy, never overwrites them',
      detail:
        'Stored and incoming labels are folded by `merge_labels` under `SERVER_MERGE_POLICY`; the request cannot replace the stored labels. The draft assigns `body.labels` directly.',
      match: {
        python: {all: [/def merge_labels\(/, /SERVER_MERGE_POLICY/]},
        typescript: {all: [/function mergeLabels\(/, /SERVER_MERGE_POLICY/]},
        go: {all: [/func mergeLabels\(/, /serverMergePolicy/]},
        scala: {all: [/def mergeLabels\(/, /ServerMergePolicy/]},
        cpp: {all: [/mergeLabels\(/, /kServerMergePolicy/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

app = FastAPI()
logger = logging.getLogger("graph")


class EntityUpsert(BaseModel):
    type: str
    canonical_name: str
    aliases: list[str] = Field(default_factory=list)
    labels: dict[str, str] = Field(default_factory=dict)
    merge_policy: str | None = None
    authority: bool = False


class GraphStore:
    def find_by_alias(self, tenant: str, alias: str) -> list[dict[str, str]]:
        raise NotImplementedError

    def upsert_entity(self, tenant: str, entity: dict) -> None:
        raise NotImplementedError

    def merge(self, tenant: str, left: str, right: str) -> None:
        raise NotImplementedError


store = GraphStore()


@app.post("/v1/entities")
def upsert_entity(body: EntityUpsert) -> JSONResponse:
    # TODO: this draft honours the caller's authority flags, merges any two entities whose aliases
    # intersect even across types, overwrites labels with whatever arrives, and never checks
    # Idempotency-Key. Review all four.
    hits = [hit for alias in [body.canonical_name, *body.aliases] for hit in store.find_by_alias(body.type, alias)]
    if hits and (body.authority or body.merge_policy == "force"):
        for other in hits:
            store.merge(body.type, other["id"], body.canonical_name)
    entity = {
        "type": body.type,
        "canonical_name": body.canonical_name,
        "aliases": body.aliases,
        "labels": body.labels,
    }
    store.upsert_entity(body.type, entity)
    logger.info("upsert %s", entity)
    return JSONResponse(entity, status_code=200)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

app = FastAPI()
logger = logging.getLogger("graph")

# The merge policy belongs to the tenant and is resolved server-side.
SERVER_MERGE_POLICY = "canonical-wins"
# A caller may send anything; these fields are refused, never honoured.
AUTHORITY_FIELDS = {"authority", "force", "allow_merge", "merge_policy"}
MAX_ALIASES = 32


class EntityUpsert(BaseModel):
    type: str
    canonical_name: str
    aliases: list[str] = Field(default_factory=list)
    labels: dict[str, str] = Field(default_factory=dict)


class AliasCollision(Exception):
    """One alias is claimed by entities of more than one type."""

    def __init__(self, candidates: list[dict[str, str]]) -> None:
        self.candidates = candidates
        super().__init__("alias collision across types")


class GraphStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The entity this (tenant, Idempotency-Key) already produced, if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, entity: dict) -> None:
        raise NotImplementedError

    def find_by_alias(self, tenant: str, alias: str) -> list[dict[str, str]]:
        """Every {id, type, canonical_name} that already claims \`alias\` for this tenant."""
        raise NotImplementedError

    def merge(self, tenant: str, left: str, right: str) -> None:
        """Fold two same-type entities together and record the undo edge."""
        raise NotImplementedError

    def link(self, tenant: str, alias: str, entity_id: str) -> None:
        raise NotImplementedError


store = GraphStore()


def merge_labels(existing: dict | None, incoming: EntityUpsert) -> dict[str, str]:
    """Apply SERVER_MERGE_POLICY to the stored labels and the request labels."""
    if SERVER_MERGE_POLICY == "canonical-wins":
        return {**(existing or {}).get("labels", {}), **incoming.labels}
    return dict(incoming.labels)


@app.post("/v1/entities")
async def upsert_entity(request: Request) -> JSONResponse:
    tenant = request.headers.get("X-Tenant-Id")
    if not tenant:
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    idem_key = request.headers.get("Idempotency-Key")
    if not idem_key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")

    raw = await request.json()
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")
    supplied = AUTHORITY_FIELDS.intersection(raw.keys())
    if supplied:
        raise HTTPException(
            status_code=400, detail={"error": "authority flags are not accepted", "fields": sorted(supplied)}
        )

    body = EntityUpsert(**raw)
    if body.type == "" or body.canonical_name == "":
        raise HTTPException(status_code=400, detail="type and canonical_name are required")
    if len(body.aliases) > MAX_ALIASES or any(alias == "" for alias in body.aliases):
        raise HTTPException(status_code=400, detail="aliases must be at most 32 non-empty strings")

    stored = store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    candidates: dict[str, dict[str, str]] = {}
    for alias in [body.canonical_name, *body.aliases]:
        for hit in store.find_by_alias(tenant, alias):
            candidates[hit["id"]] = hit
    if len({hit["type"] for hit in candidates.values()}) > 1:
        named = [{"id": hit["id"], "type": hit["type"], "name": hit["canonical_name"]} for hit in candidates.values()]
        collision = AliasCollision(named[:2])
        raise HTTPException(status_code=409, detail={"error": str(collision), "candidates": collision.candidates})

    existing = next(iter(candidates.values())) if len(candidates) == 1 else None
    entity = {
        "id": (existing or {}).get("id", str(uuid.uuid4())),
        "type": body.type,
        "canonical_name": body.canonical_name,
        "aliases": [body.canonical_name, *body.aliases],
        "labels": merge_labels(existing, body),
        "policy": SERVER_MERGE_POLICY,
    }
    store.put(tenant, idem_key, entity)
    if existing is not None:
        store.merge(tenant, existing["id"], entity["id"])
        for alias in entity["aliases"]:
            store.link(tenant, alias, entity["id"])
    logger.info("upsert tenant=%s id=%s type=%s policy=%s", tenant, entity["id"], body.type, SERVER_MERGE_POLICY)
    return JSONResponse(entity, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/entities: a model-generated draft that trusts the request body. */
import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

interface EntityBody {
  type: string;
  canonical_name: string;
  aliases?: string[];
  labels?: Record<string, string>;
  merge_policy?: string;
  authority?: boolean;
}

app.post('/v1/entities', async (request, reply) => {
  // TODO: this draft honours the caller's authority flags, merges any two entities whose aliases
  // intersect even across types, overwrites labels with whatever arrives, and never checks
  // Idempotency-Key. Review all four.
  const body = request.body as EntityBody;
  const aliases = [body.canonical_name, ...(body.aliases ?? [])];
  const hits = await Promise.all(aliases.map(alias => store.findByAlias(body.type, alias)));
  if (hits.flat().length > 0 && (body.authority === true || body.merge_policy === 'force'))
    for (const other of hits.flat()) await store.merge(body.type, other.id, body.canonical_name);
  const entity = {
    type: body.type,
    canonical_name: body.canonical_name,
    aliases: body.aliases ?? [],
    labels: body.labels ?? {},
  };
  await store.upsertEntity(body.type, entity);
  request.log.info({entity}, 'upserted');
  return reply.code(200).send(entity);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/entities: server-side merge policy, cross-type conflicts, idempotent upserts. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {store, type Entity} from './store';

export const app = Fastify();

// The merge policy belongs to the tenant and is resolved server-side.
const SERVER_MERGE_POLICY = 'canonical-wins';
// A caller may send anything; these fields are refused, never honoured.
const AUTHORITY_FIELDS: readonly string[] = ['authority', 'force', 'allow_merge', 'merge_policy'];
const MAX_ALIASES = 32;

interface EntityBody {
  type: string;
  canonical_name: string;
  aliases?: string[];
  labels?: Record<string, string>;
}

/** One alias is claimed by entities of more than one type. */
class AliasCollision extends Error {
  constructor(readonly candidates: {id: string; type: string; name: string}[]) {
    super('alias collision across types');
  }
}

function mergeLabels(existing: Entity | null, incoming: EntityBody): Record<string, string> {
  if (SERVER_MERGE_POLICY !== 'canonical-wins') return {...(incoming.labels ?? {})};
  return {...(existing?.labels ?? {}), ...(incoming.labels ?? {})};
}

app.post('/v1/entities', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const raw = (request.body ?? {}) as Record<string, unknown>;
  const supplied = AUTHORITY_FIELDS.filter(field => field in raw);
  if (supplied.length > 0)
    return reply.code(400).send({error: 'authority flags are not accepted', fields: supplied});
  const body = raw as unknown as EntityBody;
  if (typeof body.type !== 'string' || body.type === '' || typeof body.canonical_name !== 'string' || body.canonical_name === '')
    return reply.code(400).send({error: 'type and canonical_name are required'});
  const aliases = [body.canonical_name, ...(body.aliases ?? [])];
  if (aliases.length > MAX_ALIASES || aliases.some(alias => alias === ''))
    return reply.code(400).send({error: 'aliases must be at most 32 non-empty strings'});

  const stored = await store.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const hits: Entity[] = [];
  for (const alias of aliases) hits.push(...(await store.findByAlias(tenant, alias)));
  const candidates = [...new Map(hits.map(hit => [hit.id, hit])).values()];
  if (new Set(candidates.map(hit => hit.type)).size > 1) {
    const collision = new AliasCollision(
      candidates.slice(0, 2).map(hit => ({id: hit.id, type: hit.type, name: hit.canonical_name})),
    );
    return reply.code(409).send({error: collision.message, candidates: collision.candidates});
  }

  const existing = candidates.length === 1 ? candidates[0] : null;
  const entity: Entity = {
    id: existing?.id ?? randomUUID(),
    type: body.type,
    canonical_name: body.canonical_name,
    aliases,
    labels: mergeLabels(existing, body),
    policy: SERVER_MERGE_POLICY,
  };
  await store.put(tenant, idemKey, entity);
  if (existing !== null) {
    await store.merge(tenant, existing.id, entity.id);
    for (const alias of aliases) await store.link(tenant, alias, entity.id);
  }
  request.log.info({tenant, id: entity.id, type: entity.type, policy: SERVER_MERGE_POLICY}, 'entity upserted');
  return reply.code(200).send(entity);
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

type EntityBody struct {
	Type          string            \`json:"type"\`
	CanonicalName string            \`json:"canonical_name"\`
	Aliases       []string          \`json:"aliases"\`
	Labels        map[string]string \`json:"labels"\`
	MergePolicy   string            \`json:"merge_policy"\`
	Authority     bool              \`json:"authority"\`
}

type GraphStore struct{}

func (s *GraphStore) FindByAlias(tenant, alias string) []map[string]string { return nil }

func (s *GraphStore) UpsertEntity(tenant string, entity map[string]any) {}

func (s *GraphStore) Merge(tenant, left, right string) {}

var store = &GraphStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func upsertEntity(rw http.ResponseWriter, r *http.Request) {
	var body EntityBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft honours the caller's authority flags, merges any two entities whose aliases
	// intersect even across types, overwrites labels with whatever arrives, and never checks
	// Idempotency-Key. Review all four.
	aliases := append([]string{body.CanonicalName}, body.Aliases...)
	hits := make([]map[string]string, 0)
	for _, alias := range aliases {
		hits = append(hits, store.FindByAlias(body.Type, alias)...)
	}
	if len(hits) > 0 && (body.Authority || body.MergePolicy == "force") {
		for _, other := range hits {
			store.Merge(body.Type, other["id"], body.CanonicalName)
		}
	}
	entity := map[string]any{
		"type":           body.Type,
		"canonical_name": body.CanonicalName,
		"aliases":        body.Aliases,
		"labels":         body.Labels,
	}
	store.UpsertEntity(body.Type, entity)
	log.Printf("upsert %v", entity)
	writeJSON(rw, http.StatusOK, entity)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/entities", upsertEntity)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

// The merge policy belongs to the tenant and is resolved server-side.
const serverMergePolicy = "canonical-wins"

// A caller may send anything; these fields are refused, never honoured.
var authorityFields = map[string]bool{"authority": true, "force": true, "allow_merge": true, "merge_policy": true}

const maxAliases = 32

type EntityBody struct {
	Type          string            \`json:"type"\`
	CanonicalName string            \`json:"canonical_name"\`
	Aliases       []string          \`json:"aliases"\`
	Labels        map[string]string \`json:"labels"\`
}

type Entity struct {
	ID            string            \`json:"id"\`
	Type          string            \`json:"type"\`
	CanonicalName string            \`json:"canonical_name"\`
	Aliases       []string          \`json:"aliases"\`
	Labels        map[string]string \`json:"labels"\`
	Policy        string            \`json:"policy"\`
}

// AliasCollision is one alias claimed by entities of more than one type.
type AliasCollision struct {
	Candidates []map[string]string \`json:"candidates"\`
}

func (c AliasCollision) Error() string { return "alias collision across types" }

type GraphStore struct{}

func (s *GraphStore) Get(ctx context.Context, tenant, idemKey string) (*Entity, error) {
	return nil, nil
}

func (s *GraphStore) Put(ctx context.Context, tenant, idemKey string, entity *Entity) error {
	return nil
}

func (s *GraphStore) FindByAlias(ctx context.Context, tenant, alias string) ([]Entity, error) {
	return nil, nil
}

func (s *GraphStore) Merge(ctx context.Context, tenant, left, right string) error { return nil }

func (s *GraphStore) Link(ctx context.Context, tenant, alias, entityID string) error { return nil }

var store = &GraphStore{}

func mergeLabels(existing *Entity, incoming *EntityBody) map[string]string {
	labels := map[string]string{}
	if serverMergePolicy == "canonical-wins" && existing != nil {
		for key, value := range existing.Labels {
			labels[key] = value
		}
	}
	for key, value := range incoming.Labels {
		labels[key] = value
	}
	return labels
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func upsertEntity(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var raw map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	for field := range raw {
		if authorityFields[field] {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "authority flags are not accepted", "field": field})
			return
		}
	}
	var body EntityBody
	buf, _ := json.Marshal(raw)
	if err := json.Unmarshal(buf, &body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid entity"})
		return
	}
	if body.Type == "" || body.CanonicalName == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "type and canonical_name are required"})
		return
	}
	if len(body.Aliases) > maxAliases {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "too many aliases"})
		return
	}
	stored, err := store.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	aliases := append([]string{body.CanonicalName}, body.Aliases...)
	seen := map[string]Entity{}
	for _, alias := range aliases {
		hits, err := store.FindByAlias(r.Context(), tenant, alias)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		for _, hit := range hits {
			seen[hit.ID] = hit
		}
	}
	candidates := make([]Entity, 0, len(seen))
	types := map[string]bool{}
	for _, hit := range seen {
		candidates = append(candidates, hit)
		types[hit.Type] = true
	}
	if len(types) > 1 {
		named := make([]map[string]string, 0, 2)
		for _, hit := range candidates[:min(2, len(candidates))] {
			named = append(named, map[string]string{"id": hit.ID, "type": hit.Type, "name": hit.CanonicalName})
		}
		collision := AliasCollision{Candidates: named}
		log.Printf("upsert tenant=%s collision=%s", tenant, collision.Error())
		writeJSON(rw, http.StatusConflict, collision)
		return
	}
	var existing *Entity
	if len(candidates) == 1 {
		existing = &candidates[0]
	}
	entity := &Entity{
		Type:          body.Type,
		CanonicalName: body.CanonicalName,
		Aliases:       aliases,
		Labels:        mergeLabels(existing, &body),
		Policy:        serverMergePolicy,
	}
	if existing != nil {
		entity.ID = existing.ID
	} else {
		entity.ID = uuid.NewString()
	}
	if err := store.Put(r.Context(), tenant, idemKey, entity); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if existing != nil {
		if err := store.Merge(r.Context(), tenant, existing.ID, entity.ID); err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		for _, alias := range aliases {
			if err := store.Link(r.Context(), tenant, alias, entity.ID); err != nil {
				writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
				return
			}
		}
	}
	log.Printf("upsert tenant=%s id=%s type=%s policy=%s", tenant, entity.ID, entity.Type, serverMergePolicy)
	writeJSON(rw, http.StatusOK, entity)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/entities", upsertEntity)
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

final case class EntityBody(\`type\`: String, canonical_name: String, aliases: List[String], labels: Map[String, String], merge_policy: Option[String], authority: Boolean)

object GraphStore {
  def open(): GraphStore = new GraphStore()
}

class GraphStore {
  def findByAlias(tenant: String, alias: String): List[Map[String, String]] = Nil
  def upsertEntity(tenant: String, entity: Map[String, String]): Unit = ()
  def merge(tenant: String, left: String, right: String): Unit = ()
}

object EntityApi {
  implicit val system: ActorSystem = ActorSystem("knowledge-graph")
  implicit val bodyFormat: RootJsonFormat[EntityBody] = jsonFormat6(EntityBody)

  val store: GraphStore = GraphStore.open()

  val route: Route = path("v1" / "entities") {
    post {
      entity(as[EntityBody]) { body =>
        // TODO: this draft honours the caller's authority flags, merges any two entities whose
        // aliases intersect even across types, overwrites labels with whatever arrives, and never
        // checks Idempotency-Key. Review all four.
        val aliases = body.canonical_name :: body.aliases
        val hits = aliases.flatMap(alias => store.findByAlias(body.\`type\`, alias))
        if (hits.nonEmpty && (body.authority || body.merge_policy.contains("force"))) {
          hits.foreach(other => store.merge(body.\`type\`, other("id"), body.canonical_name))
        }
        val entity = Map(
          "type" -> body.\`type\`,
          "canonical_name" -> body.canonical_name,
          "aliases" -> body.aliases.mkString(","),
          "labels" -> body.labels.mkString(","),
        )
        store.upsertEntity(body.\`type\`, entity)
        system.log.info(s"upsert $entity")
        complete(StatusCodes.OK, entity)
      }
    }
  }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class EntityBody(\`type\`: String, canonical_name: String, aliases: List[String], labels: Map[String, String])
final case class Entity(
    id: String,
    \`type\`: String,
    canonical_name: String,
    aliases: List[String],
    labels: Map[String, String],
    policy: String,
)
final case class AliasCollision(candidates: List[Map[String, String]])

object GraphStore {
  def open(): GraphStore = new GraphStore()
}

class GraphStore {
  def get(tenant: String, idemKey: String): Option[Entity] = None
  def put(tenant: String, idemKey: String, entity: Entity): Unit = ()
  def findByAlias(tenant: String, alias: String): List[Entity] = Nil
  def merge(tenant: String, left: String, right: String): Unit = ()
  def link(tenant: String, alias: String, entityId: String): Unit = ()
}

object EntityApi {
  implicit val system: ActorSystem = ActorSystem("knowledge-graph")
  implicit val labelFormat: RootJsonFormat[Map[String, String]] = mapFormat[String, String]
  implicit val bodyFormat: RootJsonFormat[EntityBody] = jsonFormat4(EntityBody)
  implicit val entityFormat: RootJsonFormat[Entity] = jsonFormat6(Entity)
  implicit val collisionFormat: RootJsonFormat[AliasCollision] = jsonFormat1(AliasCollision)

  // The merge policy belongs to the tenant and is resolved server-side.
  val ServerMergePolicy = "canonical-wins"
  // A caller may send anything; these fields are refused, never honoured.
  val AuthorityFields = Set("authority", "force", "allow_merge", "merge_policy")
  val MaxAliases = 32

  val store: GraphStore = GraphStore.open()

  def mergeLabels(existing: Option[Entity], incoming: EntityBody): Map[String, String] = {
    val base =
      if (ServerMergePolicy == "canonical-wins") existing.map(_.labels).getOrElse(Map.empty[String, String])
      else Map.empty[String, String]
    base ++ incoming.labels
  }

  val route: Route = path("v1" / "entities") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
        optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
          entity(as[EntityBody]) { body =>
            val aliases = body.canonical_name :: body.aliases
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else if (!idemOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
            } else if (body.\`type\`.isEmpty || body.canonical_name.isEmpty) {
              complete(StatusCodes.BadRequest, """{"error":"type and canonical_name are required"}""")
            } else if (aliases.length > MaxAliases || aliases.exists(_.isEmpty)) {
              complete(StatusCodes.BadRequest, """{"error":"aliases must be at most 32 non-empty strings"}""")
            } else {
              val tenant = tenantOpt.get
              val idemKey = idemOpt.get
              store.get(tenant, idemKey) match {
                case Some(stored) =>
                  complete(StatusCodes.OK, stored)
                case None =>
                  val hits = aliases.flatMap(alias => store.findByAlias(tenant, alias)).distinct
                  if (hits.map(_.\`type\`).distinct.length > 1) {
                    val candidates = hits.take(2).map(hit => Map("id" -> hit.id, "type" -> hit.\`type\`, "name" -> hit.canonical_name))
                    complete(StatusCodes.Conflict, AliasCollision(candidates))
                  } else {
                    val existing = if (hits.length == 1) Some(hits.head) else None
                    val entity = Entity(
                      existing.map(_.id).getOrElse(UUID.randomUUID().toString),
                      body.\`type\`,
                      body.canonical_name,
                      aliases,
                      mergeLabels(existing, body),
                      ServerMergePolicy,
                    )
                    store.put(tenant, idemKey, entity)
                    existing.foreach { merged =>
                      store.merge(tenant, merged.id, entity.id)
                      aliases.foreach(alias => store.link(tenant, alias, entity.id))
                    }
                    system.log.info(s"upsert tenant=$tenant id=\${entity.id} policy=$ServerMergePolicy")
                    complete(StatusCodes.OK, entity)
                  }
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

#include <iostream>
#include <string>
#include <vector>

using json = nlohmann::json;

struct GraphStore {
  std::vector<json> findByAlias(const std::string& tenant, const std::string& alias);
  void upsertEntity(const std::string& tenant, const json& entity);
  void merge(const std::string& tenant, const std::string& left, const std::string& right);
};

GraphStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/entities", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft honours the caller's authority flags, merges any two entities whose aliases
    // intersect even across types, overwrites labels with whatever arrives, and never checks
    // Idempotency-Key. Review all four.
    const auto type = body.value("type", std::string());
    const auto name = body.value("canonical_name", std::string());
    std::vector<std::string> aliases{name};
    for (const auto& alias : body.value("aliases", std::vector<std::string>{})) aliases.push_back(alias);
    std::vector<json> hits;
    for (const auto& alias : aliases)
      for (const auto& hit : store.findByAlias(type, alias)) hits.push_back(hit);
    if (!hits.empty() && (body.value("authority", false) || body.value("merge_policy", std::string()) == "force"))
      for (const auto& other : hits) store.merge(type, other.value("id", std::string()), name);
    const json entity = {
        {"type", type},
        {"canonical_name", name},
        {"aliases", aliases},
        {"labels", body.value("labels", json::object())},
    };
    store.upsertEntity(type, entity);
    std::cerr << "upsert " << entity.dump() << "\\n";
    res.status = 200;
    res.set_content(entity.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <map>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

// The merge policy belongs to the tenant and is resolved server-side.
const std::string kServerMergePolicy = "canonical-wins";
// A caller may send anything; these fields are refused, never honoured.
const std::set<std::string> kAuthorityFields = {"authority", "force", "allow_merge", "merge_policy"};
constexpr std::size_t kMaxAliases = 32;

struct Entity {
  std::string id;
  std::string type;
  std::string canonicalName;
  std::vector<std::string> aliases;
  std::map<std::string, std::string> labels;
};

struct AliasCollision {
  std::vector<std::map<std::string, std::string>> candidates;
};

struct GraphStore {
  std::optional<Entity> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const Entity& entity);
  std::vector<Entity> findByAlias(const std::string& tenant, const std::string& alias);
  void merge(const std::string& tenant, const std::string& left, const std::string& right);
  void link(const std::string& tenant, const std::string& alias, const std::string& entityId);
};

GraphStore store;
std::string uuidString();

std::map<std::string, std::string> mergeLabels(const std::optional<Entity>& existing,
                                               const std::map<std::string, std::string>& incoming) {
  std::map<std::string, std::string> labels;
  if (kServerMergePolicy == "canonical-wins" && existing.has_value()) labels = existing->labels;
  for (const auto& [key, value] : incoming) labels[key] = value;
  return labels;
}

json toJson(const Entity& entity) {
  return json{{"id", entity.id},
              {"type", entity.type},
              {"canonical_name", entity.canonicalName},
              {"aliases", entity.aliases},
              {"labels", entity.labels},
              {"policy", kServerMergePolicy}};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/entities", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"body must be a JSON object"})", "application/json");
      return;
    }
    for (const auto& field : kAuthorityFields) {
      if (body.contains(field)) {
        res.status = 400;
        res.set_content(R"({"error":"authority flags are not accepted"})", "application/json");
        return;
      }
    }
    if (!body.contains("type") || !body["type"].is_string() || !body.contains("canonical_name") ||
        !body["canonical_name"].is_string() || body["type"].get<std::string>().empty() ||
        body["canonical_name"].get<std::string>().empty()) {
      res.status = 400;
      res.set_content(R"({"error":"type and canonical_name are required"})", "application/json");
      return;
    }
    const auto type = body["type"].get<std::string>();
    const auto name = body["canonical_name"].get<std::string>();
    std::vector<std::string> aliases{name};
    for (const auto& alias : body.value("aliases", std::vector<std::string>{})) aliases.push_back(alias);
    if (aliases.size() > kMaxAliases) {
      res.status = 400;
      res.set_content(R"({"error":"too many aliases"})", "application/json");
      return;
    }
    const auto stored = store.get(tenant, idemKey);
    if (stored.has_value()) {
      res.status = 200;
      res.set_content(toJson(*stored).dump(), "application/json");
      return;
    }
    std::vector<Entity> candidates;
    std::set<std::string> types;
    for (const auto& alias : aliases) {
      for (const auto& hit : store.findByAlias(tenant, alias)) {
        candidates.push_back(hit);
        types.insert(hit.type);
      }
    }
    if (types.size() > 1) {
      AliasCollision collision;
      for (std::size_t i = 0; i < candidates.size() && i < 2; ++i)
        collision.candidates.push_back({{"id", candidates[i].id}, {"type", candidates[i].type}, {"name", candidates[i].canonicalName}});
      res.status = 409;
      res.set_content(json{{"error", "alias collision across types"}, {"candidates", collision.candidates}}.dump(),
                      "application/json");
      return;
    }
    std::optional<Entity> existing;
    if (candidates.size() == 1) existing = candidates.front();
    Entity entity;
    entity.id = existing.has_value() ? existing->id : uuidString();
    entity.type = type;
    entity.canonicalName = name;
    entity.aliases = aliases;
    entity.labels = mergeLabels(existing, body.value("labels", std::map<std::string, std::string>{}));
    store.put(tenant, idemKey, entity);
    if (existing.has_value()) {
      store.merge(tenant, existing->id, entity.id);
      for (const auto& alias : aliases) store.link(tenant, alias, entity.id);
    }
    std::cerr << "upsert tenant=" << tenant << " id=" << entity.id << " type=" << entity.type
              << " policy=" << kServerMergePolicy << "\\n";
    res.status = 200;
    res.set_content(toJson(entity).dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses first, in cost order: tenant (401), Idempotency-Key (400), authority flags (400), body shape, alias count. Notice that the policy is never read from the body — the tenant owns it, the request only proposes an entity.',
    'The conflict rule is about **types**, not aliases: look every proposed alias up, group the hits, and if they span more than one type answer 409 with both candidates named. Merging same-type duplicates is allowed; merging across types is a data-loss bug.',
    'A retried batch is the normal case on a flaky network: the store keyed by `(tenant, Idempotency-Key)` returns the first entity, and the edge-writing code after the lookup is never reached twice. Labels are folded with `merge_labels` so a later sparse upsert cannot erase what an earlier one stored.',
  ],
  debrief: `The interviewer is testing whether you can review a generated upsert at the trust boundary. The draft reads fine because the demo sends one entity from one tenant and never retries. Four defects are checked: the merge policy is the tenant's, never the caller's (authority flags are refused, not obeyed); a cross-type alias collision is a conflict with both candidates named, not a silent merge; idempotency keyed by \`(tenant, Idempotency-Key)\` stops a retried batch from double-writing edges; and labels are merged under the policy instead of overwritten. Real graph services add a merge audit table with an undo edge, per-tenant alias namespaces, and a review queue for same-type candidates whose scores only an operator can settle.`,
};
