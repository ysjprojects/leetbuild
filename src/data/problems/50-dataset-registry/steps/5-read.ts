import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/datasets/{id}/versions/{v}: provenance, not just bytes',
  concept: 'http',
  file: 'read',
  focus: ['client', 'registry', 'db', 'storage'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/datasets/{dataset}/versions/{version}\`: it reads
the tenant header, calls \`store.head\`, answers \`404\` when there is no record, builds provenance
from \`source\`, \`license\` and \`row_count\`, attaches the validator record only when it passed, and
returns a \`raw_url\` built from \`PERMANENT_BASE\`. It compiles, it serves the demo, and it hides
four flaws that only matter once there are two tenants or one failed validation.

**Failure mode the checks target.** The URL is the one clients paste into tickets: without an
expiry it is a permanent public link to training data. Omitting a negative validator report is
subtler: the field that says "this version failed schema conformance" is exactly the field a
reviewer needs, and its absence reads as "nothing to report".

- The caller comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- A version **belongs to a tenant**. A version another tenant owns is **404**, not 403: the
  endpoint must not confirm that a foreign version exists.
- The response carries the version's **provenance**: \`source\`, \`license\`, \`row_count\` and the
  **full \`validator_report\`**, present whether validation passed or failed.
- The object is reachable only through a **short-lived signed URL** (\`SIGNED_URL_TTL_S\`, 300 s)
  scoped to the caller's tenant, returned with its \`expires_at\`. No permanent \`raw_url\` appears
  in the response.`,
  sequence: {
    participants: ['Client', 'Dataset Registry', 'registry store', 'object store'],
    messages: [
      {from: 'Client', to: 'Dataset Registry', label: 'GET /v1/datasets/{id}/versions/{v} · X-Tenant-Id', kind: 'sync'},
      {from: 'Dataset Registry', to: 'registry store', label: 'head(dataset, version)', kind: 'sync'},
      {from: 'registry store', to: 'Dataset Registry', label: 'record incl. tenant · license · report', kind: 'reply'},
      {from: 'Dataset Registry', to: 'Dataset Registry', label: 'foreign tenant → 404', kind: 'sync'},
      {from: 'Dataset Registry', to: 'Dataset Registry', label: 'signed_url(ttl = 300 s)', kind: 'sync'},
      {from: 'Dataset Registry', to: 'Client', label: '200 {provenance, signed_url, expires_at}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers GET /v1/datasets/{dataset}/versions/{version}',
      detail: 'Expose the version read on `GET /v1/datasets/{dataset}/versions/{version}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/datasets\/\{dataset\}\/versions\/\{version\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/datasets\/:dataset\/versions\/:version['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/datasets\/\{dataset\}\/versions\/\{version\}"/]},
        scala: {
          all: [/path\(\s*"v1"\s*\/\s*"datasets"\s*\/\s*Segment\s*\/\s*"versions"\s*\/\s*Segment\s*\)/, /\bget\s*\{/],
        },
        cpp: {all: [/svr\.Get\(/, /\/versions\//]},
      },
    },
    {
      id: 'tenant-scoped',
      title: 'A version owned by another tenant is 404',
      detail:
        'The record carries its tenant and the handler compares it to the authenticated caller, answering **404** for a foreign version. The starter answers any tenant that asks.',
      match: {
        python: {all: [/status_code\s*=\s*404/, /record\["tenant"\]\s*!=\s*tenant/]},
        typescript: {all: [/code\(\s*404\s*\)/, /record\.tenant\s*!==\s*tenant/]},
        go: {all: [/StatusNotFound/, /record\.Tenant\s*!=\s*tenant/]},
        scala: {all: [/StatusCodes\.NotFound/, /\.tenant\s*!=\s*tenant/]},
        cpp: {all: [/\b404\b/, /record\.tenant\s*!=\s*tenant/]},
      },
    },
    {
      id: 'signed-url',
      title: 'Signed URLs expire',
      detail:
        'The URL is signed over the tenant, the version and an expiry (`SIGNED_URL_TTL_S` = 300, `signed_url`/`signedUrl`/`signedURL`, an `expires_at`), so it cannot be replayed later or by another tenant. The starter hands out a permanent raw URL.',
      match: {
        python: {all: [/SIGNED_URL_TTL_S\s*=\s*300/, /def signed_url\(/, /expires_at/]},
        typescript: {all: [/SIGNED_URL_TTL_S\s*=\s*300/, /function signedUrl\(/, /expiresAt/]},
        go: {all: [/signedURLTTL\s*=\s*300/, /func signedURL\(/, /expiresAt/]},
        scala: {all: [/SignedUrlTtlSeconds\s*=\s*300/, /def signedUrl\(/, /expiresAt/]},
        cpp: {all: [/kSignedUrlTtlSeconds\s*=\s*300/, /signed_url\(/, /expires_at/]},
      },
    },
    {
      id: 'validator-report',
      title: 'The validator report is always present',
      detail:
        'The provenance carries `validator_report` and `row_count` unconditionally, including when validation failed. The starter attaches the report only on a pass, so a failed version looks like a clean one.',
      match: {
        python: {all: [/validator_report/, /row_count/]},
        typescript: {all: [/validator_report/, /row_count/]},
        go: {all: [/ValidatorReport/, /RowCount/]},
        scala: {all: [/validatorReport/, /rowCount/]},
        cpp: {all: [/validator_report/, /row_count/]},
      },
    },
    {
      id: 'no-raw-url',
      title: 'No permanent URL to the raw object',
      detail:
        'The response exposes the signed URL and never a permanent raw object URL (`raw_url` / `rawUrl` / `RawURL`). The starter returns `raw_url` alongside the provenance.',
      match: {
        python: {all: [/signed_url\(/], none: [/raw_url/]},
        typescript: {all: [/signedUrl\(/], none: [/rawUrl/]},
        go: {all: [/signedURL\(/], none: [/RawURL/]},
        scala: {all: [/signedUrl\(/], none: [/rawUrl/]},
        cpp: {all: [/signed_url\(/], none: [/raw_url/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("registry-read")

PERMANENT_BASE = "https://objects.example.com"


class RegistryStore:
    def head(self, dataset: str, version: str) -> dict | None:
        """The stored record for (dataset, version), if any."""
        raise NotImplementedError


store = RegistryStore()


def permanent_url(dataset: str, version: str) -> str:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    return f"{PERMANENT_BASE}/{dataset}/{version}"


@app.get("/v1/datasets/{dataset}/versions/{version}")
def read_version(
    dataset: str, version: str, tenant: str = Header(alias="X-Tenant-Id")
) -> JSONResponse:
    record = store.head(dataset, version)
    if record is None:
        raise HTTPException(status_code=404, detail="unknown version")
    provenance = {
        "source": record["source"],
        "license": record["license"],
        "row_count": record["row_count"],
    }
    if record["validator"]["passed"]:
        provenance["validator"] = record["validator"]
    logger.info("read dataset=%s version=%s", dataset, version)
    return JSONResponse(
        {
            "dataset": dataset,
            "version": version,
            "provenance": provenance,
            "raw_url": permanent_url(dataset, version),
        },
        status_code=200,
    )
`,
      solution: `import hashlib
import hmac
import logging
import time

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("registry-read")

SIGNED_URL_TTL_S = 300
SIGNING_KEY = b"registry-signing-key"
OBJECT_BASE = "https://objects.example.com"


class RegistryStore:
    def head(self, dataset: str, version: str) -> dict | None:
        """The stored record, including its tenant, license, rows and validator report."""
        raise NotImplementedError


store = RegistryStore()


def signed_url(dataset: str, version: str, tenant: str) -> tuple[str, int]:
    """A short-lived URL scoped to this caller: it expires, and another tenant cannot replay it."""
    expires_at = int(time.time()) + SIGNED_URL_TTL_S
    scope = f"{tenant}/{dataset}/{version}/{expires_at}"
    signature = hmac.new(SIGNING_KEY, scope.encode("utf-8"), hashlib.sha256).hexdigest()
    url = f"{OBJECT_BASE}/{dataset}/{version}?tenant={tenant}&expires={expires_at}&sig={signature}"
    return url, expires_at


@app.get("/v1/datasets/{dataset}/versions/{version}")
def read_version(
    dataset: str, version: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    record = store.head(dataset, version)
    if record is None or record["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="unknown version")
    url, expires_at = signed_url(dataset, version, tenant)
    logger.info("read tenant=%s dataset=%s version=%s", tenant, dataset, version)
    return JSONResponse(
        {
            "dataset": dataset,
            "version": version,
            "provenance": {
                "source": record["source"],
                "license": record["license"],
                "row_count": record["row_count"],
                "validator_report": record["validator_report"],
            },
            "signed_url": url,
            "expires_at": expires_at,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/datasets/{dataset}/versions/{version}. */
import Fastify from 'fastify';

export const app = Fastify();

const PERMANENT_BASE = 'https://objects.example.com';

interface VersionRecord {
  tenant: string;
  source: string;
  license: string;
  row_count: number;
  validator: {passed: boolean; checks: string[]};
}

class RegistryStore {
  async head(dataset: string, version: string): Promise<VersionRecord | null> {
    void dataset;
    void version;
    throw new Error('not implemented');
  }
}

const store = new RegistryStore();

function permanentUrl(dataset: string, version: string): string {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  return \`\${PERMANENT_BASE}/\${dataset}/\${version}\`;
}

app.get('/v1/datasets/:dataset/versions/:version', async (request, reply) => {
  const params = request.params as {dataset: string; version: string};
  const record = await store.head(params.dataset, params.version);
  if (record === null) return reply.code(404).send({error: 'unknown version'});
  const provenance: Record<string, unknown> = {
    source: record.source,
    license: record.license,
    row_count: record.row_count,
  };
  if (record.validator.passed) provenance.validator = record.validator;
  request.log.info({dataset: params.dataset, version: params.version}, 'read');
  return reply.code(200).send({
    dataset: params.dataset,
    version: params.version,
    provenance,
    raw_url: permanentUrl(params.dataset, params.version),
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/datasets/{dataset}/versions/{version}: provenance, never just bytes. */
import {createHmac} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const SIGNED_URL_TTL_S = 300;
const SIGNING_KEY = 'registry-signing-key';
const OBJECT_BASE = 'https://objects.example.com';

interface VersionRecord {
  tenant: string;
  source: string;
  license: string;
  row_count: number;
  validator_report: {passed: boolean; checks: string[]};
}

class RegistryStore {
  async head(dataset: string, version: string): Promise<VersionRecord | null> {
    void dataset;
    void version;
    throw new Error('not implemented');
  }
}

const store = new RegistryStore();

function signedUrl(dataset: string, version: string, tenant: string): {url: string; expiresAt: number} {
  const expiresAt = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_S;
  const scope = \`\${tenant}/\${dataset}/\${version}/\${expiresAt}\`;
  const signature = createHmac('sha256', SIGNING_KEY).update(scope).digest('hex');
  const url = \`\${OBJECT_BASE}/\${dataset}/\${version}?tenant=\${tenant}&expires=\${expiresAt}&sig=\${signature}\`;
  return {url, expiresAt};
}

app.get('/v1/datasets/:dataset/versions/:version', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const params = request.params as {dataset: string; version: string};
  const record = await store.head(params.dataset, params.version);
  if (record === null || record.tenant !== tenant)
    return reply.code(404).send({error: 'unknown version'});
  const signed = signedUrl(params.dataset, params.version, tenant);
  request.log.info({tenant, dataset: params.dataset, version: params.version}, 'read');
  return reply.code(200).send({
    dataset: params.dataset,
    version: params.version,
    provenance: {
      source: record.source,
      license: record.license,
      row_count: record.row_count,
      validator_report: record.validator_report,
    },
    signed_url: signed.url,
    expires_at: signed.expiresAt,
  });
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

const objectBase = "https://objects.example.com"

type VersionRecord struct {
	Tenant    string
	Source    string
	License   string
	RowCount  int64
	Validator map[string]any
}

type RegistryStore struct{}

func (s *RegistryStore) Head(ctx context.Context, dataset, version string) (*VersionRecord, error) {
	return nil, nil
}

var store = &RegistryStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/datasets/{dataset}/versions/{version}", func(rw http.ResponseWriter, r *http.Request) {
		// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
		dataset := r.PathValue("dataset")
		version := r.PathValue("version")
		record, err := store.Head(r.Context(), dataset, version)
		if err != nil || record == nil {
			writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown version"})
			return
		}
		out := map[string]any{
			"dataset": dataset,
			"version": version,
			"provenance": map[string]any{
				"source":    record.Source,
				"license":   record.License,
				"row_count": record.RowCount,
			},
			"RawURL": objectBase + "/" + dataset + "/" + version,
		}
		if passed, _ := record.Validator["passed"].(bool); passed {
			provenance := out["provenance"].(map[string]any)
			provenance["validator"] = record.Validator
		}
		writeJSON(rw, http.StatusOK, out)
	})
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"
)

const (
	signedURLTTL = 300 * time.Second
	objectBase   = "https://objects.example.com"
)

var signingKey = []byte("registry-signing-key")

type VersionRecord struct {
	Tenant          string
	Source          string
	License         string
	RowCount        int64
	ValidatorReport map[string]any
}

type RegistryStore struct{}

func (s *RegistryStore) Head(ctx context.Context, dataset, version string) (*VersionRecord, error) {
	return nil, nil
}

var store = &RegistryStore{}

func signedURL(dataset, version, tenant string) (string, int64) {
	expiresAt := time.Now().Add(signedURLTTL).Unix()
	scope := tenant + "/" + dataset + "/" + version + "/" + strconv.FormatInt(expiresAt, 10)
	mac := hmac.New(sha256.New, signingKey)
	mac.Write([]byte(scope))
	signature := hex.EncodeToString(mac.Sum(nil))
	expires := strconv.FormatInt(expiresAt, 10)
	url := objectBase + "/" + dataset + "/" + version + "?tenant=" + tenant + "&expires=" + expires + "&sig=" + signature
	return url, expiresAt
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/datasets/{dataset}/versions/{version}", func(rw http.ResponseWriter, r *http.Request) {
		tenant := r.Header.Get("X-Tenant-Id")
		if tenant == "" {
			writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
			return
		}
		dataset := r.PathValue("dataset")
		version := r.PathValue("version")
		record, err := store.Head(r.Context(), dataset, version)
		if err != nil || record == nil || record.Tenant != tenant {
			writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown version"})
			return
		}
		url, expiresAt := signedURL(dataset, version, tenant)
		log.Printf("read tenant=%s dataset=%s version=%s", tenant, dataset, version)
		writeJSON(rw, http.StatusOK, map[string]any{
			"dataset": dataset,
			"version": version,
			"provenance": map[string]any{
				"source":           record.Source,
				"license":          record.License,
				"row_count":        record.RowCount,
				"validator_report": record.ValidatorReport,
			},
			"signed_url": url,
			"expires_at": expiresAt,
		})
	})
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

final case class VersionRecord(
    tenant: String,
    source: String,
    license: String,
    rowCount: Long,
    validator: Map[String, String]
)

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("dataset-registry")

  val ObjectBase = "https://objects.example.com"

  def permanentUrl(dataset: String, version: String): String = s"$ObjectBase/$dataset/$version"

  val store: RegistryStore = RegistryStore.open()

  val route: Route =
    path("v1" / "datasets" / Segment / "versions" / Segment) { (dataset, version) =>
      get {
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        val stored = store.head(dataset, version)
        if (stored.isEmpty) {
          complete(StatusCodes.NotFound, """{"error":"unknown version"}""")
        } else {
          val record = stored.get
          system.log.info(s"read dataset=$dataset version=$version")
          complete(
            StatusCodes.OK,
            s"""{"dataset":"$dataset","version":"$version","raw_url":"\${permanentUrl(dataset, version)}","provenance":{"source":"\${record.source}","license":"\${record.license}","row_count":\${record.rowCount}}}"""
          )
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

final case class VersionRecord(
    tenant: String,
    source: String,
    license: String,
    rowCount: Long,
    validatorReport: Map[String, String]
)

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("dataset-registry")

  val SignedUrlTtlSeconds = 300
  val SigningKey = "registry-signing-key"
  val ObjectBase = "https://objects.example.com"

  val store: RegistryStore = RegistryStore.open()

  def sign(scope: String): String = {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(new SecretKeySpec(SigningKey.getBytes("UTF-8"), "HmacSHA256"))
    mac.doFinal(scope.getBytes("UTF-8")).map("%02x".format(_)).mkString
  }

  def signedUrl(dataset: String, version: String, tenant: String): (String, Long) = {
    val expiresAt = System.currentTimeMillis() / 1000 + SignedUrlTtlSeconds
    val scope = s"$tenant/$dataset/$version/$expiresAt"
    val url = s"$ObjectBase/$dataset/$version?tenant=$tenant&expires=$expiresAt&sig=\${sign(scope)}"
    (url, expiresAt)
  }

  val route: Route =
    path("v1" / "datasets" / Segment / "versions" / Segment) { (dataset, version) =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          val tenant = tenantOpt.getOrElse("")
          if (tenant.isEmpty) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            val stored = store.head(dataset, version)
            if (stored.isEmpty || stored.get.tenant != tenant) {
              complete(StatusCodes.NotFound, """{"error":"unknown version"}""")
            } else {
              val record = stored.get
              val (url, expiresAt) = signedUrl(dataset, version, tenant)
              system.log.info(s"read tenant=$tenant dataset=$dataset version=$version")
              complete(
                StatusCodes.OK,
                s"""{"dataset":"$dataset","version":"$version","signed_url":"$url","expires_at":$expiresAt,"provenance":{"source":"\${record.source}","license":"\${record.license}","row_count":\${record.rowCount},"validator_report":\${record.validatorReport}}}"""
              )
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

const std::string kObjectBase = "https://objects.example.com";

struct VersionRecord {
  std::string tenant;
  std::string source;
  std::string license;
  long row_count = 0;
  json validator;
};

struct RegistryStore {
  VersionRecord head(const std::string& dataset, const std::string& version);
};

RegistryStore store;

static std::string permanent_url(const std::string& dataset, const std::string& version) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  return kObjectBase + "/" + dataset + "/" + version;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/datasets/([^/]+)/versions/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string dataset = req.matches[1];
    const std::string version = req.matches[2];
    const auto record = store.head(dataset, version);
    if (record.source.empty()) {
      res.status = 404;
      res.set_content(R"({"error":"unknown version"})", "application/json");
      return;
    }
    json provenance = {
        {"source", record.source},
        {"license", record.license},
        {"row_count", record.row_count},
    };
    if (record.validator.value("passed", false)) provenance["validator"] = record.validator;
    res.status = 200;
    res.set_content(
        json{{"dataset", dataset},
             {"version", version},
             {"provenance", provenance},
             {"raw_url", permanent_url(dataset, version)}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <openssl/hmac.h>

#include <cstdio>
#include <ctime>
#include <iostream>
#include <string>
#include <utility>

using json = nlohmann::json;

constexpr long kSignedUrlTtlSeconds = 300;
const std::string kSigningKey = "registry-signing-key";
const std::string kObjectBase = "https://objects.example.com";

struct VersionRecord {
  std::string tenant;
  std::string source;
  std::string license;
  long row_count = 0;
  json validator_report;
};

struct RegistryStore {
  VersionRecord head(const std::string& dataset, const std::string& version);
};

RegistryStore store;

/** HMAC-SHA256 over the tenant, the version and the expiry the caller will be given. */
static std::string sign(const std::string& scope) {
  unsigned char digest[EVP_MAX_MD_SIZE];
  unsigned int length = 0;
  HMAC(EVP_sha256(), kSigningKey.data(), static_cast<int>(kSigningKey.size()),
       reinterpret_cast<const unsigned char*>(scope.data()), scope.size(), digest, &length);
  std::string out;
  for (unsigned int i = 0; i < length; i++) {
    char buf[3];
    std::snprintf(buf, sizeof(buf), "%02x", digest[i]);
    out += buf;
  }
  return out;
}

static std::pair<std::string, long> signed_url(const std::string& dataset, const std::string& version,
                                               const std::string& tenant) {
  const long expires_at = static_cast<long>(std::time(nullptr)) + kSignedUrlTtlSeconds;
  const std::string scope = tenant + "/" + dataset + "/" + version + "/" + std::to_string(expires_at);
  const std::string url = kObjectBase + "/" + dataset + "/" + version + "?tenant=" + tenant +
                          "&expires=" + std::to_string(expires_at) + "&sig=" + sign(scope);
  return {url, expires_at};
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/datasets/([^/]+)/versions/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const std::string dataset = req.matches[1];
    const std::string version = req.matches[2];
    const auto record = store.head(dataset, version);
    if (record.tenant != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"unknown version"})", "application/json");
      return;
    }
    const auto signed_result = signed_url(dataset, version, tenant);
    const json out = {
        {"dataset", dataset},
        {"version", version},
        {"provenance",
         {{"source", record.source},
          {"license", record.license},
          {"row_count", record.row_count},
          {"validator_report", record.validator_report}}},
        {"signed_url", signed_result.first},
        {"expires_at", signed_result.second},
    };
    res.status = 200;
    res.set_content(out.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'A link from a support ticket still downloads the dataset months later, from any account. A version that failed schema validation reads back with no `validator` field at all, as if it were clean.',
    '`read_version` never compares `record["tenant"]` to the caller; `permanent_url` is a plain path with no signature or expiry; the validator record is attached inside `if record["validator"]["passed"]`.',
    'Answer 404 when `record["tenant"] != tenant`, replace `permanent_url` with `signed_url(tenant, dataset, version)` over `SIGNED_URL_TTL_S = 300` returning `expires_at`, drop `raw_url`, and always include `validator_report`.',
  ],
  debrief: `The read answers 404 for a foreign version because the response itself is information: a 403 confirms the version exists under some other tenant. The URL is signed with an expiry because it is a capability, and a capability that lands in a ticket or a log needs to stop working on its own. The validator report is unconditional because a version read is how a training run records what it trained on; a missing field is read as "nothing to report", which is the opposite of what a failed validation means. Production registries add per-request audit logging on the read, range requests through the same signed scope, rotation of the URL signing key, and a check that the dataset's license is still compatible with the tenant's declared use.`,
};
