import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/uploads/{id}: the exact parts to send again',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/uploads/{upload_id}\`, the read a client makes after a
dropped connection: it loads the upload (\`store.get_upload\`), reads the registered parts
(\`manifest.read_parts\`) and the byte counter (\`manifest.uploaded_bytes\`), and answers
\`{upload_id, status, part_count, registered_parts, uploaded_bytes, percent_complete}\`. It serves the
demo and hides three flaws.

**Failure mode the checks target.** A client that reads 60 % cannot tell which parts are missing and
sends the whole file again; anyone holding an upload id from a log reads another tenant's upload; a
part registered while the read runs makes \`uploaded_bytes\` disagree with the parts the client is
told about.

- The tenant comes from \`X-Tenant-Id\` (**401** without one); an upload of another tenant, like an
  unknown id, is **404**.
- Answer \`stored\`, the registered parts \`{part_number, size, checksum}\` by number, and \`resume\`,
  every number in \`1..part_count\` that is not registered, in order.
- \`uploaded_bytes\` is the sum of the sizes in \`stored\`, from the same read of the parts, not a
  second read of the counter.`,
  sequence: {
    participants: ['Uploader', 'uploadd', 'upload records', 'Redis manifest'],
    messages: [
      {from: 'Uploader', to: 'uploadd', label: 'GET /v1/uploads/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'uploadd', to: 'upload records', label: 'get_upload(id) · tenant must match, else 404', kind: 'sync'},
      {from: 'uploadd', to: 'Redis manifest', label: 'read_parts(id): one HGETALL', kind: 'sync'},
      {
        from: 'uploadd',
        to: 'uploadd',
        label: '1..part_count → stored · resume · uploaded_bytes = Σ stored',
        kind: 'sync',
      },
      {from: 'uploadd', to: 'Uploader', label: '200 {stored, resume, uploaded_bytes}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/uploads/{upload_id}',
      detail:
        'Register the status read on `GET /v1/uploads/{upload_id}`: it answers the upload id, its status and its part count.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/uploads\/\{upload_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/uploads\/:uploadId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/uploads\/\{id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"uploads"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/uploads\//]},
      },
    },
    {
      id: 'resume-list',
      title: 'Names the exact parts to send again',
      detail:
        'The read answers `stored` (the registered parts with size and checksum) and `resume` (every unregistered number in `1..part_count`, in order); the starter answers a percentage, so the client cannot tell which parts are missing.',
      match: {
        python: {all: [/\bresume\b/, /\bstored\b/], none: [/percent/]},
        typescript: {all: [/\bresume\b/, /\bstored\b/], none: [/percent/]},
        go: {all: [/\bresume\b/i, /\bstored\b/i], none: [/percent/i]},
        scala: {all: [/\bresume\b/, /\bstored\b/], none: [/percent/]},
        cpp: {all: [/\bresume\b/, /\bstored\b/], none: [/percent/]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Another tenant's upload is 404",
      detail:
        "The upload's tenant is compared with `X-Tenant-Id` (401 when absent), and another tenant's upload answers 404 like an unknown id; the starter reads no tenant, so an upload id from a log opens any tenant's upload.",
      match: {
        python: {all: [/x-tenant-id/i, /\[["']tenant["']\]\s*!=\s*tenant|tenant\s*!=\s*upload\[["']tenant["']\]/]},
        typescript: {all: [/x-tenant-id/i, /\.tenant\s*!==\s*tenant|tenant\s*!==\s*upload\.tenant/]},
        go: {all: [/X-Tenant-Id/i, /\.Tenant\s*!=\s*tenant|tenant\s*!=\s*upload\.Tenant/]},
        scala: {all: [/X-Tenant-Id/i, /\.tenant\s*[!=]=\s*tenant|tenant\s*[!=]=\s*\w+\.tenant/]},
        cpp: {all: [/X-Tenant-Id/i, /->tenant\s*!=\s*tenant|tenant\s*!=\s*upload->tenant/]},
      },
    },
    {
      id: 'consistent-read',
      title: 'Counts the bytes of the parts it lists',
      detail:
        '`uploaded_bytes` is summed from the parts the read listed, so a part registered during the read is in both or in neither; the starter reads the counter in a second command (`uploaded_bytes`/`uploadedBytes`).',
      match: {
        python: {all: [/["']uploaded_bytes["']/], none: [/manifest\.uploaded_bytes\(/]},
        typescript: {all: [/uploaded_bytes/], none: [/uploadedBytes\(/]},
        go: {all: [/uploaded_bytes/], none: [/manifest\.UploadedBytes\(/]},
        scala: {all: [/uploaded_bytes/], none: [/Manifest\.uploadedBytes\(/]},
        cpp: {all: [/uploaded_bytes/], none: [/manifest::uploadedBytes\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from uploads import manifest, store  # store.get_upload, manifest.read_parts, manifest.uploaded_bytes

app = FastAPI()


@app.get("/v1/uploads/{upload_id}")
def get_upload(upload_id: str, request: Request) -> dict:
    """The upload's progress, for a client that lost its connection."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    upload = store.get_upload(upload_id)
    if upload is None:
        raise HTTPException(status_code=404, detail="no such upload")
    parts = manifest.read_parts(upload_id)
    uploaded = manifest.uploaded_bytes(upload_id)
    return {
        "upload_id": upload_id,
        "status": upload["status"],
        "part_count": upload["part_count"],
        "registered_parts": len(parts),
        "uploaded_bytes": uploaded,
        "percent_complete": 100 * uploaded // upload["total_bytes"],
    }
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from uploads import manifest, store  # store.get_upload, manifest.read_parts, manifest.uploaded_bytes

app = FastAPI()


@app.get("/v1/uploads/{upload_id}")
def get_upload(upload_id: str, request: Request) -> dict:
    """The upload's progress, for a client that lost its connection."""
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    upload = store.get_upload(upload_id)
    # Another tenant's upload is as unknown as a missing one: a 403 would confirm that the id exists.
    if upload is None or upload["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such upload")
    registered = {p["part_number"]: p for p in manifest.read_parts(upload_id)}
    stored, resume = [], []
    for number in range(1, upload["part_count"] + 1):
        if number in registered:
            stored.append(registered[number])
        else:
            resume.append(number)
    return {
        "upload_id": upload_id,
        "status": upload["status"],
        "part_count": upload["part_count"],
        # One read: the bytes are those of the parts listed, whatever registers meanwhile.
        "uploaded_bytes": sum(p["size"] for p in stored),
        "stored": stored,
        "resume": resume,
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {readParts, uploadedBytes} from 'uploads/manifest';
import {getUpload} from 'uploads/store';

export const app = Fastify();

app.get('/v1/uploads/:uploadId', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const {uploadId} = request.params as {uploadId: string};
  const upload = await getUpload(uploadId);
  if (upload === null) return reply.code(404).send({error: 'no such upload'});
  const parts = await readParts(uploadId);
  const uploaded = await uploadedBytes(uploadId);
  return {
    upload_id: uploadId,
    status: upload.status,
    part_count: upload.part_count,
    registered_parts: parts.length,
    uploaded_bytes: uploaded,
    percent_complete: Math.floor((100 * uploaded) / upload.total_bytes),
  };
});
`,
      solution: `import Fastify from 'fastify';

import {type Part, readParts} from 'uploads/manifest';
import {getUpload} from 'uploads/store';

export const app = Fastify();

app.get('/v1/uploads/:uploadId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {uploadId} = request.params as {uploadId: string};
  const upload = await getUpload(uploadId);
  // Another tenant's upload is as unknown as a missing one: a 403 would confirm that the id exists.
  if (upload === null || upload.tenant !== tenant) return reply.code(404).send({error: 'no such upload'});
  const registered = new Map((await readParts(uploadId)).map(p => [p.part_number, p]));
  const stored: Part[] = [];
  const resume: number[] = [];
  for (let n = 1; n <= upload.part_count; n += 1) {
    const part = registered.get(n);
    if (part === undefined) resume.push(n);
    else stored.push(part);
  }
  return {
    upload_id: uploadId,
    status: upload.status,
    part_count: upload.part_count,
    // One read: the bytes are those of the parts listed, whatever registers meanwhile.
    uploaded_bytes: stored.reduce((sum, p) => sum + p.size, 0),
    stored,
    resume,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"uploads/manifest" // manifest.ReadParts, UploadedBytes
	"uploads/store"    // store.GetUpload
)

type progressView struct {
	UploadID        string \`json:"upload_id"\`
	Status          string \`json:"status"\`
	PartCount       int    \`json:"part_count"\`
	RegisteredParts int    \`json:"registered_parts"\`
	UploadedBytes   int64  \`json:"uploaded_bytes"\`
	PercentComplete int64  \`json:"percent_complete"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func getUpload(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	uploadID := r.PathValue("id")
	upload := store.GetUpload(r.Context(), uploadID)
	if upload == nil {
		http.Error(rw, "no such upload", http.StatusNotFound)
		return
	}
	parts, err := manifest.ReadParts(r.Context(), uploadID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	uploaded, err := manifest.UploadedBytes(r.Context(), uploadID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusOK, progressView{
		UploadID: uploadID, Status: upload.Status, PartCount: upload.PartCount, RegisteredParts: len(parts),
		UploadedBytes: uploaded, PercentComplete: 100 * uploaded / upload.TotalBytes,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/uploads/{id}", getUpload)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"uploads/manifest" // manifest.ReadParts, UploadedBytes
	"uploads/store"    // store.GetUpload
)

type statusView struct {
	UploadID      string          \`json:"upload_id"\`
	Status        string          \`json:"status"\`
	PartCount     int             \`json:"part_count"\`
	UploadedBytes int64           \`json:"uploaded_bytes"\`
	Stored        []manifest.Part \`json:"stored"\`
	Resume        []int           \`json:"resume"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func getUpload(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	uploadID := r.PathValue("id")
	upload := store.GetUpload(r.Context(), uploadID)
	// Another tenant's upload is as unknown as a missing one: a 403 would confirm that the id exists.
	if upload == nil || upload.Tenant != tenant {
		http.Error(rw, "no such upload", http.StatusNotFound)
		return
	}
	parts, err := manifest.ReadParts(r.Context(), uploadID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	registered := make(map[int]manifest.Part, len(parts))
	for _, p := range parts {
		registered[p.PartNumber] = p
	}
	view := statusView{UploadID: uploadID, Status: upload.Status, PartCount: upload.PartCount, Stored: []manifest.Part{}, Resume: []int{}}
	for n := 1; n <= upload.PartCount; n++ {
		if p, ok := registered[n]; ok {
			view.Stored = append(view.Stored, p)
			view.UploadedBytes += p.Size // one read: the bytes are those of the parts listed
		} else {
			view.Resume = append(view.Resume, n)
		}
	}
	writeJSON(rw, http.StatusOK, view)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/uploads/{id}", getUpload)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import uploads.{Manifest, Store} // Store.getUpload, Manifest.readParts, Manifest.uploadedBytes

object ReadApi {
  val route: Route = path("v1" / "uploads" / Segment) { uploadId =>
    get {
      // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
      Store.getUpload(uploadId) match {
        case None => complete(StatusCodes.NotFound -> "no such upload")
        case Some(upload) =>
          val parts = Manifest.readParts(uploadId)
          val uploaded = Manifest.uploadedBytes(uploadId)
          val body = JsObject(
            "upload_id" -> JsString(uploadId), "status" -> JsString(upload.status), "part_count" -> JsNumber(upload.partCount),
            "registered_parts" -> JsNumber(parts.size), "uploaded_bytes" -> JsNumber(uploaded),
            "percent_complete" -> JsNumber(100 * uploaded / upload.totalBytes))
          complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import uploads.{Manifest, Part, Store} // Store.getUpload, Manifest.readParts, Manifest.uploadedBytes

object ReadApi {
  private def partJson(p: Part): JsObject =
    JsObject("part_number" -> JsNumber(p.partNumber), "size" -> JsNumber(p.size), "checksum" -> JsString(p.checksum))

  val route: Route = path("v1" / "uploads" / Segment) { uploadId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          Store.getUpload(uploadId) match {
            case Some(upload) if upload.tenant == tenant =>
              val registered = Manifest.readParts(uploadId).map(p => p.partNumber -> p).toMap
              val numbers = 1 to upload.partCount
              val stored = numbers.flatMap(registered.get)
              val resume = numbers.filterNot(registered.contains)
              val body = JsObject(
                "upload_id" -> JsString(uploadId), "status" -> JsString(upload.status), "part_count" -> JsNumber(upload.partCount),
                // One read: the bytes are those of the parts listed, whatever registers meanwhile.
                "uploaded_bytes" -> JsNumber(stored.map(_.size).sum),
                "stored" -> JsArray(stored.map(partJson).toVector), "resume" -> JsArray(resume.map(n => JsNumber(n)).toVector))
              complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
            // Another tenant's upload is as unknown as a missing one: a 403 would confirm that the id exists.
            case _ => complete(StatusCodes.NotFound -> "no such upload")
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

#include <string>

#include "uploads/manifest.h"  // manifest::readParts, uploadedBytes
#include "uploads/store.h"     // store::getUpload

using json = nlohmann::json;

void get_upload(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string upload_id = req.matches[1];
  const auto upload = store::getUpload(upload_id);
  if (!upload) {
    res.status = 404;
    res.set_content("no such upload", "text/plain");
    return;
  }
  const auto parts = manifest::readParts(upload_id);
  const long long uploaded = manifest::uploadedBytes(upload_id);
  const json body = {{"upload_id", upload_id},
                     {"status", upload->status},
                     {"part_count", upload->part_count},
                     {"registered_parts", parts.size()},
                     {"uploaded_bytes", uploaded},
                     {"percent_complete", 100 * uploaded / upload->total_bytes}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/uploads/([\\w-]+))", get_upload); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <string>

#include "uploads/manifest.h"  // manifest::readParts, uploadedBytes
#include "uploads/store.h"     // store::getUpload

using json = nlohmann::json;

void get_upload(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const std::string upload_id = req.matches[1];
  const auto upload = store::getUpload(upload_id);
  // Another tenant's upload is as unknown as a missing one: a 403 would confirm that the id exists.
  if (!upload || upload->tenant != tenant) {
    res.status = 404;
    res.set_content("no such upload", "text/plain");
    return;
  }
  std::map<int, manifest::Part> registered;
  for (const auto& p : manifest::readParts(upload_id)) registered[p.part_number] = p;
  json stored = json::array();
  json resume = json::array();
  long long uploaded_bytes = 0;  // one read: the bytes are those of the parts listed
  for (int n = 1; n <= upload->part_count; n++) {
    const auto it = registered.find(n);
    if (it == registered.end()) {
      resume.push_back(n);
      continue;
    }
    stored.push_back({{"part_number", n}, {"size", it->second.size}, {"checksum", it->second.checksum}});
    uploaded_bytes += it->second.size;
  }
  const json body = {{"upload_id", upload_id},          {"status", upload->status}, {"part_count", upload->part_count},
                     {"uploaded_bytes", uploaded_bytes}, {"stored", stored},         {"resume", resume}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/uploads/([\\w-]+))", get_upload); }
`,
    },
  },
  harness: {
    python: `from uploads import manifest, store

MIB = 1 << 20
T1 = {"X-Tenant-Id": "t1"}


def _size(n):
    return 3 * MIB if n == 5 else 5 * MIB  # 23 MiB in 5 MiB parts: the fifth holds 3 MiB


def _register(n):
    manifest.register_part("u-1", n, 5, _size(n), f"c{n}")


def _reader(ctx, parts=(1, 2, 4)):
    """u-1 of tenant t1: 23 MiB in five parts, with \`parts\` registered."""
    store.create_upload("t1", 23 * MIB, 5 * MIB, 5, "video/mp4")
    for n in parts:
        _register(n)
    return ctx.client(ctx.load("read").app)


def _rival(ctx, n):
    """Another server registers part n of u-1 (one script: the hash and the counter at once)."""
    ctx.redis.hset("upload:u-1:parts", n, f"{_size(n)}:c{n}")
    ctx.redis.incrby("upload:u-1:bytes", _size(n))


async def check_route(ctx):
    async with _reader(ctx) as c:
        r = await c.get("/v1/uploads/u-1", headers=T1)
    assert r.status_code == 200, f"GET /v1/uploads/u-1 answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("upload_id") == "u-1" and body.get("part_count") == 5 and body.get("status") == "pending", f"the read answered {body}, expected upload_id u-1, part_count 5, status pending"


async def check_resume_list(ctx):
    async with _reader(ctx) as c:
        body = (await c.get("/v1/uploads/u-1", headers=T1)).json()
        assert body.get("resume") == [3, 5], f"with parts 1, 2 and 4 of 5 registered the read answered {body}: resume must be exactly [3, 5], or the client sends the whole file again"
        expected = [{"part_number": n, "size": _size(n), "checksum": f"c{n}"} for n in (1, 2, 4)]
        assert body.get("stored") == expected, f"stored is {body.get('stored')}, expected parts 1, 2 and 4 with their sizes and checksums"
        _register(3)
        _register(5)
        done = (await c.get("/v1/uploads/u-1", headers=T1)).json()
    assert done.get("resume") == [] and [p.get("part_number") for p in done.get("stored", [])] == [1, 2, 3, 4, 5], f"with every part registered the read answered {done}: resume must be empty and stored list parts 1 to 5"


async def check_tenant_scope(ctx):
    async with _reader(ctx) as c:
        foreign = await c.get("/v1/uploads/u-1", headers={"X-Tenant-Id": "t2"})
        unknown = await c.get("/v1/uploads/u-9", headers=T1)
        anonymous = await c.get("/v1/uploads/u-1")
    assert foreign.status_code == 404, f"tenant t2 read t1's upload u-1 and got {foreign.status_code}: {foreign.text}. Upload ids leak through logs and URLs; another tenant's upload is 404"
    assert unknown.status_code == 404, f"an unknown upload id answered {unknown.status_code}, expected 404"
    assert anonymous.status_code == 401, f"a read without X-Tenant-Id answered {anonymous.status_code}, expected 401"


async def check_consistent_read(ctx):
    async with _reader(ctx, parts=(1,)) as c:
        ctx.redis_after("upload:u-1:parts", lambda: _rival(ctx, 2))
        ctx.redis_after("upload:u-1:bytes", lambda: _rival(ctx, 3))
        r = await c.get("/v1/uploads/u-1", headers=T1)
    body = r.json()
    stored = body.get("stored") or []
    listed = sum(p.get("size", 0) for p in stored)
    assert body.get("uploaded_bytes") == listed, f"parts were registered while the read ran, and it answered uploaded_bytes {body.get('uploaded_bytes')} beside stored parts {[p.get('part_number') for p in stored]} that add up to {listed}: the bytes and the parts came from two reads"
`,
    typescript: `const MIB = 2 ** 20;
const T1 = {'X-Tenant-Id': 't1'};

const size = (n: number): number => (n === 5 ? 3 * MIB : 5 * MIB); // 23 MiB in 5 MiB parts: the fifth holds 3 MiB

/** u-1 of tenant t1: 23 MiB in five parts, with the given parts registered. */
async function reader(ctx, parts = [1, 2, 4]) {
  const store = ctx.load('/support/uploads/store.ts');
  const manifest = ctx.load('/support/uploads/manifest.ts');
  await store.createUpload('t1', 23 * MIB, 5 * MIB, 5, 'video/mp4');
  const register = (n: number) => manifest.registerPart('u-1', n, 5, size(n), \`c\${n}\`);
  for (const n of parts) await register(n);
  return {c: ctx.client(ctx.load('read').app), register};
}

/** Another server registers part n of u-1 (one script: the hash and the counter at once). */
function rival(ctx, n: number): void {
  ctx.redis.hset('upload:u-1:parts', String(n), \`\${size(n)}:c\${n}\`);
  ctx.redis.incrby('upload:u-1:bytes', size(n));
}

export async function check_route(ctx) {
  const {c} = await reader(ctx);
  const r = await c.get('/v1/uploads/u-1', {headers: T1});
  assert.equal(r.status, 200, \`GET /v1/uploads/u-1 answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.upload_id === 'u-1' && body.part_count === 5 && body.status === 'pending', \`the read answered \${r.text}, expected upload_id u-1, part_count 5, status pending\`);
}

export async function check_resume_list(ctx) {
  const {c, register} = await reader(ctx);
  const r = await c.get('/v1/uploads/u-1', {headers: T1});
  const body = r.json();
  assert.deepStrictEqual(body.resume, [3, 5], \`with parts 1, 2 and 4 of 5 registered the read answered \${r.text}: resume must be exactly [3, 5], or the client sends the whole file again\`);
  const expected = [1, 2, 4].map(n => ({part_number: n, size: size(n), checksum: \`c\${n}\`}));
  assert.deepStrictEqual(body.stored, expected, \`stored is \${JSON.stringify(body.stored)}, expected parts 1, 2 and 4 with their sizes and checksums\`);
  await register(3);
  await register(5);
  const done = (await c.get('/v1/uploads/u-1', {headers: T1})).json();
  assert(
    Array.isArray(done.resume) && done.resume.length === 0 && JSON.stringify((done.stored ?? []).map(p => p.part_number)) === '[1,2,3,4,5]',
    \`with every part registered the read answered \${JSON.stringify(done)}: resume must be empty and stored list parts 1 to 5\`,
  );
}

export async function check_tenant_scope(ctx) {
  const {c} = await reader(ctx);
  const foreign = await c.get('/v1/uploads/u-1', {headers: {'X-Tenant-Id': 't2'}});
  const unknown = await c.get('/v1/uploads/u-9', {headers: T1});
  const anonymous = await c.get('/v1/uploads/u-1');
  assert.equal(foreign.status, 404, \`tenant t2 read t1's upload u-1 and got \${foreign.status}: \${foreign.text}. Upload ids leak through logs and URLs; another tenant's upload is 404\`);
  assert.equal(unknown.status, 404, \`an unknown upload id answered \${unknown.status}, expected 404\`);
  assert.equal(anonymous.status, 401, \`a read without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
}

export async function check_consistent_read(ctx) {
  const {c} = await reader(ctx, [1]);
  ctx.redisAfter('upload:u-1:parts', () => rival(ctx, 2));
  ctx.redisAfter('upload:u-1:bytes', () => rival(ctx, 3));
  const r = await c.get('/v1/uploads/u-1', {headers: T1});
  const body = r.json();
  const stored = body.stored ?? [];
  const listed = stored.reduce((sum, p) => sum + (p.size ?? 0), 0);
  assert.equal(body.uploaded_bytes, listed, \`parts were registered while the read ran, and it answered uploaded_bytes \${body.uploaded_bytes} beside stored parts \${JSON.stringify(stored.map(p => p.part_number))} that add up to \${listed}: the bytes and the parts came from two reads\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"

	"uploads/manifest"
	"uploads/store"

	"leetbuild/harness"
)

const readMib = int64(1) << 20

var readBg = context.Background()

type partSeen struct {
	PartNumber int    \`json:"part_number"\`
	Size       int64  \`json:"size"\`
	Checksum   string \`json:"checksum"\`
}

type statusSeen struct {
	UploadID      string     \`json:"upload_id"\`
	Status        string     \`json:"status"\`
	PartCount     int        \`json:"part_count"\`
	UploadedBytes int64      \`json:"uploaded_bytes"\`
	Stored        []partSeen \`json:"stored"\`
	Resume        []int      \`json:"resume"\`
}

// partSize: 23 MiB in 5 MiB parts, the fifth holds 3 MiB.
func partSize(n int) int64 {
	if n == 5 {
		return 3 * readMib
	}
	return 5 * readMib
}

func registerSeed(ctx *harness.Ctx, n int) {
	_, err := manifest.RegisterPart(readBg, "u-1", n, 5, partSize(n), fmt.Sprintf("c%d", n))
	ctx.NoError(err, "registering part %d", n)
}

// reader makes u-1 of tenant t1, 23 MiB in five parts, with the given parts registered.
func reader(ctx *harness.Ctx, parts ...int) *harness.HTTP {
	store.CreateUpload(readBg, "t1", 23*readMib, 5*readMib, 5, "video/mp4")
	for _, n := range parts {
		registerSeed(ctx, n)
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

// rival is another server registering part n of u-1 (one script: the hash and the counter at once).
func rival(ctx *harness.Ctx, n int) {
	ctx.Redis.Do("HSET", "upload:u-1:parts", n, fmt.Sprintf("%d:c%d", partSize(n), n))
	ctx.Redis.Do("INCRBY", "upload:u-1:bytes", partSize(n))
}

func status(c *harness.HTTP) (*harness.Response, statusSeen) {
	r := c.Get("/v1/uploads/u-1", "X-Tenant-Id", "t1")
	var body statusSeen
	if r.Status == 200 {
		r.Decode(&body)
	}
	return r, body
}

func CheckRoute(ctx *harness.Ctx) {
	r, body := status(reader(ctx, 1, 2, 4))
	ctx.Equal(r.Status, 200, "GET /v1/uploads/u-1 (%s)", r.Text())
	ctx.Assert(body.UploadID == "u-1" && body.PartCount == 5 && body.Status == "pending", "the read answered %s, expected upload_id u-1, part_count 5, status pending", r.Text())
}

func CheckResumeList(ctx *harness.Ctx) {
	c := reader(ctx, 1, 2, 4)
	r, body := status(c)
	ctx.Assert(fmt.Sprint(body.Resume) == "[3 5]", "with parts 1, 2 and 4 of 5 registered the read answered %s: resume must be exactly [3, 5], or the client sends the whole file again", r.Text())
	want := []partSeen{{1, partSize(1), "c1"}, {2, partSize(2), "c2"}, {4, partSize(4), "c4"}}
	ctx.Equal(body.Stored, want, "stored must list parts 1, 2 and 4 with their sizes and checksums")
	registerSeed(ctx, 3)
	registerSeed(ctx, 5)
	r, done := status(c)
	var numbers []int
	for _, p := range done.Stored {
		numbers = append(numbers, p.PartNumber)
	}
	ctx.Assert(done.Resume != nil && len(done.Resume) == 0 && fmt.Sprint(numbers) == "[1 2 3 4 5]", "with every part registered the read answered %s: resume must be empty and stored list parts 1 to 5", r.Text())
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := reader(ctx, 1, 2, 4)
	foreign := c.Get("/v1/uploads/u-1", "X-Tenant-Id", "t2")
	ctx.Equal(foreign.Status, 404, "tenant t2 read t1's upload u-1 (%s): upload ids leak through logs and URLs, another tenant's upload is 404", foreign.Text())
	ctx.Equal(c.Get("/v1/uploads/u-9", "X-Tenant-Id", "t1").Status, 404, "an unknown upload id")
	ctx.Equal(c.Get("/v1/uploads/u-1").Status, 401, "a read without X-Tenant-Id")
}

func CheckConsistentRead(ctx *harness.Ctx) {
	c := reader(ctx, 1)
	ctx.Redis.After("upload:u-1:parts", func() any { rival(ctx, 2); return nil })
	ctx.Redis.After("upload:u-1:bytes", func() any { rival(ctx, 3); return nil })
	r, body := status(c)
	var listed int64
	var numbers []int
	for _, p := range body.Stored {
		listed += p.Size
		numbers = append(numbers, p.PartNumber)
	}
	ctx.Assert(body.UploadedBytes == listed, "parts were registered while the read ran, and it answered uploaded_bytes %d beside stored parts %v that add up to %d: the bytes and the parts came from two reads (%s)", body.UploadedBytes, numbers, listed, r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "uploads/manifest.h"
#include "uploads/store.h"

namespace {

constexpr long long kMib = 1LL << 20;

// 23 MiB in 5 MiB parts: the fifth holds 3 MiB.
long long partSize(int n) { return n == 5 ? 3 * kMib : 5 * kMib; }

void registerSeed(int n) { manifest::registerPart("u-1", n, 5, partSize(n), "c" + std::to_string(n)); }

// u-1 of tenant t1: 23 MiB in five parts, with the given parts registered.
harness::HTTP reader(harness::Ctx& ctx, const std::vector<int>& parts) {
  store::createUpload("t1", 23 * kMib, 5 * kMib, 5, "video/mp4");
  for (const int n : parts) registerSeed(n);
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

// Another server registers part n of u-1 (one script: the hash and the counter at once).
void rival(harness::Ctx& ctx, int n) {
  ctx.Redis.Do("HSET", "upload:u-1:parts", std::to_string(n), std::to_string(partSize(n)) + ":c" + std::to_string(n));
  ctx.Redis.Do("INCRBY", "upload:u-1:bytes", std::to_string(partSize(n)));
}

nlohmann::json parsed(const harness::Response& r) {
  const auto j = nlohmann::json::parse(r.Text(), nullptr, false);
  return j.is_object() ? j : nlohmann::json::object();
}

std::vector<int> numbersOf(const nlohmann::json& body) {
  std::vector<int> out;
  if (body.contains("stored") && body["stored"].is_array()) {
    for (const auto& p : body["stored"]) out.push_back(p.value("part_number", 0));
  }
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = reader(ctx, {1, 2, 4});
  const auto r = c.Get("/v1/uploads/u-1", "X-Tenant-Id", "t1");
  ctx.Equal(r.Status, 200, "GET /v1/uploads/u-1 (%s)", r.Text());
  const auto body = parsed(r);
  ctx.Assert(body.value("upload_id", "") == "u-1" && body.value("part_count", 0) == 5 && body.value("status", "") == "pending",
             "the read answered %s, expected upload_id u-1, part_count 5, status pending", r.Text());
}

void CheckResumeList(harness::Ctx& ctx) {
  auto c = reader(ctx, {1, 2, 4});
  const auto r = c.Get("/v1/uploads/u-1", "X-Tenant-Id", "t1");
  const auto body = parsed(r);
  ctx.Assert(body.contains("resume") && body["resume"] == nlohmann::json::array({3, 5}),
             "with parts 1, 2 and 4 of 5 registered the read answered %s: resume must be exactly [3, 5], or the client sends the whole file again", r.Text());
  nlohmann::json expected = nlohmann::json::array();
  for (const int n : {1, 2, 4}) expected.push_back({{"part_number", n}, {"size", partSize(n)}, {"checksum", "c" + std::to_string(n)}});
  ctx.Assert(body.contains("stored") && body["stored"] == expected, "stored must list parts 1, 2 and 4 with their sizes and checksums, the read answered %s", r.Text());
  registerSeed(3);
  registerSeed(5);
  const auto r2 = c.Get("/v1/uploads/u-1", "X-Tenant-Id", "t1");
  const auto done = parsed(r2);
  ctx.Assert(done.contains("resume") && done["resume"] == nlohmann::json::array() && numbersOf(done) == std::vector<int>{1, 2, 3, 4, 5},
             "with every part registered the read answered %s: resume must be empty and stored list parts 1 to 5", r2.Text());
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = reader(ctx, {1, 2, 4});
  const auto foreign = c.Get("/v1/uploads/u-1", "X-Tenant-Id", "t2");
  ctx.Equal(foreign.Status, 404, "tenant t2 read t1's upload u-1 (%s): upload ids leak through logs and URLs, another tenant's upload is 404", foreign.Text());
  ctx.Equal(c.Get("/v1/uploads/u-9", "X-Tenant-Id", "t1").Status, 404, "an unknown upload id");
  ctx.Equal(c.Get("/v1/uploads/u-1").Status, 401, "a read without X-Tenant-Id");
}

void CheckConsistentRead(harness::Ctx& ctx) {
  auto c = reader(ctx, {1});
  ctx.Redis.After("upload:u-1:parts", [&ctx] { rival(ctx, 2); });
  ctx.Redis.After("upload:u-1:bytes", [&ctx] { rival(ctx, 3); });
  const auto r = c.Get("/v1/uploads/u-1", "X-Tenant-Id", "t1");
  const auto body = parsed(r);
  long long listed = 0;
  if (body.contains("stored") && body["stored"].is_array()) {
    for (const auto& p : body["stored"]) listed += p.value("size", 0LL);
  }
  ctx.Assert(body.value("uploaded_bytes", -1LL) == listed,
             "parts were registered while the read ran, and it answered uploaded_bytes %d beside stored parts %v that add up to %d: the bytes and the parts came from two reads (%s)",
             body.value("uploaded_bytes", -1LL), numbersOf(body), listed, r.Text());
}
`,
  },
  hints: [
    "After a dropped connection the client reads 60 % and sends the file again from part 1; a support engineer pastes an upload id from a log and reads another tenant's upload.",
    "The read reduces the manifest to a percentage, never compares the upload's tenant with `X-Tenant-Id`, and reads the counter in a second command, so a part registered between the two reads is counted but not listed.",
    'Read `X-Tenant-Id` (401 when absent) and answer 404 when `upload["tenant"] != tenant`; walk `1..part_count` over `read_parts`: registered parts go to `stored`, the rest to `resume`; `uploaded_bytes = sum(p["size"] for p in stored)`.',
  ],
  debrief: `A resumable upload is only as good as its status read: the client acts on the list, so the list has to be the exact set of part numbers the server does not hold, and anything it reports beside that list has to come from the same read. Summing the listed sizes costs nothing and removes the second command, so the answer describes one moment of the manifest. The 404 for another tenant's upload treats an upload id as a name rather than a credential, which is what it is once it has appeared in a log. Production services page the part list for uploads with thousands of parts, as ListParts does at 1,000, and return the upload's expiry so a client knows how long it may wait before resuming.`,
};
