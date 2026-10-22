import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/applicants/{id}/status: status with reasons, scoped',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'db', 'storage'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the status route,
reads the case and returns it together with a document URL. It compiles, it serves the demo, and it
hides three production flaws. Review it like the service owner, fix it, and prove the fix with the
checks below.

Implement \`GET /v1/applicants/{id}/status\`, the read the applicant app polls after a submission.
The caller is the authenticated tenant in \`X-Tenant-Id\`.

- The lookup is scoped to that tenant: an applicant whose case belongs to another tenant is **404**,
  the same answer as an applicant that does not exist, so the read cannot confirm that someone
  else's case exists. The draft calls \`store.get(applicant_id)\`, so any caller can read any
  applicant.
- \`reasons\` are the **customer-facing** reason codes, mapped from the vendor's internal vocabulary
  through \`PUBLIC_REASONS\`; an internal code with no public mapping never leaves the service. The
  draft returns the vendor's own codes, so the app explains a refusal in the vendor's language.
- Document images never come back as permanent links: each document carries a **short-lived signed
  link** with an \`expires_at\`, so a URL copied out of a response stops working. The draft returns
  the permanent storage URL itself.
- The response reports whether the case is \`degraded\` — a vendor timeout or error sent it to a
  human — and whether it is awaiting manual review, so the app can say "still deciding" instead of
  showing a verdict the service does not have.

**Failure mode the checks target.** The unscoped lookup is an IDOR: one tenant's app reads another
tenant's applicant, and the 404 that should hide existence never happens. The raw vendor codes leak
the vendor's internal vocabulary into customer-facing copy — a vocabulary the vendor can change
under you. The permanent document URL is the quiet one: an identity-document link that survives the
case, the account and the deletion request, and that every screenshot, share and search index keeps
alive.`,
  sequence: {
    participants: ['Applicant app', 'KYC API', 'Decision store', 'Document storage'],
    messages: [
      {from: 'Applicant app', to: 'KYC API', label: 'GET /v1/applicants/a-123/status · X-Tenant-Id', kind: 'sync'},
      {from: 'KYC API', to: 'Decision store', label: 'get(tenant, applicant) — scoped', kind: 'sync'},
      {from: 'Decision store', to: 'KYC API', label: 'case / none for a foreign applicant', kind: 'reply'},
      {from: 'KYC API', to: 'Document storage', label: 'sign documents/{tenant}/… · ttl 300 s', kind: 'sync'},
      {from: 'Document storage', to: 'KYC API', label: 'signed url + expires_at', kind: 'reply'},
      {
        from: 'KYC API',
        to: 'Applicant app',
        label: '200 {status, reasons, degraded, manual_review, documents} · 404 foreign',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/applicants/{id}/status',
      detail:
        'Register the read route on `GET /v1/applicants/{id}/status`. The draft already serves it, so this one is free — every other check has to fail on the draft.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/applicants\/\{[^"']+\}\/status["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/applicants\/:[^'"]+\/status['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/applicants\/\{id\}\/status"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"applicants"\s*\/\s*Segment\s*\/\s*"status"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/applicants/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Returns 404 for an applicant outside the caller’s tenant',
      detail:
        'The case is looked up under `(tenant, applicant)` with the tenant taken from `X-Tenant-Id`, so an applicant that exists only for another tenant is **404** — the same answer as an applicant nobody has. The draft calls `store.get(applicant_id)`, so any caller can read any applicant.',
      match: {
        python: {all: [/status_code\s*=\s*404/, /store\.get\(\s*tenant/]},
        typescript: {all: [/code\(\s*404\s*\)/, /store\.get\(\s*tenant/]},
        go: {all: [/StatusNotFound/, /store\.Get\([^\n]*tenant/]},
        scala: {all: [/StatusCodes\.NotFound/, /store\.get\(\s*tenant/]},
        cpp: {all: [/\b404\b/, /store\.get\(\s*tenant/]},
      },
    },
    {
      id: 'public-reasons',
      title: 'Maps vendor codes to the customer-facing reason set',
      detail:
        'Reason codes leave the service mapped through `PUBLIC_REASONS` (or `REASON_MAP`): a small, stable, customer-facing set. The draft returns `vendor_reason_codes` verbatim, so the app explains a refusal in the vendor’s internal vocabulary and any taxonomy change breaks it.',
      match: {
        python: {all: [/PUBLIC_REASONS|REASON_MAP/]},
        typescript: {all: [/PUBLIC_REASONS|REASON_MAP/]},
        go: {all: [/publicReasons|reasonMap/]},
        scala: {all: [/PublicReasons|ReasonMap/]},
        cpp: {all: [/kPublicReasons|kReasonMap/]},
      },
    },
    {
      id: 'signed-link',
      title: 'Hands document access out as a short-lived signed link',
      detail:
        'Each document is returned as a link signed by storage with a TTL — `signed`/`presign` plus an expiry — never the permanent object URL. The draft returns the storage URL itself, so a link that leaks into a screenshot, a share or an index keeps working forever.',
      match: {
        python: {all: [/signed|Signed|presign|Presign|signUrl|sign_url/, /expire|expires|EXPIRES|ttl|TTL/]},
        typescript: {all: [/signed|Signed|presign|Presign|signUrl|sign_url/, /expire|expires|EXPIRES|ttl|TTL/]},
        go: {all: [/signed|Signed|presign|Presign|signUrl|sign_url/, /expire|expires|EXPIRES|ttl|TTL/]},
        scala: {all: [/signed|Signed|presign|Presign|signUrl|sign_url/, /expire|expires|EXPIRES|ttl|TTL/]},
        cpp: {all: [/signed|Signed|presign|Presign|signUrl|sign_url/, /expire|expires|EXPIRES|ttl|TTL/]},
      },
    },
    {
      id: 'degraded-flag',
      title: 'Reports whether the case is degraded or awaiting a human',
      detail:
        'The response carries `degraded` — a vendor timeout or error left the case for a human — and whether it is awaiting manual review. The draft omits both, so the app cannot tell "still deciding" from a final answer and shows a verdict the service does not have.',
      match: {
        python: {all: [/degraded/, /manual/i]},
        typescript: {all: [/degraded/, /manual/i]},
        go: {all: [/degraded/, /manual/i]},
        scala: {all: [/degraded/, /manual/i]},
        cpp: {all: [/degraded/, /manual/i]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()


class DecisionStore:
    def get(self, applicant_id: str) -> dict | None:
        """The decision case recorded for the applicant."""
        raise NotImplementedError


class DocumentStorage:
    def url(self, ref: str) -> str:
        """The permanent storage URL of a document."""
        raise NotImplementedError


store = DecisionStore()
storage = DocumentStorage()


@app.get("/v1/applicants/{applicant_id}/status")
def status(applicant_id: str) -> JSONResponse:
    # TODO: scope the lookup to the caller's tenant, map the vendor's internal codes onto the
    # customer-facing reason set, hand document access out through storage's link API, and report
    # the state a vendor failure leaves the case in. Review all four.
    case = store.get(applicant_id)
    if case is None:
        raise HTTPException(status_code=404, detail="unknown applicant")
    return JSONResponse(
        {
            "applicant": applicant_id,
            "status": case["status"],
            "reasons": case["vendor_reason_codes"],
            "documents": [
                {"type": doc["type"], "url": storage.url(doc["ref"])} for doc in case["documents"]
            ],
        },
        status_code=200,
    )
`,
      solution: `from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()

# The vendor's internal codes are not what a customer is allowed to read.
PUBLIC_REASONS = {
    "FACEMATCH_LOW": "identity_mismatch",
    "DOC_GLARE": "document_unreadable",
    "ID_EXPIRED": "document_expired",
    "UNSUPPORTED_TYPE": "document_type_not_accepted",
}
DOCUMENT_LINK_TTL_SECONDS = 300


class DecisionStore:
    def get(self, tenant: str, applicant_id: str) -> dict | None:
        """The case recorded for (tenant, applicant), if any."""
        raise NotImplementedError


class DocumentStorage:
    def sign_url(self, tenant: str, ref: str, ttl_seconds: int) -> dict:
        """A short-lived signed link for the document, with the expiry it carries."""
        raise NotImplementedError


store = DecisionStore()
storage = DocumentStorage()


def public_reasons(case: dict) -> list[str]:
    mapped = {PUBLIC_REASONS[code] for code in case["vendor_reason_codes"] if code in PUBLIC_REASONS}
    return sorted(mapped)


@app.get("/v1/applicants/{applicant_id}/status")
def status(
    applicant_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    case = store.get(tenant, applicant_id)
    if case is None:
        raise HTTPException(status_code=404, detail="unknown applicant")
    documents = []
    for doc in case["documents"]:
        link = storage.sign_url(tenant, doc["ref"], DOCUMENT_LINK_TTL_SECONDS)
        documents.append({"type": doc["type"], "url": link["url"], "expires_at": link["expires_at"]})
    return JSONResponse(
        {
            "applicant": applicant_id,
            "status": case["status"],
            "reasons": public_reasons(case),
            "degraded": case.get("degraded", False),
            "manual_review": case["status"] == "manual_review",
            "documents": documents,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/applicants/:id/status: a model-generated draft that serves any caller. */
import Fastify from 'fastify';

export const app = Fastify();

interface DocumentRef {
  type: string;
  ref: string;
}

interface DecisionCase {
  status: string;
  vendor_reason_codes: string[];
  documents: DocumentRef[];
}

interface DecisionStore {
  get(applicantId: string): Promise<DecisionCase | null>;
}

interface DocumentStorage {
  url(ref: string): Promise<string>;
}

export const store: DecisionStore = {get: async () => null};
export const storage: DocumentStorage = {url: async ref => ref};

app.get('/v1/applicants/:applicantId/status', async (request, reply) => {
  // TODO: scope the lookup to the caller's tenant, map the vendor's internal codes onto the
  // customer-facing reason set, hand document access out through storage's link API, and report
  // the state a vendor failure leaves the case in. Review all four.
  const {applicantId} = request.params as {applicantId: string};
  const caseRecord = await store.get(applicantId);
  if (caseRecord === null) return reply.code(404).send({error: 'unknown applicant'});
  return reply.code(200).send({
    applicant: applicantId,
    status: caseRecord.status,
    reasons: caseRecord.vendor_reason_codes,
    documents: await Promise.all(
      caseRecord.documents.map(async doc => ({type: doc.type, url: await storage.url(doc.ref)})),
    ),
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/applicants/:id/status: tenant-scoped, with public reasons and expiring links. */
import Fastify from 'fastify';

export const app = Fastify();

interface DocumentRef {
  type: string;
  ref: string;
}

interface DecisionCase {
  status: string;
  vendor_reason_codes: string[];
  degraded: boolean;
  documents: DocumentRef[];
}

interface SignedLink {
  url: string;
  expires_at: string;
}

interface DecisionStore {
  get(tenant: string, applicantId: string): Promise<DecisionCase | null>;
}

interface DocumentStorage {
  signUrl(tenant: string, ref: string, ttlSeconds: number): Promise<SignedLink>;
}

export const store: DecisionStore = {get: async () => null};
export const storage: DocumentStorage = {signUrl: async () => ({url: '', expires_at: ''})};

// The vendor's internal codes are not what a customer is allowed to read.
const PUBLIC_REASONS: Record<string, string> = {
  FACEMATCH_LOW: 'identity_mismatch',
  DOC_GLARE: 'document_unreadable',
  ID_EXPIRED: 'document_expired',
  UNSUPPORTED_TYPE: 'document_type_not_accepted',
};
const DOCUMENT_LINK_TTL_SECONDS = 300;

function publicReasons(caseRecord: DecisionCase): string[] {
  const mapped = caseRecord.vendor_reason_codes
    .filter(code => code in PUBLIC_REASONS)
    .map(code => PUBLIC_REASONS[code]);
  return [...new Set(mapped)].sort();
}

app.get('/v1/applicants/:applicantId/status', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {applicantId} = request.params as {applicantId: string};
  const caseRecord = await store.get(tenant, applicantId);
  if (caseRecord === null) return reply.code(404).send({error: 'unknown applicant'});
  const documents = await Promise.all(
    caseRecord.documents.map(async doc => {
      const link = await storage.signUrl(tenant, doc.ref, DOCUMENT_LINK_TTL_SECONDS);
      return {type: doc.type, url: link.url, expires_at: link.expires_at};
    }),
  );
  return reply.code(200).send({
    applicant: applicantId,
    status: caseRecord.status,
    reasons: publicReasons(caseRecord),
    degraded: caseRecord.degraded,
    manual_review: caseRecord.status === 'manual_review',
    documents,
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

type DocumentRef struct {
	Type string \`json:"type"\`
	Ref  string \`json:"ref"\`
}

type DecisionCase struct {
	Status            string        \`json:"status"\`
	VendorReasonCodes []string      \`json:"vendor_reason_codes"\`
	Documents         []DocumentRef \`json:"documents"\`
}

type DecisionStore struct{}

// Get returns the case recorded for the applicant.
func (s *DecisionStore) Get(ctx context.Context, applicantID string) (*DecisionCase, error) {
	return nil, nil
}

type DocumentStorage struct{}

// URL returns the permanent storage URL of a document.
func (s *DocumentStorage) URL(ref string) string {
	return ref
}

var store = &DecisionStore{}
var storage = &DocumentStorage{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readStatus(rw http.ResponseWriter, r *http.Request) {
	applicantID := r.PathValue("id")
	// TODO: scope the lookup to the caller's tenant, map the vendor's internal codes onto the
	// customer-facing reason set, hand document access out through storage's link API, and report
	// the state a vendor failure leaves the case in. Review all four.
	caseRecord, err := store.Get(r.Context(), applicantID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if caseRecord == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown applicant"})
		return
	}
	documents := make([]map[string]string, 0, len(caseRecord.Documents))
	for _, doc := range caseRecord.Documents {
		documents = append(documents, map[string]string{"type": doc.Type, "url": storage.URL(doc.Ref)})
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"applicant": applicantID,
		"status":    caseRecord.Status,
		"reasons":   caseRecord.VendorReasonCodes,
		"documents": documents,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/applicants/{id}/status", readStatus)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sort"
)

const documentLinkTTLSeconds = 300

// The vendor's internal codes are not what a customer is allowed to read.
var publicReasons = map[string]string{
	"FACEMATCH_LOW":    "identity_mismatch",
	"DOC_GLARE":        "document_unreadable",
	"ID_EXPIRED":       "document_expired",
	"UNSUPPORTED_TYPE": "document_type_not_accepted",
}

type DocumentRef struct {
	Type string \`json:"type"\`
	Ref  string \`json:"ref"\`
}

type DecisionCase struct {
	Status            string        \`json:"status"\`
	VendorReasonCodes []string      \`json:"vendor_reason_codes"\`
	Degraded          bool          \`json:"degraded"\`
	Documents         []DocumentRef \`json:"documents"\`
}

type SignedLink struct {
	URL       string \`json:"url"\`
	ExpiresAt string \`json:"expires_at"\`
}

type DecisionStore struct{}

// Get returns the case recorded for (tenant, applicant), if any.
func (s *DecisionStore) Get(ctx context.Context, tenant, applicantID string) (*DecisionCase, error) {
	return nil, nil
}

type DocumentStorage struct{}

// SignedURL returns a short-lived signed link for the document, with the expiry it carries.
func (s *DocumentStorage) SignedURL(tenant, ref string, ttlSeconds int) SignedLink {
	return SignedLink{}
}

var store = &DecisionStore{}
var storage = &DocumentStorage{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func publicReasonCodes(codes []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, code := range codes {
		if reason, ok := publicReasons[code]; ok && !seen[reason] {
			seen[reason] = true
			out = append(out, reason)
		}
	}
	sort.Strings(out)
	return out
}

func readStatus(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	applicantID := r.PathValue("id")
	caseRecord, err := store.Get(r.Context(), tenant, applicantID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if caseRecord == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown applicant"})
		return
	}
	documents := make([]map[string]string, 0, len(caseRecord.Documents))
	for _, doc := range caseRecord.Documents {
		link := storage.SignedURL(tenant, doc.Ref, documentLinkTTLSeconds)
		documents = append(documents, map[string]string{
			"type":       doc.Type,
			"url":        link.URL,
			"expires_at": link.ExpiresAt,
		})
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"applicant":     applicantID,
		"status":        caseRecord.Status,
		"reasons":       publicReasonCodes(caseRecord.VendorReasonCodes),
		"degraded":      caseRecord.Degraded,
		"manual_review": caseRecord.Status == "manual_review",
		"documents":     documents,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/applicants/{id}/status", readStatus)
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
import spray.json._

final case class DocumentRef(docType: String, ref: String)
final case class DecisionCase(status: String, vendorReasonCodes: List[String], documents: List[DocumentRef])

class DecisionStore {
  /** The case recorded for the applicant. */
  def get(applicantId: String): Option[DecisionCase] = None
}

class DocumentStorage {
  /** The permanent storage URL of a document. */
  def url(ref: String): String = ref
}

object StatusRead {
  implicit val system: ActorSystem = ActorSystem("kycd")
  val store = new DecisionStore
  val storage = new DocumentStorage

  val route: Route =
    path("v1" / "applicants" / Segment / "status") { applicantId =>
      get {
        // TODO: scope the lookup to the caller's tenant, map the vendor's internal codes onto the
        // customer-facing reason set, hand document access out through storage's link API, and
        // report the state a vendor failure leaves the case in. Review all four.
        store.get(applicantId) match {
          case None =>
            complete(StatusCodes.NotFound, JsObject("error" -> JsString("unknown applicant")))
          case Some(caseRecord) =>
            complete(
              StatusCodes.OK,
              JsObject(
                "applicant" -> JsString(applicantId),
                "status" -> JsString(caseRecord.status),
                "reasons" -> JsArray(caseRecord.vendorReasonCodes.map(JsString(_)).toVector),
                "documents" -> JsArray(
                  caseRecord.documents
                    .map(doc => JsObject("type" -> JsString(doc.docType), "url" -> JsString(storage.url(doc.ref))))
                    .toVector
                )
              )
            )
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
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

final case class DocumentRef(docType: String, ref: String)
final case class DecisionCase(
    status: String,
    vendorReasonCodes: List[String],
    degraded: Boolean,
    documents: List[DocumentRef]
)
final case class SignedLink(url: String, expires_at: String)

class DecisionStore {
  /** The case recorded for (tenant, applicant), if any. */
  def get(tenant: String, applicantId: String): Option[DecisionCase] = None
}

class DocumentStorage {
  /** A short-lived signed link for the document, with the expiry it carries. */
  def signUrl(tenant: String, ref: String, ttlSeconds: Int): SignedLink = SignedLink("", "")
}

object StatusRead {
  implicit val system: ActorSystem = ActorSystem("kycd")

  // The vendor's internal codes are not what a customer is allowed to read.
  val PublicReasons: Map[String, String] = Map(
    "FACEMATCH_LOW" -> "identity_mismatch",
    "DOC_GLARE" -> "document_unreadable",
    "ID_EXPIRED" -> "document_expired",
    "UNSUPPORTED_TYPE" -> "document_type_not_accepted"
  )
  val DocumentLinkTtlSeconds = 300

  val store = new DecisionStore
  val storage = new DocumentStorage

  def publicReasons(caseRecord: DecisionCase): List[String] =
    caseRecord.vendorReasonCodes.flatMap(PublicReasons.get).distinct.sorted

  val route: Route =
    path("v1" / "applicants" / Segment / "status") { applicantId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          tenantOpt.filter(_.nonEmpty) match {
            case None =>
              complete(StatusCodes.Unauthorized, JsObject("error" -> JsString("missing X-Tenant-Id")))
            case Some(tenant) =>
              store.get(tenant, applicantId) match {
                case None =>
                  complete(StatusCodes.NotFound, JsObject("error" -> JsString("unknown applicant")))
                case Some(caseRecord) =>
                  val documents = caseRecord.documents.map { doc =>
                    val link = storage.signUrl(tenant, doc.ref, DocumentLinkTtlSeconds)
                    JsObject(
                      "type" -> JsString(doc.docType),
                      "url" -> JsString(link.url),
                      "expires_at" -> JsString(link.expires_at)
                    )
                  }
                  complete(
                    StatusCodes.OK,
                    JsObject(
                      "applicant" -> JsString(applicantId),
                      "status" -> JsString(caseRecord.status),
                      "reasons" -> JsArray(publicReasons(caseRecord).map(JsString(_)).toVector),
                      "degraded" -> JsBoolean(caseRecord.degraded),
                      "manual_review" -> JsBoolean(caseRecord.status == "manual_review"),
                      "documents" -> JsArray(documents.toVector)
                    )
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

#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

struct DocumentRef {
  std::string type;
  std::string ref;
};

struct DecisionCase {
  std::string status;
  std::vector<std::string> vendor_reason_codes;
  std::vector<DocumentRef> documents;
};

struct DecisionStore {
  // The case recorded for the applicant.
  std::optional<DecisionCase> get(const std::string& applicantId);
};

struct DocumentStorage {
  // The permanent storage URL of a document.
  std::string url(const std::string& ref);
};

DecisionStore store;
DocumentStorage storage;

void writeJson(httplib::Response& res, int status, const std::string& body) {
  res.status = status;
  res.set_content(body, "application/json");
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/applicants/([^/]+)/status)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string applicantId = req.matches[1];
    // TODO: scope the lookup to the caller's tenant, map the vendor's internal codes onto the
    // customer-facing reason set, hand document access out through storage's link API, and report
    // the state a vendor failure leaves the case in. Review all four.
    const auto caseRecord = store.get(applicantId);
    if (!caseRecord) {
      writeJson(res, 404, R"({"error":"unknown applicant"})");
      return;
    }
    json documents = json::array();
    for (const auto& doc : caseRecord->documents) {
      documents.push_back(json{{"type", doc.type}, {"url", storage.url(doc.ref)}});
    }
    writeJson(res, 200, json{{"applicant", applicantId},
                             {"status", caseRecord->status},
                             {"reasons", caseRecord->vendor_reason_codes},
                             {"documents", documents}}
                              .dump());
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kDocumentLinkTtlSeconds = 300;

// The vendor's internal codes are not what a customer is allowed to read.
const std::map<std::string, std::string> kPublicReasons = {
    {"FACEMATCH_LOW", "identity_mismatch"},
    {"DOC_GLARE", "document_unreadable"},
    {"ID_EXPIRED", "document_expired"},
    {"UNSUPPORTED_TYPE", "document_type_not_accepted"},
};

struct DocumentRef {
  std::string type;
  std::string ref;
};

struct DecisionCase {
  std::string status;
  std::vector<std::string> vendor_reason_codes;
  bool degraded = false;
  std::vector<DocumentRef> documents;
};

struct SignedLink {
  std::string url;
  std::string expires_at;
};

struct DecisionStore {
  // The case recorded for (tenant, applicant), if any.
  std::optional<DecisionCase> get(const std::string& tenant, const std::string& applicantId);
};

struct DocumentStorage {
  // A short-lived signed link for the document, with the expiry it carries.
  SignedLink signUrl(const std::string& tenant, const std::string& ref, int ttlSeconds);
};

DecisionStore store;
DocumentStorage storage;

void writeJson(httplib::Response& res, int status, const std::string& body) {
  res.status = status;
  res.set_content(body, "application/json");
}

std::vector<std::string> publicReasons(const DecisionCase& caseRecord) {
  std::set<std::string> mapped;
  for (const auto& code : caseRecord.vendor_reason_codes) {
    const auto it = kPublicReasons.find(code);
    if (it != kPublicReasons.end()) mapped.insert(it->second);
  }
  return {mapped.begin(), mapped.end()};
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/applicants/([^/]+)/status)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      writeJson(res, 401, R"({"error":"missing X-Tenant-Id"})");
      return;
    }
    const std::string applicantId = req.matches[1];
    const auto caseRecord = store.get(tenant, applicantId);
    if (!caseRecord) {
      writeJson(res, 404, R"({"error":"unknown applicant"})");
      return;
    }
    json documents = json::array();
    for (const auto& doc : caseRecord->documents) {
      const auto link = storage.signUrl(tenant, doc.ref, kDocumentLinkTtlSeconds);
      documents.push_back(json{{"type", doc.type}, {"url", link.url}, {"expires_at", link.expires_at}});
    }
    writeJson(res, 200, json{{"applicant", applicantId},
                             {"status", caseRecord->status},
                             {"reasons", publicReasons(*caseRecord)},
                             {"degraded", caseRecord->degraded},
                             {"manual_review", caseRecord->status == "manual_review"},
                             {"documents", documents}}
                              .dump());
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Scope the read before anything else: take the caller from `X-Tenant-Id`, look the case up under `(tenant, applicant)`, and answer **404** when that pair is unknown — the same answer a foreign applicant gets, so the read never confirms that someone else’s case exists. An applicant id alone is a guess, not a permission.',
    'Reason codes are a product contract, not a debug view: keep a `PUBLIC_REASONS` map from the vendor’s internal codes onto a small customer-facing set, map every code before it leaves, and drop the codes with no mapping instead of forwarding them. That is also what lets the vendor change its taxonomy without changing what customers read.',
    'Documents leave only as storage-signed links: ask storage to sign `(tenant, ref)` with a TTL of a few minutes, return `expires_at` beside the URL, and never build or cache the URL yourself. The API should not even be able to serve document bytes — a permanent link is a leaked identity document the first time a response is screenshotted or shared.',
  ],
  debrief: `The interviewer is testing the read side of a verification system, where the interesting question is never "does it return a status" but "who may see it, in what language, and for how long". Three properties are checked. Scoping: the case is read under the authenticated tenant, and a foreign applicant gets the same **404** as an unknown one, so the endpoint cannot be used to enumerate other tenants' applicants — an unscoped read is an IDOR no matter how unguessable the id looks. Language: vendor codes are an internal vocabulary, so reason codes are mapped through a fixed public set; that keeps the vendor from writing customer-facing copy and lets its taxonomy evolve without an app release. Least disclosure: documents are photographs of identity papers, so the read returns signed links with a short expiry instead of permanent URLs — the bytes never transit the API, and a link that escapes a response dies on its own. The degraded/manual flag is the honesty part: "still deciding" and "a human has to look" are different answers, and the app can only show them if the service says so. Real systems add role-scoped views (support sees less than a reviewer), audit logging on every document link, and reason codes versioned alongside the app.`,
};
