import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/cases/{id}: review without oversharing',
  concept: 'http',
  file: 'read',
  focus: ['reviewer', 'scorer', 'accounts', 'audit'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/cases/{id}\` for the review console: it looks the
case up with \`cases.get(case_id)\`, answers a miss with 404, builds the body in \`case_view\` with
the score, band, signals, velocity, \`card_number: record["pan"]\` and \`raw_features\`, and adds an
unmasked \`pan\` when the caller's role header says \`admin\`. It serves the demo and hides four
flaws.

**Failure mode the checks target.** A cross-tenant card-data export: any caller reads any case by
guessing an id, the body carries the full card number and the feature vector, and the role gate is
a header the client sets.

- Read the case scoped to the authenticated \`X-Tenant-Id\`: \`cases.get(tenant, case_id)\`. A
  foreign case is **404**, not 403 and not a partial body.
- Return score, band, signals, velocity snapshot and a masked card reference: \`mask_card(pan)\`
  (\`MASK_PREFIX\` plus the last four digits), applied in the response builder.
- No \`card_number\`, \`pan\` or raw feature vector for any role, \`admin\` included.
- Raw card data is reachable only through \`audited_pan(actor, tenant, case_id)\`, which writes
  \`audit_log.record(actor, scope, case_id)\` before returning the PAN.`,
  sequence: {
    participants: ['Review console', 'Fraud Scorer', 'Case store', 'Audit tool'],
    messages: [
      {from: 'Review console', to: 'Fraud Scorer', label: 'GET /v1/cases/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Fraud Scorer', to: 'Case store', label: 'cases.get(tenant, case_id)', kind: 'sync'},
      {from: 'Case store', to: 'Fraud Scorer', label: 'scoped record / none', kind: 'reply'},
      {from: 'Fraud Scorer', to: 'Fraud Scorer', label: '404 for a foreign case', kind: 'sync'},
      {from: 'Fraud Scorer', to: 'Fraud Scorer', label: 'mask_card(pan) · digest · signals · velocity', kind: 'sync'},
      {
        from: 'Fraud Scorer',
        to: 'Review console',
        label: '200 {score, band, signals, velocity, card_ref}',
        kind: 'reply',
      },
      {
        from: 'Review console',
        to: 'Audit tool',
        label: 'audited_pan(actor, tenant, case_id) · scope pan:read',
        kind: 'sync',
      },
      {from: 'Audit tool', to: 'Case store', label: 'raw PAN + audit row', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'route-param',
      title: 'Serves GET /v1/cases/{id}',
      detail: 'Register the case read on `GET /v1/cases/{id}` with the case id as a path parameter.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/cases\/\{case_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/cases\/:caseId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/cases\//]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"cases"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(/, /\/v1\/cases\//]},
      },
    },
    {
      id: 'masking',
      title: 'Masking is enforced in the response',
      detail:
        '`mask_card(pan)` returns `MASK_PREFIX` plus the last four digits and the response builder uses it for the account’s card reference. The starter returns the full card number, which turns a review screen into a card-data export.',
      match: {
        python: {all: [/def mask_card\(/, /MASK_PREFIX/]},
        typescript: {all: [/function maskCard\(/, /MASK_PREFIX/]},
        go: {all: [/func maskCard\(/, /maskPrefix/]},
        scala: {all: [/def maskCard\(/, /MaskPrefix/]},
        cpp: {all: [/maskCard\(/, /kMaskPrefix/]},
      },
    },
    {
      id: 'raw-pan-absent',
      title: 'No raw card data in the response, whatever the role',
      detail:
        'The case detail carries no full card number: the masked `card_ref` replaces it and no `card_number` field exists. The starter ships `card_number` to everyone and an unmasked `pan` to anyone who claims the admin role.',
      match: {
        python: {all: [/mask_card\(/], none: [/card_number/]},
        typescript: {all: [/maskCard\(/], none: [/card_number/]},
        go: {all: [/maskCard\(/], none: [/card_number/]},
        scala: {all: [/maskCard\(/], none: [/card_number/]},
        cpp: {all: [/maskCard\(/], none: [/card_number/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'A foreign case is 404',
      detail:
        "The lookup is scoped with the caller's tenant, `cases.get(tenant, case_id)`, and a miss is **404**, so a case id from another tenant is indistinguishable from an unknown one. The starter looks the case up by id alone, so any authenticated caller can read any case.",
      match: {
        python: {all: [/cases\.get\(tenant/, /\b404\b/]},
        typescript: {all: [/cases\.get\(tenant/, /\b404\b/]},
        go: {all: [/cases\.Get\(ctx,\s*tenant/, /StatusNotFound/]},
        scala: {all: [/cases\.get\(tenant/, /NotFound/]},
        cpp: {all: [/cases\.get\(tenant/, /\b404\b/]},
      },
    },
    {
      id: 'audited-tool',
      title: 'Raw card data lives behind a separately audited tool',
      detail:
        '`audited_pan(actor, tenant, case_id)` resolves the case for that tenant, writes an audit row with a declared scope, and only then returns the PAN. The starter instead branches on a caller-supplied role inside the read handler, `if role == "admin"`, which is a client-controlled bypass, not authorization.',
      match: {
        python: {all: [/def audited_pan\(/, /audit_log\.record\(/], none: [/role\s*==\s*["']admin["']/]},
        typescript: {all: [/function auditedPan\(/, /auditLog\.record\(/], none: [/role\s*===\s*['"]admin['"]/]},
        go: {all: [/func auditedPan\(/, /auditLog\.Record\(/], none: [/role\s*==\s*"admin"/]},
        scala: {all: [/def auditedPan\(/, /auditLog\.record\(/], none: [/role\.(contains|==)\("admin"\)/]},
        cpp: {all: [/auditedPan\(/, /auditLog\.record\(/], none: [/role\s*==\s*"admin"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("cases")


class CaseStore:
    def get(self, case_id: str) -> dict | None:
        """The stored case record: score, signals, velocity, pan and features."""
        raise NotImplementedError


cases = CaseStore()


def case_view(record: dict, case_id: str) -> dict:
    return {
        "case_id": case_id,
        "score": record["score"],
        "band": record["band"],
        "signals": record["signals"],
        "velocity": record["velocity"],
        "card_number": record["pan"],
        "raw_features": record["features"],
    }


@app.get("/v1/cases/{case_id}")
def read_case(case_id: str, role: str = Header(default="reviewer")) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    record = cases.get(case_id)
    if record is None:
        return JSONResponse({"error": "case not found"}, status_code=404)
    body = case_view(record, case_id)
    if role == "admin":
        body["pan"] = record["pan"]
    return JSONResponse(body, status_code=200)
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("cases")

MASK_PREFIX = "****"
CASE_NOT_FOUND = "case_not_found"
AUDIT_SCOPE = "pan:read"


class CaseStore:
    def get(self, tenant: str, case_id: str) -> dict | None:
        """The case record for this tenant, or None when it does not belong to them."""
        raise NotImplementedError

    def velocity(self, case_id: str) -> dict:
        """The velocity snapshot stored with the case."""
        raise NotImplementedError


class AuditLog:
    def record(self, actor: str, scope: str, case_id: str) -> None:
        """Write one audit row: who looked at which case, under which declared scope."""
        raise NotImplementedError


cases = CaseStore()
audit_log = AuditLog()


def mask_card(pan: str) -> str:
    """The review console gets the last four digits and nothing else."""
    digits = "".join(ch for ch in pan if ch.isdigit())
    return f"{MASK_PREFIX}{digits[-4:]}" if len(digits) >= 4 else MASK_PREFIX


def case_view(record: dict, case_id: str) -> dict:
    return {
        "case_id": case_id,
        "score": record["score"],
        "band": record["band"],
        "signals": record["signals"],
        "velocity": cases.velocity(case_id),
        "account_ref": record["account_ref"],
        "feature_digest": record.get("feature_digest"),
        "card_ref": mask_card(record["pan"]),
    }


def audited_pan(actor: str, tenant: str, case_id: str) -> str | None:
    """The only path to a raw card number: a named actor, a declared scope, an audit row."""
    record = cases.get(tenant, case_id)
    if record is None:
        return None
    audit_log.record(actor, AUDIT_SCOPE, case_id)
    return record["pan"]


@app.get("/v1/cases/{case_id}")
def read_case(case_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    record = cases.get(tenant, case_id)
    if record is None:
        raise HTTPException(status_code=404, detail=CASE_NOT_FOUND)
    logger.info("case read tenant=%s case=%s", tenant, case_id)
    return JSONResponse(case_view(record, case_id), status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/cases/{id}. */
import Fastify from 'fastify';

export const app = Fastify();

interface CaseRecord {
  account_ref: string;
  score: number;
  band: string;
  signals: string[];
  velocity: Record<string, number>;
  pan: string;
  features: Record<string, unknown>;
}

class CaseStore {
  async get(caseId: string): Promise<CaseRecord | null> {
    return null;
  }
}

const cases = new CaseStore();

app.get('/v1/cases/:caseId', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const {caseId} = request.params as {caseId: string};
  const role = request.headers['x-reviewer-role'];
  const record = await cases.get(caseId);
  if (record === null) return reply.code(404).send({error: 'case not found'});
  const body = {
    case_id: caseId,
    score: record.score,
    band: record.band,
    signals: record.signals,
    velocity: record.velocity,
    card_number: record.pan,
    raw_features: record.features,
  };
  if (role === 'admin') return reply.code(200).send({...body, pan: record.pan});
  return reply.code(200).send(body);
});
`,
      solution: `/** GET /v1/cases/{id}: the review read, masked and scoped to the caller's tenant. */
import Fastify from 'fastify';

export const app = Fastify();

const MASK_PREFIX = '****';
const CASE_NOT_FOUND = 'case_not_found';
const AUDIT_SCOPE = 'pan:read';

interface CaseRecord {
  account_ref: string;
  score: number;
  band: string;
  signals: string[];
  feature_digest: string;
  pan: string;
}

class CaseStore {
  /** The case record for this tenant, or null when it does not belong to them. */
  async get(tenant: string, caseId: string): Promise<CaseRecord | null> {
    return null;
  }

  async velocity(caseId: string): Promise<Record<string, number>> {
    return {};
  }
}

class AuditLog {
  /** One audit row: who looked at which case, under which declared scope. */
  record(actor: string, scope: string, caseId: string): void {}
}

const cases = new CaseStore();
const auditLog = new AuditLog();

/** The review console gets the last four digits and nothing else. */
function maskCard(pan: string): string {
  const digits = pan.replaceAll(/\\D/g, '');
  return digits.length >= 4 ? \`\${MASK_PREFIX}\${digits.slice(-4)}\` : MASK_PREFIX;
}

function caseView(record: CaseRecord, caseId: string, velocity: Record<string, number>) {
  return {
    case_id: caseId,
    score: record.score,
    band: record.band,
    signals: record.signals,
    velocity,
    account_ref: record.account_ref,
    feature_digest: record.feature_digest,
    card_ref: maskCard(record.pan),
  };
}

/** The only path to a raw card number: a named actor, a declared scope, an audit row. */
async function auditedPan(actor: string, tenant: string, caseId: string): Promise<string | null> {
  const record = await cases.get(tenant, caseId);
  if (record === null) return null;
  auditLog.record(actor, AUDIT_SCOPE, caseId);
  return record.pan;
}

app.get('/v1/cases/:caseId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {caseId} = request.params as {caseId: string};
  const record = await cases.get(tenant, caseId);
  if (record === null) return reply.code(404).send({error: CASE_NOT_FOUND});
  request.log.info({tenant, case: caseId}, 'case read');
  return reply.code(200).send(caseView(record, caseId, await cases.velocity(caseId)));
});
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

type CaseRecord struct {
	AccountRef string         \`json:"account_ref"\`
	Score      float64        \`json:"score"\`
	Band       string         \`json:"band"\`
	Signals    []string       \`json:"signals"\`
	Velocity   map[string]int \`json:"velocity"\`
	PAN        string         \`json:"pan"\`
	Features   map[string]any \`json:"features"\`
}

type CaseStore struct{}

func (s *CaseStore) Get(ctx context.Context, caseID string) (CaseRecord, error) {
	return CaseRecord{}, nil
}

var cases = &CaseStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func readCase(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	caseID := r.PathValue("case_id")
	role := r.Header.Get("X-Reviewer-Role")
	record, err := cases.Get(r.Context(), caseID)
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "case not found"})
		return
	}
	body := map[string]any{
		"case_id":      caseID,
		"score":        record.Score,
		"band":         record.Band,
		"signals":      record.Signals,
		"velocity":     record.Velocity,
		"card_number":  record.PAN,
		"raw_features": record.Features,
	}
	if role == "admin" {
		body["pan"] = record.PAN
	}
	writeJSON(rw, http.StatusOK, body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/cases/{case_id}", readCase)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

const (
	maskPrefix   = "****"
	caseNotFound = "case_not_found"
	auditScope   = "pan:read"
)

type CaseRecord struct {
	AccountRef    string         \`json:"account_ref"\`
	Score         float64        \`json:"score"\`
	Band          string         \`json:"band"\`
	Signals       []string       \`json:"signals"\`
	FeatureDigest string         \`json:"feature_digest"\`
	PAN           string         \`json:"pan"\`
}

type CaseStore struct{}

// Get returns the case record for this tenant, or an error when it does not belong to them.
func (s *CaseStore) Get(ctx context.Context, tenant, caseID string) (CaseRecord, error) {
	return CaseRecord{}, nil
}

func (s *CaseStore) Velocity(ctx context.Context, caseID string) (map[string]int, error) {
	return map[string]int{}, nil
}

// AuditLog writes one audit row: who looked at which case, under which declared scope.
type AuditLog struct{}

func (a *AuditLog) Record(actor, scope, caseID string) {}

var cases = &CaseStore{}
var auditLog = &AuditLog{}

// The review console gets the last four digits and nothing else.
func maskCard(pan string) string {
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, pan)
	if len(digits) < 4 {
		return maskPrefix
	}
	return maskPrefix + digits[len(digits)-4:]
}

func caseView(record CaseRecord, caseID string, velocity map[string]int) map[string]any {
	return map[string]any{
		"case_id":        caseID,
		"score":          record.Score,
		"band":           record.Band,
		"signals":        record.Signals,
		"velocity":       velocity,
		"account_ref":    record.AccountRef,
		"feature_digest": record.FeatureDigest,
		"card_ref":       maskCard(record.PAN),
	}
}

// The only path to a raw card number: a named actor, a declared scope, an audit row.
func auditedPan(ctx context.Context, actor, tenant, caseID string) (string, error) {
	record, err := cases.Get(ctx, tenant, caseID)
	if err != nil {
		return "", err
	}
	auditLog.Record(actor, auditScope, caseID)
	return record.PAN, nil
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func readCase(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	caseID := r.PathValue("case_id")
	record, err := cases.Get(r.Context(), tenant, caseID)
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": caseNotFound})
		return
	}
	velocity, err := cases.Velocity(r.Context(), caseID)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "velocity unavailable"})
		return
	}
	log.Printf("case read tenant=%s case=%s", tenant, caseID)
	writeJSON(rw, http.StatusOK, caseView(record, caseID, velocity))
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/cases/{case_id}", readCase)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

object CasesApi {
  case class CaseRecord(accountRef: String, score: Double, band: String, pan: String, signals: List[String])

  class CaseStore {
    def get(caseId: String): Option[CaseRecord] = None
  }

  val cases = new CaseStore

  private def json(status: StatusCode, body: String): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  val route: Route =
    path("v1" / "cases" / Segment) { caseId =>
      get {
        optionalHeaderValueByName("X-Reviewer-Role") { role =>
          cases.get(caseId) match {
            case None => json(StatusCodes.NotFound, """{"error":"case not found"}""")
            case Some(record) =>
              val body = JsObject(
                "case_id" -> JsString(caseId),
                "score" -> JsNumber(record.score),
                "band" -> JsString(record.band),
                "signals" -> JsArray(record.signals.map(JsString(_)).toVector),
                "card_number" -> JsString(record.pan),
              )
              if (role.contains("admin")) json(StatusCodes.OK, JsObject(body.fields + ("pan" -> JsString(record.pan))).compactPrint)
              else json(StatusCodes.OK, body.compactPrint)
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("cases")
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

object CasesApi {
  val MaskPrefix = "****"
  val CaseNotFound = "case_not_found"
  val AuditScope = "pan:read"

  case class CaseRecord(
      accountRef: String,
      score: Double,
      band: String,
      signals: List[String],
      featureDigest: String,
      pan: String,
  )

  class CaseStore {
    /** The case record for this tenant, or None when it does not belong to them. */
    def get(tenant: String, caseId: String): Option[CaseRecord] = None
    def velocity(caseId: String): Map[String, Int] = Map.empty
  }

  class AuditLog {
    /** One audit row: who looked at which case, under which declared scope. */
    def record(actor: String, scope: String, caseId: String): Unit = ()
  }

  val cases = new CaseStore
  val auditLog = new AuditLog

  /** The review console gets the last four digits and nothing else. */
  def maskCard(pan: String): String = {
    val digits = pan.filter(_.isDigit)
    if (digits.length < 4) MaskPrefix else MaskPrefix + digits.takeRight(4)
  }

  def caseView(record: CaseRecord, caseId: String): JsObject = JsObject(
    "case_id" -> JsString(caseId),
    "score" -> JsNumber(record.score),
    "band" -> JsString(record.band),
    "signals" -> JsArray(record.signals.map(JsString(_)).toVector),
    "velocity" -> JsObject(cases.velocity(caseId).map { case (field, value) => field -> JsNumber(value) }),
    "account_ref" -> JsString(record.accountRef),
    "feature_digest" -> JsString(record.featureDigest),
    "card_ref" -> JsString(maskCard(record.pan)),
  )

  /** The only path to a raw card number: a named actor, a declared scope, an audit row. */
  def auditedPan(actor: String, tenant: String, caseId: String): Option[String] =
    cases.get(tenant, caseId).map { record =>
      auditLog.record(actor, AuditScope, caseId)
      record.pan
    }

  private def json(status: StatusCode, body: String): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  val route: Route =
    path("v1" / "cases" / Segment) { caseId =>
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          cases.get(tenant, caseId) match {
            case None => json(StatusCodes.NotFound, s"""{"error":"$CaseNotFound"}""")
            case Some(record) => json(StatusCodes.OK, caseView(record, caseId).compactPrint)
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("cases")
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `// GET /v1/cases/{id}.
#include <string>

#include <httplib.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

class CaseStore {
 public:
  json get(const std::string& case_id) { return json(); }
};

static CaseStore cases;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/cases/([\\w-]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const std::string case_id = req.matches[1];
    const json record = cases.get(case_id);
    if (record.is_null()) {
      res.status = 404;
      res.set_content("{\\"error\\":\\"case not found\\"}", "application/json");
      return;
    }
    json body = {
        {"case_id", case_id},
        {"score", record["score"]},
        {"band", record["band"]},
        {"signals", record["signals"]},
        {"card_number", record["pan"]},
        {"raw_features", record["features"]},
    };
    const std::string role = req.get_header_value("X-Reviewer-Role");
    if (role == "admin") {
      body["pan"] = record["pan"];
    }
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `// GET /v1/cases/{id}: the review read, masked and scoped to the caller's tenant.
#include <string>

#include <httplib.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

constexpr const char* kMaskPrefix = "****";
constexpr const char* kCaseNotFound = "case_not_found";
constexpr const char* kAuditScope = "pan:read";

class CaseStore {
 public:
  /** The case record for this tenant, or null when it does not belong to them. */
  json get(const std::string& tenant, const std::string& case_id) { return json(); }
  json velocity(const std::string& case_id) { return json::object(); }
};

class AuditLog {
 public:
  /** One audit row: who looked at which case, under which declared scope. */
  void record(const std::string& actor, const std::string& scope, const std::string& case_id) {}
};

static CaseStore cases;
static AuditLog auditLog;

/** The review console gets the last four digits and nothing else. */
static std::string maskCard(const std::string& pan) {
  std::string digits;
  for (const char ch : pan) {
    if (ch >= '0' && ch <= '9') digits += ch;
  }
  if (digits.size() < 4) return kMaskPrefix;
  return std::string(kMaskPrefix) + digits.substr(digits.size() - 4);
}

static json caseView(const json& record, const std::string& case_id) {
  return json{
      {"case_id", case_id},
      {"score", record["score"]},
      {"band", record["band"]},
      {"signals", record["signals"]},
      {"velocity", cases.velocity(case_id)},
      {"account_ref", record["account_ref"]},
      {"feature_digest", record["feature_digest"]},
      {"card_ref", maskCard(record.value("pan", std::string()))},
  };
}

/** The only path to a raw card number: a named actor, a declared scope, an audit row. */
static json auditedPan(const std::string& actor, const std::string& tenant, const std::string& case_id) {
  const json record = cases.get(tenant, case_id);
  if (record.is_null()) return json();
  auditLog.record(actor, kAuditScope, case_id);
  return record.value("pan", std::string());
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/cases/([\\w-]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content("{\\"error\\":\\"missing X-Tenant-Id\\"}", "application/json");
      return;
    }
    const std::string case_id = req.matches[1];
    const json record = cases.get(tenant, case_id);
    if (record.is_null()) {
      res.status = 404;
      res.set_content(json{{"error", kCaseNotFound}}.dump(), "application/json");
      return;
    }
    res.status = 200;
    res.set_content(caseView(record, case_id).dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    "A reviewer from tenant A pastes a case id from tenant B's support ticket and gets a 200 with a full card number in it; with `role: admin` in the header the same body grows a `pan` field.",
    '`cases.get(case_id)` has no tenant argument, `case_view` copies `record["pan"]` and `record["features"]` straight into the body, and the only guard on unmasking is a header the client wrote.',
    'Read `X-Tenant-Id`, call `cases.get(tenant, case_id)` and 404 on a miss; in `case_view` emit `card_ref: mask_card(pan)` with `MASK_PREFIX` and drop `card_number`/`raw_features`; move the PAN to `audited_pan`, which calls `audit_log.record` first.',
  ],
  debrief: `Tenant scoping is a parameter of the lookup rather than a filter on the result because a filter is something a future caller forgets; a store method that cannot be called without a tenant cannot be bypassed by one. Masking lives in \`case_view\` for the same reason: there is one place that builds a case body, so there is one place the invariant has to hold. The role header was removed rather than hardened because a value the client sends is data, not authorization; the legitimate need for a PAN is met by a tool whose first line is an audit write, so the rare read leaves a trace. Production consoles drive redaction from a data-classification tag on each field, require a reason code on every audited read, and rate-limit case reads per reviewer so one curious account cannot enumerate the case table.
`,
};
