import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/files/{id}: access that expires',
  concept: 'http',
  file: 'read',
  focus: ['client', 'reader', 'redis', 'audit'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the download endpoint: it
registers the route and returns a URL for the file. It compiles, the demo downloads work, and it hides
three production flaws. Review it, fix it, and prove the fix with the checks below.

Implement \`GET /v1/files/{id}\`:

- The tenant comes from \`X-Tenant-Id\` and the person asking from \`X-User-Id\`; a missing tenant is
  **401**.
- The file is looked up by id and the request is authorized against the file's owning tenant. A file
  that does not exist, **or exists but belongs to another tenant**, is **404** — never **403**, so the
  endpoint does not confirm that an id exists.
- The response is a **signed URL** to the CDN: the signature covers the path, the expiry and the tenant,
  so the CDN can verify it without calling back and a signature minted for one tenant cannot be
  replayed by another.
- The URL **expires in 10 minutes** (\`600\` seconds). After that the CDN rejects it; the client asks the
  API for a fresh one.
- Every issuance appends an audit record — \`download_issued\`, the file id, the tenant and the
  **requesting user** — to the audit stream, before the URL is returned.

**Failure mode the checks target.** A permanent public URL is a capability with no end: anyone who sees
it, including a browser history or a proxy log, keeps access forever. Serving any file id to any caller
turns a guessable id into a data leak. And a download path with no audit is the one access you cannot
reconstruct after an incident, when the question is exactly who read which object and when.`,
  sequence: {
    participants: ['Client', 'Download API', 'File index', 'Audit topic'],
    messages: [
      {from: 'Client', to: 'Download API', label: 'GET /v1/files/{id} · X-Tenant-Id · X-User-Id', kind: 'sync'},
      {from: 'Download API', to: 'File index', label: 'get(file_id)', kind: 'sync'},
      {from: 'File index', to: 'Download API', label: 'record / none', kind: 'reply'},
      {from: 'Download API', to: 'Download API', label: 'authorize tenant · sign URL · expires 600s', kind: 'sync'},
      {from: 'Download API', to: 'Audit topic', label: 'audit download_issued · requester', kind: 'async'},
      {from: 'Download API', to: 'Client', label: '200 {url, expires_in}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/files/{id}',
      detail: 'Register the download endpoint on `GET /v1/files/{id}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/files\/\{file_id\}["']\)/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/files\/:fileId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/files\/\{fileId\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"files"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/files\/\(\[\^\/\]\+\)"/]},
      },
    },
    {
      id: 'signed-url',
      title: 'Returns a URL signed with the server key',
      detail:
        'The URL is signed over path, expiry and tenant with the server’s signing key. The draft returns a plain public URL that anyone can mint.',
      match: {
        python: {all: [/SIGNING_KEY/, /hmac\.new\(/]},
        typescript: {all: [/SIGNING_KEY/, /createHmac\(/]},
        go: {all: [/signingKey/, /hmac\.New\(/]},
        scala: {all: [/SigningKey/, /HmacSHA256/]},
        cpp: {all: [/kSigningKey/, /HMAC\(/]},
      },
    },
    {
      id: 'expiry',
      title: 'The signed URL expires after 10 minutes',
      detail:
        'The signature carries an expiry `600` seconds out. The draft’s URL has no expiry, so it is a permanent capability.',
      match: {
        python: {all: [/SIGNED_URL_TTL_S/, /expires/]},
        typescript: {all: [/SIGNED_URL_TTL_S/, /expires/]},
        go: {all: [/signedUrlTtlSeconds/, /expires/]},
        scala: {all: [/SignedUrlTtlSeconds/, /expires/]},
        cpp: {all: [/kSignedUrlTtlS/, /expires/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'A foreign file id is 404, not 403',
      detail:
        'The file’s owning tenant is compared with the caller’s and a mismatch is **404**, so the endpoint never confirms that another tenant’s id exists. The draft serves any file id to any caller.',
      match: {
        python: {all: [/status_code\s*=\s*404/, /record\["tenant"\]/]},
        typescript: {all: [/code\(\s*404\s*\)/, /record\.tenant/]},
        go: {all: [/StatusNotFound/, /record\.Tenant/]},
        scala: {all: [/StatusCodes\.NotFound/, /record\.tenant/]},
        cpp: {all: [/\b404\b/, /record\.tenant/]},
      },
    },
    {
      id: 'audit',
      title: 'Every issuance is audited with the requester',
      detail:
        'An `download_issued` record carrying the file, the tenant and the requesting user is appended before the URL leaves. The draft audits nothing.',
      match: {
        python: {all: [/audit\.append\(/, /download_issued/]},
        typescript: {all: [/audit\.append\(/, /download_issued/]},
        go: {all: [/audit\.Append\(/, /download_issued/]},
        scala: {all: [/audit\.append\(/, /download_issued/]},
        cpp: {all: [/audit\.append\(/, /download_issued/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()

CDN_BASE = "https://cdn.example.com"


@app.get("/v1/files/{file_id}")
async def download(file_id: str, x_tenant_id: str = Header(default="")):
    # TODO: this draft hands out a permanent public URL, serves any file id to any caller, and
    # audits nothing.
    return JSONResponse({"url": CDN_BASE + "/" + file_id}, status_code=200)
`,
      solution: `import hashlib
import hmac
import time
from urllib.parse import urlencode

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()

SIGNED_URL_TTL_S = 600
SIGNING_KEY = b"config://file-storage/signing-key"
CDN_BASE = "https://cdn.example.com"


def sign_path(path: str, expires: int, tenant: str) -> str:
    message = ("%s|%d|%s" % (path, expires, tenant)).encode()
    return hmac.new(SIGNING_KEY, message, hashlib.sha256).hexdigest()


@app.get("/v1/files/{file_id}")
async def download(file_id: str, x_tenant_id: str = Header(default=""), x_user_id: str = Header(default="")):
    if not x_tenant_id:
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    record = index.get(file_id)
    if record is None or record["tenant"] != x_tenant_id:
        return JSONResponse({"error": "not found"}, status_code=404)
    expires = int(time.time()) + SIGNED_URL_TTL_S
    signature = sign_path("/" + file_id, expires, x_tenant_id)
    audit.append(
        {
            "action": "download_issued",
            "file_id": file_id,
            "tenant": x_tenant_id,
            "user": x_user_id,
        }
    )
    query = urlencode({"expires": expires, "signature": signature})
    return JSONResponse({"url": CDN_BASE + "/" + file_id + "?" + query, "expires_in": SIGNED_URL_TTL_S})
`,
    },
    typescript: {
      starter: `import type {FastifyInstance} from 'fastify';

const CDN_BASE = 'https://cdn.example.com';

export function registerDownloadApi(app: FastifyInstance): void {
  app.get('/v1/files/:fileId', async (req, reply) => {
    // TODO: this draft hands out a permanent public URL, serves any file id to any caller, and
    // audits nothing.
    return reply.code(200).send({url: CDN_BASE + '/' + (req.params as {fileId: string}).fileId});
  });
}
`,
      solution: `import {createHmac} from 'node:crypto';
import type {FastifyInstance} from 'fastify';

const SIGNED_URL_TTL_S = 600;
const SIGNING_KEY = process.env.SIGNING_KEY ?? '';
const CDN_BASE = 'https://cdn.example.com';

function signPath(path: string, expires: number, tenant: string): string {
  return createHmac('sha256', SIGNING_KEY).update(path + '|' + expires + '|' + tenant).digest('hex');
}

export function registerDownloadApi(app: FastifyInstance): void {
  app.get('/v1/files/:fileId', async (req, reply) => {
    const tenant = req.headers['x-tenant-id'] as string | undefined;
    const user = req.headers['x-user-id'] as string | undefined;
    if (!tenant) return reply.code(401).send({error: 'missing X-Tenant-Id'});
    const {fileId} = req.params as {fileId: string};
    const record = index.get(fileId);
    if (record === undefined || record.tenant !== tenant) return reply.code(404).send({error: 'not found'});
    const expires = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_S;
    const signature = signPath('/' + fileId, expires, tenant);
    audit.append({action: 'download_issued', file_id: fileId, tenant, user});
    return reply.code(200).send({
      url: CDN_BASE + '/' + fileId + '?expires=' + expires + '&signature=' + signature,
      expires_in: SIGNED_URL_TTL_S,
    });
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"net/http"
)

func download(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft hands out a permanent public URL, serves any file id to any caller, and
	// audits nothing.
	writeJSON(rw, http.StatusOK, map[string]string{"url": "https://cdn.example.com/" + r.PathValue("fileId")})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/files/{fileId}", download)
	http.ListenAndServe(":8443", mux)
}
`,
      solution: `package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"
	"time"
)

const signedUrlTtlSeconds = 600

var signingKey = []byte("config://file-storage/signing-key")

func signPath(path string, expires int64, tenant string) string {
	mac := hmac.New(sha256.New, signingKey)
	mac.Write([]byte(path + "|" + strconv.FormatInt(expires, 10) + "|" + tenant))
	return hex.EncodeToString(mac.Sum(nil))
}

func download(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	user := r.Header.Get("X-User-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	fileID := r.PathValue("fileId")
	record, ok := index.Get(fileID)
	if !ok || record.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	expires := time.Now().Unix() + signedUrlTtlSeconds
	signature := signPath("/"+fileID, expires, tenant)
	audit.Append(AuditEntry{Action: "download_issued", FileID: fileID, Tenant: tenant, User: user})
	url := "https://cdn.example.com/" + fileID + "?expires=" + strconv.FormatInt(expires, 10) + "&signature=" + signature
	writeJSON(rw, http.StatusOK, map[string]any{"url": url, "expires_in": signedUrlTtlSeconds})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/files/{fileId}", download)
	http.ListenAndServe(":8443", mux)
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

final case class PublicUrl(url: String)

object DownloadApi {
  implicit val system: ActorSystem = ActorSystem("file-storage")
  implicit val publicUrlFormat: RootJsonFormat[PublicUrl] = jsonFormat1(PublicUrl)

  val route: Route =
    path("v1" / "files" / Segment) { fileId =>
      get {
        // TODO: this draft hands out a permanent public URL, serves any file id to any caller, and
        // audits nothing.
        complete(StatusCodes.OK, PublicUrl("https://cdn.example.com/" + fileId))
      }
    }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.time.Instant
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class SignedUrl(url: String, expires_in: Long)

object DownloadApi {
  implicit val system: ActorSystem = ActorSystem("file-storage")
  implicit val signedUrlFormat: RootJsonFormat[SignedUrl] = jsonFormat2(SignedUrl)

  val SignedUrlTtlSeconds: Long = 600
  val SigningKey: Array[Byte] = "config://file-storage/signing-key".getBytes(StandardCharsets.UTF_8)
  val CdnBase = "https://cdn.example.com"

  def signPath(path: String, expires: Long, tenant: String): String = {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(new SecretKeySpec(SigningKey, "HmacSHA256"))
    mac.doFinal((path + "|" + expires + "|" + tenant).getBytes(StandardCharsets.UTF_8)).map("%02x".format(_)).mkString
  }

  val route: Route =
    path("v1" / "files" / Segment) { fileId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("X-User-Id") { userOpt =>
            val tenant = tenantOpt.getOrElse("")
            index.get(fileId) match {
              case Some(record) if record.tenant == tenant =>
                val expires = Instant.now().getEpochSecond + SignedUrlTtlSeconds
                val signature = signPath("/" + fileId, expires, tenant)
                audit.append(AuditEntry("download_issued", fileId, tenant, userOpt.getOrElse("")))
                complete(StatusCodes.OK, SignedUrl(CdnBase + "/" + fileId + "?expires=" + expires + "&signature=" + signature, SignedUrlTtlSeconds))
              case _ =>
                complete(StatusCodes.NotFound, PublicUrl("not found"))
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

#include <string>

using json = nlohmann::json;

const std::string kCdnBase = "https://cdn.example.com";

int main() {
  httplib::Server svr;

  svr.Get("/v1/files/([^/]+)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft hands out a permanent public URL, serves any file id to any caller, and
    // audits nothing.
    res.status = 200;
    res.set_content(json{{"url", kCdnBase + "/" + req.matches[1]}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <openssl/hmac.h>

#include <ctime>
#include <string>

using json = nlohmann::json;

const long kSignedUrlTtlS = 600;
const std::string kSigningKey = "config://file-storage/signing-key";
const std::string kCdnBase = "https://cdn.example.com";

std::string signPath(const std::string& path, long expires, const std::string& tenant) {
  const std::string message = path + "|" + std::to_string(expires) + "|" + tenant;
  unsigned char digest[EVP_MAX_MD_SIZE];
  unsigned int length = 0;
  HMAC(EVP_sha256(), kSigningKey.data(), static_cast<int>(kSigningKey.size()),
       reinterpret_cast<const unsigned char*>(message.data()), message.size(), digest, &length);
  static const char* digits = "0123456789abcdef";
  std::string hex;
  for (unsigned int i = 0; i < length; i++) {
    hex.push_back(digits[digest[i] >> 4]);
    hex.push_back(digits[digest[i] & 0xf]);
  }
  return hex;
}

int main() {
  httplib::Server svr;

  svr.Get("/v1/files/([^/]+)", [](const httplib::Request& req, httplib::Response& res) {
    const auto fileId = req.matches[1];
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto user = req.get_header_value("X-User-Id");
    const auto found = index.get(fileId);
    if (!found) {
      res.status = 404;
      res.set_content(R"({"error":"not found"})", "application/json");
      return;
    }
    const FileRecord& record = *found;
    if (record.tenant != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"not found"})", "application/json");
      return;
    }
    const long expires = static_cast<long>(std::time(nullptr)) + kSignedUrlTtlS;
    const auto signature = signPath("/" + fileId, expires, tenant);
    audit.append(AuditEntry{"download_issued", fileId, tenant, user});
    const std::string url = kCdnBase + "/" + fileId + "?expires=" + std::to_string(expires) + "&signature=" + signature;
    res.status = 200;
    res.set_content(json{{"url", url}, {"expires_in", kSignedUrlTtlS}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The signature is the whole point: sign the path, the expiry and the tenant together so the CDN can verify the link without calling the API, and so a link minted for one tenant cannot be replayed by another.',
    'Ten minutes is a budget, not a constant to admire: long enough for the browser to follow the redirect and start the transfer, short enough that a leaked link dies before it is useful. Return `expires_in` so the client knows when to ask again.',
    'Answer 404 for another tenant’s file, never 403. A 403 tells the caller the id exists and belongs to someone else; a 404 tells them nothing, and the audit record is where the attempt shows up instead.',
  ],
  debrief: `The interviewer is testing whether you can review an access path, not just a storage path. The draft's "public URL" is the single most common generated shortcut and the most expensive: it turns a one-time read into a permanent capability. The fix has three parts — sign the URL so the CDN can verify it, give it a short expiry so a leak is bounded, and bind it to the tenant so the signature cannot be replayed. The audit record is the part candidates skip: it is what turns "someone read the object" into "this user read this object at this time". Real systems add per-object rate limits, a CDN-side check that the file's tenant still matches, and a key rotation that invalidates links older than the rotation window.`,
};
