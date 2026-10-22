import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/verifications: the caller does not set the verdict',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis', 'storage'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, reads
the caller's documents and answers **200** with a case. It serves the demo because the demo sends a
well-formed body, one tenant, and one attempt — and it hides three production flaws. Review it like
the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/verifications\` with body
\`{"applicant": "a-123", "documents": [{"type": "passport", "ref": "documents/tenant-a/passport-9.jpg"}]}\`
and header \`X-Tenant-Id\`:

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**. The
  tenant is the only owner of its documents — the body never names storage.
- \`documents\` is a non-empty array of \`{type, ref}\`. \`type\` must come from the allowlist
  \`passport\`, \`drivers_license\`, \`national_id\` (**400** otherwise); a \`ref\` outside
  \`documents/{tenant}/\` is **403**.
- The prefix check happens **before** anything is fetched, signed or reserved: the API is not a
  proxy, and it must never dereference a caller-supplied URL.
- Attempts per applicant are bounded: **4** reservations (\`MAX_ATTEMPTS = 4\`), made atomically in
  Redis before the case opens, and a fifth attempt is **429** with \`Retry-After\`.
- The response is the opened case: \`{"case_id": …, "applicant": …, "status": "pending"}\`. No
  caller input may set a status — a \`status\` field in the body is ignored, and the verdict is
  always the service's.

**Failure mode the checks target.** The draft reads \`status\` from the body and persists it, so a
caller opens a case that is already \`approved\`; it never counts attempts, so one applicant can
grind the review pipeline forever; and it fetches whatever URL arrives in \`ref\`, so the API
becomes an open proxy pointed at the tenant's own network.`,
  sequence: {
    participants: ['Client', 'KYC API', 'Redis', 'Document storage'],
    messages: [
      {
        from: 'Client',
        to: 'KYC API',
        label: 'POST /v1/verifications · X-Tenant-Id · {applicant, documents[{type, ref}]}',
        kind: 'sync',
      },
      {
        from: 'KYC API',
        to: 'KYC API',
        label: 'validate type allowlist · ref under documents/{tenant}/',
        kind: 'sync',
      },
      {
        from: 'KYC API',
        to: 'Client',
        label: '403 document outside tenant storage — before any fetch',
        kind: 'reply',
      },
      {from: 'KYC API', to: 'Redis', label: 'INCR attempts:{tenant}:{applicant} · atomic reservation', kind: 'sync'},
      {from: 'Redis', to: 'KYC API', label: 'reserved n of 4 / over cap', kind: 'reply'},
      {from: 'KYC API', to: 'Client', label: '429 Retry-After: 3600', kind: 'reply'},
      {from: 'KYC API', to: 'Document storage', label: 'sign(ref, ttl=15m) for the reviewer path', kind: 'sync'},
      {from: 'Document storage', to: 'KYC API', label: 'signed ref, expiring', kind: 'reply'},
      {from: 'KYC API', to: 'Client', label: '200 {case_id, status: "pending"}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/verifications',
      detail:
        'The submission route is registered as `POST /v1/verifications`. The draft already has it, so this check passes before any fix — the four below are the real review.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/verifications["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/verifications['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/verifications"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"verifications"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/verifications"/]},
      },
    },
    {
      id: 'status-server-side',
      title: 'A body status never sets the case status',
      detail:
        'The case is written `pending` by the service, and a `status` field in the request is never read or persisted. The draft takes the caller’s `status` and stores it, so a caller can open a case that is already `approved`.',
      match: {
        python: {all: [/["']pending["']/], none: [/body\.status/, /body\[["']status["']\]/]},
        typescript: {all: [/'pending'/], none: [/body\.status/, /body\[['"]status['"]\]/]},
        go: {all: [/"pending"/], none: [/body\.Status/]},
        scala: {all: [/"pending"/], none: [/body\.status/]},
        cpp: {all: [/"pending"/], none: [/body\.value\(\s*"status"/, /body\["status"\]/]},
      },
    },
    {
      id: 'attempt-cap',
      title: 'Bounds attempts per applicant and answers 429',
      detail:
        'Attempts per applicant are bounded with `MAX_ATTEMPTS = 4` and reserved atomically before the case opens; the refusal is **429** with `Retry-After`. The draft never counts attempts, so one applicant can submit without limit.',
      match: {
        python: {all: [/\bMAX_ATTEMPTS\b/, /status_code\s*=\s*429/]},
        typescript: {all: [/\bMAX_ATTEMPTS\b/, /code\(\s*429\s*\)/]},
        go: {all: [/\bmaxAttempts\b/, /StatusTooManyRequests/]},
        scala: {all: [/\bMaxAttempts\b/, /StatusCodes\.TooManyRequests/]},
        cpp: {all: [/\bkMaxAttempts\b/, /\b429\b/]},
      },
    },
    {
      id: 'document-scope',
      title: 'Refuses a non-tenant document reference before any fetch',
      detail:
        'A `ref` outside `documents/{tenant}/` is **403**, refused before anything is fetched or signed, and the API never dereferences a caller-supplied URL. The draft fetches whatever URL arrives in `ref`.',
      match: {
        python: {all: [/status_code\s*=\s*403/, /startswith\(/], none: [/urlopen\(/, /requests\.get\(/]},
        typescript: {all: [/code\(\s*403\s*\)/, /startsWith\(/], none: [/\bfetch\(/]},
        go: {all: [/StatusForbidden/, /HasPrefix\(/], none: [/http\.Get\(/]},
        scala: {all: [/StatusCodes\.Forbidden/, /startsWith\(/], none: [/singleRequest/]},
        cpp: {all: [/\b403\b/, /rfind\(|starts_with\(/], none: [/httplib::Client/]},
      },
    },
    {
      id: 'document-type',
      title: 'Requires a document type from the allowlist',
      detail:
        'Every document `type` must come from the allowlist `passport` / `drivers_license` / `national_id`; anything else is **400**. The draft trusts the caller and never checks the type.',
      match: {
        python: {all: [/\bALLOWED_DOCUMENT_TYPES\b/, /document_type/]},
        typescript: {all: [/\bALLOWED_DOCUMENT_TYPES\b/, /documentType/]},
        go: {all: [/\ballowedDocumentTypes\b/, /documentType/]},
        scala: {all: [/\bAllowedDocumentTypes\b/, /documentType/]},
        cpp: {all: [/\bkAllowedDocumentTypes\b/, /documentType/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import requests

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class DocumentRef(BaseModel):
    type: str
    ref: str


class Submission(BaseModel):
    applicant: str
    status: str | None = None
    documents: list[DocumentRef]


@app.post("/v1/verifications")
def submit(body: Submission, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft persists a caller-supplied status, never bounds attempts per applicant, and
    # dereferences whatever document URL the caller sends. Review all three flaws.
    for document in body.documents:
        response = requests.get(document.ref)
        response.raise_for_status()
    return JSONResponse(
        {"case_id": "case-1", "applicant": body.applicant, "status": body.status or "pending"},
        status_code=200,
    )
`,
      solution: `import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

app = FastAPI()

MAX_ATTEMPTS = 4
RETRY_AFTER_S = 3600
SIGNED_REF_TTL_S = 15 * 60
ALLOWED_DOCUMENT_TYPES = {"passport", "drivers_license", "national_id"}


class DocumentRef(BaseModel):
    document_type: str = Field(alias="type")
    ref: str


class Submission(BaseModel):
    applicant: str
    documents: list[DocumentRef]


class AttemptStore:
    def reserve(self, tenant: str, applicant: str) -> int:
        """INCR attempts:{tenant}:{applicant} — the count after this reservation, atomic."""
        raise NotImplementedError


attempts = AttemptStore()


def tenant_prefix(tenant: str) -> str:
    return f"documents/{tenant}/"


def sign_storage_ref(tenant: str, ref: str, ttl_s: int) -> str:
    """A short-lived read link for one key under documents/{tenant}/ — the reviewer path only."""
    raise NotImplementedError


def open_pending_case(tenant: str, applicant: str, signed_refs: list[str]) -> str:
    """Store the case with status pending and return its id."""
    raise NotImplementedError


@app.post("/v1/verifications")
def submit(
    body: Submission,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if not body.documents:
        raise HTTPException(status_code=400, detail="at least one document is required")
    prefix = tenant_prefix(tenant)
    for document in body.documents:
        if document.document_type not in ALLOWED_DOCUMENT_TYPES:
            raise HTTPException(status_code=400, detail="unsupported document type")
        # A ref is a key inside the tenant's own prefix, never a URL: refuse it before the case is
        # reserved, signed or fetched.
        if not document.ref.startswith(prefix):
            raise HTTPException(status_code=403, detail="document outside tenant storage")
    used = attempts.reserve(tenant, body.applicant)
    if used > MAX_ATTEMPTS:
        raise HTTPException(
            status_code=429,
            detail="attempt limit reached",
            headers={"Retry-After": str(RETRY_AFTER_S)},
        )
    # The verdict is the service's: the case opens pending whatever the body says. Storage links
    # are signed for the reviewer path and expire with their TTL.
    signed = [sign_storage_ref(tenant, document.ref, SIGNED_REF_TTL_S) for document in body.documents]
    case_id = open_pending_case(tenant, body.applicant, signed)
    return JSONResponse(
        {"case_id": case_id, "applicant": body.applicant, "status": "pending"},
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/verifications: a model-generated draft that trusts the caller. */
import Fastify from 'fastify';

export const app = Fastify();

interface DocumentRef {
  type: string;
  ref: string;
}

interface Submission {
  applicant: string;
  status?: string;
  documents: DocumentRef[];
}

app.post('/v1/verifications', async (request, reply) => {
  // TODO: this draft persists a caller-supplied status, never bounds attempts per applicant, and
  // dereferences whatever document URL the caller sends. Review all three flaws.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as Submission;
  for (const document of body.documents) {
    const response = await fetch(document.ref);
    await response.arrayBuffer();
  }
  request.log.info({tenant}, 'verification submitted');
  return reply.code(200).send({case_id: 'case-1', applicant: body.applicant, status: body.status ?? 'pending'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/verifications: the case opens pending; the caller never sets the verdict. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const MAX_ATTEMPTS = 4;
const RETRY_AFTER_S = 3600;
const SIGNED_REF_TTL_S = 15 * 60;
const ALLOWED_DOCUMENT_TYPES: Record<string, true> = {
  passport: true,
  drivers_license: true,
  national_id: true,
};

interface DocumentRef {
  documentType: string;
  ref: string;
}

interface Submission {
  applicant: string;
  documents: DocumentRef[];
}

const attempts = {
  /** INCR attempts:{tenant}:{applicant} — the count after this reservation, atomic. */
  async reserve(tenant: string, applicant: string): Promise<number> {
    throw new Error('not implemented');
  },
};

function signStorageRef(tenant: string, ref: string, ttlSeconds: number): string {
  throw new Error('not implemented');
}

async function openPendingCase(tenant: string, applicant: string, signedRefs: string[]): Promise<string> {
  throw new Error('not implemented');
}

app.post('/v1/verifications', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const body = request.body as Partial<Submission> | null;
  if (body === null || typeof body !== 'object' || !Array.isArray(body.documents) || body.documents.length === 0)
    return reply.code(400).send({error: 'at least one document is required'});
  const applicant = typeof body.applicant === 'string' ? body.applicant : '';
  const prefix = 'documents/' + tenant + '/';
  for (const document of body.documents) {
    if (ALLOWED_DOCUMENT_TYPES[document.documentType] !== true)
      return reply.code(400).send({error: 'unsupported document type'});
    // A ref is a key inside the tenant's own prefix, never a URL: refuse it before the case is
    // reserved, signed or fetched.
    if (!document.ref.startsWith(prefix)) return reply.code(403).send({error: 'document outside tenant storage'});
  }

  const used = await attempts.reserve(tenant, applicant);
  if (used > MAX_ATTEMPTS)
    return reply.code(429).header('Retry-After', String(RETRY_AFTER_S)).send({error: 'attempt limit reached'});

  // The verdict is the service's: the case opens pending whatever the body says.
  const signed = body.documents.map(document => signStorageRef(tenant, document.ref, SIGNED_REF_TTL_S));
  const caseId = await openPendingCase(tenant, applicant, signed);
  request.log.info({tenant, applicant, caseId}, 'case opened pending');
  return reply.code(200).send({case_id: caseId, applicant, status: 'pending'});
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

type documentRef struct {
	Type string \`json:"type"\`
	Ref  string \`json:"ref"\`
}

type submission struct {
	Applicant string        \`json:"applicant"\`
	Status    string        \`json:"status"\`
	Documents []documentRef \`json:"documents"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func submit(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body submission
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft persists a caller-supplied status, never bounds attempts per applicant, and
	// dereferences whatever document URL the caller sends. Review all three flaws.
	for _, document := range body.Documents {
		response, err := http.Get(document.Ref)
		if err != nil {
			writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "document fetch failed"})
			return
		}
		response.Body.Close()
	}
	status := body.Status
	if status == "" {
		status = "pending"
	}
	log.Printf("verification tenant=%s applicant=%s status=%s", tenant, body.Applicant, status)
	writeJSON(rw, http.StatusOK, map[string]any{"case_id": "case-1", "applicant": body.Applicant, "status": status})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/verifications", submit)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
)

const (
	maxAttempts        = 4
	retryAfterSeconds  = 3600
	signedRefTTLSecond = 15 * 60
)

var allowedDocumentTypes = map[string]bool{
	"passport":        true,
	"drivers_license": true,
	"national_id":     true,
}

type documentRef struct {
	DocumentType string \`json:"type"\`
	Ref          string \`json:"ref"\`
}

type submission struct {
	Applicant string        \`json:"applicant"\`
	Documents []documentRef \`json:"documents"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// reserveAttempt INCRs attempts:{tenant}:{applicant} in Redis, atomically, and returns the count
// after this reservation.
func reserveAttempt(ctx context.Context, tenant, applicant string) (int, error) {
	return 0, nil
}

// signStorageRef returns a short-lived read link for one key under documents/{tenant}/ — the
// reviewer path only; the API itself never dereferences a ref.
func signStorageRef(ctx context.Context, tenant, ref string, ttlSeconds int) (string, error) {
	return "", nil
}

// openPendingCase stores the case with status pending and returns its id.
func openPendingCase(ctx context.Context, tenant, applicant string, signedRefs []string) (string, error) {
	return "", nil
}

func submit(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body submission
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if len(body.Documents) == 0 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "at least one document is required"})
		return
	}
	prefix := "documents/" + tenant + "/"
	for _, document := range body.Documents {
		documentType := document.DocumentType
		if !allowedDocumentTypes[documentType] {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unsupported document type"})
			return
		}
		// A ref is a key inside the tenant's own prefix, never a URL: refuse it before the case is
		// reserved, signed or fetched.
		if !strings.HasPrefix(document.Ref, prefix) {
			writeJSON(rw, http.StatusForbidden, map[string]string{"error": "document outside tenant storage"})
			return
		}
	}
	used, err := reserveAttempt(r.Context(), tenant, body.Applicant)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if used > maxAttempts {
		rw.Header().Set("Retry-After", strconv.Itoa(retryAfterSeconds))
		writeJSON(rw, http.StatusTooManyRequests, map[string]string{"error": "attempt limit reached"})
		return
	}
	signedRefs := make([]string, 0, len(body.Documents))
	for _, document := range body.Documents {
		signed, err := signStorageRef(r.Context(), tenant, document.Ref, signedRefTTLSecond)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		signedRefs = append(signedRefs, signed)
	}
	caseID, err := openPendingCase(r.Context(), tenant, body.Applicant, signedRefs)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	// The verdict is the service's: the case opens pending whatever the body says.
	log.Printf("case opened case=%s tenant=%s applicant=%s status=pending", caseID, tenant, body.Applicant)
	writeJSON(rw, http.StatusOK, map[string]any{"case_id": caseID, "applicant": body.Applicant, "status": "pending"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/verifications", submit)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class DocumentRef(\`type\`: String, ref: String)
final case class Submission(applicant: String, status: Option[String], documents: List[DocumentRef])
final case class PendingCase(case_id: String, applicant: String, status: String)

object VerificationApi {
  implicit val system: ActorSystem = ActorSystem("kycd")
  implicit val documentRefFormat: RootJsonFormat[DocumentRef] = jsonFormat2(DocumentRef)
  implicit val submissionFormat: RootJsonFormat[Submission] = jsonFormat3(Submission)
  implicit val pendingCaseFormat: RootJsonFormat[PendingCase] = jsonFormat3(PendingCase)

  val route: Route =
    path("v1" / "verifications") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[Submission]) { body =>
            // TODO: this draft persists a caller-supplied status, never bounds attempts per
            // applicant, and dereferences whatever document URL the caller sends. Review all three.
            body.documents.foreach { document =>
              Http().singleRequest(HttpRequest(uri = document.ref))
            }
            system.log.info("verification tenant=" + tenant + " applicant=" + body.applicant)
            complete(
              StatusCodes.OK,
              PendingCase(UUID.randomUUID().toString, body.applicant, body.status.getOrElse("pending")))
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
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json._

final case class DocumentRef(documentType: String, ref: String)
final case class Submission(applicant: String, documents: List[DocumentRef])
final case class PendingCase(case_id: String, applicant: String, status: String)

object VerificationApi {
  implicit val system: ActorSystem = ActorSystem("kycd")

  val MaxAttempts = 4
  val RetryAfterSeconds = 3600
  val SignedRefTtlSeconds = 15 * 60
  val AllowedDocumentTypes = Set("passport", "drivers_license", "national_id")

  implicit object DocumentRefFormat extends RootJsonFormat[DocumentRef] {
    def write(document: DocumentRef): JsValue =
      JsObject("type" -> JsString(document.documentType), "ref" -> JsString(document.ref))
    def read(value: JsValue): DocumentRef = value.asJsObject.getFields("type", "ref") match {
      case Seq(JsString(documentType), JsString(ref)) => DocumentRef(documentType, ref)
      case _ => throw DeserializationException("a document is {type, ref}")
    }
  }
  implicit val submissionFormat: RootJsonFormat[Submission] = jsonFormat2(Submission)
  implicit val pendingCaseFormat: RootJsonFormat[PendingCase] = jsonFormat3(PendingCase)

  // INCR attempts:{tenant}:{applicant} in Redis, atomically; the count after this reservation.
  def reserveAttempt(tenant: String, applicant: String): Long =
    throw new NotImplementedError("attempt reservation")

  // A short-lived read link for one key under documents/{tenant}/ — the reviewer path only; the
  // API itself never dereferences a ref.
  def signStorageRef(tenant: String, ref: String, ttlSeconds: Long): String =
    throw new NotImplementedError("signed storage ref")

  // Stores the case with status pending and returns its id.
  def openPendingCase(tenant: String, applicant: String, signedRefs: List[String]): String =
    throw new NotImplementedError("case store")

  val route: Route =
    path("v1" / "verifications") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            entity(as[Submission]) { body =>
              val tenant = tenantOpt.get
              if (body.documents.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"at least one document is required"}""")
              } else {
                val prefix = "documents/" + tenant + "/"
                val unsupported =
                  body.documents.exists(document => !AllowedDocumentTypes.contains(document.documentType))
                // A ref is a key inside the tenant's own prefix, never a URL: refuse it before the
                // case is reserved, signed or fetched.
                val outOfScope = body.documents.exists(document => !document.ref.startsWith(prefix))
                if (unsupported) {
                  complete(StatusCodes.BadRequest, """{"error":"unsupported document type"}""")
                } else if (outOfScope) {
                  complete(StatusCodes.Forbidden, """{"error":"document outside tenant storage"}""")
                } else {
                  val used = reserveAttempt(tenant, body.applicant)
                  if (used > MaxAttempts) {
                    complete(
                      StatusCodes.TooManyRequests,
                      List(RawHeader("Retry-After", RetryAfterSeconds.toString)),
                      """{"error":"attempt limit reached"}""")
                  } else {
                    // The verdict is the service's: the case opens pending whatever the body says.
                    val signedRefs =
                      body.documents.map(document => signStorageRef(tenant, document.ref, SignedRefTtlSeconds))
                    val caseId = openPendingCase(tenant, body.applicant, signedRefs)
                    complete(StatusCodes.OK, PendingCase(caseId, body.applicant, "pending"))
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

using json = nlohmann::json;

int main() {
  httplib::Server svr;

  svr.Post("/v1/verifications", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft persists a caller-supplied status, never bounds attempts per applicant, and
    // dereferences whatever document URL the caller sends. Review all three flaws.
    for (const auto& document : body["documents"]) {
      const auto ref = document.value("ref", std::string());
      httplib::Client client(ref);
      client.Get("/");
    }
    std::cerr << "verification tenant=" << tenant << " applicant=" << body.value("applicant", std::string())
              << std::endl;
    res.status = 200;
    res.set_content(json{{"case_id", "case-1"},
                         {"applicant", body.value("applicant", std::string())},
                         {"status", body.value("status", std::string("pending"))}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kMaxAttempts = 4;
constexpr int kRetryAfterSeconds = 3600;
constexpr int kSignedRefTtlSeconds = 15 * 60;
const std::set<std::string> kAllowedDocumentTypes = {"passport", "drivers_license", "national_id"};

// INCR attempts:{tenant}:{applicant} in Redis, atomically; the count after this reservation.
int reserveAttempt(const std::string& tenant, const std::string& applicant);
// A short-lived read link for one key under documents/{tenant}/ — the reviewer path only; the API
// itself never dereferences a ref.
std::string signStorageRef(const std::string& tenant, const std::string& ref, int ttlSeconds);
// Stores the case with status pending and returns its id.
std::string openPendingCase(const std::string& tenant, const std::string& applicant,
                            const std::vector<std::string>& signedRefs);

int main() {
  httplib::Server svr;

  svr.Post("/v1/verifications", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("documents") || !body["documents"].is_array() ||
        body["documents"].empty()) {
      res.status = 400;
      res.set_content(R"({"error":"at least one document is required"})", "application/json");
      return;
    }
    const std::string prefix = "documents/" + tenant + "/";
    for (const auto& document : body["documents"]) {
      const std::string documentType = document.value("type", std::string());
      if (kAllowedDocumentTypes.count(documentType) == 0) {
        res.status = 400;
        res.set_content(R"({"error":"unsupported document type"})", "application/json");
        return;
      }
      // A ref is a key inside the tenant's own prefix, never a URL: refuse it before the case is
      // reserved, signed or fetched.
      const std::string ref = document.value("ref", std::string());
      if (ref.rfind(prefix, 0) != 0) {
        res.status = 403;
        res.set_content(R"({"error":"document outside tenant storage"})", "application/json");
        return;
      }
    }
    const std::string applicant = body.value("applicant", std::string());
    const int used = reserveAttempt(tenant, applicant);
    if (used > kMaxAttempts) {
      res.set_header("Retry-After", std::to_string(kRetryAfterSeconds));
      res.status = 429;
      res.set_content(R"({"error":"attempt limit reached"})", "application/json");
      return;
    }
    std::vector<std::string> signedRefs;
    for (const auto& document : body["documents"]) {
      signedRefs.push_back(signStorageRef(tenant, document.value("ref", std::string()), kSignedRefTtlSeconds));
    }
    // The verdict is the service's: the case opens pending whatever the body says.
    const std::string caseId = openPendingCase(tenant, applicant, signedRefs);
    std::cout << "case opened case=" << caseId << " tenant=" << tenant << " status=pending" << std::endl;
    res.status = 200;
    res.set_content(
        json{{"case_id", caseId}, {"applicant", applicant}, {"status", "pending"}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guards in cost order — tenant, body shape, `type` allowlist, then the tenant-prefix check — and answer there when one of them fails. All of them are local string comparisons, so they run before anything is reserved, signed or fetched.',
    'A `ref` is a key in tenant storage under `documents/{tenant}/`, not a URL. Compare the prefix (`startswith` / `startsWith` / `HasPrefix` / `rfind(prefix, 0)`) and never open it; a signed reference is created by the service with a TTL for the reviewer path, never from caller input.',
    'The verdict is server-side: the case is stored `pending` whatever the body says. Reserve the attempt atomically in Redis before opening the case, cap it at `MAX_ATTEMPTS = 4`, and answer the refusal with **429** plus `Retry-After`.',
  ],
  debrief: `The interviewer is testing whether you treat submission as a trust boundary. The caller supplies
an applicant, a document type and a storage key — nothing else. The draft reads well because the
demo never sends a \`status\` field, never retries and never points \`ref\` at an internal address.
Three separate defects are being checked: the verdict is the service's (the case opens \`pending\`
and the body cannot name a status), attempts are bounded per applicant (4 reservations, atomic in
Redis, refused with \`Retry-After\`), and a \`ref\` is scoped to \`documents/{tenant}/\` before any
side effect, so the API cannot be turned into a proxy that fetches whatever URL arrives. Real KYC
services add idempotency keys so a client retry does not burn an attempt, per-jurisdiction retention
and deletion schedules for the documents themselves, sanctions and PEP screening after identity,
reviewer tooling with its own access logs, and audit export formats that prove who saw which
document and when.`,
};
