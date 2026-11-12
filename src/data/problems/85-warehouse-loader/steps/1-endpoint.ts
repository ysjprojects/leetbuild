import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/loads: a manifest that is the unit of work',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/loads\` with body
\`{"source": {"dataset", "version"}, "target", "mode", "transform"}\`: it takes the tenant from
\`X-Tenant-Id\` (401 without), compiles \`transform\` through \`TRANSFORMS\`, stores the load with
\`store.create_load\` and answers 202 with \`load_id\`, \`status\`, \`target\`, \`mode\`, \`partitions\`
and \`rows_planned\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A transform that is not a registered name runs as SQL with the
loader's warehouse credentials; a target in another tenant's schema writes into their table; a
client that retries its POST starts a second load of the same manifest; an oversized manifest or an
unknown mode is accepted.

- \`transform\` must be a key of \`TRANSFORMS\`; anything else is **400**.
- \`target\` is \`schema.table\` (**400** otherwise) in the schema \`wh_{tenant}\` (**403** otherwise).
- \`Idempotency-Key\` is required (**400**). \`store.find_key(tenant, key)\` before creating: the same
  manifest answers the recorded load with **200**, another manifest is **409**; a new load is
  recorded with \`store.remember_key\`. The fingerprint is \`{dataset}@{version}>{target}:{mode}:{transform}\`.
- A body over \`MAX_MANIFEST_BYTES\` (64 KiB) is **413**; \`mode\` is one of \`LOAD_MODES\` (\`append\`,
  \`merge\`, \`replace\`), **400** otherwise.`,
  sequence: {
    participants: ['Loader client', 'Load API', 'loads store'],
    messages: [
      {from: 'Loader client', to: 'Load API', label: 'POST /v1/loads · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Load API', to: 'Load API', label: 'size · mode · TRANSFORMS · schema wh_{tenant}', kind: 'sync'},
      {from: 'Load API', to: 'loads store', label: 'find_key(tenant, key)', kind: 'sync'},
      {from: 'loads store', to: 'Load API', label: 'recorded load + fingerprint / none', kind: 'reply'},
      {from: 'Load API', to: 'loads store', label: 'create_load · remember_key', kind: 'sync'},
      {from: 'Load API', to: 'Loader client', label: '202 new · 200 replay · 409 other manifest', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/loads and stores the load',
      detail: 'Register `POST /v1/loads`; a valid manifest answers 202 with the load the store created.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/loads["']/, /store\.create_load\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/loads['"]/, /createLoad\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/loads"/, /store\.CreateLoad\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"loads"\s*\)/, /Store\.createLoad\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/loads"/, /store::createLoad\(/]},
      },
    },
    {
      id: 'registered-transform',
      title: 'Runs only registered transforms',
      detail:
        '`transform` must name an entry of `TRANSFORMS` (**400** otherwise) and the SQL is the registry entry; the starter falls back to the caller’s string, which then runs as SQL with the loader’s credentials.',
      match: {
        python: {all: [/TRANSFORMS/], none: [/TRANSFORMS\.get\(\s*transform\s*,\s*transform\s*\)/]},
        typescript: {all: [/TRANSFORMS/], none: [/TRANSFORMS\[transform\]\s*\?\?\s*transform/]},
        go: {all: [/transforms\[/], none: [/sql\s*=\s*transform\b/]},
        scala: {all: [/Transforms/], none: [/Transforms\.getOrElse\(\s*transform\s*,\s*transform\s*\)/]},
        cpp: {all: [/kTransforms/], none: [/\?\s*registered->second\s*:\s*transform/]},
      },
    },
    {
      id: 'tenant-schema',
      title: 'Refuses a target outside the tenant’s schema',
      detail:
        'The target is `schema.table` (**400** otherwise) and its schema is `wh_{tenant}` for the authenticated tenant (**403** otherwise); the starter writes wherever the body points.',
      match: {
        python: {all: [/wh_/, /\b403\b/]},
        typescript: {all: [/wh_/, /\b403\b/]},
        go: {all: [/wh_/, /StatusForbidden|\b403\b/]},
        scala: {all: [/wh_/, /Forbidden|\b403\b/]},
        cpp: {all: [/wh_/, /\b403\b/]},
      },
    },
    {
      id: 'manifest-key',
      title: 'Keys the load by (tenant, Idempotency-Key) and the manifest',
      detail:
        '`Idempotency-Key` is required (**400**) and looked up (`find_key`/`findKey`) before a load is created: the same manifest answers the recorded load with 200, another manifest under the key is **409**, and a new load is remembered.',
      match: {
        python: {
          all: [/idempotency-key/i, /store\.find_key\(/, /store\.remember_key\(/, /\b409\b/],
          order: [/store\.find_key\(/, /store\.create_load\(/],
        },
        typescript: {
          all: [/idempotency-key/i, /findKey\(/, /rememberKey\(/, /\b409\b/],
          order: [/await findKey\(/, /await createLoad\(/],
        },
        go: {
          all: [/Idempotency-Key/i, /store\.FindKey\(/, /store\.RememberKey\(/, /StatusConflict|\b409\b/],
          order: [/store\.FindKey\(/, /store\.CreateLoad\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Store\.findKey\(/, /Store\.rememberKey\(/, /Conflict|\b409\b/],
          order: [/Store\.findKey\(/, /Store\.createLoad\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /store::findKey\(/, /store::rememberKey\(/, /\b409\b/],
          order: [/store::findKey\(/, /store::createLoad\(/],
        },
      },
    },
    {
      id: 'manifest-bounds',
      title: 'Bounds the manifest and validates the mode',
      detail:
        'A body over `MAX_MANIFEST_BYTES` (`1 << 16`) is **413** and a `mode` outside `LOAD_MODES` (`append`, `merge`, `replace`) is **400**; the starter accepts any size and defaults any mode through.',
      match: {
        python: {all: [/MAX_MANIFEST_BYTES\s*=\s*1\s*<<\s*16/, /\b413\b/, /LOAD_MODES/]},
        typescript: {
          all: [/MAX_MANIFEST_BYTES\s*=\s*1\s*<<\s*16/, /bodyLimit:\s*MAX_MANIFEST_BYTES|\b413\b/, /LOAD_MODES/],
        },
        go: {all: [/maxManifestBytes\s*=\s*1\s*<<\s*16/, /StatusRequestEntityTooLarge|\b413\b/, /loadModes/]},
        scala: {
          all: [
            /MaxManifestBytes(:\s*Int)?\s*=\s*1\s*<<\s*16/,
            /PayloadTooLarge|RequestEntityTooLarge|\b413\b/,
            /LoadModes/,
          ],
        },
        cpp: {all: [/kMaxManifestBytes\s*=\s*1\s*<<\s*16/, /\b413\b/, /kLoadModes/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from loader import store  # create_load, get_load, find_key, remember_key

app = FastAPI()

TRANSFORMS = {
    "identity": "SELECT * FROM source",
    "dedupe": "SELECT DISTINCT * FROM source",
    "cast_types": "SELECT CAST(id AS BIGINT) AS id, CAST(amount AS DECIMAL(18, 2)) AS amount, email FROM source",
    "mask_pii": "SELECT id, amount, SHA2(email, 256) AS email FROM source",
}
VIEW = ("load_id", "status", "target", "mode", "partitions", "rows_planned")


@app.post("/v1/loads")
async def create_load(request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    body = json.loads(await request.body())
    transform = body.get("transform", "identity")
    manifest = {
        "dataset": body["source"]["dataset"],
        "version": body["source"]["version"],
        "target": body["target"],
        "mode": body.get("mode", "append"),
        "transform": transform,
        "sql": TRANSFORMS.get(transform, transform),
    }
    load = store.create_load(tenant, manifest)
    return JSONResponse({name: load[name] for name in VIEW}, status_code=202)
`,
      solution: `import json

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from loader import store  # create_load, get_load, find_key, remember_key

app = FastAPI()

MAX_MANIFEST_BYTES = 1 << 16
LOAD_MODES = ("append", "merge", "replace")
TRANSFORMS = {
    "identity": "SELECT * FROM source",
    "dedupe": "SELECT DISTINCT * FROM source",
    "cast_types": "SELECT CAST(id AS BIGINT) AS id, CAST(amount AS DECIMAL(18, 2)) AS amount, email FROM source",
    "mask_pii": "SELECT id, amount, SHA2(email, 256) AS email FROM source",
}
VIEW = ("load_id", "status", "target", "mode", "partitions", "rows_planned")


@app.post("/v1/loads")
async def create_load(request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    raw = await request.body()
    if len(raw) > MAX_MANIFEST_BYTES:
        raise HTTPException(status_code=413, detail="the manifest is over 64 KiB")
    key = request.headers.get("idempotency-key", "")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    body = json.loads(raw)
    mode = body.get("mode", "")
    if mode not in LOAD_MODES:
        raise HTTPException(status_code=400, detail="mode must be append, merge or replace")
    transform = body.get("transform", "")
    if transform not in TRANSFORMS:
        raise HTTPException(status_code=400, detail="transform must name a registered transform")
    schema, _, table = body["target"].partition(".")
    if not schema or not table:
        raise HTTPException(status_code=400, detail="target must be schema.table")
    if schema != f"wh_{tenant}":
        raise HTTPException(status_code=403, detail=f"a load of tenant {tenant} writes into wh_{tenant} only")
    manifest = {
        "dataset": body["source"]["dataset"],
        "version": body["source"]["version"],
        "target": body["target"],
        "mode": mode,
        "transform": transform,
        "sql": TRANSFORMS[transform],
    }
    fingerprint = f"{manifest['dataset']}@{manifest['version']}>{manifest['target']}:{mode}:{transform}"
    recorded = store.find_key(tenant, key)
    if recorded is not None and recorded["fingerprint"] != fingerprint:
        raise HTTPException(status_code=409, detail="this Idempotency-Key started a load of another manifest")
    if recorded is None:
        load = store.create_load(tenant, manifest)
        store.remember_key(tenant, key, fingerprint, load["load_id"])
    else:
        load = store.get_load(tenant, recorded["load_id"])  # a retry answers the load it started
    return JSONResponse({name: load[name] for name in VIEW}, status_code=202 if recorded is None else 200)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {createLoad, findKey, getLoad, rememberKey} from 'loader/store';

export const app = Fastify();

export const TRANSFORMS: Record<string, string> = {
  identity: 'SELECT * FROM source',
  dedupe: 'SELECT DISTINCT * FROM source',
  cast_types: 'SELECT CAST(id AS BIGINT) AS id, CAST(amount AS DECIMAL(18, 2)) AS amount, email FROM source',
  mask_pii: 'SELECT id, amount, SHA2(email, 256) AS email FROM source',
};

interface LoadBody {
  source: {dataset: string; version: string};
  target: string;
  mode?: string;
  transform?: string;
}

app.post('/v1/loads', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = request.body as LoadBody;
  const transform = body.transform ?? 'identity';
  const load = await createLoad(tenant, {
    dataset: body.source.dataset,
    version: body.source.version,
    target: body.target,
    mode: body.mode ?? 'append',
    transform,
    sql: TRANSFORMS[transform] ?? transform,
  });
  const {load_id, status, target, mode, partitions, rows_planned} = load;
  return reply.code(202).send({load_id, status, target, mode, partitions, rows_planned});
});
`,
      solution: `import Fastify from 'fastify';

import {createLoad, findKey, getLoad, rememberKey} from 'loader/store';

export const MAX_MANIFEST_BYTES = 1 << 16;
export const LOAD_MODES = ['append', 'merge', 'replace'];
export const TRANSFORMS: Record<string, string> = {
  identity: 'SELECT * FROM source',
  dedupe: 'SELECT DISTINCT * FROM source',
  cast_types: 'SELECT CAST(id AS BIGINT) AS id, CAST(amount AS DECIMAL(18, 2)) AS amount, email FROM source',
  mask_pii: 'SELECT id, amount, SHA2(email, 256) AS email FROM source',
};

export const app = Fastify();

// A manifest over the limit is answered 413 before the handler runs.
app.addContentTypeParser('application/json', {parseAs: 'string', bodyLimit: MAX_MANIFEST_BYTES}, (request, body, done) => {
  try {
    done(null, JSON.parse(body as string));
  } catch (err) {
    done(err as Error, undefined);
  }
});

interface LoadBody {
  source: {dataset: string; version: string};
  target: string;
  mode?: string;
  transform?: string;
}

app.post('/v1/loads', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = request.body as LoadBody;
  const mode = body.mode ?? '';
  if (!LOAD_MODES.includes(mode)) return reply.code(400).send({error: 'mode must be append, merge or replace'});
  const transform = body.transform ?? '';
  if (!Object.hasOwn(TRANSFORMS, transform)) return reply.code(400).send({error: 'transform must name a registered transform'});
  const sql = TRANSFORMS[transform];
  const [schema, table] = body.target.split('.', 2);
  if (!schema || !table) return reply.code(400).send({error: 'target must be schema.table'});
  if (schema !== \`wh_\${tenant}\`) return reply.code(403).send({error: \`a load of tenant \${tenant} writes into wh_\${tenant} only\`});
  const {dataset, version} = body.source;
  const fingerprint = \`\${dataset}@\${version}>\${body.target}:\${mode}:\${transform}\`;
  const recorded = await findKey(tenant, key);
  if (recorded !== null && recorded.fingerprint !== fingerprint) {
    return reply.code(409).send({error: 'this Idempotency-Key started a load of another manifest'});
  }
  let load;
  if (recorded === null) {
    load = await createLoad(tenant, {dataset, version, target: body.target, mode, transform, sql});
    await rememberKey(tenant, key, fingerprint, load.load_id);
  } else {
    load = await getLoad(tenant, recorded.load_id); // a retry answers the load it started
    if (load === null) return reply.code(404).send({error: 'the recorded load is gone'});
  }
  const {load_id, status, target, partitions, rows_planned} = load;
  return reply.code(recorded === null ? 202 : 200).send({load_id, status, target, mode: load.mode, partitions, rows_planned});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"io"
	"net/http"

	"loader/store" // store.CreateLoad, GetLoad, FindKey, RememberKey
)

var transforms = map[string]string{
	"identity":   "SELECT * FROM source",
	"dedupe":     "SELECT DISTINCT * FROM source",
	"cast_types": "SELECT CAST(id AS BIGINT) AS id, CAST(amount AS DECIMAL(18, 2)) AS amount, email FROM source",
	"mask_pii":   "SELECT id, amount, SHA2(email, 256) AS email FROM source",
}

type loadBody struct {
	Source struct {
		Dataset string \`json:"dataset"\`
		Version string \`json:"version"\`
	} \`json:"source"\`
	Target    string \`json:"target"\`
	Mode      string \`json:"mode"\`
	Transform string \`json:"transform"\`
}

type loadView struct {
	LoadID      string \`json:"load_id"\`
	Status      string \`json:"status"\`
	Target      string \`json:"target"\`
	Mode        string \`json:"mode"\`
	Partitions  int    \`json:"partitions"\`
	RowsPlanned int64  \`json:"rows_planned"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createLoad(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	raw, _ := io.ReadAll(r.Body)
	var body loadBody
	if err := json.Unmarshal(raw, &body); err != nil {
		http.Error(rw, "the manifest is not JSON", http.StatusBadRequest)
		return
	}
	mode := body.Mode
	if mode == "" {
		mode = "append"
	}
	transform := body.Transform
	if transform == "" {
		transform = "identity"
	}
	sql, ok := transforms[transform]
	if !ok {
		sql = transform
	}
	load := store.CreateLoad(r.Context(), tenant, store.Manifest{Dataset: body.Source.Dataset, Version: body.Source.Version, Target: body.Target, Mode: mode, Transform: transform, SQL: sql})
	writeJSON(rw, http.StatusAccepted, loadView{LoadID: load.LoadID, Status: load.Status, Target: load.Target, Mode: load.Mode, Partitions: load.Partitions, RowsPlanned: load.RowsPlanned})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/loads", createLoad)
}
`,
      solution: `package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"loader/store" // store.CreateLoad, GetLoad, FindKey, RememberKey
)

const maxManifestBytes = 1 << 16

var loadModes = map[string]bool{"append": true, "merge": true, "replace": true}

var transforms = map[string]string{
	"identity":   "SELECT * FROM source",
	"dedupe":     "SELECT DISTINCT * FROM source",
	"cast_types": "SELECT CAST(id AS BIGINT) AS id, CAST(amount AS DECIMAL(18, 2)) AS amount, email FROM source",
	"mask_pii":   "SELECT id, amount, SHA2(email, 256) AS email FROM source",
}

type loadBody struct {
	Source struct {
		Dataset string \`json:"dataset"\`
		Version string \`json:"version"\`
	} \`json:"source"\`
	Target    string \`json:"target"\`
	Mode      string \`json:"mode"\`
	Transform string \`json:"transform"\`
}

type loadView struct {
	LoadID      string \`json:"load_id"\`
	Status      string \`json:"status"\`
	Target      string \`json:"target"\`
	Mode        string \`json:"mode"\`
	Partitions  int    \`json:"partitions"\`
	RowsPlanned int64  \`json:"rows_planned"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createLoad(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	raw, _ := io.ReadAll(io.LimitReader(r.Body, maxManifestBytes+1))
	if len(raw) > maxManifestBytes {
		http.Error(rw, "the manifest is over 64 KiB", http.StatusRequestEntityTooLarge)
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		http.Error(rw, "Idempotency-Key is required", http.StatusBadRequest)
		return
	}
	var body loadBody
	if err := json.Unmarshal(raw, &body); err != nil {
		http.Error(rw, "the manifest is not JSON", http.StatusBadRequest)
		return
	}
	if !loadModes[body.Mode] {
		http.Error(rw, "mode must be append, merge or replace", http.StatusBadRequest)
		return
	}
	sql, ok := transforms[body.Transform]
	if !ok {
		http.Error(rw, "transform must name a registered transform", http.StatusBadRequest)
		return
	}
	schema, table, _ := strings.Cut(body.Target, ".")
	if schema == "" || table == "" {
		http.Error(rw, "target must be schema.table", http.StatusBadRequest)
		return
	}
	if schema != "wh_"+tenant {
		http.Error(rw, "a load of tenant "+tenant+" writes into wh_"+tenant+" only", http.StatusForbidden)
		return
	}
	manifest := store.Manifest{Dataset: body.Source.Dataset, Version: body.Source.Version, Target: body.Target, Mode: body.Mode, Transform: body.Transform, SQL: sql}
	fingerprint := manifest.Dataset + "@" + manifest.Version + ">" + manifest.Target + ":" + manifest.Mode + ":" + manifest.Transform
	recorded := store.FindKey(r.Context(), tenant, key)
	if recorded != nil && recorded.Fingerprint != fingerprint {
		http.Error(rw, "this Idempotency-Key started a load of another manifest", http.StatusConflict)
		return
	}
	status := http.StatusOK
	var load *store.Load
	if recorded == nil {
		status = http.StatusAccepted
		load = store.CreateLoad(r.Context(), tenant, manifest)
		store.RememberKey(r.Context(), tenant, key, fingerprint, load.LoadID)
	} else {
		load = store.GetLoad(r.Context(), tenant, recorded.LoadID) // a retry answers the load it started
	}
	writeJSON(rw, status, loadView{LoadID: load.LoadID, Status: load.Status, Target: load.Target, Mode: load.Mode, Partitions: load.Partitions, RowsPlanned: load.RowsPlanned})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/loads", createLoad)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import loader.Store // Store.createLoad, getLoad, findKey, rememberKey

object LoadApi {
  val Transforms: Map[String, String] = Map(
    "identity" -> "SELECT * FROM source",
    "dedupe" -> "SELECT DISTINCT * FROM source",
    "cast_types" -> "SELECT CAST(id AS BIGINT) AS id, CAST(amount AS DECIMAL(18, 2)) AS amount, email FROM source",
    "mask_pii" -> "SELECT id, amount, SHA2(email, 256) AS email FROM source"
  )

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def view(load: Store.Load): JsObject = JsObject(
    "load_id" -> JsString(load.loadId), "status" -> JsString(load.status), "target" -> JsString(load.target),
    "mode" -> JsString(load.mode), "partitions" -> JsNumber(load.partitions), "rows_planned" -> JsNumber(load.rowsPlanned))

  private def text(fields: Map[String, JsValue], name: String, default: String): String =
    fields.get(name).collect { case JsString(s) => s }.getOrElse(default)

  val route: Route = path("v1" / "loads") {
    post {
      // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject.fields
            val source = body("source").asJsObject.fields
            val transform = text(body, "transform", "identity")
            val manifest = Store.Manifest(text(source, "dataset", ""), text(source, "version", ""), text(body, "target", ""),
              text(body, "mode", "append"), transform, Transforms.getOrElse(transform, transform))
            complete(json(StatusCodes.Accepted, view(Store.createLoad(tenant, manifest))))
          }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import loader.Store // Store.createLoad, getLoad, findKey, rememberKey

object LoadApi {
  val MaxManifestBytes: Int = 1 << 16
  val LoadModes: Set[String] = Set("append", "merge", "replace")
  val Transforms: Map[String, String] = Map(
    "identity" -> "SELECT * FROM source",
    "dedupe" -> "SELECT DISTINCT * FROM source",
    "cast_types" -> "SELECT CAST(id AS BIGINT) AS id, CAST(amount AS DECIMAL(18, 2)) AS amount, email FROM source",
    "mask_pii" -> "SELECT id, amount, SHA2(email, 256) AS email FROM source"
  )

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def view(load: Store.Load): JsObject = JsObject(
    "load_id" -> JsString(load.loadId), "status" -> JsString(load.status), "target" -> JsString(load.target),
    "mode" -> JsString(load.mode), "partitions" -> JsNumber(load.partitions), "rows_planned" -> JsNumber(load.rowsPlanned))

  private def text(fields: Map[String, JsValue], name: String, default: String): String =
    fields.get(name).collect { case JsString(s) => s }.getOrElse(default)

  /** The answer to one manifest under (tenant, key): a new load, the recorded one, or why not. */
  private def load(tenant: String, key: String, raw: String): HttpResponse = {
    val body = raw.parseJson.asJsObject.fields
    val source = body("source").asJsObject.fields
    val mode = text(body, "mode", "")
    val transform = text(body, "transform", "")
    val target = text(body, "target", "")
    val schema = target.takeWhile(_ != '.')
    val table = target.drop(schema.length + 1)
    if (!LoadModes.contains(mode)) HttpResponse(StatusCodes.BadRequest, entity = "mode must be append, merge or replace")
    else if (!Transforms.contains(transform)) HttpResponse(StatusCodes.BadRequest, entity = "transform must name a registered transform")
    else if (schema.isEmpty || table.isEmpty) HttpResponse(StatusCodes.BadRequest, entity = "target must be schema.table")
    else if (schema != s"wh_$tenant") HttpResponse(StatusCodes.Forbidden, entity = s"a load of tenant $tenant writes into wh_$tenant only")
    else {
      val manifest = Store.Manifest(text(source, "dataset", ""), text(source, "version", ""), target, mode, transform, Transforms(transform))
      val fingerprint = s"\${manifest.dataset}@\${manifest.version}>$target:$mode:$transform"
      Store.findKey(tenant, key) match {
        case Some(recorded) if recorded.fingerprint != fingerprint =>
          HttpResponse(StatusCodes.Conflict, entity = "this Idempotency-Key started a load of another manifest")
        case Some(recorded) => json(StatusCodes.OK, view(Store.getLoad(tenant, recorded.loadId).get)) // a retry answers the load it started
        case None =>
          val created = Store.createLoad(tenant, manifest)
          Store.rememberKey(tenant, key, fingerprint, created.loadId)
          json(StatusCodes.Accepted, view(created))
      }
    }
  }

  val route: Route = path("v1" / "loads") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          entity(as[String]) { raw =>
            if (raw.getBytes("UTF-8").length > MaxManifestBytes) complete(StatusCodes.PayloadTooLarge -> "the manifest is over 64 KiB")
            else
              optionalHeaderValueByName("Idempotency-Key") {
                case None | Some("") => complete(StatusCodes.BadRequest -> "Idempotency-Key is required")
                case Some(key) => complete(load(tenant, key, raw))
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

#include <map>
#include <string>

#include "loader/store.h"  // store::createLoad, getLoad, findKey, rememberKey

using json = nlohmann::json;

const std::map<std::string, std::string> kTransforms = {
    {"identity", "SELECT * FROM source"},
    {"dedupe", "SELECT DISTINCT * FROM source"},
    {"cast_types", "SELECT CAST(id AS BIGINT) AS id, CAST(amount AS DECIMAL(18, 2)) AS amount, email FROM source"},
    {"mask_pii", "SELECT id, amount, SHA2(email, 256) AS email FROM source"},
};

json loadView(const store::Load& load) {
  return json{{"load_id", load.load_id}, {"status", load.status},         {"target", load.target},
              {"mode", load.mode},       {"partitions", load.partitions}, {"rows_planned", load.rows_planned}};
}

void create_load(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const json body = json::parse(req.body, nullptr, false);
  if (body.is_discarded() || !body.contains("source")) {
    res.status = 400;
    res.set_content("the manifest is not JSON", "text/plain");
    return;
  }
  const std::string transform = body.value("transform", "identity");
  const auto registered = kTransforms.find(transform);
  const store::Manifest manifest{body["source"].value("dataset", ""), body["source"].value("version", ""), body.value("target", ""),
                                 body.value("mode", "append"), transform, registered != kTransforms.end() ? registered->second : transform};
  res.status = 202;
  res.set_content(loadView(store::createLoad(tenant, manifest)).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/loads", create_load); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <set>
#include <string>

#include "loader/store.h"  // store::createLoad, getLoad, findKey, rememberKey

using json = nlohmann::json;

constexpr size_t kMaxManifestBytes = 1 << 16;
const std::set<std::string> kLoadModes = {"append", "merge", "replace"};
const std::map<std::string, std::string> kTransforms = {
    {"identity", "SELECT * FROM source"},
    {"dedupe", "SELECT DISTINCT * FROM source"},
    {"cast_types", "SELECT CAST(id AS BIGINT) AS id, CAST(amount AS DECIMAL(18, 2)) AS amount, email FROM source"},
    {"mask_pii", "SELECT id, amount, SHA2(email, 256) AS email FROM source"},
};

json loadView(const store::Load& load) {
  return json{{"load_id", load.load_id}, {"status", load.status},         {"target", load.target},
              {"mode", load.mode},       {"partitions", load.partitions}, {"rows_planned", load.rows_planned}};
}

void refuse(httplib::Response& res, int status, const std::string& why) {
  res.status = status;
  res.set_content(why, "text/plain");
}

void create_load(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return refuse(res, 401, "X-Tenant-Id is required");
  if (req.body.size() > kMaxManifestBytes) return refuse(res, 413, "the manifest is over 64 KiB");
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return refuse(res, 400, "Idempotency-Key is required");
  const json body = json::parse(req.body, nullptr, false);
  if (body.is_discarded() || !body.contains("source")) return refuse(res, 400, "the manifest is not JSON");
  const std::string mode = body.value("mode", "");
  if (!kLoadModes.count(mode)) return refuse(res, 400, "mode must be append, merge or replace");
  const std::string transform = body.value("transform", "");
  const auto registered = kTransforms.find(transform);
  if (registered == kTransforms.end()) return refuse(res, 400, "transform must name a registered transform");
  const std::string target = body.value("target", "");
  const size_t dot = target.find('.');
  if (dot == std::string::npos || dot == 0 || dot + 1 == target.size()) return refuse(res, 400, "target must be schema.table");
  if (target.substr(0, dot) != "wh_" + tenant) return refuse(res, 403, "a load of tenant " + tenant + " writes into wh_" + tenant + " only");
  const store::Manifest manifest{body["source"].value("dataset", ""), body["source"].value("version", ""), target, mode, transform, registered->second};
  const std::string fingerprint = manifest.dataset + "@" + manifest.version + ">" + target + ":" + mode + ":" + transform;
  const auto recorded = store::findKey(tenant, key);
  if (recorded && recorded->fingerprint != fingerprint) return refuse(res, 409, "this Idempotency-Key started a load of another manifest");
  if (recorded) {
    res.status = 200;  // a retry answers the load it started
    res.set_content(loadView(*store::getLoad(tenant, recorded->load_id)).dump(), "application/json");
    return;
  }
  const store::Load load = store::createLoad(tenant, manifest);
  store::rememberKey(tenant, key, fingerprint, load.load_id);
  res.status = 202;
  res.set_content(loadView(load).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/loads", create_load); }
`,
    },
  },
  harness: {
    python: `from loader import store

MANIFEST = {"source": {"dataset": "orders", "version": "2026-10-20"}, "target": "wh_acme.orders", "mode": "merge", "transform": "dedupe"}


def _api(ctx):
    ctx.redis.hset("source:orders:2026-10-20", mapping={"p-0": 250, "p-1": 250, "p-2": 250, "p-3": 250})
    ctx.redis.hset("source:orders:2026-10-21", mapping={"p-0": 300, "p-1": 300})
    m = ctx.load("api")
    return m, ctx.client(m.app)


async def _post(c, body=None, tenant="acme", key="k-1"):
    headers = {name: value for name, value in (("X-Tenant-Id", tenant), ("Idempotency-Key", key)) if value}
    return await c.post("/v1/loads", json=MANIFEST if body is None else body, headers=headers)


def _loads(ctx):
    return sorted(k for k in ctx.redis.keys("load:ld-*") if k.count(":") == 1)


async def check_route(ctx):
    _, client = _api(ctx)
    async with client as c:
        r = await _post(c)
        anonymous = await _post(c, tenant=None, key="k-2")
    assert r.status_code == 202, f"POST /v1/loads answered {r.status_code}: {r.text}"
    body = r.json()
    for name, value in (("status", "queued"), ("target", "wh_acme.orders"), ("mode", "merge"), ("partitions", 4), ("rows_planned", 1000)):
        assert body.get(name) == value, f"the new load must answer {name}={value!r}, got {body}"
    assert store.get_load("acme", body.get("load_id", "")) is not None, f"the load {body.get('load_id')!r} the API answered is not in the loads store"
    assert anonymous.status_code == 401, f"a POST without X-Tenant-Id answered {anonymous.status_code}, expected 401"


async def check_registered_transform(ctx):
    m, client = _api(ctx)
    async with client as c:
        sql = await _post(c, {**MANIFEST, "transform": "SELECT * FROM wh_globex.orders"}, key="k-sql")
        assert sql.status_code == 400, f"a transform that is SQL, not a registered name, answered {sql.status_code}: {sql.text}. It would run with the loader's warehouse credentials"
        assert _loads(ctx) == [], f"the load with caller SQL was stored: {[ctx.redis.hgetall(k) for k in _loads(ctx)]}"
        unknown = await _post(c, {**MANIFEST, "transform": "pivot"}, key="k-pivot")
        assert unknown.status_code == 400, f"an unregistered transform name answered {unknown.status_code}, expected 400"
        r = await _post(c, key="k-ok")
    assert r.status_code == 202, f"a load with the registered transform dedupe answered {r.status_code}: {r.text}"
    load = store.get_load("acme", r.json()["load_id"])
    assert load["sql"] == m.TRANSFORMS["dedupe"], f"the load must carry the registry's SQL for dedupe, it carries {load['sql']!r}"


async def check_tenant_schema(ctx):
    _, client = _api(ctx)
    async with client as c:
        for target in ("wh_globex.orders", "shared.loads"):
            r = await _post(c, {**MANIFEST, "target": target}, key=f"k-{target}")
            assert r.status_code == 403, f"tenant acme loading into {target} answered {r.status_code}: {r.text}. A load writes into wh_acme only"
        r = await _post(c, {**MANIFEST, "target": "orders"}, key="k-bare")
        assert r.status_code == 400, f"a target that is not schema.table answered {r.status_code}, expected 400"
        assert _loads(ctx) == [], f"a refused target was stored as a load: {[ctx.redis.hgetall(k) for k in _loads(ctx)]}"
        r = await _post(c, key="k-own")
    assert r.status_code == 202, f"tenant acme loading into wh_acme.orders answered {r.status_code}: {r.text}"


async def check_manifest_key(ctx):
    _, client = _api(ctx)
    other = {**MANIFEST, "source": {"dataset": "orders", "version": "2026-10-21"}}
    async with client as c:
        none = await _post(c, key=None)
        assert none.status_code == 400, f"a POST without Idempotency-Key answered {none.status_code}, expected 400"
        first = await _post(c, key="k-1")
        assert first.status_code == 202, f"the first POST answered {first.status_code}: {first.text}"
        replay = await _post(c, key="k-1")
        assert replay.status_code == 200, f"a retry of the same manifest under the same key answered {replay.status_code}, expected 200 with the recorded load"
        assert replay.json().get("load_id") == first.json()["load_id"], f"the retry started load {replay.json().get('load_id')}, the first POST started {first.json()['load_id']}: one manifest, one load"
        changed = await _post(c, other, key="k-1")
        assert changed.status_code == 409, f"another manifest under a used key answered {changed.status_code}, expected 409"
        fresh = await _post(c, other, key="k-2")
        assert fresh.status_code == 202 and fresh.json().get("load_id") != first.json()["load_id"], f"a new key must start a new load, got {fresh.status_code} {fresh.text}"
        theirs = await _post(c, {**MANIFEST, "target": "wh_globex.orders"}, tenant="globex", key="k-1")
    assert theirs.status_code == 202, f"another tenant's k-1 is its own key: globex's first POST answered {theirs.status_code}: {theirs.text}"
    assert len(_loads(ctx)) == 3, f"three distinct loads were started, the store holds {len(_loads(ctx))}"


async def check_manifest_bounds(ctx):
    _, client = _api(ctx)
    async with client as c:
        r = await _post(c, {**MANIFEST, "mode": "upsert"}, key="k-mode")
        assert r.status_code == 400, f"mode upsert answered {r.status_code}, expected 400: the modes are append, merge and replace"
        r = await _post(c, {**MANIFEST, "notes": "x" * 70000}, key="k-big")
        assert r.status_code == 413, f"a 70 KB manifest answered {r.status_code}, expected 413 over MAX_MANIFEST_BYTES (64 KiB)"
        assert _loads(ctx) == [], f"a refused manifest was stored as a load: {[ctx.redis.hgetall(k) for k in _loads(ctx)]}"
        r = await _post(c, {**MANIFEST, "mode": "replace"}, key="k-replace")
    assert r.status_code == 202, f"mode replace answered {r.status_code}: {r.text}"
`,
    typescript: `const MANIFEST = {source: {dataset: 'orders', version: '2026-10-20'}, target: 'wh_acme.orders', mode: 'merge', transform: 'dedupe'};

function api(ctx) {
  ctx.redis.hset('source:orders:2026-10-20', {'p-0': '250', 'p-1': '250', 'p-2': '250', 'p-3': '250'});
  ctx.redis.hset('source:orders:2026-10-21', {'p-0': '300', 'p-1': '300'});
  const m = ctx.load('api');
  return {m, c: ctx.client(m.app), store: ctx.load('/support/loader/store.ts')};
}

function post(c, body: object = MANIFEST, tenant: string | null = 'acme', key: string | null = 'k-1') {
  const headers: Record<string, string> = {};
  if (tenant !== null) headers['X-Tenant-Id'] = tenant;
  if (key !== null) headers['Idempotency-Key'] = key;
  return c.post('/v1/loads', {json: body, headers});
}

const loads = ctx => ctx.redis.keys('load:ld-*').filter(k => k.split(':').length === 2);

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const r = await post(c);
  assert.equal(r.status, 202, \`POST /v1/loads answered \${r.status}: \${r.text}\`);
  const body = r.json();
  for (const [name, value] of Object.entries({status: 'queued', target: 'wh_acme.orders', mode: 'merge', partitions: 4, rows_planned: 1000})) {
    assert.equal(body[name], value, \`the new load must answer \${name}=\${JSON.stringify(value)}, got \${r.text}\`);
  }
  assert((await store.getLoad('acme', body.load_id)) !== null, \`the load \${body.load_id} the API answered is not in the loads store\`);
  const anonymous = await post(c, MANIFEST, null, 'k-2');
  assert.equal(anonymous.status, 401, \`a POST without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
}

export async function check_registered_transform(ctx) {
  const {m, c, store} = api(ctx);
  const sql = await post(c, {...MANIFEST, transform: 'SELECT * FROM wh_globex.orders'}, 'acme', 'k-sql');
  assert.equal(sql.status, 400, \`a transform that is SQL, not a registered name, answered \${sql.status}: \${sql.text}. It would run with the loader's warehouse credentials\`);
  assert.deepEqual(loads(ctx), [], 'the load with caller SQL was stored');
  const unknown = await post(c, {...MANIFEST, transform: 'pivot'}, 'acme', 'k-pivot');
  assert.equal(unknown.status, 400, \`an unregistered transform name answered \${unknown.status}, expected 400\`);
  const r = await post(c, MANIFEST, 'acme', 'k-ok');
  assert.equal(r.status, 202, \`a load with the registered transform dedupe answered \${r.status}: \${r.text}\`);
  const load = await store.getLoad('acme', r.json().load_id);
  assert.equal(load.sql, m.TRANSFORMS.dedupe, \`the load must carry the registry's SQL for dedupe, it carries \${JSON.stringify(load.sql)}\`);
}

export async function check_tenant_schema(ctx) {
  const {c} = api(ctx);
  for (const target of ['wh_globex.orders', 'shared.loads']) {
    const r = await post(c, {...MANIFEST, target}, 'acme', \`k-\${target}\`);
    assert.equal(r.status, 403, \`tenant acme loading into \${target} answered \${r.status}: \${r.text}. A load writes into wh_acme only\`);
  }
  const bare = await post(c, {...MANIFEST, target: 'orders'}, 'acme', 'k-bare');
  assert.equal(bare.status, 400, \`a target that is not schema.table answered \${bare.status}, expected 400\`);
  assert.deepEqual(loads(ctx), [], 'a refused target was stored as a load');
  const own = await post(c, MANIFEST, 'acme', 'k-own');
  assert.equal(own.status, 202, \`tenant acme loading into wh_acme.orders answered \${own.status}: \${own.text}\`);
}

export async function check_manifest_key(ctx) {
  const {c} = api(ctx);
  const other = {...MANIFEST, source: {dataset: 'orders', version: '2026-10-21'}};
  const none = await post(c, MANIFEST, 'acme', null);
  assert.equal(none.status, 400, \`a POST without Idempotency-Key answered \${none.status}, expected 400\`);
  const first = await post(c, MANIFEST, 'acme', 'k-1');
  assert.equal(first.status, 202, \`the first POST answered \${first.status}: \${first.text}\`);
  const replay = await post(c, MANIFEST, 'acme', 'k-1');
  assert.equal(replay.status, 200, \`a retry of the same manifest under the same key answered \${replay.status}, expected 200 with the recorded load\`);
  assert.equal(replay.json().load_id, first.json().load_id, \`the retry started load \${replay.json().load_id}, the first POST started \${first.json().load_id}: one manifest, one load\`);
  const changed = await post(c, other, 'acme', 'k-1');
  assert.equal(changed.status, 409, \`another manifest under a used key answered \${changed.status}, expected 409\`);
  const fresh = await post(c, other, 'acme', 'k-2');
  assert(fresh.status === 202 && fresh.json().load_id !== first.json().load_id, \`a new key must start a new load, got \${fresh.status} \${fresh.text}\`);
  const theirs = await post(c, {...MANIFEST, target: 'wh_globex.orders'}, 'globex', 'k-1');
  assert.equal(theirs.status, 202, \`another tenant's k-1 is its own key: globex's first POST answered \${theirs.status}: \${theirs.text}\`);
  assert.equal(loads(ctx).length, 3, \`three distinct loads were started, the store holds \${loads(ctx).length}\`);
}

export async function check_manifest_bounds(ctx) {
  const {c} = api(ctx);
  const mode = await post(c, {...MANIFEST, mode: 'upsert'}, 'acme', 'k-mode');
  assert.equal(mode.status, 400, \`mode upsert answered \${mode.status}, expected 400: the modes are append, merge and replace\`);
  const big = await post(c, {...MANIFEST, notes: 'x'.repeat(70000)}, 'acme', 'k-big');
  assert.equal(big.status, 413, \`a 70 KB manifest answered \${big.status}, expected 413 over MAX_MANIFEST_BYTES (64 KiB)\`);
  assert.deepEqual(loads(ctx), [], 'a refused manifest was stored as a load');
  const replace = await post(c, {...MANIFEST, mode: 'replace'}, 'acme', 'k-replace');
  assert.equal(replace.status, 202, \`mode replace answered \${replace.status}: \${replace.text}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"loader/store"

	"leetbuild/harness"
)

func apiManifest(version, target, mode, transform string) map[string]any {
	return map[string]any{"source": map[string]string{"dataset": "orders", "version": version}, "target": target, "mode": mode, "transform": transform}
}

var apiDefault = apiManifest("2026-10-20", "wh_acme.orders", "merge", "dedupe")

func api(ctx *harness.Ctx) *harness.HTTP {
	ctx.Redis.Do("HSET", "source:orders:2026-10-20", "p-0", "250", "p-1", "250", "p-2", "250", "p-3", "250")
	ctx.Redis.Do("HSET", "source:orders:2026-10-21", "p-0", "300", "p-1", "300")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiPost(c *harness.HTTP, body any, tenant, key string) *harness.Response {
	var header []string
	if tenant != "" {
		header = append(header, "X-Tenant-Id", tenant)
	}
	if key != "" {
		header = append(header, "Idempotency-Key", key)
	}
	return c.Post("/v1/loads", body, header...)
}

func apiBody(r *harness.Response) map[string]any {
	var body map[string]any
	r.Decode(&body)
	return body
}

func apiLoads(ctx *harness.Ctx) []string {
	var out []string
	for _, k := range ctx.Redis.Keys("load:ld-*") {
		if strings.Count(k, ":") == 1 {
			out = append(out, k)
		}
	}
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := apiPost(c, apiDefault, "acme", "k-1")
	ctx.Equal(r.Status, 202, "POST /v1/loads (%s)", r.Text())
	body := apiBody(r)
	want := map[string]any{"status": "queued", "target": "wh_acme.orders", "mode": "merge", "partitions": 4, "rows_planned": 1000}
	for name, value := range want {
		ctx.Equal(body[name], value, "the new load's %s (%s)", name, r.Text())
	}
	loadID, _ := body["load_id"].(string)
	ctx.Assert(store.GetLoad(context.Background(), "acme", loadID) != nil, "the load %q the API answered is not in the loads store", loadID)
	anonymous := apiPost(c, apiDefault, "", "k-2")
	ctx.Equal(anonymous.Status, 401, "a POST without X-Tenant-Id")
}

func CheckRegisteredTransform(ctx *harness.Ctx) {
	c := api(ctx)
	sql := apiPost(c, apiManifest("2026-10-20", "wh_acme.orders", "merge", "SELECT * FROM wh_globex.orders"), "acme", "k-sql")
	ctx.Equal(sql.Status, 400, "a transform that is SQL, not a registered name, would run with the loader's warehouse credentials (%s)", sql.Text())
	ctx.Equal(len(apiLoads(ctx)), 0, "the load with caller SQL must not be stored; loads")
	unknown := apiPost(c, apiManifest("2026-10-20", "wh_acme.orders", "merge", "pivot"), "acme", "k-pivot")
	ctx.Equal(unknown.Status, 400, "an unregistered transform name")
	r := apiPost(c, apiDefault, "acme", "k-ok")
	ctx.Equal(r.Status, 202, "a load with the registered transform dedupe (%s)", r.Text())
	loadID, _ := apiBody(r)["load_id"].(string)
	load := store.GetLoad(context.Background(), "acme", loadID)
	ctx.Assert(load != nil, "the load %q is not in the store", loadID)
	ctx.Equal(load.SQL, transforms["dedupe"], "the load must carry the registry's SQL for dedupe; its sql")
}

func CheckTenantSchema(ctx *harness.Ctx) {
	c := api(ctx)
	for _, target := range []string{"wh_globex.orders", "shared.loads"} {
		r := apiPost(c, apiManifest("2026-10-20", target, "merge", "dedupe"), "acme", "k-"+target)
		ctx.Equal(r.Status, 403, "tenant acme loading into %s must be refused: a load writes into wh_acme only (%s)", target, r.Text())
	}
	bare := apiPost(c, apiManifest("2026-10-20", "orders", "merge", "dedupe"), "acme", "k-bare")
	ctx.Equal(bare.Status, 400, "a target that is not schema.table")
	ctx.Equal(len(apiLoads(ctx)), 0, "a refused target must not be stored as a load; loads")
	own := apiPost(c, apiDefault, "acme", "k-own")
	ctx.Equal(own.Status, 202, "tenant acme loading into wh_acme.orders (%s)", own.Text())
}

func CheckManifestKey(ctx *harness.Ctx) {
	c := api(ctx)
	other := apiManifest("2026-10-21", "wh_acme.orders", "merge", "dedupe")
	none := apiPost(c, apiDefault, "acme", "")
	ctx.Equal(none.Status, 400, "a POST without Idempotency-Key")
	first := apiPost(c, apiDefault, "acme", "k-1")
	ctx.Equal(first.Status, 202, "the first POST (%s)", first.Text())
	replay := apiPost(c, apiDefault, "acme", "k-1")
	ctx.Equal(replay.Status, 200, "a retry of the same manifest under the same key must answer the recorded load")
	ctx.Equal(apiBody(replay)["load_id"], apiBody(first)["load_id"], "one manifest, one load: the retry's load_id")
	changed := apiPost(c, other, "acme", "k-1")
	ctx.Equal(changed.Status, 409, "another manifest under a used key")
	fresh := apiPost(c, other, "acme", "k-2")
	ctx.Assert(fresh.Status == 202 && apiBody(fresh)["load_id"] != apiBody(first)["load_id"], "a new key must start a new load, got %d %s", fresh.Status, fresh.Text())
	theirs := apiPost(c, apiManifest("2026-10-20", "wh_globex.orders", "merge", "dedupe"), "globex", "k-1")
	ctx.Equal(theirs.Status, 202, "another tenant's k-1 is its own key: globex's first POST (%s)", theirs.Text())
	ctx.Equal(len(apiLoads(ctx)), 3, "three distinct loads were started; the loads in the store")
}

func CheckManifestBounds(ctx *harness.Ctx) {
	c := api(ctx)
	mode := apiPost(c, apiManifest("2026-10-20", "wh_acme.orders", "upsert", "dedupe"), "acme", "k-mode")
	ctx.Equal(mode.Status, 400, "mode upsert (the modes are append, merge and replace)")
	big := apiManifest("2026-10-20", "wh_acme.orders", "merge", "dedupe")
	big["notes"] = strings.Repeat("x", 70000)
	r := apiPost(c, big, "acme", "k-big")
	ctx.Equal(r.Status, 413, "a 70 KB manifest is over maxManifestBytes (64 KiB)")
	ctx.Equal(len(apiLoads(ctx)), 0, "a refused manifest must not be stored as a load; loads")
	replace := apiPost(c, apiManifest("2026-10-20", "wh_acme.orders", "replace", "dedupe"), "acme", "k-replace")
	ctx.Equal(replace.Status, 202, "mode replace (%s)", replace.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "loader/store.h"

namespace {

nlohmann::json manifest(const std::string& version, const std::string& target, const std::string& mode, const std::string& transform) {
  return {{"source", {{"dataset", "orders"}, {"version", version}}}, {"target", target}, {"mode", mode}, {"transform", transform}};
}

const nlohmann::json kManifest = manifest("2026-10-20", "wh_acme.orders", "merge", "dedupe");

harness::HTTP api(harness::Ctx& ctx) {
  ctx.Redis.Do("HSET", "source:orders:2026-10-20", "p-0", "250", "p-1", "250", "p-2", "250", "p-3", "250");
  ctx.Redis.Do("HSET", "source:orders:2026-10-21", "p-0", "300", "p-1", "300");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response post(harness::HTTP& c, const nlohmann::json& body, const std::string& tenant, const std::string& key) {
  const std::string text = body.dump();
  if (tenant.empty()) return c.Post("/v1/loads", text, "Content-Type", "application/json", "Idempotency-Key", key);
  if (key.empty()) return c.Post("/v1/loads", text, "Content-Type", "application/json", "X-Tenant-Id", tenant);
  return c.Post("/v1/loads", text, "Content-Type", "application/json", "X-Tenant-Id", tenant, "Idempotency-Key", key);
}

nlohmann::json bodyOf(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

size_t loads(harness::Ctx& ctx) {
  size_t n = 0;
  for (const auto& k : ctx.Redis.Keys("load:ld-*")) {
    if (k.find(':', 5) == std::string::npos) n++;
  }
  return n;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = post(c, kManifest, "acme", "k-1");
  ctx.Equal(r.Status, 202, "POST /v1/loads (%s)", r.Text());
  const auto body = bodyOf(r);
  ctx.Equal(body.value("status", ""), "queued", "the new load's status (%s)", r.Text());
  ctx.Equal(body.value("target", ""), "wh_acme.orders", "the new load's target (%s)", r.Text());
  ctx.Equal(body.value("mode", ""), "merge", "the new load's mode (%s)", r.Text());
  ctx.Equal(body.value("partitions", 0L), 4, "the new load's partitions (%s)", r.Text());
  ctx.Equal(body.value("rows_planned", 0L), 1000, "the new load's rows_planned (%s)", r.Text());
  const std::string load_id = body.value("load_id", "");
  ctx.Assert(store::getLoad("acme", load_id).has_value(), "the load %q the API answered is not in the loads store", load_id);
  const auto anonymous = post(c, kManifest, "", "k-2");
  ctx.Equal(anonymous.Status, 401, "a POST without X-Tenant-Id");
}

void CheckRegisteredTransform(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto sql = post(c, manifest("2026-10-20", "wh_acme.orders", "merge", "SELECT * FROM wh_globex.orders"), "acme", "k-sql");
  ctx.Equal(sql.Status, 400, "a transform that is SQL, not a registered name, would run with the loader's warehouse credentials (%s)", sql.Text());
  ctx.Equal(loads(ctx), 0, "the load with caller SQL must not be stored; loads");
  const auto unknown = post(c, manifest("2026-10-20", "wh_acme.orders", "merge", "pivot"), "acme", "k-pivot");
  ctx.Equal(unknown.Status, 400, "an unregistered transform name");
  const auto r = post(c, kManifest, "acme", "k-ok");
  ctx.Equal(r.Status, 202, "a load with the registered transform dedupe (%s)", r.Text());
  const auto load = store::getLoad("acme", bodyOf(r).value("load_id", ""));
  ctx.Assert(load.has_value(), "the load the API answered is not in the store");
  ctx.Equal(load->sql, kTransforms.at("dedupe"), "the load must carry the registry's SQL for dedupe; its sql");
}

void CheckTenantSchema(harness::Ctx& ctx) {
  auto c = api(ctx);
  for (const std::string target : {"wh_globex.orders", "shared.loads"}) {
    const auto r = post(c, manifest("2026-10-20", target, "merge", "dedupe"), "acme", "k-" + target);
    ctx.Equal(r.Status, 403, "tenant acme loading into %s must be refused: a load writes into wh_acme only (%s)", target, r.Text());
  }
  const auto bare = post(c, manifest("2026-10-20", "orders", "merge", "dedupe"), "acme", "k-bare");
  ctx.Equal(bare.Status, 400, "a target that is not schema.table");
  ctx.Equal(loads(ctx), 0, "a refused target must not be stored as a load; loads");
  const auto own = post(c, kManifest, "acme", "k-own");
  ctx.Equal(own.Status, 202, "tenant acme loading into wh_acme.orders (%s)", own.Text());
}

void CheckManifestKey(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto other = manifest("2026-10-21", "wh_acme.orders", "merge", "dedupe");
  const auto none = post(c, kManifest, "acme", "");
  ctx.Equal(none.Status, 400, "a POST without Idempotency-Key");
  const auto first = post(c, kManifest, "acme", "k-1");
  ctx.Equal(first.Status, 202, "the first POST (%s)", first.Text());
  const auto replay = post(c, kManifest, "acme", "k-1");
  ctx.Equal(replay.Status, 200, "a retry of the same manifest under the same key must answer the recorded load");
  ctx.Equal(bodyOf(replay).value("load_id", ""), bodyOf(first).value("load_id", ""), "one manifest, one load: the retry's load_id");
  const auto changed = post(c, other, "acme", "k-1");
  ctx.Equal(changed.Status, 409, "another manifest under a used key");
  const auto fresh = post(c, other, "acme", "k-2");
  ctx.Assert(fresh.Status == 202 && bodyOf(fresh).value("load_id", "") != bodyOf(first).value("load_id", ""), "a new key must start a new load, got %d %s", fresh.Status, fresh.Text());
  const auto theirs = post(c, manifest("2026-10-20", "wh_globex.orders", "merge", "dedupe"), "globex", "k-1");
  ctx.Equal(theirs.Status, 202, "another tenant's k-1 is its own key: globex's first POST (%s)", theirs.Text());
  ctx.Equal(loads(ctx), 3, "three distinct loads were started; the loads in the store");
}

void CheckManifestBounds(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto mode = post(c, manifest("2026-10-20", "wh_acme.orders", "upsert", "dedupe"), "acme", "k-mode");
  ctx.Equal(mode.Status, 400, "mode upsert (the modes are append, merge and replace)");
  nlohmann::json big = kManifest;
  big["notes"] = std::string(70000, 'x');
  const auto r = post(c, big, "acme", "k-big");
  ctx.Equal(r.Status, 413, "a 70 KB manifest is over kMaxManifestBytes (64 KiB)");
  ctx.Equal(loads(ctx), 0, "a refused manifest must not be stored as a load; loads");
  const auto replace = post(c, manifest("2026-10-20", "wh_acme.orders", "replace", "dedupe"), "acme", "k-replace");
  ctx.Equal(replace.Status, 202, "mode replace (%s)", replace.Text());
}
`,
  },
  hints: [
    'Post the same manifest twice under one Idempotency-Key: two load ids come back. Post a transform of `SELECT * FROM wh_globex.orders`, or a target in `wh_globex`, as tenant acme: both are accepted.',
    'The starter trusts the body. `TRANSFORMS.get(transform, transform)` falls back to the caller’s string as SQL, nothing compares the target’s schema with the tenant, the key header is not read, and neither size nor mode is checked.',
    'Read the raw body and answer 413 over `MAX_MANIFEST_BYTES`; 400 for a missing key, a mode outside `LOAD_MODES` or a transform outside `TRANSFORMS`; 403 unless the schema is `wh_{tenant}`; then `find_key`: 200 or 409, else `create_load` and `remember_key`.',
  ],
  debrief: `Everything about a load is decided before it exists, because the manifest is the unit of work. The registry turns a name into SQL the platform wrote, the schema comes from the authenticated tenant rather than the body, and the fingerprint ties an Idempotency-Key to exactly one manifest, so a retry finds the first load instead of starting a second. The 409 matters as much as the replay: answering the old load for a different manifest would hide a client bug behind a success. Production loaders expire the key records, create the load and the key in one transaction so two concurrent retries cannot both win, and check the target against the tenant's table catalog with column types, not only the schema prefix.`,
};
