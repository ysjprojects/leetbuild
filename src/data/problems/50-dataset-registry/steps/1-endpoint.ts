import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/datasets: versions nobody can edit',
  concept: 'http',
  file: 'api',
  focus: ['client', 'registry', 'db', 'storage'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the register endpoint: it
parses the body, writes a version record and answers \`201\`. It compiles, it serves the demo, and it
hides four production flaws. Review it like the registry owner, fix it, and prove the fix.

Implement \`POST /v1/datasets\` with body
\`{"dataset": "imdb-reviews", "version": "2026-01", "content_sha256": "…", "license": "mit", "owner": "team-lm", "size_bytes": 12}\`.

- The caller comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`dataset\`, \`version\`, \`content_sha256\` and \`owner\` are non-empty strings (**422** otherwise).
- \`license\` must be on the server-side allowlist (**422** otherwise): a dataset with no license is
  never registered, because unregistered data is data nobody may train on.
- A \`(dataset, version)\` pair is immutable. If the version already exists, answer **409** and never
  move the pointer. The handler's \`head\` check and the store's write are the same key.
- The stored \`size_bytes\` and \`row_count\` come from scanning the stored object once —
  \`measure_content(store, content_sha256)\` — never from the caller's \`size_bytes\`. The body's number
  is a budget hint at most; it is never the recorded truth.
- Answer **201** with the stored record.

**Failure mode the checks target.** A version name is a promise about bytes. The draft lets a second
register of the same \`(dataset, version)\` overwrite the pointer, so the content hash stops
identifying the content and every run recorded against that name becomes unreproducible. The
missing license check admits data nobody may legally train on, and reporting the caller's size lets
a client claim a 10 GiB dataset costs 1 KiB of budget.`,
  sequence: {
    participants: ['Client', 'Dataset Registry', 'registry store', 'object store'],
    messages: [
      {from: 'Client', to: 'Dataset Registry', label: 'POST /v1/datasets · X-Tenant-Id', kind: 'sync'},
      {from: 'Dataset Registry', to: 'Dataset Registry', label: 'validate hash · license · owner', kind: 'sync'},
      {from: 'Dataset Registry', to: 'registry store', label: 'head(dataset, version)', kind: 'sync'},
      {from: 'registry store', to: 'Dataset Registry', label: 'existing version / none', kind: 'reply'},
      {from: 'Dataset Registry', to: 'object store', label: 'measure_content(sha) → bytes · rows', kind: 'sync'},
      {from: 'Dataset Registry', to: 'registry store', label: 'put_version(record)', kind: 'sync'},
      {from: 'Dataset Registry', to: 'Client', label: '201 {dataset, version, size_bytes, row_count}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/datasets',
      detail: 'Register the registration route on `POST /v1/datasets`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/datasets["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/datasets['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/datasets"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"datasets"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/datasets"/]},
      },
    },
    {
      id: 'immutable',
      title: 'Re-registering an existing version is 409',
      detail:
        'The handler looks the version up by `(dataset, version)` and answers **409** instead of overwriting the pointer. The draft writes unconditionally, so a hash no longer identifies its bytes.',
      match: {
        python: {all: [/status_code\s*=\s*409/, /store\.head\(/]},
        typescript: {all: [/code\(\s*409\s*\)/, /store\.head\(/]},
        go: {all: [/StatusConflict/, /store\.Head\(/]},
        scala: {all: [/StatusCodes\.Conflict/, /store\.head\(/]},
        cpp: {all: [/\b409\b/, /store\.head\(/]},
      },
    },
    {
      id: 'license',
      title: 'License must be on the allowlist, else 422',
      detail:
        '`ALLOWED_LICENSES` is checked server-side and an unknown or missing license is **422**. The draft stores whatever license string the caller sent, including none.',
      match: {
        python: {all: [/ALLOWED_LICENSES/, /status_code\s*=\s*422/]},
        typescript: {all: [/ALLOWED_LICENSES/, /code\(\s*422\s*\)/]},
        go: {all: [/allowedLicenses/, /StatusUnprocessableEntity/]},
        scala: {all: [/AllowedLicenses/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/kAllowedLicenses/, /\b422\b/]},
      },
    },
    {
      id: 'measured-size',
      title: 'Size comes from a scan of the content',
      detail:
        '`measure_content(store, sha)` scans the stored object and returns the byte size and row count the record carries. The draft stores `body.size_bytes`, so a client can under-report a dataset to slip past a budget.',
      match: {
        python: {all: [/def measure_content\(/, /measure_content\(store/]},
        typescript: {all: [/function measureContent\(/, /measureContent\(store/]},
        go: {all: [/func measureContent\(/, /measureContent\(store/]},
        scala: {all: [/def measureContent\(/, /measureContent\(store/]},
        cpp: {all: [/measureContent\(store/]},
      },
    },
    {
      id: 'required-fields',
      title: 'Owner and hash are required before anything is written',
      detail:
        'A missing `owner` or `content_sha256` is **422** before the store is touched. The draft accepts both defaults and publishes a record with no accountable owner.',
      match: {
        python: {all: [/if not body\.owner/, /status_code\s*=\s*422/]},
        typescript: {all: [/!body\.owner/, /code\(\s*422\s*\)/]},
        go: {all: [/body\.Owner == ""/, /StatusUnprocessableEntity/]},
        scala: {all: [/body\.owner\.isEmpty/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/body\.value\(\s*"owner"/, /\b422\b/]},
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
logger = logging.getLogger("registry")


class RegisterRequest(BaseModel):
    dataset: str
    version: str
    content_sha256: str
    license: str = ""
    owner: str = ""
    size_bytes: int = 0


class RegistryStore:
    def put_version(self, dataset: str, version: str, record: dict) -> None:
        """Write the version record under (dataset, version)."""
        raise NotImplementedError


store = RegistryStore()


@app.post("/v1/datasets")
def register(body: RegisterRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft overwrites an existing version's pointer, accepts a dataset with no
    # license, stores the caller-supplied size, and never checks the owner. Review all four.
    record = {
        "dataset": body.dataset,
        "version": body.version,
        "content_sha256": body.content_sha256,
        "license": body.license,
        "owner": body.owner,
        "size_bytes": body.size_bytes,
    }
    store.put_version(body.dataset, body.version, record)
    logger.info("registered dataset=%s version=%s", body.dataset, body.version)
    return JSONResponse(record, status_code=201)
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("registry")

ALLOWED_LICENSES = {"apache-2.0", "cc-by-4.0", "cc-by-sa-4.0", "mit", "odc-by-1.0"}


class RegisterRequest(BaseModel):
    dataset: str
    version: str
    content_sha256: str
    license: str = ""
    owner: str = ""
    size_bytes: int = 0


class RegistryStore:
    def head(self, dataset: str, version: str) -> dict | None:
        """The stored version for (dataset, version), if the key already exists."""
        raise NotImplementedError

    def put_version(self, dataset: str, version: str, record: dict) -> None:
        """Write the record once; a second write for the same key must fail."""
        raise NotImplementedError


store = RegistryStore()


def measure_content(store, content_sha256: str) -> tuple[int, int]:
    """Scan the object once and return its byte size and row count — measured, not reported."""
    raise NotImplementedError


@app.post("/v1/datasets")
def register(
    body: RegisterRequest, tenant: str | None = Header(default=None, alias="X-Tenant-Id")
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if not body.dataset or not body.version:
        raise HTTPException(status_code=422, detail="dataset and version are required")
    if not body.content_sha256:
        raise HTTPException(status_code=422, detail="content_sha256 is required")
    if not body.owner:
        raise HTTPException(status_code=422, detail="owner is required")
    if body.license not in ALLOWED_LICENSES:
        raise HTTPException(status_code=422, detail="license is not on the allowlist")
    if store.head(body.dataset, body.version) is not None:
        raise HTTPException(status_code=409, detail="version is immutable")

    size_bytes, row_count = measure_content(store, body.content_sha256)
    record = {
        "dataset": body.dataset,
        "version": body.version,
        "content_sha256": body.content_sha256,
        "license": body.license,
        "owner": body.owner,
        "size_bytes": size_bytes,
        "row_count": row_count,
    }
    store.put_version(body.dataset, body.version, record)
    logger.info("registered dataset=%s version=%s rows=%d", body.dataset, body.version, row_count)
    return JSONResponse(record, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/datasets: a model-generated draft that trusts whatever the caller sends. */
import Fastify from 'fastify';

export const app = Fastify();

interface RegisterBody {
  dataset: string;
  version: string;
  content_sha256: string;
  license?: string;
  owner?: string;
  size_bytes?: number;
}

interface VersionRecord {
  dataset: string;
  version: string;
  content_sha256: string;
  license: string;
  owner: string;
  size_bytes: number;
}

class RegistryStore {
  async putVersion(dataset: string, version: string, record: VersionRecord): Promise<void> {
    void dataset;
    void version;
    void record;
    throw new Error('not implemented');
  }
}

const store = new RegistryStore();

app.post('/v1/datasets', async (request, reply) => {
  // TODO: this draft overwrites an existing version's pointer, accepts a dataset with no
  // license, stores the caller-supplied size, and never checks the owner. Review all four.
  const body = request.body as RegisterBody;
  const record: VersionRecord = {
    dataset: body.dataset,
    version: body.version,
    content_sha256: body.content_sha256,
    license: body.license ?? '',
    owner: body.owner ?? '',
    size_bytes: body.size_bytes ?? 0,
  };
  await store.putVersion(body.dataset, body.version, record);
  request.log.info({dataset: body.dataset, version: body.version}, 'registered');
  return reply.code(201).send(record);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/datasets: immutable versions measured from the content, not from the caller. */
import Fastify from 'fastify';

export const app = Fastify();

const ALLOWED_LICENSES: Record<string, true> = {
  'apache-2.0': true,
  'cc-by-4.0': true,
  'cc-by-sa-4.0': true,
  mit: true,
  'odc-by-1.0': true,
};

interface RegisterBody {
  dataset: string;
  version: string;
  content_sha256: string;
  license?: string;
  owner?: string;
  size_bytes?: number;
}

interface VersionRecord {
  dataset: string;
  version: string;
  content_sha256: string;
  license: string;
  owner: string;
  size_bytes: number;
  row_count: number;
}

class RegistryStore {
  async head(dataset: string, version: string): Promise<VersionRecord | null> {
    void dataset;
    void version;
    throw new Error('not implemented');
  }

  async putVersion(dataset: string, version: string, record: VersionRecord): Promise<void> {
    void dataset;
    void version;
    void record;
    throw new Error('not implemented');
  }
}

const store = new RegistryStore();

export async function measureContent(
  store: RegistryStore,
  contentSha256: string,
): Promise<{bytes: number; rows: number}> {
  void store;
  void contentSha256;
  throw new Error('not implemented');
}

app.post('/v1/datasets', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const body = request.body as Partial<RegisterBody> | null;
  if (body === null || typeof body !== 'object') return reply.code(422).send({error: 'invalid body'});
  if (!body.dataset || !body.version)
    return reply.code(422).send({error: 'dataset and version are required'});
  if (!body.content_sha256) return reply.code(422).send({error: 'content_sha256 is required'});
  if (!body.owner) return reply.code(422).send({error: 'owner is required'});
  const license = body.license ?? '';
  if (ALLOWED_LICENSES[license] !== true)
    return reply.code(422).send({error: 'license is not on the allowlist'});

  if ((await store.head(body.dataset, body.version)) !== null)
    return reply.code(409).send({error: 'version is immutable'});

  const measured = await measureContent(store, body.content_sha256);
  const record: VersionRecord = {
    dataset: body.dataset,
    version: body.version,
    content_sha256: body.content_sha256,
    license,
    owner: body.owner,
    size_bytes: measured.bytes,
    row_count: measured.rows,
  };
  await store.putVersion(body.dataset, body.version, record);
  request.log.info({dataset: record.dataset, version: record.version, rows: record.row_count}, 'registered');
  return reply.code(201).send(record);
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
)

type RegisterRequest struct {
	Dataset       string \`json:"dataset"\`
	Version       string \`json:"version"\`
	ContentSHA256 string \`json:"content_sha256"\`
	License       string \`json:"license"\`
	Owner         string \`json:"owner"\`
	SizeBytes     int64  \`json:"size_bytes"\`
}

type RegistryStore struct{}

func (s *RegistryStore) PutVersion(ctx context.Context, dataset, version string, record map[string]any) error {
	return nil
}

var store = &RegistryStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func register(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft overwrites an existing version's pointer, accepts a dataset with no
	// license, stores the caller-supplied size, and never checks the owner. Review all four.
	record := map[string]any{
		"dataset":        body.Dataset,
		"version":        body.Version,
		"content_sha256": body.ContentSHA256,
		"license":        body.License,
		"owner":          body.Owner,
		"size_bytes":     body.SizeBytes,
	}
	if err := store.PutVersion(r.Context(), body.Dataset, body.Version, record); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("registered tenant=%s dataset=%s version=%s", tenant, body.Dataset, body.Version)
	writeJSON(rw, http.StatusCreated, record)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/datasets", register)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

var allowedLicenses = map[string]bool{
	"apache-2.0":  true,
	"cc-by-4.0":   true,
	"cc-by-sa-4.0": true,
	"mit":         true,
	"odc-by-1.0":  true,
}

type RegisterRequest struct {
	Dataset       string \`json:"dataset"\`
	Version       string \`json:"version"\`
	ContentSHA256 string \`json:"content_sha256"\`
	License       string \`json:"license"\`
	Owner         string \`json:"owner"\`
	SizeBytes     int64  \`json:"size_bytes"\`
}

type RegistryStore struct{}

func (s *RegistryStore) Head(ctx context.Context, dataset, version string) (map[string]any, error) {
	return nil, nil
}

func (s *RegistryStore) PutVersion(ctx context.Context, dataset, version string, record map[string]any) error {
	return nil
}

var store = &RegistryStore{}

func measureContent(store *RegistryStore, contentSHA256 string) (int64, int64) {
	return 0, 0
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func register(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.Dataset == "" || body.Version == "" {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "dataset and version are required"})
		return
	}
	if body.ContentSHA256 == "" {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "content_sha256 is required"})
		return
	}
	if body.Owner == "" {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "owner is required"})
		return
	}
	if !allowedLicenses[body.License] {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "license is not on the allowlist"})
		return
	}
	existing, err := store.Head(r.Context(), body.Dataset, body.Version)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if existing != nil {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "version is immutable"})
		return
	}
	sizeBytes, rowCount := measureContent(store, body.ContentSHA256)
	record := map[string]any{
		"dataset":        body.Dataset,
		"version":        body.Version,
		"content_sha256": body.ContentSHA256,
		"license":        body.License,
		"owner":          body.Owner,
		"size_bytes":     sizeBytes,
		"row_count":      rowCount,
	}
	if err := store.PutVersion(r.Context(), body.Dataset, body.Version, record); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("registered tenant=%s dataset=%s version=%s rows=%d", tenant, body.Dataset, body.Version, rowCount)
	writeJSON(rw, http.StatusCreated, record)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/datasets", register)
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

final case class RegisterRequest(
    dataset: String,
    version: String,
    content_sha256: String,
    license: String,
    owner: String,
    size_bytes: Long
)
final case class VersionRecord(
    dataset: String,
    version: String,
    content_sha256: String,
    license: String,
    owner: String,
    size_bytes: Long,
    row_count: Long
)

trait RegistryStore {
  def putVersion(dataset: String, version: String, record: VersionRecord): Unit
}

object RegistryStore {
  def open(): RegistryStore = new RegistryStore {
    override def putVersion(dataset: String, version: String, record: VersionRecord): Unit = ()
  }
}

object DatasetApi {
  implicit val system: ActorSystem = ActorSystem("dataset-registry")
  implicit val registerFormat: RootJsonFormat[RegisterRequest] = jsonFormat6(RegisterRequest)
  implicit val recordFormat: RootJsonFormat[VersionRecord] = jsonFormat7(VersionRecord)

  val store = RegistryStore.open()

  val route: Route =
    path("v1" / "datasets") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[RegisterRequest]) { body =>
            // TODO: this draft overwrites an existing version's pointer, accepts a dataset with
            // no license, stores the caller-supplied size, and never checks the owner.
            val record = VersionRecord(
              body.dataset,
              body.version,
              body.content_sha256,
              body.license,
              body.owner,
              body.size_bytes,
              0L
            )
            store.putVersion(body.dataset, body.version, record)
            system.log.info(s"registered dataset=$tenant version=\${body.version}")
            complete(StatusCodes.Created, record)
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

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class RegisterRequest(
    dataset: String,
    version: String,
    content_sha256: String,
    license: String,
    owner: String,
    size_bytes: Long
)
final case class VersionRecord(
    dataset: String,
    version: String,
    content_sha256: String,
    license: String,
    owner: String,
    size_bytes: Long,
    row_count: Long
)

trait RegistryStore {
  def head(dataset: String, version: String): Option[VersionRecord]
  def putVersion(dataset: String, version: String, record: VersionRecord): Unit
}

object RegistryStore {
  def open(): RegistryStore = new RegistryStore {
    override def head(dataset: String, version: String): Option[VersionRecord] = None
    override def putVersion(dataset: String, version: String, record: VersionRecord): Unit = ()
  }
}

object DatasetApi {
  implicit val system: ActorSystem = ActorSystem("dataset-registry")
  implicit val registerFormat: RootJsonFormat[RegisterRequest] = jsonFormat6(RegisterRequest)
  implicit val recordFormat: RootJsonFormat[VersionRecord] = jsonFormat7(VersionRecord)

  val AllowedLicenses = Set("apache-2.0", "cc-by-4.0", "cc-by-sa-4.0", "mit", "odc-by-1.0")

  val store = RegistryStore.open()

  def measureContent(store: RegistryStore, contentSha256: String): (Long, Long) = (0L, 0L)

  val route: Route =
    path("v1" / "datasets") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[RegisterRequest]) { body =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else if (body.dataset.isEmpty || body.version.isEmpty) {
              complete(StatusCodes.UnprocessableEntity, """{"error":"dataset and version are required"}""")
            } else if (body.content_sha256.isEmpty) {
              complete(StatusCodes.UnprocessableEntity, """{"error":"content_sha256 is required"}""")
            } else if (body.owner.isEmpty) {
              complete(StatusCodes.UnprocessableEntity, """{"error":"owner is required"}""")
            } else if (!AllowedLicenses.contains(body.license)) {
              complete(StatusCodes.UnprocessableEntity, """{"error":"license is not on the allowlist"}""")
            } else if (store.head(body.dataset, body.version).isDefined) {
              complete(StatusCodes.Conflict, """{"error":"version is immutable"}""")
            } else {
              val (sizeBytes, rowCount) = measureContent(store, body.content_sha256)
              val record = VersionRecord(
                body.dataset,
                body.version,
                body.content_sha256,
                body.license,
                body.owner,
                sizeBytes,
                rowCount
              )
              store.putVersion(body.dataset, body.version, record)
              system.log.info(s"registered dataset=\${body.dataset} version=\${body.version} rows=$rowCount")
              complete(StatusCodes.Created, record)
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

using json = nlohmann::json;

struct RegistryStore {
  void putVersion(const std::string& dataset, const std::string& version, const json& record);
};

RegistryStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/datasets", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft overwrites an existing version's pointer, accepts a dataset with no
    // license, stores the caller-supplied size, and never checks the owner. Review all four.
    const auto dataset = body.value("dataset", std::string());
    const auto version = body.value("version", std::string());
    const auto license = body.value("license", std::string());
    const auto owner = body.value("owner", std::string());
    const json record = {
        {"dataset", dataset},
        {"version", version},
        {"content_sha256", body.value("content_sha256", std::string())},
        {"license", license},
        {"owner", owner},
        {"size_bytes", body.value("size_bytes", 0L)},
    };
    store.putVersion(dataset, version, record);
    std::cout << "registered tenant=" << tenant << " dataset=" << dataset << "\\n";
    res.status = 201;
    res.set_content(record.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <set>
#include <string>
#include <utility>

using json = nlohmann::json;

const std::set<std::string> kAllowedLicenses = {"apache-2.0", "cc-by-4.0", "cc-by-sa-4.0", "mit", "odc-by-1.0"};

struct RegistryStore {
  json head(const std::string& dataset, const std::string& version);  // empty json when absent
  void putVersion(const std::string& dataset, const std::string& version, const json& record);
};

RegistryStore store;

std::pair<long, long> measureContent(RegistryStore& store, const std::string& contentSha256);

int main() {
  httplib::Server svr;

  svr.Post("/v1/datasets", [](const httplib::Request& req, httplib::Response& res) {
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
    const auto dataset = body.value("dataset", std::string());
    const auto version = body.value("version", std::string());
    const auto contentSha256 = body.value("content_sha256", std::string());
    if (dataset.empty() || version.empty()) {
      res.status = 422;
      res.set_content(R"({"error":"dataset and version are required"})", "application/json");
      return;
    }
    if (contentSha256.empty()) {
      res.status = 422;
      res.set_content(R"({"error":"content_sha256 is required"})", "application/json");
      return;
    }
    const auto owner = body.value("owner", std::string());
    if (owner.empty()) {
      res.status = 422;
      res.set_content(R"({"error":"owner is required"})", "application/json");
      return;
    }
    const auto license = body.value("license", std::string());
    if (kAllowedLicenses.count(license) == 0) {
      res.status = 422;
      res.set_content(R"({"error":"license is not on the allowlist"})", "application/json");
      return;
    }
    if (!store.head(dataset, version).is_null()) {
      res.status = 409;
      res.set_content(R"({"error":"version is immutable"})", "application/json");
      return;
    }
    const auto measured = measureContent(store, contentSha256);
    const json record = {
        {"dataset", dataset},
        {"version", version},
        {"content_sha256", contentSha256},
        {"license", license},
        {"owner", owner},
        {"size_bytes", measured.first},
        {"row_count", measured.second},
    };
    store.putVersion(dataset, version, record);
    std::cout << "registered tenant=" << tenant << " dataset=" << dataset << "\\n";
    res.status = 201;
    res.set_content(record.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Order the guards by cost: tenant (401), required fields (422), license allowlist (422), immutability (409) — then, and only then, scan. A version that already exists is rejected before any object is read.',
    "Size is not an input. `measure_content(store, content_sha256)` scans the object once and returns bytes and rows; the caller's `size_bytes` is a budget hint at most and must never be the recorded truth.",
    'Immutability is a store contract, not a handler convention: `head(dataset, version)` must read the same key `put_version` writes, and the store must fail when that key appears twice. A handler-only check still races two concurrent registers.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary, where a version name is a promise about bytes. The draft reads fine because the demo registers each dataset once from one tenant. Four defects are checked: the missing required fields (no accountable owner, no hash identity), the license allowlist (legal exposure, not a style choice), immutability (409 on a re-register, keyed exactly like the write), and provenance measured by scanning the content instead of trusting a number the caller sent. Real registries add server-side hash verification of the uploaded object, per-license obligations recorded alongside the id, a size budget checked against the measured value, and an approval trail on the version record.`,
};
