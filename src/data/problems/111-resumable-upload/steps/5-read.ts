import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/uploads/{id}: resume without re-sending',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/uploads/{upload_id}\`, the read a client makes to
resume after a dropped connection. It loads the manifest by id and returns
\`{"percent_complete": ...}\` computed from the entry count over \`part_count\`. A dashboard can draw
a progress bar from that, so the demo passes. It hides four flaws.

**Failure mode the checks target.** A percentage is not resumable: the client knows it is 73% done
but not which 27% to send, so one failed part costs a full multi-gigabyte re-upload. A read that
trusts the id without checking the tenant is an enumeration bug, since upload ids leak in logs and
referrers. And a part whose bytes were corrupted in the store, but whose manifest entry still says
stored, is reported as fine until finalize discovers it.

- The response names the **stored** parts (number, size, checksum), the **missing** part numbers and
  the **corrupt** parts (number and the checksum that did not match), plus a \`resume\` list that is
  exactly the numbers to re-send.
- A part whose stored checksum does not match the expected checksum is **corrupt** and belongs in
  \`resume\`, not in \`stored\`.
- The upload belongs to the tenant that created it. A read from a **foreign tenant**, or for an id
  that does not exist, is **404**.
- \`part_count\` is included so the client can compute the gaps itself.`,
  sequence: {
    participants: ['Uploader', 'Upload API', 'Part manifest'],
    messages: [
      {from: 'Uploader', to: 'Upload API', label: 'GET /v1/uploads/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Upload API', to: 'Part manifest', label: 'load upload · manifest', kind: 'sync'},
      {from: 'Part manifest', to: 'Upload API', label: 'parts with size and checksum', kind: 'reply'},
      {from: 'Upload API', to: 'Upload API', label: 'partition stored · missing · corrupt', kind: 'sync'},
      {from: 'Upload API', to: 'Uploader', label: '200 {stored, missing, corrupt, resume} | 404', kind: 'reply'},
    ],
  },
  hints: [
    "After a dropped connection the mobile app reads the status, sees `73`, and re-sends the file from part 1. Separately, a support engineer pastes an upload id from a log and gets another tenant's manifest.",
    'The handler divides the manifest length by `part_count` and returns that number; it does not read `X-Tenant-Id` at all, and it compares no checksum, so a corrupted part counts as present.',
    "In `get_upload`: return 404 when the upload's tenant differs from the header; walk `1..part_count` into `stored`, `missing` and `corrupt` (checksum mismatch), and return `resume = missing + corrupt`.",
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/uploads/{upload_id}',
      detail: 'Register the status route on `GET /v1/uploads/{upload_id}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/uploads\/\{upload_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/uploads\/:uploadId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/uploads\/\{uploadId\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"uploads"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/uploads\/:uploadId"/]},
      },
    },
    {
      id: 'missing-parts',
      title: 'Names the individual missing parts',
      detail:
        'The response lists the missing part numbers so the client resumes from exact gaps instead of restarting. The starter returns only a percentage complete.',
      match: {
        python: {all: [/missing/, /part_number|part_count/]},
        typescript: {all: [/missing/, /part_number|part_count/]},
        go: {all: [/missing/, /partNumber|PartCount/]},
        scala: {all: [/missing/, /part_number|partCount/]},
        cpp: {all: [/missing/, /part_number|part_count/]},
      },
    },
    {
      id: 'corrupt-parts',
      title: 'Flags corrupt parts for re-send',
      detail:
        'A part whose checksum does not match the expected checksum is reported as corrupt and appears in the resume list. The starter never verifies anything.',
      match: {
        python: {all: [/corrupt/, /part_number|resume/]},
        typescript: {all: [/corrupt/, /part_number|resume/]},
        go: {all: [/corrupt/, /partNumber|resume/]},
        scala: {all: [/corrupt/, /part_number|resume/]},
        cpp: {all: [/corrupt/, /part_number|resume/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'A foreign upload id is 404',
      detail:
        'The read checks the upload’s tenant against `X-Tenant-Id` and answers **404** for a foreign or unknown id. The starter lets any caller read any upload.',
      match: {
        python: {all: [/tenant/, /status_code\s*=\s*404/]},
        typescript: {all: [/tenant/, /code\(\s*404\s*\)/]},
        go: {all: [/Tenant/, /StatusNotFound/]},
        scala: {all: [/tenant/, /StatusCodes\.NotFound/]},
        cpp: {all: [/tenant/, /\b404\b/]},
      },
    },
    {
      id: 'checksums',
      title: 'Returns checksums beside each stored part',
      detail:
        'Every stored part is returned with its number, size and checksum, so the client can verify what the server has. The starter returns neither the parts nor their checksums.',
      match: {
        python: {all: [/checksum/, /stored/]},
        typescript: {all: [/checksum/, /stored/]},
        go: {all: [/Checksum/, /stored/]},
        scala: {all: [/checksum/, /stored/]},
        cpp: {all: [/checksum/, /stored/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()


@app.get("/v1/uploads/{upload_id}")
def get_upload(upload_id: str) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    manifest = load_manifest(upload_id)
    percent = 100 * len(manifest) // manifest["part_count"]
    return JSONResponse({"upload_id": upload_id, "percent_complete": percent}, status_code=200)
`,
      solution: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()


@app.get("/v1/uploads/{upload_id}")
def get_upload(
    upload_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    """Return stored, missing and corrupt parts so the client resumes from the exact gaps."""
    upload = load_upload(upload_id)
    if upload is None or upload["tenant"] != tenant:
        return JSONResponse({"error": "unknown upload"}, status_code=404)

    part_count = upload["part_count"]
    manifest = load_manifest(upload_id)
    stored = []
    missing = []
    corrupt = []
    for number in range(1, part_count + 1):
        part = manifest.get(number)
        if part is None:
            missing.append(number)
            continue
        if part["checksum"] != expected_checksum(upload_id, number):
            corrupt.append({"part_number": number, "checksum": part["checksum"]})
            continue
        stored.append(
            {"part_number": number, "size": part["size"], "checksum": part["checksum"]}
        )

    return JSONResponse(
        {
            "upload_id": upload_id,
            "part_count": part_count,
            "stored": stored,
            "missing": missing,
            "corrupt": corrupt,
            "resume": missing + [part["part_number"] for part in corrupt],
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/uploads/{id}. */
import Fastify from 'fastify';

export const app = Fastify();

app.get('/v1/uploads/:uploadId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const uploadId = (request.params as {uploadId: string}).uploadId;
  const manifest = await loadManifest(uploadId);
  const percent = Math.floor((Object.keys(manifest).length / manifest.part_count) * 100);
  return reply.code(200).send({upload_id: uploadId, percent_complete: percent});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/uploads/{id}: stored, missing and corrupt parts so the client resumes exactly. */
import Fastify from 'fastify';

export const app = Fastify();

interface PartRecord {
  size: number;
  checksum: string;
}

interface UploadRecord {
  upload_id: string;
  tenant: string;
  part_count: number;
}

interface PartStatus {
  part_number: number;
  size: number;
  checksum: string;
}

app.get('/v1/uploads/:uploadId', async (request, reply) => {
  const uploadId = (request.params as {uploadId: string}).uploadId;
  const tenant = request.headers['x-tenant-id'];
  const upload = await loadUpload(uploadId);
  if (upload === null || upload.tenant !== tenant)
    return reply.code(404).send({error: 'unknown upload'});

  const manifest = await loadManifest(uploadId);
  const stored: PartStatus[] = [];
  const missing: number[] = [];
  const corrupt: PartStatus[] = [];
  for (let number = 1; number <= upload.part_count; number += 1) {
    const part: PartRecord | undefined = manifest[number];
    if (part === undefined) {
      missing.push(number);
      continue;
    }
    const expected = await expectedChecksum(uploadId, number);
    if (part.checksum !== expected) {
      corrupt.push({part_number: number, size: part.size, checksum: part.checksum});
      continue;
    }
    stored.push({part_number: number, size: part.size, checksum: part.checksum});
  }

  return reply.code(200).send({
    upload_id: uploadId,
    part_count: upload.part_count,
    stored,
    missing,
    corrupt,
    resume: [...missing, ...corrupt.map(part => part.part_number)],
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package api

import (
	"encoding/json"
	"net/http"
)

func getUpload(w http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	uploadID := r.PathValue("uploadId")
	manifest, _ := loadManifest(r.Context(), uploadID)
	percent := 100 * len(manifest) / partCountOf(manifest)
	writeJSON(w, http.StatusOK, map[string]any{
		"upload_id":        uploadID,
		"percent_complete": percent,
	})
}

func RegisterRead(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/uploads/{uploadId}", getUpload)
}
`,
      solution: `package api

import (
	"encoding/json"
	"net/http"
)

func getUpload(w http.ResponseWriter, r *http.Request) {
	uploadID := r.PathValue("uploadId")
	tenant := r.Header.Get("X-Tenant-Id")
	upload, err := loadUpload(r.Context(), uploadID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	if upload == nil || upload.Tenant != tenant {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown upload"})
		return
	}

	manifest, err := loadManifest(r.Context(), uploadID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	stored := make([]map[string]any, 0, upload.PartCount)
	missing := make([]int64, 0)
	corrupt := make([]map[string]any, 0)
	resume := make([]int64, 0)
	for number := int64(1); number <= upload.PartCount; number++ {
		part, ok := manifest[number]
		if !ok {
			missing = append(missing, number)
			resume = append(resume, number)
			continue
		}
		expected, _ := expectedChecksum(r.Context(), uploadID, number)
		if part.Checksum != expected {
			corrupt = append(corrupt, map[string]any{"part_number": number, "checksum": part.Checksum})
			resume = append(resume, number)
			continue
		}
		stored = append(stored, map[string]any{
			"part_number": number,
			"size":        part.Size,
			"checksum":    part.Checksum,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"upload_id":  uploadID,
		"part_count": upload.PartCount,
		"stored":     stored,
		"missing":    missing,
		"corrupt":    corrupt,
		"resume":     resume,
	})
}

func RegisterRead(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/uploads/{uploadId}", getUpload)
}
`,
    },
    scala: {
      starter: `package upload

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object UploadReadApi {
  implicit val system: ActorSystem = ActorSystem("upload-read")

  val route: Route =
    path("v1" / "uploads" / Segment) { uploadId =>
      get {
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        onSuccess(loadManifest(uploadId)) { manifest =>
          val percent = 100 * manifest.size / partCountOf(manifest)
          complete(StatusCodes.OK, s"""{"upload_id":"$uploadId","percent_complete":$percent}""")
        }
      }
    }
}
`,
      solution: `package upload

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class PartStatus(part_number: Long, size: Long, checksum: String)
final case class UploadStatus(
    upload_id: String,
    part_count: Long,
    stored: Seq[PartStatus],
    missing: Seq[Long],
    corrupt: Seq[PartStatus],
    resume: Seq[Long],
)

object UploadReadApi {
  implicit val system: ActorSystem = ActorSystem("upload-read")
  implicit val partFormat: RootJsonFormat[PartStatus] = jsonFormat3(PartStatus)
  implicit val statusFormat: RootJsonFormat[UploadStatus] = jsonFormat6(UploadStatus)

  val route: Route =
    path("v1" / "uploads" / Segment) { uploadId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          val tenant = tenantOpt.getOrElse("")
          onSuccess(loadUpload(uploadId)) { upload =>
            if (upload.isEmpty || upload.get.tenant != tenant) {
              complete(StatusCodes.NotFound, """{"error":"unknown upload"}""")
            } else {
              onSuccess(loadManifest(uploadId)) { manifest =>
                val partCount = upload.get.part_count
                val stored = (1L to partCount).flatMap { number =>
                  manifest.get(number).map(part => PartStatus(number, part.size, part.checksum))
                }
                val missing = (1L to partCount).filterNot(manifest.contains)
                val corrupt = (1L to partCount).flatMap { number =>
                  manifest
                    .get(number)
                    .filter(part => part.checksum != expectedChecksum(uploadId, number))
                    .map(part => PartStatus(number, part.size, part.checksum))
                }
                complete(
                  StatusCodes.OK,
                  UploadStatus(
                    uploadId,
                    partCount,
                    stored,
                    missing,
                    corrupt,
                    missing ++ corrupt.map(_.part_number),
                  ),
                )
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
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

void GetUpload(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto uploadId = req.path_params.at("uploadId");
  const auto manifest = LoadManifest(uploadId);
  const auto percent = 100 * static_cast<long long>(manifest.size()) / PartCountOf(uploadId);
  res.status = 200;
  res.set_content(
      json{{"upload_id", uploadId}, {"percent_complete", percent}}.dump(), "application/json");
}

int main() {
  httplib::Server svr;
  svr.Get("/v1/uploads/:uploadId", GetUpload);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

void GetUpload(const httplib::Request& req, httplib::Response& res) {
  const auto uploadId = req.path_params.at("uploadId");
  const auto tenant = req.get_header_value("X-Tenant-Id");
  const auto upload = LoadUpload(uploadId);
  if (!upload.has_value() || upload->tenant != tenant) {
    res.status = 404;
    res.set_content(json{{"error", "unknown upload"}}.dump(), "application/json");
    return;
  }

  const auto manifest = LoadManifest(uploadId);
  json stored = json::array();
  json missing = json::array();
  json corrupt = json::array();
  json resume = json::array();
  for (long long number = 1; number <= upload->part_count; ++number) {
    const auto it = manifest.find(number);
    if (it == manifest.end()) {
      missing.push_back(number);
      resume.push_back(number);
      continue;
    }
    if (it->second.checksum != ExpectedChecksum(uploadId, number)) {
      corrupt.push_back(json{{"part_number", number}, {"size", it->second.size}, {"checksum", it->second.checksum}});
      resume.push_back(number);
      continue;
    }
    stored.push_back(json{{"part_number", number}, {"size", it->second.size}, {"checksum", it->second.checksum}});
  }

  res.status = 200;
  res.set_content(
      json{{"upload_id", uploadId},
           {"part_count", upload->part_count},
           {"stored", stored},
           {"missing", missing},
           {"corrupt", corrupt},
           {"resume", resume}}
          .dump(),
      "application/json");
}

int main() {
  httplib::Server svr;
  svr.Get("/v1/uploads/:uploadId", GetUpload);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The fix returns a work list instead of a number because the property it protects is that one read tells the client exactly which parts to send next. Partitioning the manifest into stored, missing and corrupt makes corruption its own state, so a part whose bytes were altered in the store is re-sent rather than reported as present. The tenant guard answers 404 for a foreign id so it stays indistinguishable from a missing one; upload ids travel in logs and referrers, and a read that trusts the id alone is an enumeration bug. Production services go further than this step: a signed read URL, a short-lived per-part upload URL for each gap, and the object store's ETag per part so the client can verify what it already sent.`,
};
