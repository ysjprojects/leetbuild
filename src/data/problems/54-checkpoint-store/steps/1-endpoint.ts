import type {Step} from '@/lib/types';

export const checkpointEndpointStep: Step = {
  id: 'endpoint',
  title: 'PUT a checkpoint chunk: each chunk at its own index',
  concept: 'http',
  guides: ['idempotent-requests', 'atomic-state'],
  file: 'api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves the upload path on the upload store (\`checkpoint.store\`,
provided). \`POST /v1/checkpoints\` with \`{run_id, step, chunks}\` opens an upload of a run the
\`X-Tenant-Id\` owns and answers \`201\` with its \`upload_id\`. \`PUT
/v1/checkpoints/{upload_id}/chunks/{index}\` with \`{"data": base64}\` stages the chunk with
\`store.put_chunk\` in the next free slot (\`store.stored_count\`) and answers \`{upload_id, index,
received}\`; a missing tenant is 401, another tenant's upload 404. It serves the demo and hides three
flaws.

**Failure mode the checks target.** The trainer's uploader retries. A redelivered chunk is staged a
second time, a chunk that overtook its predecessor lands in the predecessor's slot, and a replay
carrying different bytes is accepted. Each one resumes as wrong weights.

- A chunk is staged **at its own index**: \`store.put_chunk(upload_id, index, payload, digest)\`.
- The expected index is \`store.stored_count(upload_id)\`. A chunk past it, or at or past the
  upload's \`chunks\`, is **409** and stages nothing.
- A chunk below it is a replay: compare \`store.digest(payload)\` with
  \`store.chunk_digest(upload_id, index)\`. The same bytes answer 200 and stage nothing new; different
  bytes are **409**.`,
  sequence: {
    participants: ['Training job', 'Checkpoint API', 'Upload store'],
    messages: [
      {
        from: 'Training job',
        to: 'Checkpoint API',
        label: 'POST /v1/checkpoints · run r1, step 1200, 3 chunks',
        kind: 'sync',
      },
      {from: 'Checkpoint API', to: 'Training job', label: '201 {upload_id: u-1}', kind: 'reply'},
      {from: 'Training job', to: 'Checkpoint API', label: 'PUT …/u-1/chunks/1 · data', kind: 'sync'},
      {from: 'Checkpoint API', to: 'Upload store', label: 'stored_count(u-1) → 1 · expected index 1', kind: 'sync'},
      {from: 'Checkpoint API', to: 'Upload store', label: 'put_chunk(u-1, 1, bytes, sha256)', kind: 'sync'},
      {
        from: 'Checkpoint API',
        to: 'Training job',
        label: '200 {index 1, received 2} · 409 gap or different bytes',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Opens an upload and stages its first chunk',
      detail:
        'Register `POST /v1/checkpoints` and `PUT /v1/checkpoints/{upload_id}/chunks/{index}`: the open answers 201 with the upload id, the first chunk 200, a missing tenant 401 and another tenant 404.',
      match: {
        python: {
          all: [
            /@app\.post\(\s*["']\/v1\/checkpoints["']/,
            /@app\.put\(\s*["']\/v1\/checkpoints\/\{upload_id\}\/chunks\/\{index\}["']/,
          ],
        },
        typescript: {
          all: [
            /app\.post\(\s*['"]\/v1\/checkpoints['"]/,
            /app\.put\(\s*['"]\/v1\/checkpoints\/:uploadId\/chunks\/:index['"]/,
          ],
        },
        go: {all: [/"POST \/v1\/checkpoints"/, /"PUT \/v1\/checkpoints\/\{id\}\/chunks\/\{index\}"/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/checkpoints"/, /svr\.Put\(\s*R"\(\/v1\/checkpoints\//]},
      },
    },
    {
      id: 'chunk-at-index',
      title: 'Stages a chunk at its own index',
      detail:
        'The chunk is written with `put_chunk(upload_id, index, …)`, the index the request names, and a redelivery with the same bytes answers 200 and stages nothing, the last chunk of a complete upload included. The starter writes it to the next free slot, so a redelivered chunk is staged twice.',
      match: {
        python: {all: [/store\.put_chunk\(\s*upload_id,\s*index\b/], none: [/put_chunk\(\s*upload_id,\s*slot\b/]},
        typescript: {all: [/putChunk\(\s*uploadId,\s*index\b/], none: [/putChunk\(\s*uploadId,\s*slot\b/]},
        go: {all: [/store\.PutChunk\(\s*ctx,\s*uploadID,\s*index\b/], none: [/PutChunk\(\s*ctx,\s*uploadID,\s*slot\b/]},
        cpp: {all: [/store::putChunk\(\s*upload_id,\s*index\b/], none: [/putChunk\(\s*upload_id,\s*slot\b/]},
      },
    },
    {
      id: 'chunk-order',
      title: 'A chunk past the expected index is 409',
      detail:
        'The expected index is the staged count; a chunk past it, or past the upload’s chunk count, answers **409** before anything is staged. The starter accepts any index.',
      match: {
        python: {
          all: [/\b409\b/],
          order: [/store\.stored_count\(/, /index\s*>\s*\w+|\w+\s*<\s*index/, /store\.put_chunk\(/],
        },
        typescript: {all: [/\b409\b/], order: [/storedCount\(/, /index\s*>\s*\w+|\w+\s*<\s*index/, /putChunk\(/]},
        go: {
          all: [/StatusConflict|\b409\b/],
          order: [/store\.StoredCount\(/, /index\s*>\s*\w+|\w+\s*<\s*index/, /store\.PutChunk\(/],
        },
        cpp: {
          all: [/\b409\b/],
          order: [/store::storedCount\(/, /index\s*>\s*\w+|\w+\s*<\s*index/, /store::putChunk\(/],
        },
      },
    },
    {
      id: 'chunk-conflict',
      title: 'A replay with different bytes is 409',
      detail:
        'A chunk below the expected index, any staged index and not only the last one, is compared by digest with what `chunk_digest`/`chunkDigest` holds: the same bytes answer 200 and stage nothing new, different bytes answer **409**. The starter never compares.',
      match: {
        python: {all: [/\b409\b/], order: [/store\.chunk_digest\(\s*upload_id,\s*index/, /store\.put_chunk\(/]},
        typescript: {all: [/\b409\b/], order: [/chunkDigest\(\s*uploadId,\s*index/, /putChunk\(/]},
        go: {
          all: [/StatusConflict|\b409\b/],
          order: [/store\.ChunkDigest\(\s*ctx,\s*uploadID,\s*index/, /store\.PutChunk\(/],
        },
        cpp: {all: [/\b409\b/], order: [/store::chunkDigest\(\s*upload_id,\s*index/, /store::putChunk\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from checkpoint import store  # run_tenant, open_upload, upload, decode, digest, stored_count, chunk_digest, put_chunk

app = FastAPI()


def _tenant(request: Request) -> str:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    return tenant


@app.post("/v1/checkpoints", status_code=201)
async def open_checkpoint(request: Request) -> dict:
    tenant = _tenant(request)
    body = await request.json()
    if store.run_tenant(body["run_id"]) != tenant:
        raise HTTPException(status_code=404, detail="no such run")
    return store.open_upload(body["run_id"], tenant, int(body["step"]), int(body["chunks"]))


@app.put("/v1/checkpoints/{upload_id}/chunks/{index}")
async def put_chunk(upload_id: str, index: int, request: Request) -> dict:
    # TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
    tenant = _tenant(request)
    upload = store.upload(upload_id)
    if upload is None or upload["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such upload")
    payload = store.decode((await request.json()).get("data", ""))
    if payload is None:
        raise HTTPException(status_code=400, detail="data must be base64")
    slot = store.stored_count(upload_id)  # chunks arrive in order: each one takes the next slot
    store.put_chunk(upload_id, slot, payload, store.digest(payload))
    return {"upload_id": upload_id, "index": slot, "received": slot + 1}
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from checkpoint import store  # run_tenant, open_upload, upload, decode, digest, stored_count, chunk_digest, put_chunk

app = FastAPI()


def _tenant(request: Request) -> str:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    return tenant


@app.post("/v1/checkpoints", status_code=201)
async def open_checkpoint(request: Request) -> dict:
    tenant = _tenant(request)
    body = await request.json()
    if store.run_tenant(body["run_id"]) != tenant:
        raise HTTPException(status_code=404, detail="no such run")
    return store.open_upload(body["run_id"], tenant, int(body["step"]), int(body["chunks"]))


@app.put("/v1/checkpoints/{upload_id}/chunks/{index}")
async def put_chunk(upload_id: str, index: int, request: Request) -> dict:
    tenant = _tenant(request)
    upload = store.upload(upload_id)
    if upload is None or upload["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such upload")
    payload = store.decode((await request.json()).get("data", ""))
    if payload is None:
        raise HTTPException(status_code=400, detail="data must be base64")
    stored = store.stored_count(upload_id)
    if index >= upload["chunks"] or index > stored:
        # A gap: staging it now would leave a hole the commit can never fill in order.
        raise HTTPException(status_code=409, detail={"error": "chunk out of order", "expected": stored})
    chunk_sha = store.digest(payload)
    if index < stored:
        # A redelivery: the same bytes are already staged, different bytes are a conflict.
        if store.chunk_digest(upload_id, index) != chunk_sha:
            raise HTTPException(status_code=409, detail={"error": "chunk differs from the staged one", "index": index})
        return {"upload_id": upload_id, "index": index, "received": stored}
    store.put_chunk(upload_id, index, payload, chunk_sha)
    return {"upload_id": upload_id, "index": index, "received": stored + 1}
`,
    },
    typescript: {
      starter: `import Fastify, {type FastifyRequest} from 'fastify';

import {chunkDigest, decode, digest, openUpload, putChunk, runTenant, storedCount, upload} from 'checkpoint/store';

export const app = Fastify();

const tenantOf = (request: FastifyRequest): string | null => {
  const tenant = request.headers['x-tenant-id'];
  return typeof tenant === 'string' && tenant !== '' ? tenant : null;
};

app.post('/v1/checkpoints', async (request, reply) => {
  const tenant = tenantOf(request);
  if (tenant === null) return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {run_id, step, chunks} = request.body as {run_id: string; step: number; chunks: number};
  if ((await runTenant(run_id)) !== tenant) return reply.code(404).send({error: 'no such run'});
  return reply.code(201).send(await openUpload(run_id, tenant, Number(step), Number(chunks)));
});

app.put('/v1/checkpoints/:uploadId/chunks/:index', async (request, reply) => {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  const tenant = tenantOf(request);
  if (tenant === null) return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {uploadId} = request.params as {uploadId: string; index: string};
  const current = await upload(uploadId);
  if (current === null || current.tenant !== tenant) return reply.code(404).send({error: 'no such upload'});
  const payload = decode((request.body as {data?: string}).data ?? '');
  if (payload === null) return reply.code(400).send({error: 'data must be base64'});
  const slot = await storedCount(uploadId); // chunks arrive in order: each one takes the next slot
  await putChunk(uploadId, slot, payload, digest(payload));
  return {upload_id: uploadId, index: slot, received: slot + 1};
});
`,
      solution: `import Fastify, {type FastifyRequest} from 'fastify';

import {chunkDigest, decode, digest, openUpload, putChunk, runTenant, storedCount, upload} from 'checkpoint/store';

export const app = Fastify();

const tenantOf = (request: FastifyRequest): string | null => {
  const tenant = request.headers['x-tenant-id'];
  return typeof tenant === 'string' && tenant !== '' ? tenant : null;
};

app.post('/v1/checkpoints', async (request, reply) => {
  const tenant = tenantOf(request);
  if (tenant === null) return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {run_id, step, chunks} = request.body as {run_id: string; step: number; chunks: number};
  if ((await runTenant(run_id)) !== tenant) return reply.code(404).send({error: 'no such run'});
  return reply.code(201).send(await openUpload(run_id, tenant, Number(step), Number(chunks)));
});

app.put('/v1/checkpoints/:uploadId/chunks/:index', async (request, reply) => {
  const tenant = tenantOf(request);
  if (tenant === null) return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const params = request.params as {uploadId: string; index: string};
  const uploadId = params.uploadId;
  const index = Number(params.index);
  const current = await upload(uploadId);
  if (current === null || current.tenant !== tenant) return reply.code(404).send({error: 'no such upload'});
  const payload = decode((request.body as {data?: string}).data ?? '');
  if (payload === null) return reply.code(400).send({error: 'data must be base64'});
  const stored = await storedCount(uploadId);
  if (!Number.isInteger(index) || index >= current.chunks || index > stored) {
    // A gap: staging it now would leave a hole the commit can never fill in order.
    return reply.code(409).send({error: 'chunk out of order', expected: stored});
  }
  const chunkSha = digest(payload);
  if (index < stored) {
    // A redelivery: the same bytes are already staged, different bytes are a conflict.
    if ((await chunkDigest(uploadId, index)) !== chunkSha) return reply.code(409).send({error: 'chunk differs from the staged one', index});
    return {upload_id: uploadId, index, received: stored};
  }
  await putChunk(uploadId, index, payload, chunkSha);
  return {upload_id: uploadId, index, received: stored + 1};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"checkpoint/store" // store.RunTenant, OpenUpload, GetUpload, Decode, Digest, StoredCount, ChunkDigest, PutChunk
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func openCheckpoint(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	var body struct {
		RunID  string \`json:"run_id"\`
		Step   int64  \`json:"step"\`
		Chunks int64  \`json:"chunks"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "body must be JSON"})
		return
	}
	if store.RunTenant(r.Context(), body.RunID) != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such run"})
		return
	}
	writeJSON(rw, http.StatusCreated, store.OpenUpload(r.Context(), body.RunID, tenant, body.Step, body.Chunks))
}

func putChunk(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
	ctx := r.Context()
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	uploadID := r.PathValue("id")
	upload := store.GetUpload(ctx, uploadID)
	if upload == nil || upload.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such upload"})
		return
	}
	var body struct {
		Data string \`json:"data"\`
	}
	json.NewDecoder(r.Body).Decode(&body)
	payload, err := store.Decode(body.Data)
	if err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "data must be base64"})
		return
	}
	slot := store.StoredCount(ctx, uploadID) // chunks arrive in order: each one takes the next slot
	store.PutChunk(ctx, uploadID, slot, payload, store.Digest(payload))
	writeJSON(rw, http.StatusOK, map[string]any{"upload_id": uploadID, "index": slot, "received": slot + 1})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/checkpoints", openCheckpoint)
	mux.HandleFunc("PUT /v1/checkpoints/{id}/chunks/{index}", putChunk)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	"checkpoint/store" // store.RunTenant, OpenUpload, GetUpload, Decode, Digest, StoredCount, ChunkDigest, PutChunk
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func openCheckpoint(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	var body struct {
		RunID  string \`json:"run_id"\`
		Step   int64  \`json:"step"\`
		Chunks int64  \`json:"chunks"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "body must be JSON"})
		return
	}
	if store.RunTenant(r.Context(), body.RunID) != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such run"})
		return
	}
	writeJSON(rw, http.StatusCreated, store.OpenUpload(r.Context(), body.RunID, tenant, body.Step, body.Chunks))
}

func putChunk(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	uploadID := r.PathValue("id")
	index, err := strconv.ParseInt(r.PathValue("index"), 10, 64)
	if err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "index must be a number"})
		return
	}
	upload := store.GetUpload(ctx, uploadID)
	if upload == nil || upload.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such upload"})
		return
	}
	var body struct {
		Data string \`json:"data"\`
	}
	json.NewDecoder(r.Body).Decode(&body)
	payload, err := store.Decode(body.Data)
	if err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "data must be base64"})
		return
	}
	stored := store.StoredCount(ctx, uploadID)
	if index >= upload.Chunks || index > stored {
		// A gap: staging it now would leave a hole the commit can never fill in order.
		writeJSON(rw, http.StatusConflict, map[string]any{"error": "chunk out of order", "expected": stored})
		return
	}
	chunkSha := store.Digest(payload)
	if index < stored {
		// A redelivery: the same bytes are already staged, different bytes are a conflict.
		if store.ChunkDigest(ctx, uploadID, index) != chunkSha {
			writeJSON(rw, http.StatusConflict, map[string]any{"error": "chunk differs from the staged one", "index": index})
			return
		}
		writeJSON(rw, http.StatusOK, map[string]any{"upload_id": uploadID, "index": index, "received": stored})
		return
	}
	store.PutChunk(ctx, uploadID, index, payload, chunkSha)
	writeJSON(rw, http.StatusOK, map[string]any{"upload_id": uploadID, "index": index, "received": stored + 1})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/checkpoints", openCheckpoint)
	mux.HandleFunc("PUT /v1/checkpoints/{id}/chunks/{index}", putChunk)
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "checkpoint/store.h"  // store::runTenant, openUpload, upload, decode, digest, storedCount, chunkDigest, putChunk

using json = nlohmann::json;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

json uploadJson(const store::Upload& u) {
  return json{{"upload_id", u.upload_id}, {"run_id", u.run_id}, {"step", u.step}, {"chunks", u.chunks}};
}

void open_checkpoint(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, {{"error", "body must be JSON"}});
  const std::string run_id = body.value("run_id", "");
  if (store::runTenant(run_id) != tenant) return reply(res, 404, {{"error", "no such run"}});
  reply(res, 201, uploadJson(store::openUpload(run_id, tenant, body.value("step", 0L), body.value("chunks", 0L))));
}

void put_chunk(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const std::string upload_id = req.matches[1];
  const auto upload = store::upload(upload_id);
  if (!upload || upload->tenant != tenant) return reply(res, 404, {{"error", "no such upload"}});
  const json body = json::parse(req.body, nullptr, false);
  const auto payload = store::decode(body.is_object() ? body.value("data", "") : "");
  if (!payload) return reply(res, 400, {{"error", "data must be base64"}});
  const long slot = store::storedCount(upload_id);  // chunks arrive in order: each one takes the next slot
  store::putChunk(upload_id, slot, *payload, store::digest(*payload));
  reply(res, 200, {{"upload_id", upload_id}, {"index", slot}, {"received", slot + 1}});
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/checkpoints", open_checkpoint);
  svr.Put(R"(/v1/checkpoints/([\\w-]+)/chunks/(\\d+))", put_chunk);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "checkpoint/store.h"  // store::runTenant, openUpload, upload, decode, digest, storedCount, chunkDigest, putChunk

using json = nlohmann::json;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

json uploadJson(const store::Upload& u) {
  return json{{"upload_id", u.upload_id}, {"run_id", u.run_id}, {"step", u.step}, {"chunks", u.chunks}};
}

void open_checkpoint(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, {{"error", "body must be JSON"}});
  const std::string run_id = body.value("run_id", "");
  if (store::runTenant(run_id) != tenant) return reply(res, 404, {{"error", "no such run"}});
  reply(res, 201, uploadJson(store::openUpload(run_id, tenant, body.value("step", 0L), body.value("chunks", 0L))));
}

void put_chunk(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const std::string upload_id = req.matches[1];
  const long index = std::stol(req.matches[2]);
  const auto upload = store::upload(upload_id);
  if (!upload || upload->tenant != tenant) return reply(res, 404, {{"error", "no such upload"}});
  const json body = json::parse(req.body, nullptr, false);
  const auto payload = store::decode(body.is_object() ? body.value("data", "") : "");
  if (!payload) return reply(res, 400, {{"error", "data must be base64"}});
  const long stored = store::storedCount(upload_id);
  if (index >= upload->chunks || index > stored) {
    // A gap: staging it now would leave a hole the commit can never fill in order.
    return reply(res, 409, {{"error", "chunk out of order"}, {"expected", stored}});
  }
  const std::string chunk_sha = store::digest(*payload);
  if (index < stored) {
    // A redelivery: the same bytes are already staged, different bytes are a conflict.
    if (store::chunkDigest(upload_id, index) != chunk_sha) return reply(res, 409, {{"error", "chunk differs from the staged one"}, {"index", index}});
    return reply(res, 200, {{"upload_id", upload_id}, {"index", index}, {"received", stored}});
  }
  store::putChunk(upload_id, index, *payload, chunk_sha);
  reply(res, 200, {{"upload_id", upload_id}, {"index", index}, {"received", stored + 1}});
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/checkpoints", open_checkpoint);
  svr.Put(R"(/v1/checkpoints/([\\w-]+)/chunks/(\\d+))", put_chunk);
}
`,
    },
  },
  harness: {
    python: `import base64

from checkpoint import store

A = b"layer-0 weights"
B = b"layer-1 weights"
C = b"layer-2 weights"
T1 = {"X-Tenant-Id": "t1"}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _open(c, chunks=3):
    store.create_run("r1", "t1")
    r = await c.post("/v1/checkpoints", json={"run_id": "r1", "step": 1200, "chunks": chunks}, headers=T1)
    assert r.status_code == 201, f"POST /v1/checkpoints answered {r.status_code}: {r.text}"
    return r.json()["upload_id"]


async def _put(c, upload_id, index, payload, headers=T1):
    return await c.put(f"/v1/checkpoints/{upload_id}/chunks/{index}", json={"data": base64.b64encode(payload).decode()}, headers=headers)


def _staged(upload_id, n):
    return [store.chunk(upload_id, i) for i in range(n)]


async def check_route(ctx):
    async with _api(ctx) as c:
        upload_id = await _open(c)
        r = await _put(c, upload_id, 0, A)
        assert r.status_code == 200, f"PUT chunk 0 answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("index") == 0 and body.get("received") == 1, f"chunk 0 of a fresh upload must answer index 0, received 1, got {body}"
        assert store.chunk(upload_id, 0) == A and store.chunk_digest(upload_id, 0) == store.digest(A), "chunk 0 must be staged with its sha256"
        r = await _put(c, upload_id, 1, B, headers={})
        assert r.status_code == 401, f"a chunk without X-Tenant-Id answered {r.status_code}, expected 401"
        r = await _put(c, upload_id, 1, B, headers={"X-Tenant-Id": "t2"})
        assert r.status_code == 404, f"another tenant's chunk answered {r.status_code}, expected 404"
        store.create_run("r2", "t2")
        r = await c.post("/v1/checkpoints", json={"run_id": "r2", "step": 1, "chunks": 1}, headers=T1)
    assert r.status_code == 404, f"opening an upload of another tenant's run answered {r.status_code}, expected 404"


async def check_chunk_at_index(ctx):
    async with _api(ctx) as c:
        upload_id = await _open(c)
        await _put(c, upload_id, 0, A)
        await _put(c, upload_id, 1, B)
        r = await _put(c, upload_id, 1, B)  # the uploader timed out and sent chunk 1 again
        assert r.status_code == 200, f"a redelivery of chunk 1 with the same bytes answered {r.status_code}: {r.text}"
        count = store.stored_count(upload_id)
        assert count == 2, f"after chunks 0, 1 and a redelivery of chunk 1 the upload stages {count} chunks: the redelivered chunk was staged a second time, in another slot. Stage a chunk at its own index"
        r = await _put(c, upload_id, 2, C)
        assert r.status_code == 200, f"chunk 2 after the redelivery answered {r.status_code}: {r.text}"
        r = await _put(c, upload_id, 2, C)  # the last chunk again, once the upload is complete
        assert r.status_code == 200, f"a redelivery of the last chunk of a complete upload answered {r.status_code}: {r.text}, expected 200: the same bytes at a staged index are a replay"
        assert store.stored_count(upload_id) == 3, f"after a redelivery of the last chunk the upload stages {store.stored_count(upload_id)} chunks, expected 3"
    staged = _staged(upload_id, 3)
    assert staged == [A, B, C], f"the upload stages {staged}, expected the three chunks in index order"


async def check_chunk_order(ctx):
    async with _api(ctx) as c:
        upload_id = await _open(c)
        await _put(c, upload_id, 0, A)
        r = await _put(c, upload_id, 2, C)  # chunk 2 overtook chunk 1
        assert r.status_code == 409, f"chunk 2 arriving before chunk 1 answered {r.status_code}, expected 409: chunk 1 is the expected index"
        assert store.stored_count(upload_id) == 1 and store.chunk(upload_id, 1) is None, f"the out-of-order chunk was staged: {_staged(upload_id, 3)}"
        await _put(c, upload_id, 1, B)
        await _put(c, upload_id, 2, C)
        r = await _put(c, upload_id, 3, b"one chunk too many")
        assert r.status_code == 409, f"a chunk past the upload's 3 chunks answered {r.status_code}, expected 409"
    staged = _staged(upload_id, 4)
    assert staged == [A, B, C, None], f"the upload stages {staged}, expected chunks 0, 1, 2 and nothing past them"


async def check_chunk_conflict(ctx):
    async with _api(ctx) as c:
        upload_id = await _open(c)
        await _put(c, upload_id, 0, A)
        await _put(c, upload_id, 1, B)
        r = await _put(c, upload_id, 0, b"tampered weights")  # chunk 0 again, behind the last staged chunk
        assert r.status_code == 409, f"a replay of chunk 0 with different bytes answered {r.status_code}, expected 409"
        assert store.chunk(upload_id, 0) == A and store.chunk_digest(upload_id, 0) == store.digest(A), f"chunk 0 now stages {store.chunk(upload_id, 0)!r}: the replay with different bytes overwrote it"
        assert store.stored_count(upload_id) == 2, f"the conflicting replay was staged as another chunk: {store.stored_count(upload_id)} staged"
        r = await _put(c, upload_id, 0, A)
    assert r.status_code == 200, f"a replay of chunk 0 with the same bytes answered {r.status_code}, expected 200: any staged index, not only the last one, can be redelivered"
    assert store.stored_count(upload_id) == 2, f"the replay of chunk 0 with the same bytes left {store.stored_count(upload_id)} chunks staged, expected 2"
`,
    typescript: `const A = 'layer-0 weights';
const B = 'layer-1 weights';
const C = 'layer-2 weights';
const T1 = {'X-Tenant-Id': 't1'};

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/checkpoint/store.ts')};
}

async function open(c, store, chunks = 3): Promise<string> {
  await store.createRun('r1', 't1');
  const r = await c.post('/v1/checkpoints', {json: {run_id: 'r1', step: 1200, chunks}, headers: T1});
  assert.equal(r.status, 201, \`POST /v1/checkpoints answered \${r.status}: \${r.text}\`);
  return r.json().upload_id;
}

const put = (c, uploadId: string, index: number, payload: string, headers: Record<string, string> = T1) =>
  c.put(\`/v1/checkpoints/\${uploadId}/chunks/\${index}\`, {json: {data: Buffer.from(payload).toString('base64')}, headers});

async function staged(store, uploadId: string, n: number): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (let i = 0; i < n; i++) {
    const chunk = await store.chunk(uploadId, i);
    out.push(chunk === null ? null : chunk.toString());
  }
  return out;
}

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const uploadId = await open(c, store);
  let r = await put(c, uploadId, 0, A);
  assert.equal(r.status, 200, \`PUT chunk 0 answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.index === 0 && body.received === 1, \`chunk 0 of a fresh upload must answer index 0, received 1, got \${r.text}\`);
  assert.deepEqual(await staged(store, uploadId, 1), [A], 'chunk 0 must be staged');
  assert.equal(await store.chunkDigest(uploadId, 0), store.digest(Buffer.from(A)), 'chunk 0 must be staged with its sha256');
  r = await put(c, uploadId, 1, B, {});
  assert.equal(r.status, 401, \`a chunk without X-Tenant-Id answered \${r.status}, expected 401\`);
  r = await put(c, uploadId, 1, B, {'X-Tenant-Id': 't2'});
  assert.equal(r.status, 404, \`another tenant's chunk answered \${r.status}, expected 404\`);
  await store.createRun('r2', 't2');
  r = await c.post('/v1/checkpoints', {json: {run_id: 'r2', step: 1, chunks: 1}, headers: T1});
  assert.equal(r.status, 404, \`opening an upload of another tenant's run answered \${r.status}, expected 404\`);
}

export async function check_chunk_at_index(ctx) {
  const {c, store} = api(ctx);
  const uploadId = await open(c, store);
  await put(c, uploadId, 0, A);
  await put(c, uploadId, 1, B);
  let r = await put(c, uploadId, 1, B); // the uploader timed out and sent chunk 1 again
  assert.equal(r.status, 200, \`a redelivery of chunk 1 with the same bytes answered \${r.status}: \${r.text}\`);
  const count = await store.storedCount(uploadId);
  assert.equal(count, 2, \`after chunks 0, 1 and a redelivery of chunk 1 the upload stages \${count} chunks: the redelivered chunk was staged a second time, in another slot. Stage a chunk at its own index\`);
  r = await put(c, uploadId, 2, C);
  assert.equal(r.status, 200, \`chunk 2 after the redelivery answered \${r.status}: \${r.text}\`);
  r = await put(c, uploadId, 2, C); // the last chunk again, once the upload is complete
  assert.equal(r.status, 200, \`a redelivery of the last chunk of a complete upload answered \${r.status}: \${r.text}, expected 200: the same bytes at a staged index are a replay\`);
  assert.equal(await store.storedCount(uploadId), 3, 'after a redelivery of the last chunk the upload must stage 3 chunks');
  assert.deepEqual(await staged(store, uploadId, 3), [A, B, C], 'the upload must stage the three chunks in index order');
}

export async function check_chunk_order(ctx) {
  const {c, store} = api(ctx);
  const uploadId = await open(c, store);
  await put(c, uploadId, 0, A);
  let r = await put(c, uploadId, 2, C); // chunk 2 overtook chunk 1
  assert.equal(r.status, 409, \`chunk 2 arriving before chunk 1 answered \${r.status}, expected 409: chunk 1 is the expected index\`);
  assert.deepEqual(await staged(store, uploadId, 3), [A, null, null], 'the out-of-order chunk must not be staged');
  await put(c, uploadId, 1, B);
  await put(c, uploadId, 2, C);
  r = await put(c, uploadId, 3, 'one chunk too many');
  assert.equal(r.status, 409, \`a chunk past the upload's 3 chunks answered \${r.status}, expected 409\`);
  assert.deepEqual(await staged(store, uploadId, 4), [A, B, C, null], 'the upload must stage chunks 0, 1, 2 and nothing past them');
}

export async function check_chunk_conflict(ctx) {
  const {c, store} = api(ctx);
  const uploadId = await open(c, store);
  await put(c, uploadId, 0, A);
  await put(c, uploadId, 1, B);
  let r = await put(c, uploadId, 0, 'tampered weights'); // chunk 0 again, behind the last staged chunk
  assert.equal(r.status, 409, \`a replay of chunk 0 with different bytes answered \${r.status}, expected 409\`);
  assert.deepEqual(await staged(store, uploadId, 2), [A, B], 'the replay with different bytes overwrote chunk 0');
  assert.equal(await store.chunkDigest(uploadId, 0), store.digest(Buffer.from(A)), 'chunk 0 must keep its own sha256');
  assert.equal(await store.storedCount(uploadId), 2, 'the conflicting replay was staged as another chunk');
  r = await put(c, uploadId, 0, A);
  assert.equal(r.status, 200, \`a replay of chunk 0 with the same bytes answered \${r.status}, expected 200: any staged index, not only the last one, can be redelivered\`);
  assert.equal(await store.storedCount(uploadId), 2, 'the replay of chunk 0 with the same bytes must leave 2 chunks staged');
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"

	"checkpoint/store"

	"leetbuild/harness"
)

var (
	hBg     = context.Background()
	hChunkA = []byte("layer-0 weights")
	hChunkB = []byte("layer-1 weights")
	hChunkC = []byte("layer-2 weights")
)

func hAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func hOpenUpload(ctx *harness.Ctx, c *harness.HTTP) string {
	store.CreateRun(hBg, "r1", "t1")
	r := c.Post("/v1/checkpoints", map[string]any{"run_id": "r1", "step": 1200, "chunks": 3}, "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 201, "POST /v1/checkpoints (%s)", r.Text())
	var body struct {
		UploadID string \`json:"upload_id"\`
	}
	r.Decode(&body)
	return body.UploadID
}

func hPutAs(c *harness.HTTP, uploadID string, index int, payload []byte, header ...string) *harness.Response {
	return c.Put(fmt.Sprintf("/v1/checkpoints/%s/chunks/%d", uploadID, index), map[string]string{"data": store.Encode(payload)}, header...)
}

func hPut(c *harness.HTTP, uploadID string, index int, payload []byte) *harness.Response {
	return hPutAs(c, uploadID, index, payload, "X-Tenant-Id", "t1")
}

func hStaged(uploadID string, n int) []string {
	out := make([]string, n)
	for i := range out {
		if chunk := store.Chunk(hBg, uploadID, int64(i)); chunk != nil {
			out[i] = string(chunk)
		}
	}
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	c := hAPI(ctx)
	uploadID := hOpenUpload(ctx, c)
	r := hPut(c, uploadID, 0, hChunkA)
	ctx.Equal(r.Status, 200, "PUT chunk 0 (%s)", r.Text())
	var body struct {
		Index    int64 \`json:"index"\`
		Received int64 \`json:"received"\`
	}
	r.Decode(&body)
	ctx.Assert(body.Index == 0 && body.Received == 1, "chunk 0 of a fresh upload must answer index 0, received 1, got %s", r.Text())
	ctx.Equal(hStaged(uploadID, 1), []string{string(hChunkA)}, "chunk 0 must be staged")
	ctx.Equal(store.ChunkDigest(hBg, uploadID, 0), store.Digest(hChunkA), "chunk 0 must be staged with its sha256")
	r = hPutAs(c, uploadID, 1, hChunkB)
	ctx.Equal(r.Status, 401, "a chunk without X-Tenant-Id")
	r = hPutAs(c, uploadID, 1, hChunkB, "X-Tenant-Id", "t2")
	ctx.Equal(r.Status, 404, "another tenant's chunk")
	store.CreateRun(hBg, "r2", "t2")
	r = c.Post("/v1/checkpoints", map[string]any{"run_id": "r2", "step": 1, "chunks": 1}, "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 404, "opening an upload of another tenant's run")
}

func CheckChunkAtIndex(ctx *harness.Ctx) {
	c := hAPI(ctx)
	uploadID := hOpenUpload(ctx, c)
	hPut(c, uploadID, 0, hChunkA)
	hPut(c, uploadID, 1, hChunkB)
	r := hPut(c, uploadID, 1, hChunkB) // the uploader timed out and sent chunk 1 again
	ctx.Equal(r.Status, 200, "a redelivery of chunk 1 with the same bytes (%s)", r.Text())
	count := store.StoredCount(hBg, uploadID)
	ctx.Equal(count, 2, "after chunks 0, 1 and a redelivery of chunk 1 the redelivered chunk must not be staged a second time, in another slot (stage a chunk at its own index); the staged chunks")
	r = hPut(c, uploadID, 2, hChunkC)
	ctx.Equal(r.Status, 200, "chunk 2 after the redelivery (%s)", r.Text())
	r = hPut(c, uploadID, 2, hChunkC) // the last chunk again, once the upload is complete
	ctx.Equal(r.Status, 200, "a redelivery of the last chunk of a complete upload (the same bytes at a staged index are a replay) (%s)", r.Text())
	ctx.Equal(store.StoredCount(hBg, uploadID), 3, "after a redelivery of the last chunk; the staged chunks")
	ctx.Equal(hStaged(uploadID, 3), []string{string(hChunkA), string(hChunkB), string(hChunkC)}, "the upload must stage the three chunks in index order")
}

func CheckChunkOrder(ctx *harness.Ctx) {
	c := hAPI(ctx)
	uploadID := hOpenUpload(ctx, c)
	hPut(c, uploadID, 0, hChunkA)
	r := hPut(c, uploadID, 2, hChunkC) // chunk 2 overtook chunk 1
	ctx.Equal(r.Status, 409, "chunk 2 arriving before chunk 1 (chunk 1 is the expected index)")
	ctx.Equal(hStaged(uploadID, 3), []string{string(hChunkA), "", ""}, "the out-of-order chunk must not be staged")
	hPut(c, uploadID, 1, hChunkB)
	hPut(c, uploadID, 2, hChunkC)
	r = hPut(c, uploadID, 3, []byte("one chunk too many"))
	ctx.Equal(r.Status, 409, "a chunk past the upload's 3 chunks")
	ctx.Equal(hStaged(uploadID, 4), []string{string(hChunkA), string(hChunkB), string(hChunkC), ""}, "the upload must stage chunks 0, 1, 2 and nothing past them")
}

func CheckChunkConflict(ctx *harness.Ctx) {
	c := hAPI(ctx)
	uploadID := hOpenUpload(ctx, c)
	hPut(c, uploadID, 0, hChunkA)
	hPut(c, uploadID, 1, hChunkB)
	r := hPut(c, uploadID, 0, []byte("tampered weights")) // chunk 0 again, behind the last staged chunk
	ctx.Equal(r.Status, 409, "a replay of chunk 0 with different bytes")
	ctx.Equal(hStaged(uploadID, 2), []string{string(hChunkA), string(hChunkB)}, "the replay with different bytes must not overwrite chunk 0")
	ctx.Equal(store.ChunkDigest(hBg, uploadID, 0), store.Digest(hChunkA), "chunk 0 must keep its own sha256")
	ctx.Equal(store.StoredCount(hBg, uploadID), 2, "the conflicting replay must not be staged as another chunk; the staged chunks")
	r = hPut(c, uploadID, 0, hChunkA)
	ctx.Equal(r.Status, 200, "a replay of chunk 0 with the same bytes (any staged index, not only the last one, can be redelivered)")
	ctx.Equal(store.StoredCount(hBg, uploadID), 2, "after the replay of chunk 0 with the same bytes; the staged chunks")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "checkpoint/store.h"

namespace {

const std::string hA = "layer-0 weights";
const std::string hB = "layer-1 weights";
const std::string hC = "layer-2 weights";

harness::HTTP hApi(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string hOpenUpload(harness::Ctx& ctx, harness::HTTP& c) {
  store::createRun("r1", "t1");
  const auto r = c.Post("/v1/checkpoints", R"({"run_id": "r1", "step": 1200, "chunks": 3})", "Content-Type", "application/json", "X-Tenant-Id", "t1");
  ctx.Equal(r.Status, 201, "POST /v1/checkpoints (%s)", r.Text());
  return nlohmann::json::parse(r.Text()).value("upload_id", "");
}

std::string hChunkBody(const std::string& payload) { return nlohmann::json{{"data", store::encode(payload)}}.dump(); }

harness::Response hPut(harness::HTTP& c, const std::string& upload_id, int index, const std::string& payload, const std::string& tenant = "t1") {
  const std::string path = "/v1/checkpoints/" + upload_id + "/chunks/" + std::to_string(index);
  if (tenant.empty()) return c.Put(path, hChunkBody(payload), "Content-Type", "application/json");
  return c.Put(path, hChunkBody(payload), "Content-Type", "application/json", "X-Tenant-Id", tenant);
}

std::vector<std::string> hStaged(const std::string& upload_id, int n) {
  std::vector<std::string> out;
  for (int i = 0; i < n; i++) out.push_back(store::chunk(upload_id, i).value_or(""));
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = hApi(ctx);
  const std::string upload_id = hOpenUpload(ctx, c);
  auto r = hPut(c, upload_id, 0, hA);
  ctx.Equal(r.Status, 200, "PUT chunk 0 (%s)", r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object() && body.value("index", -1L) == 0 && body.value("received", -1L) == 1,
             "chunk 0 of a fresh upload must answer index 0, received 1, got %s", r.Text());
  ctx.Equal(hStaged(upload_id, 1), std::vector<std::string>{hA}, "chunk 0 must be staged");
  ctx.Equal(store::chunkDigest(upload_id, 0), store::digest(hA), "chunk 0 must be staged with its sha256");
  r = hPut(c, upload_id, 1, hB, "");
  ctx.Equal(r.Status, 401, "a chunk without X-Tenant-Id");
  r = hPut(c, upload_id, 1, hB, "t2");
  ctx.Equal(r.Status, 404, "another tenant's chunk");
  store::createRun("r2", "t2");
  r = c.Post("/v1/checkpoints", R"({"run_id": "r2", "step": 1, "chunks": 1})", "Content-Type", "application/json", "X-Tenant-Id", "t1");
  ctx.Equal(r.Status, 404, "opening an upload of another tenant's run");
}

void CheckChunkAtIndex(harness::Ctx& ctx) {
  auto c = hApi(ctx);
  const std::string upload_id = hOpenUpload(ctx, c);
  hPut(c, upload_id, 0, hA);
  hPut(c, upload_id, 1, hB);
  auto r = hPut(c, upload_id, 1, hB);  // the uploader timed out and sent chunk 1 again
  ctx.Equal(r.Status, 200, "a redelivery of chunk 1 with the same bytes (%s)", r.Text());
  ctx.Equal(store::storedCount(upload_id), 2,
            "after chunks 0, 1 and a redelivery of chunk 1 the redelivered chunk must not be staged a second time, in another slot (stage a chunk at its own index); the staged chunks");
  r = hPut(c, upload_id, 2, hC);
  ctx.Equal(r.Status, 200, "chunk 2 after the redelivery (%s)", r.Text());
  r = hPut(c, upload_id, 2, hC);  // the last chunk again, once the upload is complete
  ctx.Equal(r.Status, 200, "a redelivery of the last chunk of a complete upload (the same bytes at a staged index are a replay) (%s)", r.Text());
  ctx.Equal(store::storedCount(upload_id), 3, "after a redelivery of the last chunk; the staged chunks");
  ctx.Equal(hStaged(upload_id, 3), std::vector<std::string>{hA, hB, hC}, "the upload must stage the three chunks in index order");
}

void CheckChunkOrder(harness::Ctx& ctx) {
  auto c = hApi(ctx);
  const std::string upload_id = hOpenUpload(ctx, c);
  hPut(c, upload_id, 0, hA);
  auto r = hPut(c, upload_id, 2, hC);  // chunk 2 overtook chunk 1
  ctx.Equal(r.Status, 409, "chunk 2 arriving before chunk 1 (chunk 1 is the expected index)");
  ctx.Equal(hStaged(upload_id, 3), std::vector<std::string>{hA, "", ""}, "the out-of-order chunk must not be staged");
  hPut(c, upload_id, 1, hB);
  hPut(c, upload_id, 2, hC);
  r = hPut(c, upload_id, 3, "one chunk too many");
  ctx.Equal(r.Status, 409, "a chunk past the upload's 3 chunks");
  ctx.Equal(hStaged(upload_id, 4), std::vector<std::string>{hA, hB, hC, ""}, "the upload must stage chunks 0, 1, 2 and nothing past them");
}

void CheckChunkConflict(harness::Ctx& ctx) {
  auto c = hApi(ctx);
  const std::string upload_id = hOpenUpload(ctx, c);
  hPut(c, upload_id, 0, hA);
  hPut(c, upload_id, 1, hB);
  auto r = hPut(c, upload_id, 0, "tampered weights");  // chunk 0 again, behind the last staged chunk
  ctx.Equal(r.Status, 409, "a replay of chunk 0 with different bytes");
  ctx.Equal(hStaged(upload_id, 2), std::vector<std::string>{hA, hB}, "the replay with different bytes must not overwrite chunk 0");
  ctx.Equal(store::chunkDigest(upload_id, 0), store::digest(hA), "chunk 0 must keep its own sha256");
  ctx.Equal(store::storedCount(upload_id), 2, "the conflicting replay must not be staged as another chunk; the staged chunks");
  r = hPut(c, upload_id, 0, hA);
  ctx.Equal(r.Status, 200, "a replay of chunk 0 with the same bytes (any staged index, not only the last one, can be redelivered)");
  ctx.Equal(store::storedCount(upload_id), 2, "after the replay of chunk 0 with the same bytes; the staged chunks");
}
`,
  },
  hints: [
    'Resume from a checkpoint whose uploader retried a chunk: the staged count is one higher than the chunk count, and chunk 2 holds chunk 1’s bytes. A chunk sent before its predecessor is accepted too.',
    'The handler ignores the index in the path. It writes every chunk to the next free slot, so a redelivery takes a new slot, an early chunk takes its predecessor’s slot, and nothing ever compares a replay with what is staged.',
    'Read `stored = store.stored_count(upload_id)`; 409 when `index >= chunks` or `index > stored`; when `index < stored`, 409 unless `store.chunk_digest` equals `store.digest(payload)`, else 200; otherwise `store.put_chunk(upload_id, index, …)`.',
  ],
  debrief: `The index in the path is the only thing that ties a stream of requests to one position in the checkpoint, so every decision comes from comparing it with what is already staged. Writing at the index makes a redelivery land on itself; refusing a gap keeps the staged set a prefix, which is what lets the count stand for completeness; and the digest turns "same index" into "same bytes", the only replay that is safe to accept. Production uploaders send several chunks in parallel, so stores like S3 accept parts in any order and check completeness at the end against a manifest the client sends; they also cap a part's size and bound how long an open upload may idle.`,
};
