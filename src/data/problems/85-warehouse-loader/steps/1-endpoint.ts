import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/loads: a manifest that is the unit of work',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the manifest and answers \`202\` with a new load id, so the demo reads a file into a table. It hides
four production flaws. Review it like the service owner, fix it, and prove the fix with the checks
below.

Implement \`POST /v1/loads\` with body
\`{"source": {"dataset": "orders", "version": "2026-10-20"}, "target": "wh_acme.orders", "mode": "merge", "transform": "dedupe"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- The rendered manifest is at most **64 KiB** (\`1 << 16\` bytes) of JSON; a larger one is **413**.
- \`mode\` is one of \`append\`, \`merge\`, \`replace\` (**400** otherwise) — the load mode decides
  whether a re-run may replace a partition or must add to it, so it is never guessed.
- \`transform\` must be the **name** of a registered transform: the registry maps \`identity\`,
  \`dedupe\`, \`cast_types\`, \`mask_pii\` to SQL compiled server-side. A caller-supplied SQL
  string is **400** — a raw transform would run caller-authored SQL in the warehouse under the
  loader's credentials, on every tenant's data.
- \`target\` is \`schema.table\`, and \`schema\` must be the caller's own \`wh_{tenant}\`; a target
  in another tenant's schema is **403**, and so is a malformed target.
- \`Idempotency-Key\` is required (**400** when missing). It is keyed **by the manifest**: the same
  \`(tenant, key)\` with the same manifest returns the original load (**200**) instead of starting a
  second one; the same key with a *different* manifest is **409**, because two different loads can
  never share one idempotency key.
- A new load answers **202** with \`load_id\`, \`status\`, \`target\`, \`mode\` and \`rows_planned\`.

**Failure mode the checks target.** A raw \`transform\` is remote code execution with the loader's
warehouse credentials; a \`target\` that defaults to a shared schema silently writes one tenant's rows
into another tenant's table; and an un-keyed retry starts a second load of the same manifest, which is
exactly how a table ends up with the same day counted twice.`,
  sequence: {
    participants: ['Loader client', 'Load API', 'catalog', 'loads store'],
    messages: [
      {from: 'Loader client', to: 'Load API', label: 'POST /v1/loads · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Load API', to: 'Load API', label: 'validate mode · transform · tenant target', kind: 'sync'},
      {from: 'Load API', to: 'catalog', label: 'rows_planned(dataset, version)', kind: 'sync'},
      {from: 'catalog', to: 'Load API', label: 'count', kind: 'reply'},
      {from: 'Load API', to: 'loads store', label: 'get(tenant, idem_key)', kind: 'sync'},
      {from: 'loads store', to: 'Load API', label: 'stored manifest / none', kind: 'reply'},
      {from: 'Load API', to: 'loads store', label: 'put(tenant, idem_key, manifest)', kind: 'async'},
      {from: 'Load API', to: 'Loader client', label: '202 {load_id, rows_planned} · 200 on replay', kind: 'reply'},
    ],
  },
  hints: [
    'Validate in cost order before touching the store: tenant, Idempotency-Key, manifest size, mode, transform, target schema. Every rejection is cheap and happens before any warehouse work can be planned.',
    'The transform is a *name*: `sql = REGISTERED_TRANSFORMS[body.transform]` after a membership test. If the caller can put SQL in the body, it runs with your credentials; the registry is the whole trust boundary between the API and the warehouse.',
    'Key idempotency by `(tenant, key)` and store the manifest fingerprint beside the load. A hit with the same fingerprint returns the stored load; a hit with a different one is a 409 — reusing one key for two manifests would otherwise answer the wrong load.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/loads',
      detail: 'Register the load route on `POST /v1/loads`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/loads["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/loads['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/loads"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"loads"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/loads"/]},
      },
    },
    {
      id: 'registered-transform',
      title: 'Compiles a registered transform instead of executing caller SQL',
      detail:
        '`transform` must be a key of the registry; anything else is **400**, and the SQL that runs comes from the registry, not from the body. The draft stores the caller’s string as the transform.',
      match: {
        python: {
          all: [/REGISTERED_TRANSFORMS/, /status_code\s*=\s*400/],
          none: [/["']transform["']\s*:\s*body\.transform/],
        },
        typescript: {
          all: [/REGISTERED_TRANSFORMS/, /code\(\s*400\s*\)/],
          none: [/transform:\s*body\.transform/],
        },
        go: {all: [/registeredTransforms/, /StatusBadRequest/]},
        scala: {all: [/RegisteredTransforms/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kRegisteredTransforms/, /\b400\b/]},
      },
    },
    {
      id: 'tenant-schema',
      title: 'Refuses a target outside the tenant’s schema',
      detail:
        'The target schema must equal `wh_{tenant}`; a cross-tenant or malformed target is **403** (or **400** when it is not `schema.table`). The draft defaults the target to a shared schema, so one tenant writes into another’s table.',
      match: {
        python: {all: [/schema_for\(/, /status_code\s*=\s*403/]},
        typescript: {all: [/schemaFor\(/, /code\(\s*403\s*\)/]},
        go: {all: [/schemaFor\(/, /StatusForbidden/]},
        scala: {all: [/schemaFor\(/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/schemaFor\(/, /\b403\b/]},
      },
    },
    {
      id: 'manifest-key',
      title: 'Keys the load by the manifest and returns the original on replay',
      detail:
        '`Idempotency-Key` is required and the load is stored under `(tenant, key)` with the manifest fingerprint; a replay of the same manifest returns the original load, a different manifest under the same key is **409**. The draft ignores the header and starts a second load.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/, /status_code\s*=\s*409/]},
        typescript: {all: [/idempotency-key/, /store\.get\(/, /store\.put\(/, /code\(\s*409\s*\)/]},
        go: {all: [/Idempotency-Key/, /store\.Get\(/, /store\.Put\(/, /StatusConflict/]},
        scala: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/, /StatusCodes\.Conflict/]},
        cpp: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/, /\b409\b/]},
      },
    },
    {
      id: 'manifest-bounds',
      title: 'Bounds the manifest and validates the load mode',
      detail:
        'A rendered manifest over `1 << 16` bytes is **413** and a `mode` outside `append`/`merge`/`replace` is **400**. The draft never checks the size and lets any mode through.',
      match: {
        python: {all: [/MAX_MANIFEST_BYTES/, /status_code\s*=\s*413/, /LOAD_MODES/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_MANIFEST_BYTES/, /code\(\s*413\s*\)/, /LOAD_MODES/, /code\(\s*400\s*\)/]},
        go: {all: [/maxManifestBytes/, /StatusRequestEntityTooLarge/, /loadModes/, /StatusBadRequest/]},
        scala: {
          all: [/MaxManifestBytes/, /StatusCodes\.RequestEntityTooLarge/, /LoadModes/, /StatusCodes\.BadRequest/],
        },
        cpp: {all: [/kMaxManifestBytes/, /\b413\b/, /kLoadModes/, /\b400\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class Source(BaseModel):
    dataset: str
    version: str


class LoadRequest(BaseModel):
    source: Source
    target: str | None = None
    mode: str = "append"
    transform: str = "identity"


class LoadStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The record stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, record: dict) -> None:
        """Store the load under (tenant, idem_key)."""
        raise NotImplementedError


store = LoadStore()


@app.post("/v1/loads")
def create_load(body: LoadRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft takes the raw transform the caller sent, lets the target default to a shared
    # schema, ignores Idempotency-Key so a client retry starts a second load, and never validates
    # the manifest size or the load mode. Review all four.
    load = {
        "load_id": str(uuid.uuid4()),
        "status": "queued",
        "target": body.target or "shared.loads",
        "mode": body.mode,
        "transform": body.transform,
    }
    store.put(tenant, load["load_id"], load)
    return JSONResponse(load, status_code=202)
`,
      solution: `import hashlib
import json
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

MAX_MANIFEST_BYTES = 1 << 16
LOAD_MODES = {"append", "merge", "replace"}
SCHEMA_PREFIX = "wh_"
REGISTERED_TRANSFORMS = {
    "identity": "SELECT * FROM source",
    "dedupe": "SELECT DISTINCT ON (id) * FROM source",
    "cast_types": "SELECT id, paid_at::timestamptz AS paid_at FROM source",
    "mask_pii": "SELECT id, mask(email) AS email FROM source",
}


class Source(BaseModel):
    dataset: str
    version: str


class LoadRequest(BaseModel):
    source: Source
    target: str
    mode: str
    transform: str


class LoadStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The record stored for (tenant, idem_key): {"manifest_hash": ..., "load": {...}}."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, record: dict) -> None:
        """Store the record under (tenant, idem_key)."""
        raise NotImplementedError


class Catalog:
    def rows_planned(self, dataset: str, version: str) -> int:
        """The row count the source version declares; the load is only complete when all of them land."""
        raise NotImplementedError


store = LoadStore()
catalog = Catalog()


def schema_for(tenant: str) -> str:
    """The only schema a tenant may write into."""
    return f"{SCHEMA_PREFIX}{tenant}"


def manifest_hash(body: LoadRequest) -> str:
    raw = json.dumps(
        [body.source.dataset, body.source.version, body.target, body.mode, body.transform],
        sort_keys=True,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def target_schema(target: str) -> str:
    schema, sep, table = target.partition(".")
    if sep == "" or schema == "" or table == "":
        raise HTTPException(status_code=400, detail="target must be schema.table")
    return schema


@app.post("/v1/loads")
def create_load(
    body: LoadRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    rendered = json.dumps(body.model_dump())
    if len(rendered.encode("utf-8")) > MAX_MANIFEST_BYTES:
        raise HTTPException(status_code=413, detail="manifest exceeds 64 KiB")
    if body.mode not in LOAD_MODES:
        raise HTTPException(status_code=400, detail="mode must be append, merge or replace")
    if body.transform not in REGISTERED_TRANSFORMS:
        raise HTTPException(status_code=400, detail="unknown transform")
    transform = body.transform
    registered_sql = REGISTERED_TRANSFORMS[transform]
    if target_schema(body.target) != schema_for(tenant):
        raise HTTPException(status_code=403, detail="target is outside the tenant schema")

    digest = manifest_hash(body)
    stored = store.get(tenant, idem_key)
    if stored is not None:
        if stored["manifest_hash"] != digest:
            raise HTTPException(status_code=409, detail="Idempotency-Key reused for another manifest")
        return JSONResponse(stored["load"], status_code=200)

    load = {
        "load_id": str(uuid.uuid4()),
        "status": "queued",
        "target": body.target,
        "mode": body.mode,
        "transform": transform,
        "sql": registered_sql,
        "rows_planned": catalog.rows_planned(body.source.dataset, body.source.version),
    }
    store.put(tenant, idem_key, {"manifest_hash": digest, "load": load})
    return JSONResponse(load, status_code=202)
`,
    },
    typescript: {
      starter: `/** POST /v1/loads: a model-generated draft that trusts the whole manifest. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

interface LoadBody {
  source: {dataset: string; version: string};
  target?: string;
  mode?: string;
  transform?: string;
}

app.post('/v1/loads', async (request, reply) => {
  // TODO: this draft takes the raw transform the caller sent, lets the target default to a shared
  // schema, ignores Idempotency-Key so a client retry starts a second load, and never validates
  // the manifest size or the load mode. Review all four.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as LoadBody;
  const load = {
    load_id: randomUUID(),
    status: 'queued',
    target: body.target ?? 'shared.loads',
    mode: body.mode ?? 'append',
    transform: body.transform ?? 'identity',
  };
  await store.put(tenant, load.load_id, {manifest_hash: '', load});
  return reply.code(202).send(load);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/loads: a manifest is the unit of work, keyed by tenant and Idempotency-Key. */
import {createHash, randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const MAX_MANIFEST_BYTES = 1 << 16;
const LOAD_MODES: Record<string, true> = {append: true, merge: true, replace: true};
const SCHEMA_PREFIX = 'wh_';
const REGISTERED_TRANSFORMS: Record<string, string> = {
  identity: 'SELECT * FROM source',
  dedupe: 'SELECT DISTINCT ON (id) * FROM source',
  cast_types: 'SELECT id, paid_at::timestamptz AS paid_at FROM source',
  mask_pii: 'SELECT id, mask(email) AS email FROM source',
};

interface LoadBody {
  source: {dataset: string; version: string};
  target: string;
  mode: string;
  transform: string;
}

interface LoadRecord {
  manifest_hash: string;
  load: Record<string, unknown>;
}

export const store = {
  async get(tenant: string, idemKey: string): Promise<LoadRecord | null> {
    throw new Error('not implemented');
  },
  async put(tenant: string, idemKey: string, record: LoadRecord): Promise<void> {
    throw new Error('not implemented');
  },
};

export const catalog = {
  async rowsPlanned(dataset: string, version: string): Promise<number> {
    throw new Error('not implemented');
  },
};

function schemaFor(tenant: string): string {
  if (!/^[a-z0-9_]{1,32}$/.test(tenant)) throw new Error('invalid tenant');
  return \`\${SCHEMA_PREFIX}\${tenant}\`;
}

function manifestHash(body: LoadBody): string {
  return createHash('sha256')
    .update(JSON.stringify([body.source.dataset, body.source.version, body.target, body.mode, body.transform]))
    .digest('hex');
}

function targetSchema(target: string): string {
  const [schema, table] = target.split('.');
  if (schema === undefined || schema === '' || table === undefined || table === '') throw new Error('malformed');
  return schema;
}

app.post('/v1/loads', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as LoadBody;
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_MANIFEST_BYTES)
    return reply.code(413).send({error: 'manifest exceeds 64 KiB'});
  if (LOAD_MODES[body.mode] !== true) return reply.code(400).send({error: 'mode must be append, merge or replace'});
  if (REGISTERED_TRANSFORMS[body.transform] === undefined)
    return reply.code(400).send({error: 'unknown transform'});
  const transform = body.transform;
  let schema: string;
  try {
    schema = targetSchema(body.target);
  } catch {
    return reply.code(400).send({error: 'target must be schema.table'});
  }
  if (schema !== schemaFor(tenant)) return reply.code(403).send({error: 'target is outside the tenant schema'});

  const digest = manifestHash(body);
  const stored = await store.get(tenant, idemKey);
  if (stored !== null) {
    if (stored.manifest_hash !== digest)
      return reply.code(409).send({error: 'Idempotency-Key reused for another manifest'});
    return reply.code(200).send(stored.load);
  }

  const load = {
    load_id: randomUUID(),
    status: 'queued',
    target: body.target,
    mode: body.mode,
    transform,
    sql: REGISTERED_TRANSFORMS[transform],
    rows_planned: await catalog.rowsPlanned(body.source.dataset, body.source.version),
  };
  await store.put(tenant, idemKey, {manifest_hash: digest, load});
  return reply.code(202).send(load);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

type Manifest struct {
	Source struct {
		Dataset string \`json:"dataset"\`
		Version string \`json:"version"\`
	} \`json:"source"\`
	Target    string \`json:"target"\`
	Mode      string \`json:"mode"\`
	Transform string \`json:"transform"\`
}

type LoadStore struct{}

func (s *LoadStore) Get(ctx context.Context, tenant, idemKey string) (*LoadRecord, error) { return nil, nil }

func (s *LoadStore) Put(ctx context.Context, tenant, idemKey string, rec LoadRecord) error { return nil }

type LoadRecord struct {
	ManifestHash string         \`json:"manifest_hash"\`
	Load         map[string]any \`json:"load"\`
}

var store = &LoadStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createLoad(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body Manifest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft takes the raw transform the caller sent, lets the target default to a shared
	// schema, ignores Idempotency-Key so a client retry starts a second load, and never validates
	// the manifest size or the load mode. Review all four.
	target := body.Target
	if target == "" {
		target = "shared.loads"
	}
	load := map[string]any{
		"load_id":   uuid.NewString(),
		"status":    "queued",
		"target":    target,
		"mode":      body.Mode,
		"transform": body.Transform,
	}
	log.Printf("load queued tenant=%s target=%s", tenant, target)
	store.Put(r.Context(), tenant, load["load_id"].(string), LoadRecord{Load: load})
	writeJSON(rw, http.StatusAccepted, load)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/loads", createLoad)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

const (
	maxManifestBytes = 1 << 16
	schemaPrefix     = "wh_"
)

var loadModes = map[string]bool{"append": true, "merge": true, "replace": true}

var registeredTransforms = map[string]string{
	"identity":   "SELECT * FROM source",
	"dedupe":     "SELECT DISTINCT ON (id) * FROM source",
	"cast_types": "SELECT id, paid_at::timestamptz AS paid_at FROM source",
	"mask_pii":   "SELECT id, mask(email) AS email FROM source",
}

type Manifest struct {
	Source struct {
		Dataset string \`json:"dataset"\`
		Version string \`json:"version"\`
	} \`json:"source"\`
	Target    string \`json:"target"\`
	Mode      string \`json:"mode"\`
	Transform string \`json:"transform"\`
}

type LoadRecord struct {
	ManifestHash string         \`json:"manifest_hash"\`
	Load         map[string]any \`json:"load"\`
}

type LoadStore struct{}

func (s *LoadStore) Get(ctx context.Context, tenant, idemKey string) (*LoadRecord, error) {
	return nil, nil
}

func (s *LoadStore) Put(ctx context.Context, tenant, idemKey string, rec LoadRecord) error { return nil }

type Catalog struct{}

func (c *Catalog) RowsPlanned(ctx context.Context, dataset, version string) (int64, error) { return 0, nil }

var (
	store   = &LoadStore{}
	catalog = &Catalog{}
)

func schemaFor(tenant string) string { return schemaPrefix + tenant }

func manifestHash(body Manifest) string {
	raw, _ := json.Marshal([]string{body.Source.Dataset, body.Source.Version, body.Target, body.Mode, body.Transform})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createLoad(rw http.ResponseWriter, r *http.Request) {
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
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxManifestBytes+1))
	if err != nil || len(raw) > maxManifestBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "manifest exceeds 64 KiB"})
		return
	}
	var body Manifest
	if err := json.Unmarshal(raw, &body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if !loadModes[body.Mode] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "mode must be append, merge or replace"})
		return
	}
	sql, ok := registeredTransforms[body.Transform]
	if !ok {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown transform"})
		return
	}
	schema, table, found := strings.Cut(body.Target, ".")
	if !found || schema == "" || table == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "target must be schema.table"})
		return
	}
	if schema != schemaFor(tenant) {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "target is outside the tenant schema"})
		return
	}

	digest := manifestHash(body)
	stored, err := store.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		if stored.ManifestHash != digest {
			writeJSON(rw, http.StatusConflict, map[string]string{"error": "Idempotency-Key reused for another manifest"})
			return
		}
		writeJSON(rw, http.StatusOK, stored.Load)
		return
	}

	planned, err := catalog.RowsPlanned(r.Context(), body.Source.Dataset, body.Source.Version)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	load := map[string]any{
		"load_id":      uuid.NewString(),
		"status":       "queued",
		"target":       body.Target,
		"mode":         body.Mode,
		"transform":    body.Transform,
		"sql":          sql,
		"rows_planned": planned,
	}
	if err := store.Put(r.Context(), tenant, idemKey, LoadRecord{ManifestHash: digest, Load: load}); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("load queued tenant=%s target=%s mode=%s", tenant, body.Target, body.Mode)
	writeJSON(rw, http.StatusAccepted, load)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/loads", createLoad)
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

final case class ManifestSource(dataset: String, version: String)
final case class Manifest(source: ManifestSource, target: Option[String], mode: Option[String], transform: Option[String])
final case class LoadRecord(manifest_hash: String, load: Map[String, String])

object LoadStore {
  def open(): LoadStore = new LoadStore

  class LoadStore {
    def get(tenant: String, idemKey: String): Option[LoadRecord] = None
    def put(tenant: String, idemKey: String, record: LoadRecord): Unit = ()
  }
}

object LoadApi {
  implicit val system: ActorSystem = ActorSystem("warehouse-loader")
  implicit val sourceFormat: RootJsonFormat[ManifestSource] = jsonFormat2(ManifestSource)
  implicit val manifestFormat: RootJsonFormat[Manifest] = jsonFormat4(Manifest)

  val store = LoadStore.open()

  val route: Route =
    path("v1" / "loads") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[Manifest]) { body =>
            // TODO: this draft takes the raw transform the caller sent, lets the target default to
            // a shared schema, ignores Idempotency-Key so a client retry starts a second load, and
            // never validates the manifest size or the load mode. Review all four.
            val load = Map(
              "load_id" -> java.util.UUID.randomUUID().toString,
              "status" -> "queued",
              "target" -> body.target.getOrElse("shared.loads"),
              "mode" -> body.mode.getOrElse("append"),
              "transform" -> body.transform.getOrElse("identity")
            )
            store.put(tenant, load("load_id"), LoadRecord("", load))
            complete(StatusCodes.Accepted, load)
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ManifestSource(dataset: String, version: String)
final case class Manifest(source: ManifestSource, target: String, mode: String, transform: String)
final case class LoadRecord(manifest_hash: String, load: Map[String, Any])

object LoadStore {
  def open(): LoadStore = new LoadStore

  class LoadStore {
    def get(tenant: String, idemKey: String): Option[LoadRecord] = None
    def put(tenant: String, idemKey: String, record: LoadRecord): Unit = ()
  }
}

object Catalog {
  def rowsPlanned(dataset: String, version: String): Long = 0L
}

object LoadApi {
  implicit val system: ActorSystem = ActorSystem("warehouse-loader")
  implicit val sourceFormat: RootJsonFormat[ManifestSource] = jsonFormat2(ManifestSource)
  implicit val manifestFormat: RootJsonFormat[Manifest] = jsonFormat4(Manifest)

  val MaxManifestBytes = 1 << 16
  val SchemaPrefix = "wh_"
  val LoadModes = Set("append", "merge", "replace")
  val RegisteredTransforms = Map(
    "identity" -> "SELECT * FROM source",
    "dedupe" -> "SELECT DISTINCT ON (id) * FROM source",
    "cast_types" -> "SELECT id, paid_at::timestamptz AS paid_at FROM source",
    "mask_pii" -> "SELECT id, mask(email) AS email FROM source"
  )

  val store = LoadStore.open()

  def schemaFor(tenant: String): String = SchemaPrefix + tenant

  def manifestHash(body: Manifest): String =
    MessageDigest
      .getInstance("SHA-256")
      .digest(s"\${body.source.dataset}|\${body.source.version}|\${body.target}|\${body.mode}|\${body.transform}".getBytes(StandardCharsets.UTF_8))
      .map("%02x".format(_))
      .mkString

  def targetSchema(target: String): Either[String, String] = {
    val parts = target.split("\\\\.", -1)
    if (parts.length != 2 || parts(0).isEmpty || parts(1).isEmpty) Left("target must be schema.table") else Right(parts(0))
  }

  val route: Route =
    path("v1" / "loads") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[Manifest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.toString.getBytes(StandardCharsets.UTF_8).length > MaxManifestBytes) {
                complete(StatusCodes.RequestEntityTooLarge, """{"error":"manifest exceeds 64 KiB"}""")
              } else if (!LoadModes.contains(body.mode)) {
                complete(StatusCodes.BadRequest, """{"error":"mode must be append, merge or replace"}""")
              } else if (!RegisteredTransforms.contains(body.transform)) {
                complete(StatusCodes.BadRequest, """{"error":"unknown transform"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                targetSchema(body.target) match {
                  case Left(reason) =>
                    complete(StatusCodes.BadRequest, s"""{"error":"$reason"}""")
                  case Right(schema) if schema != schemaFor(tenant) =>
                    complete(StatusCodes.Forbidden, """{"error":"target is outside the tenant schema"}""")
                  case Right(_) =>
                    val digest = manifestHash(body)
                    store.get(tenant, idemKey) match {
                      case Some(stored) if stored.manifest_hash != digest =>
                        complete(StatusCodes.Conflict, """{"error":"Idempotency-Key reused for another manifest"}""")
                      case Some(stored) =>
                        complete(StatusCodes.OK, stored.load)
                      case None =>
                        val load = Map(
                          "load_id" -> java.util.UUID.randomUUID().toString,
                          "status" -> "queued",
                          "target" -> body.target,
                          "mode" -> body.mode,
                          "transform" -> body.transform,
                          "sql" -> RegisteredTransforms(body.transform),
                          "rows_planned" -> Catalog.rowsPlanned(body.source.dataset, body.source.version).toString
                        )
                        store.put(tenant, idemKey, LoadRecord(digest, load))
                        complete(StatusCodes.Accepted, load)
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
#include <optional>
#include <string>

using json = nlohmann::json;

struct LoadRecord {
  std::string manifest_hash;
  json load;
};

struct LoadStore {
  std::optional<LoadRecord> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const LoadRecord& record);
};

LoadStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/loads", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft takes the raw transform the caller sent, lets the target default to a shared
    // schema, ignores Idempotency-Key so a client retry starts a second load, and never validates
    // the manifest size or the load mode. Review all four.
    const json load = {
        {"load_id", uuidString()},
        {"status", "queued"},
        {"target", body.value("target", std::string("shared.loads"))},
        {"mode", body.value("mode", std::string("append"))},
        {"transform", body.value("transform", std::string("identity"))},
    };
    std::cerr << "load queued tenant=" << tenant << " target=" << load["target"] << "\\n";
    store.put(tenant, load["load_id"].get<std::string>(), LoadRecord{"", load});
    res.status = 202;
    res.set_content(load.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <map>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

constexpr std::size_t kMaxManifestBytes = 1 << 16;
const std::string kSchemaPrefix = "wh_";
const std::set<std::string> kLoadModes = {"append", "merge", "replace"};
const std::map<std::string, std::string> kRegisteredTransforms = {
    {"identity", "SELECT * FROM source"},
    {"dedupe", "SELECT DISTINCT ON (id) * FROM source"},
    {"cast_types", "SELECT id, paid_at::timestamptz AS paid_at FROM source"},
    {"mask_pii", "SELECT id, mask(email) AS email FROM source"},
};

struct LoadRecord {
  std::string manifest_hash;
  json load;
};

struct LoadStore {
  std::optional<LoadRecord> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const LoadRecord& record);
};

LoadStore store;
std::string uuidString();
std::string sha256Hex(const std::string& raw);

std::string schemaFor(const std::string& tenant) { return kSchemaPrefix + tenant; }

int main() {
  httplib::Server svr;

  svr.Post("/v1/loads", [](const httplib::Request& req, httplib::Response& res) {
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
    if (req.body.size() > kMaxManifestBytes) {
      res.status = 413;
      res.set_content(R"({"error":"manifest exceeds 64 KiB"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("source") || !body.contains("target")) {
      res.status = 400;
      res.set_content(R"({"error":"manifest must carry source and target"})", "application/json");
      return;
    }
    const auto mode = body.value("mode", std::string("append"));
    if (kLoadModes.count(mode) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"mode must be append, merge or replace"})", "application/json");
      return;
    }
    const auto transform = body.value("transform", std::string("identity"));
    const auto sql = kRegisteredTransforms.find(transform);
    if (sql == kRegisteredTransforms.end()) {
      res.status = 400;
      res.set_content(R"({"error":"unknown transform"})", "application/json");
      return;
    }
    const auto target = body["target"].get<std::string>();
    const auto dot = target.find('.');
    if (dot == std::string::npos || dot == 0 || dot + 1 == target.size()) {
      res.status = 400;
      res.set_content(R"({"error":"target must be schema.table"})", "application/json");
      return;
    }
    if (target.substr(0, dot) != schemaFor(tenant)) {
      res.status = 403;
      res.set_content(R"({"error":"target is outside the tenant schema"})", "application/json");
      return;
    }

    const auto digest = sha256Hex(body.dump());
    const auto stored = store.get(tenant, idemKey);
    if (stored) {
      if (stored->manifest_hash != digest) {
        res.status = 409;
        res.set_content(R"({"error":"Idempotency-Key reused for another manifest"})", "application/json");
        return;
      }
      res.status = 200;
      res.set_content(stored->load.dump(), "application/json");
      return;
    }

    const json load = {
        {"load_id", uuidString()},
        {"status", "queued"},
        {"target", target},
        {"mode", mode},
        {"transform", transform},
        {"sql", sql->second},
        {"rows_planned", 0},
    };
    store.put(tenant, idemKey, LoadRecord{digest, load});
    std::cerr << "load queued tenant=" << tenant << " target=" << target << " mode=" << mode << "\\n";
    res.status = 202;
    res.set_content(load.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a load endpoint at the trust boundary the
warehouse hands you. The draft reads fine because the demo loads one well-formed manifest from one
tenant and never retries. Four separate defects are being checked: the transform is a registry lookup,
not a string the caller controls (raw SQL here runs with the loader's credentials); the target schema
is derived from the authenticated tenant, so a cross-tenant write is a 403 and not a default; the
idempotency key is stored with the manifest fingerprint, so a replay answers the original load and a
key reused for a different manifest is a conflict instead of a silent mix-up; and the manifest is
bounded and its mode is one of three known values. Real loaders add per-tenant transform policies,
manifest signing, and a plan step that returns the compiled SQL for review before it ever runs.`,
};
