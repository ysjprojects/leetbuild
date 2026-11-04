import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/verifications: the caller does not set the verdict',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis', 'storage'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/verifications\` on the provided \`kyc\` package: it
reads \`X-Tenant-Id\` and \`{applicant, documents: [{type, ref}], status}\`, reserves an attempt
(\`intake.reserve_attempt\`, **429** with \`Retry-After\` past the cap), fetches each document for its
digest (\`storage.fetch\`), opens the applicant's case (\`intake.open_case\`) and answers
\`{case_id, applicant, status}\`, **201** for a new case. It serves the demo and hides three flaws.

**Failure mode the checks target.** A partner integration opens cases that are already
\`approved\`; a utility bill passes as an identity document; and a caller with no tenant, or one that
names another tenant's passport, gets the service to download it.

- The verdict is the service's: a case opens \`pending\` whatever the body says, and the endpoint
  decides nothing.
- Every \`type\` is in \`ALLOWED_DOCUMENT_TYPES\` (\`passport\`, \`drivers_license\`, \`national_id\`),
  else **400**.
- A missing \`X-Tenant-Id\` is **401**; a \`ref\` outside \`documents/{tenant}/\` is **403**. Every
  refusal happens before an attempt is reserved or a document fetched.`,
  sequence: {
    participants: ['Applicant app', 'KYC API', 'Redis', 'Document storage'],
    messages: [
      {
        from: 'Applicant app',
        to: 'KYC API',
        label: 'POST /v1/verifications · X-Tenant-Id · {applicant, documents}',
        kind: 'sync',
      },
      {
        from: 'KYC API',
        to: 'KYC API',
        label: 'tenant → 401 · type allowlist → 400 · ref under documents/{tenant}/ → 403',
        kind: 'sync',
      },
      {from: 'KYC API', to: 'Redis', label: 'reserve_attempt(tenant, applicant)', kind: 'sync'},
      {from: 'Redis', to: 'KYC API', label: 'reserved / 429 Retry-After', kind: 'reply'},
      {from: 'KYC API', to: 'Document storage', label: 'fetch(ref) → digest', kind: 'sync'},
      {from: 'KYC API', to: 'Redis', label: 'open_case(tenant, applicant, documents)', kind: 'sync'},
      {from: 'KYC API', to: 'Applicant app', label: '201 {case_id, status: "pending"}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/verifications',
      detail:
        'Register `POST /v1/verifications`; a valid submission opens a pending case with each document’s digest and answers 201.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/verifications["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/verifications['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/verifications"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"verifications"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/verifications"/]},
      },
    },
    {
      id: 'caller-verdict',
      title: 'A status in the body never sets the case status',
      detail:
        'The case opens `pending` through `open_case`/`openCase` and the endpoint records no decision: nothing in it calls `decide`, so a body that says `approved` opens a pending case.',
      match: {
        python: {all: [/intake\.open_case\(/], none: [/\bdecide\(/, /body\.status/]},
        typescript: {all: [/openCase\(/], none: [/\bdecide\(/, /body\.status/]},
        go: {all: [/intake\.OpenCase\(/], none: [/\bDecide\(/, /body\.Status/]},
        scala: {all: [/Intake\.openCase\(/], none: [/\bdecide\(/, /"status"\)/]},
        cpp: {all: [/intake::openCase\(/], none: [/\bdecide\(/, /\["status"\]|value\(\s*"status"/]},
      },
    },
    {
      id: 'document-type',
      title: 'Accepts only the allowlisted document types',
      detail:
        'Every document type is checked against `ALLOWED_DOCUMENT_TYPES` (`passport`, `drivers_license`, `national_id`) and anything else is **400**, before an attempt is reserved.',
      match: {
        python: {all: [/ALLOWED_DOCUMENT_TYPES\s*=/, /not in ALLOWED_DOCUMENT_TYPES/, /\b400\b/]},
        typescript: {all: [/ALLOWED_DOCUMENT_TYPES\s*=/, /ALLOWED_DOCUMENT_TYPES\.(includes|has)\(/, /\b400\b/]},
        go: {all: [/allowedDocumentTypes\s*=/, /allowedDocumentTypes\[/, /StatusBadRequest/]},
        scala: {all: [/AllowedDocumentTypes\s*[:=]/, /AllowedDocumentTypes\.contains\(/, /BadRequest/]},
        cpp: {all: [/kAllowedDocumentTypes\s*=/, /kAllowedDocumentTypes\.(count|find|contains)\(/, /\b400\b/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Refuses a missing tenant and a foreign document before any fetch',
      detail:
        'A missing `X-Tenant-Id` is **401** and a `ref` outside `documents/{tenant}/` (trailing slash included) is **403**, both decided before `reserve_attempt` and `fetch` run, so the service never downloads another tenant’s document.',
      match: {
        python: {
          all: [/\b401\b/, /\b403\b/, /startswith\(\s*f["']documents\/\{tenant\}\/["']\s*\)/],
          order: [/startswith\(/, /intake\.reserve_attempt\(/, /storage\.fetch\(/],
        },
        typescript: {
          all: [/\b401\b/, /\b403\b/, /startsWith\(\s*`documents\/\$\{tenant\}\/`\s*\)/],
          order: [/startsWith\(/, /reserveAttempt\(/, /storage\.fetch\(/],
        },
        go: {
          all: [/StatusUnauthorized/, /StatusForbidden/, /HasPrefix\([^\n]*"documents\/"\s*\+\s*tenant\s*\+\s*"\/"/],
          order: [/HasPrefix\(/, /intake\.ReserveAttempt\(/, /storage\.Fetch\(/],
        },
        scala: {
          all: [/Unauthorized/, /Forbidden/, /startsWith\(\s*s"documents\/\$tenant\/"\s*\)/],
          order: [/startsWith\(/, /Intake\.reserveAttempt\(/, /Storage\.fetch\(/],
        },
        cpp: {
          all: [/\b401\b/, /\b403\b/, /rfind\(\s*"documents\/"\s*\+\s*tenant\s*\+\s*"\/"\s*,\s*0\s*\)/],
          order: [/rfind\(/, /intake::reserveAttempt\(/, /storage::fetch\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from kyc import cases, intake, storage  # cases.load/decide, intake.reserve_attempt/open_case, storage.fetch

app = FastAPI()


class DocumentRef(BaseModel):
    type: str
    ref: str


class Submission(BaseModel):
    applicant: str
    documents: list[DocumentRef]
    status: str | None = None  # partners submit applicants they already verified


@app.post("/v1/verifications")
def submit(body: Submission, request: Request) -> JSONResponse:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not body.documents:
        raise HTTPException(status_code=400, detail="at least one document is required")
    allowed, retry_after = intake.reserve_attempt(tenant, body.applicant)
    if not allowed:
        return JSONResponse({"error": "too many attempts"}, status_code=429, headers={"Retry-After": str(retry_after)})
    documents = []
    for document in body.documents:
        stored = storage.fetch(document.ref)
        if stored is None:
            raise HTTPException(status_code=422, detail=f"no document at {document.ref}")
        documents.append({"type": document.type, "ref": document.ref, "digest": stored["digest"]})
    case_id, created = intake.open_case(tenant, body.applicant, documents)
    if body.status:
        cases.decide(case_id, body.status, [], False)
    case = cases.load(case_id)
    return JSONResponse({"case_id": case_id, "applicant": body.applicant, "status": case["status"]}, status_code=201 if created else 200)
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from kyc import cases, intake, storage  # cases.load/decide, intake.reserve_attempt/open_case, storage.fetch

app = FastAPI()

ALLOWED_DOCUMENT_TYPES = ("passport", "drivers_license", "national_id")


class DocumentRef(BaseModel):
    type: str
    ref: str


class Submission(BaseModel):
    applicant: str
    documents: list[DocumentRef]


@app.post("/v1/verifications")
def submit(body: Submission, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    if not body.documents:
        raise HTTPException(status_code=400, detail="at least one document is required")
    # Every refusal comes before an attempt is spent or a byte is downloaded.
    for document in body.documents:
        if document.type not in ALLOWED_DOCUMENT_TYPES:
            raise HTTPException(status_code=400, detail=f"document type {document.type!r} is not accepted")
        if not document.ref.startswith(f"documents/{tenant}/"):
            raise HTTPException(status_code=403, detail="the document is not in this tenant's storage")
    allowed, retry_after = intake.reserve_attempt(tenant, body.applicant)
    if not allowed:
        return JSONResponse({"error": "too many attempts"}, status_code=429, headers={"Retry-After": str(retry_after)})
    documents = []
    for document in body.documents:
        stored = storage.fetch(document.ref)
        if stored is None:
            raise HTTPException(status_code=422, detail=f"no document at {document.ref}")
        documents.append({"type": document.type, "ref": document.ref, "digest": stored["digest"]})
    # The case opens pending: the verdict is the service's, whatever the caller sent.
    case_id, created = intake.open_case(tenant, body.applicant, documents)
    case = cases.load(case_id)
    return JSONResponse({"case_id": case_id, "applicant": body.applicant, "status": case["status"]}, status_code=201 if created else 200)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import * as cases from 'kyc/cases'; // cases.load, decide
import * as intake from 'kyc/intake'; // intake.reserveAttempt, openCase
import * as storage from 'kyc/storage'; // storage.fetch

export const app = Fastify();

interface Submission {
  applicant: string;
  documents: {type: string; ref: string}[];
  status?: string; // partners submit applicants they already verified
}

app.post('/v1/verifications', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  const body = request.body as Submission;
  if (!Array.isArray(body.documents) || body.documents.length === 0) return reply.code(400).send({error: 'at least one document is required'});
  const reservation = await intake.reserveAttempt(tenant, body.applicant);
  if (!reservation.allowed) return reply.code(429).header('Retry-After', String(reservation.retryAfterS)).send({error: 'too many attempts'});
  const documents: cases.Document[] = [];
  for (const document of body.documents) {
    const stored = await storage.fetch(document.ref);
    if (stored === null) return reply.code(422).send({error: \`no document at \${document.ref}\`});
    documents.push({type: document.type, ref: document.ref, digest: stored.digest});
  }
  const opened = await intake.openCase(tenant, body.applicant, documents);
  if (body.status) await cases.decide(opened.caseId, body.status, [], false);
  const current = (await cases.load(opened.caseId)) as cases.Case;
  return reply.code(opened.created ? 201 : 200).send({case_id: opened.caseId, applicant: body.applicant, status: current.status});
});
`,
      solution: `import Fastify from 'fastify';

import * as cases from 'kyc/cases'; // cases.load, decide
import * as intake from 'kyc/intake'; // intake.reserveAttempt, openCase
import * as storage from 'kyc/storage'; // storage.fetch

export const app = Fastify();

const ALLOWED_DOCUMENT_TYPES = ['passport', 'drivers_license', 'national_id'];

interface Submission {
  applicant: string;
  documents: {type: string; ref: string}[];
}

app.post('/v1/verifications', async (request, reply) => {
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  if (tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = request.body as Submission;
  if (!Array.isArray(body.documents) || body.documents.length === 0) return reply.code(400).send({error: 'at least one document is required'});
  // Every refusal comes before an attempt is spent or a byte is downloaded.
  for (const document of body.documents) {
    if (!ALLOWED_DOCUMENT_TYPES.includes(document.type)) return reply.code(400).send({error: \`document type \${document.type} is not accepted\`});
    if (!document.ref.startsWith(\`documents/\${tenant}/\`)) return reply.code(403).send({error: "the document is not in this tenant's storage"});
  }
  const reservation = await intake.reserveAttempt(tenant, body.applicant);
  if (!reservation.allowed) return reply.code(429).header('Retry-After', String(reservation.retryAfterS)).send({error: 'too many attempts'});
  const documents: cases.Document[] = [];
  for (const document of body.documents) {
    const stored = await storage.fetch(document.ref);
    if (stored === null) return reply.code(422).send({error: \`no document at \${document.ref}\`});
    documents.push({type: document.type, ref: document.ref, digest: stored.digest});
  }
  // The case opens pending: the verdict is the service's, whatever the caller sent.
  const opened = await intake.openCase(tenant, body.applicant, documents);
  const current = (await cases.load(opened.caseId)) as cases.Case;
  return reply.code(opened.created ? 201 : 200).send({case_id: opened.caseId, applicant: body.applicant, status: current.status});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	"kyc/cases"   // cases.Load, Decide, Document
	"kyc/intake"  // intake.ReserveAttempt, OpenCase
	"kyc/storage" // storage.Fetch
)

type documentRef struct {
	Type string \`json:"type"\`
	Ref  string \`json:"ref"\`
}

type submission struct {
	Applicant string        \`json:"applicant"\`
	Documents []documentRef \`json:"documents"\`
	Status    string        \`json:"status"\` // partners submit applicants they already verified
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func submit(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	var body submission
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Documents) == 0 {
		http.Error(rw, "applicant and at least one document are required", http.StatusBadRequest)
		return
	}
	allowed, retryAfter, err := intake.ReserveAttempt(r.Context(), tenant, body.Applicant)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if !allowed {
		rw.Header().Set("Retry-After", strconv.FormatInt(retryAfter, 10))
		http.Error(rw, "too many attempts", http.StatusTooManyRequests)
		return
	}
	documents := []cases.Document{}
	for _, d := range body.Documents {
		stored := storage.Fetch(r.Context(), d.Ref)
		if stored == nil {
			http.Error(rw, "no document at "+d.Ref, http.StatusUnprocessableEntity)
			return
		}
		documents = append(documents, cases.Document{Type: d.Type, Ref: d.Ref, Digest: stored.Digest})
	}
	caseID, created, err := intake.OpenCase(r.Context(), tenant, body.Applicant, documents)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if body.Status != "" {
		cases.Decide(r.Context(), caseID, body.Status, []string{}, false)
	}
	opened := cases.Load(r.Context(), caseID)
	code := http.StatusOK
	if created {
		code = http.StatusCreated
	}
	writeJSON(rw, code, map[string]string{"case_id": caseID, "applicant": body.Applicant, "status": opened.Status})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/verifications", submit)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"kyc/cases"   // cases.Load, Decide, Document
	"kyc/intake"  // intake.ReserveAttempt, OpenCase
	"kyc/storage" // storage.Fetch
)

var allowedDocumentTypes = map[string]bool{"passport": true, "drivers_license": true, "national_id": true}

type documentRef struct {
	Type string \`json:"type"\`
	Ref  string \`json:"ref"\`
}

type submission struct {
	Applicant string        \`json:"applicant"\`
	Documents []documentRef \`json:"documents"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func submit(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	var body submission
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Documents) == 0 {
		http.Error(rw, "applicant and at least one document are required", http.StatusBadRequest)
		return
	}
	// Every refusal comes before an attempt is spent or a byte is downloaded.
	for _, d := range body.Documents {
		if !allowedDocumentTypes[d.Type] {
			http.Error(rw, "document type "+d.Type+" is not accepted", http.StatusBadRequest)
			return
		}
		if !strings.HasPrefix(d.Ref, "documents/"+tenant+"/") {
			http.Error(rw, "the document is not in this tenant's storage", http.StatusForbidden)
			return
		}
	}
	allowed, retryAfter, err := intake.ReserveAttempt(r.Context(), tenant, body.Applicant)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if !allowed {
		rw.Header().Set("Retry-After", strconv.FormatInt(retryAfter, 10))
		http.Error(rw, "too many attempts", http.StatusTooManyRequests)
		return
	}
	documents := []cases.Document{}
	for _, d := range body.Documents {
		stored := storage.Fetch(r.Context(), d.Ref)
		if stored == nil {
			http.Error(rw, "no document at "+d.Ref, http.StatusUnprocessableEntity)
			return
		}
		documents = append(documents, cases.Document{Type: d.Type, Ref: d.Ref, Digest: stored.Digest})
	}
	// The case opens pending: the verdict is the service's, whatever the caller sent.
	caseID, created, err := intake.OpenCase(r.Context(), tenant, body.Applicant, documents)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	opened := cases.Load(r.Context(), caseID)
	code := http.StatusOK
	if created {
		code = http.StatusCreated
	}
	writeJSON(rw, code, map[string]string{"case_id": caseID, "applicant": body.Applicant, "status": opened.Status})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/verifications", submit)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import kyc.{Cases, Intake, Storage} // Cases.load/decide, Intake.reserveAttempt/openCase, Storage.fetch

object Api {
  private def json(status: StatusCode, body: JsObject, headers: List[RawHeader] = Nil): HttpResponse =
    HttpResponse(status, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def text(fields: Map[String, JsValue], name: String): String = fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  private def submit(tenant: String, raw: String): HttpResponse = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    val fields = raw.parseJson.asJsObject.fields
    val applicant = text(fields, "applicant")
    val requested = text(fields, "status") // partners submit applicants they already verified
    val documents = fields.get("documents").collect { case JsArray(items) => items.map(i => (text(i.asJsObject.fields, "type"), text(i.asJsObject.fields, "ref"))) }.getOrElse(Vector.empty)
    if (applicant.isEmpty || documents.isEmpty) error(StatusCodes.BadRequest, "applicant and at least one document are required")
    else {
      val (allowed, retryAfter) = Intake.reserveAttempt(tenant, applicant)
      if (!allowed) json(StatusCodes.TooManyRequests, JsObject("error" -> JsString("too many attempts")), List(RawHeader("Retry-After", retryAfter.toString)))
      else {
        val fetched = documents.map { case (documentType, ref) => (documentType, ref, Storage.fetch(ref)) }
        fetched.collectFirst { case (_, ref, None) => ref } match {
          case Some(ref) => error(StatusCodes.UnprocessableEntity, s"no document at $ref")
          case None =>
            val stored = fetched.collect { case (documentType, ref, Some(obj)) => Cases.Document(documentType, ref, obj.digest) }
            val (caseId, created) = Intake.openCase(tenant, applicant, stored)
            if (requested.nonEmpty) Cases.decide(caseId, requested, Nil, degraded = false)
            val opened = Cases.load(caseId).get
            json(if (created) StatusCodes.Created else StatusCodes.OK, JsObject("case_id" -> JsString(caseId), "applicant" -> JsString(applicant), "status" -> JsString(opened.status)))
        }
      }
    }
  }

  val route: Route = path("v1" / "verifications") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        entity(as[String]) { raw =>
          complete(submit(tenant.getOrElse(""), raw))
        }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import kyc.{Cases, Intake, Storage} // Cases.load/decide, Intake.reserveAttempt/openCase, Storage.fetch

object Api {
  val AllowedDocumentTypes: Set[String] = Set("passport", "drivers_license", "national_id")

  private def json(status: StatusCode, body: JsObject, headers: List[RawHeader] = Nil): HttpResponse =
    HttpResponse(status, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def text(fields: Map[String, JsValue], name: String): String = fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  private def submit(tenant: String, raw: String): HttpResponse = {
    val fields = raw.parseJson.asJsObject.fields
    val applicant = text(fields, "applicant")
    val documents = fields.get("documents").collect { case JsArray(items) => items.map(i => (text(i.asJsObject.fields, "type"), text(i.asJsObject.fields, "ref"))) }.getOrElse(Vector.empty)
    // Every refusal comes before an attempt is spent or a byte is downloaded.
    if (applicant.isEmpty || documents.isEmpty) error(StatusCodes.BadRequest, "applicant and at least one document are required")
    else if (documents.exists { case (documentType, _) => !AllowedDocumentTypes.contains(documentType) }) error(StatusCodes.BadRequest, "document type is not accepted")
    else if (documents.exists { case (_, ref) => !ref.startsWith(s"documents/$tenant/") }) error(StatusCodes.Forbidden, "the document is not in this tenant's storage")
    else {
      val (allowed, retryAfter) = Intake.reserveAttempt(tenant, applicant)
      if (!allowed) json(StatusCodes.TooManyRequests, JsObject("error" -> JsString("too many attempts")), List(RawHeader("Retry-After", retryAfter.toString)))
      else {
        val fetched = documents.map { case (documentType, ref) => (documentType, ref, Storage.fetch(ref)) }
        fetched.collectFirst { case (_, ref, None) => ref } match {
          case Some(ref) => error(StatusCodes.UnprocessableEntity, s"no document at $ref")
          case None =>
            val stored = fetched.collect { case (documentType, ref, Some(obj)) => Cases.Document(documentType, ref, obj.digest) }
            // The case opens pending: the verdict is the service's, whatever the caller sent.
            val (caseId, created) = Intake.openCase(tenant, applicant, stored)
            val opened = Cases.load(caseId).get
            json(if (created) StatusCodes.Created else StatusCodes.OK, JsObject("case_id" -> JsString(caseId), "applicant" -> JsString(applicant), "status" -> JsString(opened.status)))
        }
      }
    }
  }

  val route: Route = path("v1" / "verifications") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        entity(as[String]) { raw =>
          tenant.filter(_.nonEmpty) match {
            case None => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
            case Some(t) => complete(submit(t, raw))
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
#include <vector>

#include "kyc/cases.h"    // cases::load, decide, Document
#include "kyc/intake.h"   // intake::reserveAttempt, openCase
#include "kyc/storage.h"  // storage::fetch

using json = nlohmann::json;

void reply_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void submit(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const json body = json::parse(req.body, nullptr, false);
  if (body.is_discarded() || !body.contains("documents") || !body["documents"].is_array() || body["documents"].empty()) {
    return reply_json(res, 400, {{"error", "applicant and at least one document are required"}});
  }
  const std::string applicant = body.value("applicant", "");
  const std::string requested = body.value("status", "");  // partners submit applicants they already verified
  const intake::Reservation reservation = intake::reserveAttempt(tenant, applicant);
  if (!reservation.allowed) {
    res.set_header("Retry-After", std::to_string(reservation.retry_after_s));
    return reply_json(res, 429, {{"error", "too many attempts"}});
  }
  std::vector<cases::Document> documents;
  for (const json& d : body["documents"]) {
    const std::string ref = d.value("ref", "");
    const auto stored = storage::fetch(ref);
    if (!stored) return reply_json(res, 422, {{"error", "no document at " + ref}});
    documents.push_back({d.value("type", ""), ref, stored->digest});
  }
  const intake::Opened opened = intake::openCase(tenant, applicant, documents);
  if (!requested.empty()) cases::decide(opened.case_id, requested, {}, false);
  const cases::Case current = *cases::load(opened.case_id);
  reply_json(res, opened.created ? 201 : 200, {{"case_id", opened.case_id}, {"applicant", applicant}, {"status", current.status}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/verifications", submit); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>
#include <vector>

#include "kyc/cases.h"    // cases::load, decide, Document
#include "kyc/intake.h"   // intake::reserveAttempt, openCase
#include "kyc/storage.h"  // storage::fetch

using json = nlohmann::json;

const std::set<std::string> kAllowedDocumentTypes = {"passport", "drivers_license", "national_id"};

void reply_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void submit(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply_json(res, 401, {{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (body.is_discarded() || !body.contains("documents") || !body["documents"].is_array() || body["documents"].empty()) {
    return reply_json(res, 400, {{"error", "applicant and at least one document are required"}});
  }
  const std::string applicant = body.value("applicant", "");
  // Every refusal comes before an attempt is spent or a byte is downloaded.
  for (const json& d : body["documents"]) {
    if (!kAllowedDocumentTypes.count(d.value("type", ""))) return reply_json(res, 400, {{"error", "document type is not accepted"}});
    if (d.value("ref", "").rfind("documents/" + tenant + "/", 0) != 0) {
      return reply_json(res, 403, {{"error", "the document is not in this tenant's storage"}});
    }
  }
  const intake::Reservation reservation = intake::reserveAttempt(tenant, applicant);
  if (!reservation.allowed) {
    res.set_header("Retry-After", std::to_string(reservation.retry_after_s));
    return reply_json(res, 429, {{"error", "too many attempts"}});
  }
  std::vector<cases::Document> documents;
  for (const json& d : body["documents"]) {
    const std::string ref = d.value("ref", "");
    const auto stored = storage::fetch(ref);
    if (!stored) return reply_json(res, 422, {{"error", "no document at " + ref}});
    documents.push_back({d.value("type", ""), ref, stored->digest});
  }
  // The case opens pending: the verdict is the service's, whatever the caller sent.
  const intake::Opened opened = intake::openCase(tenant, applicant, documents);
  const cases::Case current = *cases::load(opened.case_id);
  reply_json(res, opened.created ? 201 : 200, {{"case_id", opened.case_id}, {"applicant", applicant}, {"status", current.status}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/verifications", submit); }
`,
    },
  },
  harness: {
    python: `from kyc import cases, storage

PASSPORT = {"type": "passport", "ref": "documents/t-a/passport-1.jpg"}


def _api(ctx):
    storage.put("documents/t-a/passport-1.jpg", "<passport scan of a-1>", "sha256:5e1f0c")
    storage.put("documents/t-a/license-1.jpg", "<licence scan of a-1>", "sha256:77ab02")
    storage.put("documents/t-b/passport-7.jpg", "<passport scan of tenant t-b's applicant>", "sha256:c0ffee")
    storage.put("documents/t-ab/passport-3.jpg", "<passport scan of tenant t-ab's applicant>", "sha256:0b0e11")
    return ctx.client(ctx.load("api").app)


async def _submit(c, body, tenant="t-a"):
    return await c.post("/v1/verifications", json=body, headers={"X-Tenant-Id": tenant} if tenant else {})


def _untouched(ctx, what):
    fetched = ctx.redis.lrange("storage:fetches", 0, -1)
    assert fetched == [], f"{what} was refused only after the service downloaded {fetched}: refuse before anything is fetched"
    assert ctx.redis.get("kyc:attempts:t-a:a-1") is None, f"{what} spent one of the applicant's attempts: refuse before reserve_attempt"
    assert cases.lookup("t-a", "a-1") is None, f"{what} opened a case: {cases.lookup('t-a', 'a-1')}"


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _submit(c, {"applicant": "a-1", "documents": [PASSPORT]})
    assert r.status_code == 201, f"POST /v1/verifications answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("status") == "pending" and body.get("applicant") == "a-1", f"a new submission must answer a pending case for a-1, got {body}"
    case = cases.load(body.get("case_id", ""))
    assert case is not None and case["tenant"] == "t-a", f"the store holds {case} for case {body.get('case_id')!r}"
    want = [{"type": "passport", "ref": PASSPORT["ref"], "digest": "sha256:5e1f0c"}]
    assert case["documents"] == want, f"the case must carry each document with its digest, got {case['documents']}"


async def check_caller_verdict(ctx):
    async with _api(ctx) as c:
        r = await _submit(c, {"applicant": "a-1", "status": "approved", "documents": [PASSPORT]})
    assert r.status_code == 201, f"a submission carrying a status answered {r.status_code}: {r.text}"
    assert r.json().get("status") == "pending", f"a body that says approved opened a case answering {r.json()}: the caller set its own verdict"
    case = cases.load(r.json()["case_id"])
    assert case["status"] == "pending", f"a body that says approved left the case {case['status']!r} in the store: the verdict is the service's, the case opens pending"


async def check_document_type(ctx):
    async with _api(ctx) as c:
        r = await _submit(c, {"applicant": "a-1", "documents": [{"type": "utility_bill", "ref": "documents/t-a/license-1.jpg"}]})
        assert r.status_code == 400, f"a utility_bill answered {r.status_code}, expected 400: only passport, drivers_license and national_id prove an identity"
        _untouched(ctx, "a utility_bill")
        for kind in ("passport", "drivers_license", "national_id"):
            ok = await _submit(c, {"applicant": f"a-{kind}", "documents": [{"type": kind, "ref": "documents/t-a/license-1.jpg"}]})
            assert ok.status_code == 201, f"a {kind} answered {ok.status_code}: {ok.text}"


async def check_tenant_scope(ctx):
    async with _api(ctx) as c:
        r = await _submit(c, {"applicant": "a-1", "documents": [PASSPORT]}, tenant=None)
        assert r.status_code == 401, f"a submission without X-Tenant-Id answered {r.status_code}, expected 401"
        _untouched(ctx, "a submission without X-Tenant-Id")
        for ref in ("documents/t-b/passport-7.jpg", "documents/t-ab/passport-3.jpg"):
            r = await _submit(c, {"applicant": "a-1", "documents": [{"type": "passport", "ref": ref}]})
            assert r.status_code == 403, f"tenant t-a naming {ref} answered {r.status_code}, expected 403: the document is another tenant's"
            _untouched(ctx, f"a ref to {ref}")
`,
    typescript: `const PASSPORT = {type: 'passport', ref: 'documents/t-a/passport-1.jpg'};

async function api(ctx) {
  const storage = ctx.load('/support/kyc/storage.ts');
  await storage.put('documents/t-a/passport-1.jpg', '<passport scan of a-1>', 'sha256:5e1f0c');
  await storage.put('documents/t-a/license-1.jpg', '<licence scan of a-1>', 'sha256:77ab02');
  await storage.put('documents/t-b/passport-7.jpg', "<passport scan of tenant t-b's applicant>", 'sha256:c0ffee');
  await storage.put('documents/t-ab/passport-3.jpg', "<passport scan of tenant t-ab's applicant>", 'sha256:0b0e11');
  return {c: ctx.client(ctx.load('api').app), cases: ctx.load('/support/kyc/cases.ts')};
}

const submit = (c, body, tenant: string | null = 't-a') =>
  c.post('/v1/verifications', {json: body, headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});

async function untouched(ctx, cases, what: string): Promise<void> {
  const fetched = ctx.redis.lrange('storage:fetches', 0, -1);
  assert.equal(fetched.length, 0, \`\${what} was refused only after the service downloaded \${JSON.stringify(fetched)}: refuse before anything is fetched\`);
  assert.equal(ctx.redis.get('kyc:attempts:t-a:a-1'), null, \`\${what} spent one of the applicant's attempts: refuse before reserveAttempt\`);
  assert.equal(await cases.lookup('t-a', 'a-1'), null, \`\${what} opened a case\`);
}

export async function check_route(ctx) {
  const {c, cases} = await api(ctx);
  const r = await submit(c, {applicant: 'a-1', documents: [PASSPORT]});
  assert.equal(r.status, 201, \`POST /v1/verifications answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.status === 'pending' && body.applicant === 'a-1', \`a new submission must answer a pending case for a-1, got \${r.text}\`);
  const stored = await cases.load(body.case_id ?? '');
  assert(stored !== null && stored.tenant === 't-a', \`the store holds \${JSON.stringify(stored)} for case \${body.case_id}\`);
  assert.deepStrictEqual(stored.documents, [{type: 'passport', ref: PASSPORT.ref, digest: 'sha256:5e1f0c'}], \`the case must carry each document with its digest, got \${JSON.stringify(stored.documents)}\`);
}

export async function check_caller_verdict(ctx) {
  const {c, cases} = await api(ctx);
  const r = await submit(c, {applicant: 'a-1', status: 'approved', documents: [PASSPORT]});
  assert.equal(r.status, 201, \`a submission carrying a status answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().status, 'pending', \`a body that says approved opened a case answering \${r.text}: the caller set its own verdict\`);
  const stored = await cases.load(r.json().case_id);
  assert.equal(stored.status, 'pending', \`a body that says approved left the case \${stored.status} in the store: the verdict is the service's, the case opens pending\`);
}

export async function check_document_type(ctx) {
  const {c, cases} = await api(ctx);
  const r = await submit(c, {applicant: 'a-1', documents: [{type: 'utility_bill', ref: 'documents/t-a/license-1.jpg'}]});
  assert.equal(r.status, 400, \`a utility_bill answered \${r.status}, expected 400: only passport, drivers_license and national_id prove an identity\`);
  await untouched(ctx, cases, 'a utility_bill');
  for (const kind of ['passport', 'drivers_license', 'national_id']) {
    const ok = await submit(c, {applicant: \`a-\${kind}\`, documents: [{type: kind, ref: 'documents/t-a/license-1.jpg'}]});
    assert.equal(ok.status, 201, \`a \${kind} answered \${ok.status}: \${ok.text}\`);
  }
}

export async function check_tenant_scope(ctx) {
  const {c, cases} = await api(ctx);
  let r = await submit(c, {applicant: 'a-1', documents: [PASSPORT]}, null);
  assert.equal(r.status, 401, \`a submission without X-Tenant-Id answered \${r.status}, expected 401\`);
  await untouched(ctx, cases, 'a submission without X-Tenant-Id');
  for (const ref of ['documents/t-b/passport-7.jpg', 'documents/t-ab/passport-3.jpg']) {
    r = await submit(c, {applicant: 'a-1', documents: [{type: 'passport', ref}]});
    assert.equal(r.status, 403, \`tenant t-a naming \${ref} answered \${r.status}, expected 403: the document is another tenant's\`);
    await untouched(ctx, cases, \`a ref to \${ref}\`);
  }
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"kyc/cases"
	"kyc/storage"

	"leetbuild/harness"
)

var bg = context.Background()

var passport = map[string]string{"type": "passport", "ref": "documents/t-a/passport-1.jpg"}

func api(ctx *harness.Ctx) *harness.HTTP {
	storage.Put(bg, "documents/t-a/passport-1.jpg", "<passport scan of a-1>", "sha256:5e1f0c")
	storage.Put(bg, "documents/t-a/license-1.jpg", "<licence scan of a-1>", "sha256:77ab02")
	storage.Put(bg, "documents/t-b/passport-7.jpg", "<passport scan of tenant t-b's applicant>", "sha256:c0ffee")
	storage.Put(bg, "documents/t-ab/passport-3.jpg", "<passport scan of tenant t-ab's applicant>", "sha256:0b0e11")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func submitAs(c *harness.HTTP, tenant string, body map[string]any) *harness.Response {
	if tenant == "" {
		return c.Post("/v1/verifications", body)
	}
	return c.Post("/v1/verifications", body, "X-Tenant-Id", tenant)
}

type opened struct {
	CaseID    string \`json:"case_id"\`
	Applicant string \`json:"applicant"\`
	Status    string \`json:"status"\`
}

func untouched(ctx *harness.Ctx, what string) {
	fetched := ctx.Redis.LRange("storage:fetches", 0, -1)
	ctx.Assert(len(fetched) == 0, "%s was refused only after the service downloaded %q: refuse before anything is fetched", what, fetched)
	_, spent := ctx.Redis.Get("kyc:attempts:t-a:a-1")
	ctx.Assert(!spent, "%s spent one of the applicant's attempts: refuse before ReserveAttempt", what)
	ctx.Assert(cases.Lookup(bg, "t-a", "a-1") == nil, "%s opened a case", what)
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := submitAs(c, "t-a", map[string]any{"applicant": "a-1", "documents": []any{passport}})
	ctx.Equal(r.Status, 201, "POST /v1/verifications (%s)", r.Text())
	var body opened
	r.Decode(&body)
	ctx.Assert(body.Status == "pending" && body.Applicant == "a-1", "a new submission must answer a pending case for a-1, got %s", r.Text())
	stored := cases.Load(bg, body.CaseID)
	ctx.Assert(stored != nil && stored.Tenant == "t-a", "the store holds %+v for case %q", stored, body.CaseID)
	ctx.Equal(stored.Documents, []cases.Document{{Type: "passport", Ref: "documents/t-a/passport-1.jpg", Digest: "sha256:5e1f0c"}}, "the case must carry each document with its digest")
}

func CheckCallerVerdict(ctx *harness.Ctx) {
	c := api(ctx)
	r := submitAs(c, "t-a", map[string]any{"applicant": "a-1", "status": "approved", "documents": []any{passport}})
	ctx.Equal(r.Status, 201, "a submission carrying a status (%s)", r.Text())
	var body opened
	r.Decode(&body)
	ctx.Equal(body.Status, "pending", "a body that says approved opened a case answering %s: the caller set its own verdict; the status", r.Text())
	ctx.Equal(cases.Load(bg, body.CaseID).Status, "pending", "a body that says approved must leave the case pending in the store (the verdict is the service's); the stored status")
}

func CheckDocumentType(ctx *harness.Ctx) {
	c := api(ctx)
	r := submitAs(c, "t-a", map[string]any{"applicant": "a-1", "documents": []any{map[string]string{"type": "utility_bill", "ref": "documents/t-a/license-1.jpg"}}})
	ctx.Equal(r.Status, 400, "a utility_bill (only passport, drivers_license and national_id prove an identity)")
	untouched(ctx, "a utility_bill")
	for _, kind := range []string{"passport", "drivers_license", "national_id"} {
		ok := submitAs(c, "t-a", map[string]any{"applicant": "a-" + kind, "documents": []any{map[string]string{"type": kind, "ref": "documents/t-a/license-1.jpg"}}})
		ctx.Equal(ok.Status, 201, "a %s (%s)", kind, ok.Text())
	}
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := api(ctx)
	r := submitAs(c, "", map[string]any{"applicant": "a-1", "documents": []any{passport}})
	ctx.Equal(r.Status, 401, "a submission without X-Tenant-Id")
	untouched(ctx, "a submission without X-Tenant-Id")
	for _, ref := range []string{"documents/t-b/passport-7.jpg", "documents/t-ab/passport-3.jpg"} {
		r = submitAs(c, "t-a", map[string]any{"applicant": "a-1", "documents": []any{map[string]string{"type": "passport", "ref": ref}}})
		ctx.Equal(r.Status, 403, "tenant t-a naming %s (the document is another tenant's)", ref)
		untouched(ctx, "a ref to "+ref)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "kyc/cases.h"
#include "kyc/storage.h"

namespace {

const std::string kPassport = R"({"type": "passport", "ref": "documents/t-a/passport-1.jpg"})";

harness::HTTP api(harness::Ctx& ctx) {
  storage::put("documents/t-a/passport-1.jpg", "<passport scan of a-1>", "sha256:5e1f0c");
  storage::put("documents/t-a/license-1.jpg", "<licence scan of a-1>", "sha256:77ab02");
  storage::put("documents/t-b/passport-7.jpg", "<passport scan of tenant t-b's applicant>", "sha256:c0ffee");
  storage::put("documents/t-ab/passport-3.jpg", "<passport scan of tenant t-ab's applicant>", "sha256:0b0e11");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response submitAs(harness::HTTP& c, const std::string& tenant, const std::string& body) {
  if (tenant.empty()) return c.Post("/v1/verifications", body, "Content-Type", "application/json");
  return c.Post("/v1/verifications", body, "Content-Type", "application/json", "X-Tenant-Id", tenant);
}

std::string document(const std::string& type, const std::string& ref) {
  return nlohmann::json{{"type", type}, {"ref", ref}}.dump();
}

void untouched(harness::Ctx& ctx, const std::string& what) {
  const auto fetched = ctx.Redis.LRange("storage:fetches", 0, -1);
  ctx.Assert(fetched.empty(), "%s was refused only after the service downloaded %q: refuse before anything is fetched", what, fetched);
  ctx.Assert(!ctx.Redis.Get("kyc:attempts:t-a:a-1"), "%s spent one of the applicant's attempts: refuse before reserveAttempt", what);
  ctx.Assert(!cases::lookup("t-a", "a-1"), "%s opened a case", what);
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = submitAs(c, "t-a", R"({"applicant": "a-1", "documents": [)" + kPassport + "]}");
  ctx.Equal(r.Status, 201, "POST /v1/verifications (%s)", r.Text());
  const auto body = nlohmann::json::parse(r.Text());
  ctx.Assert(body.value("status", "") == "pending" && body.value("applicant", "") == "a-1", "a new submission must answer a pending case for a-1, got %s", r.Text());
  const auto stored = cases::load(body.value("case_id", ""));
  ctx.Assert(stored && stored->tenant == "t-a", "the store holds no case of tenant t-a under %q", body.value("case_id", ""));
  ctx.Assert(stored->documents.size() == 1 && stored->documents[0].ref == "documents/t-a/passport-1.jpg" && stored->documents[0].digest == "sha256:5e1f0c",
             "the case must carry each document with its digest, got %s", cases::documentsJson(stored->documents).dump());
}

void CheckCallerVerdict(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = submitAs(c, "t-a", R"({"applicant": "a-1", "status": "approved", "documents": [)" + kPassport + "]}");
  ctx.Equal(r.Status, 201, "a submission carrying a status (%s)", r.Text());
  const auto body = nlohmann::json::parse(r.Text());
  ctx.Equal(body.value("status", ""), "pending", "a body that says approved opened a case answering %s: the caller set its own verdict; the status", r.Text());
  ctx.Equal(cases::load(body.value("case_id", ""))->status, "pending", "a body that says approved must leave the case pending in the store (the verdict is the service's); the stored status");
}

void CheckDocumentType(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = submitAs(c, "t-a", R"({"applicant": "a-1", "documents": [)" + document("utility_bill", "documents/t-a/license-1.jpg") + "]}");
  ctx.Equal(r.Status, 400, "a utility_bill (only passport, drivers_license and national_id prove an identity)");
  untouched(ctx, "a utility_bill");
  for (const std::string kind : {"passport", "drivers_license", "national_id"}) {
    const auto ok = submitAs(c, "t-a", R"({"applicant": "a-)" + kind + R"(", "documents": [)" + document(kind, "documents/t-a/license-1.jpg") + "]}");
    ctx.Equal(ok.Status, 201, "a %s (%s)", kind, ok.Text());
  }
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = submitAs(c, "", R"({"applicant": "a-1", "documents": [)" + kPassport + "]}");
  ctx.Equal(r.Status, 401, "a submission without X-Tenant-Id");
  untouched(ctx, "a submission without X-Tenant-Id");
  for (const std::string ref : {"documents/t-b/passport-7.jpg", "documents/t-ab/passport-3.jpg"}) {
    r = submitAs(c, "t-a", R"({"applicant": "a-1", "documents": [)" + document("passport", ref) + "]}");
    ctx.Equal(r.Status, 403, "tenant t-a naming %s (the document is another tenant's)", ref);
    untouched(ctx, "a ref to " + ref);
  }
}
`,
  },
  hints: [
    'Submit with `"status": "approved"` and the response says approved. Submit a ref under another tenant’s folder, or no tenant at all, and a case opens with that passport’s digest.',
    'After opening the case the starter hands the body’s `status` to `cases.decide`. Nothing checks `type`, the tenant header may be empty, and `storage.fetch` runs on whatever `ref` arrives.',
    'Drop the `status` field and the `decide` call. Before `reserve_attempt`: 401 on an empty tenant, 400 on a type outside `ALLOWED_DOCUMENT_TYPES`, 403 unless `ref.startswith(f"documents/{tenant}/")`.',
  ],
  debrief: `The order is the fix. Authentication, the allowlist and the tenant prefix are checks on what the caller sent, so they run before the service spends anything on the request: an attempt, a download, a case. The trailing slash in the prefix keeps \`t-a\` from reading \`t-ab\`'s folder. Dropping the caller's \`status\` takes a write path away instead of validating it, because no value of it is safe. Production intake signs the upload URLs itself so a \`ref\` names an object the tenant uploaded, normalises paths before comparing them, and logs every refusal against the tenant's credentials so abuse shows up before the vendor bill does.`,
};
