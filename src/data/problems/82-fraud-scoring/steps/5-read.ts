import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/cases/{id}: review without oversharing',
  concept: 'http',
  guides: ['request-boundaries', 'honest-reads'],
  file: 'read',
  focus: ['reviewer', 'scorer', 'redis', 'audit'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/cases/{id}\` for the review console: it loads the case
with \`store.load_case(case_id)\` (the back-office read, any tenant), answers a miss with 404, builds
the body in \`case_view\` (score, band, signals, velocity and \`card_number\`), and adds \`pan\` when
the \`X-Role\` header says \`admin\`. \`audited_pan(actor, tenant, case_id)\` returns a case's card
number. It serves the demo and hides four flaws.

**Failure mode the checks target.** A cross-tenant card-data export: any caller reads any case by
guessing an id, the body carries the full card number, a header the client sets unlocks it again,
and the raw-card tool leaves no trace.

- Read the case with \`store.case_of(tenant, case_id)\`, the tenant taken from \`X-Tenant-Id\` and
  nowhere else (missing: **401**); a foreign case is **404** with the same body as a missing one.
- The body carries \`card_ref: mask_card(pan)\`, \`MASK_PREFIX\` (\`****\`) plus the last four digits
  whatever the card's length, and no card number for any caller.
- No header changes what the read returns.
- \`audited_pan\` reads through \`store.case_of\` and writes \`store.audit(actor, PAN_SCOPE, case_id)\`
  before returning the PAN; a foreign case returns None and leaves no row, and a PAN whose audit row
  could not be written is not returned.`,
  sequence: {
    participants: ['Review console', 'scorer', 'Redis', 'Audit log'],
    messages: [
      {from: 'Review console', to: 'scorer', label: 'GET /v1/cases/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'scorer', to: 'Redis', label: 'case_of(tenant, case_id)', kind: 'sync'},
      {from: 'Redis', to: 'scorer', label: 'the case / none: 404', kind: 'reply'},
      {
        from: 'scorer',
        to: 'Review console',
        label: '200 {score, band, signals, velocity, card_ref ****4242}',
        kind: 'reply',
      },
      {from: 'Review console', to: 'scorer', label: 'audited_pan(actor, tenant, case_id)', kind: 'sync'},
      {from: 'scorer', to: 'Audit log', label: 'audit(actor, pan:read, case_id) before the PAN', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'route-param',
      title: 'Serves GET /v1/cases/{id}',
      detail: "Register `GET /v1/cases/{id}`; the case's own tenant reads its score, band, signals and velocity.",
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/cases\/\{case_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/cases\/:caseId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/cases\/\{id\}"/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/cases\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'A foreign case is 404',
      detail:
        "Every lookup goes through `case_of(tenant, case_id)` with the caller's `X-Tenant-Id` (no other source of the tenant), so another tenant's case answers **404** with the same body as a missing one; the starter reads by id alone.",
      match: {
        python: {all: [/store\.case_of\(\s*tenant/, /\b404\b/, /\b401\b/], none: [/store\.load_case\(/]},
        typescript: {all: [/caseOf\(\s*tenant/, /\b404\b/, /\b401\b/], none: [/loadCase\(/]},
        go: {
          all: [/store\.CaseOf\([^)\n]*tenant/, /StatusNotFound/, /StatusUnauthorized/],
          none: [/store\.LoadCase\(/],
        },
        cpp: {all: [/store::caseOf\(\s*tenant/, /\b404\b/, /\b401\b/], none: [/store::loadCase\(/]},
      },
    },
    {
      id: 'masking',
      title: 'The card is masked in the response builder',
      detail:
        '`case_view` answers `card_ref: mask_card(pan)` (`MASK_PREFIX` plus the last four digits, for a 19-digit card as for a 16-digit one) and no `card_number`; the starter copies the full number into every body.',
      match: {
        python: {all: [/def mask_card\(/, /MASK_PREFIX/, /mask_card\(case/], none: [/card_number/]},
        typescript: {
          all: [/maskCard\s*=|function maskCard\(/, /MASK_PREFIX/, /maskCard\(found|maskCard\(c\./],
          none: [/card_number/],
        },
        go: {all: [/func maskCard\(/, /maskPrefix/, /maskCard\(c\.Pan\)/], none: [/card_number/]},
        cpp: {all: [/std::string maskCard\(/, /kMaskPrefix/, /maskCard\(c\.pan\)/], none: [/card_number/]},
      },
    },
    {
      id: 'role-header',
      title: 'No header unlocks the card number',
      detail:
        'The read answers the same masked body whatever role the client claims; the starter adds the PAN when `X-Role` says `admin`, a header any caller can set.',
      match: {
        python: {all: [/def case_view\(/], none: [/x-role/i]},
        typescript: {all: [/function caseView\(/], none: [/x-role/i]},
        go: {all: [/func caseView\(/], none: [/x-role/i]},
        cpp: {all: [/json caseView\(/], none: [/x-role/i]},
      },
    },
    {
      id: 'audited-tool',
      title: 'Raw card data only through an audited read',
      detail:
        "`audited_pan` resolves the case for the tenant and writes `store.audit(actor, PAN_SCOPE, case_id)` before it returns the PAN; a foreign case gets nothing, and when the audit row cannot be written the PAN is not returned. The starter returns any case's PAN and writes no audit row.",
      match: {
        python: {all: [/PAN_SCOPE/], order: [/def audited_pan\(/, /store\.case_of\(/, /store\.audit\(/]},
        typescript: {all: [/PAN_SCOPE/], order: [/function auditedPan\(/, /caseOf\(/, /audit\(actor/]},
        go: {all: [/panScope/], order: [/func auditedPan\(/, /store\.CaseOf\(/, /store\.Audit\(/]},
        cpp: {all: [/kPanScope/], order: [/auditedPan\(/, /store::caseOf\(/, /store::audit\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from fraud import store  # store.case_of, load_case, audit

app = FastAPI()

PAN_SCOPE = "pan:read"


def case_view(case: dict) -> dict:
    """The review console's view of a case."""
    return {
        "case_id": case["case_id"],
        "transaction_id": case["transaction_id"],
        "account_ref": case["account_ref"],
        "score": case["score"],
        "band": case["band"],
        "signals": case["signals"],
        "velocity": {"card_attempts": case["card_attempts"], "device_accounts": case["device_accounts"]},
        "card_number": case["pan"],
    }


@app.get("/v1/cases/{case_id}")
def get_case(case_id: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    case = store.load_case(case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="no such case")
    body = case_view(case)
    if request.headers.get("x-role") == "admin":
        body["pan"] = case["pan"]
    return body


def audited_pan(actor: str, tenant: str, case_id: str) -> str | None:
    """The raw card number for the review tooling."""
    case = store.load_case(case_id)
    return None if case is None else case["pan"]
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from fraud import store  # store.case_of, load_case, audit

app = FastAPI()

MASK_PREFIX = "****"
PAN_SCOPE = "pan:read"


def mask_card(pan: str) -> str:
    return MASK_PREFIX + pan[-4:]


def case_view(case: dict) -> dict:
    """The review console's view of a case: the decision and its signals, the card masked."""
    return {
        "case_id": case["case_id"],
        "transaction_id": case["transaction_id"],
        "account_ref": case["account_ref"],
        "score": case["score"],
        "band": case["band"],
        "signals": case["signals"],
        "velocity": {"card_attempts": case["card_attempts"], "device_accounts": case["device_accounts"]},
        "card_ref": mask_card(case["pan"]),
    }


@app.get("/v1/cases/{case_id}")
def get_case(case_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    case = store.case_of(tenant, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="no such case")  # a foreign case looks like a missing one
    return case_view(case)


def audited_pan(actor: str, tenant: str, case_id: str) -> str | None:
    """The raw card number for the review tooling: scoped to the tenant, one audit row per read."""
    case = store.case_of(tenant, case_id)
    if case is None:
        return None
    store.audit(actor, PAN_SCOPE, case_id)
    return case["pan"]
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type Case, audit, caseOf, loadCase} from 'fraud/store';

export const app = Fastify();

export const PAN_SCOPE = 'pan:read';

/** The review console's view of a case. */
export function caseView(c: Case): Record<string, unknown> {
  return {
    case_id: c.case_id,
    transaction_id: c.transaction_id,
    account_ref: c.account_ref,
    score: c.score,
    band: c.band,
    signals: c.signals,
    velocity: {card_attempts: c.card_attempts, device_accounts: c.device_accounts},
    card_number: c.pan,
  };
}

app.get('/v1/cases/:caseId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {caseId} = request.params as {caseId: string};
  const found = await loadCase(caseId);
  if (found === null) return reply.code(404).send({error: 'no such case'});
  const body = caseView(found);
  if (request.headers['x-role'] === 'admin') body.pan = found.pan;
  return body;
});

/** The raw card number for the review tooling. */
export async function auditedPan(actor: string, tenant: string, caseId: string): Promise<string | null> {
  const found = await loadCase(caseId);
  return found === null ? null : found.pan;
}
`,
      solution: `import Fastify from 'fastify';

import {type Case, audit, caseOf} from 'fraud/store';

export const app = Fastify();

export const MASK_PREFIX = '****';
export const PAN_SCOPE = 'pan:read';

export function maskCard(pan: string): string {
  return MASK_PREFIX + pan.slice(-4);
}

/** The review console's view of a case: the decision and its signals, the card masked. */
export function caseView(c: Case): Record<string, unknown> {
  return {
    case_id: c.case_id,
    transaction_id: c.transaction_id,
    account_ref: c.account_ref,
    score: c.score,
    band: c.band,
    signals: c.signals,
    velocity: {card_attempts: c.card_attempts, device_accounts: c.device_accounts},
    card_ref: maskCard(c.pan),
  };
}

app.get('/v1/cases/:caseId', async (request, reply) => {
  const {caseId} = request.params as {caseId: string};
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const found = await caseOf(tenant, caseId);
  if (found === null) return reply.code(404).send({error: 'no such case'}); // a foreign case looks like a missing one
  return caseView(found);
});

/** The raw card number for the review tooling: scoped to the tenant, one audit row per read. */
export async function auditedPan(actor: string, tenant: string, caseId: string): Promise<string | null> {
  const found = await caseOf(tenant, caseId);
  if (found === null) return null;
  await audit(actor, PAN_SCOPE, caseId);
  return found.pan;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"fraud/store" // store.CaseOf, LoadCase, Audit
)

const panScope = "pan:read"

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// caseView is the review console's view of a case.
func caseView(c *store.Case) map[string]any {
	return map[string]any{
		"case_id":        c.CaseID,
		"transaction_id": c.TransactionID,
		"account_ref":    c.AccountRef,
		"score":          c.Score,
		"band":           c.Band,
		"signals":        c.Signals,
		"velocity":       map[string]int64{"card_attempts": c.CardAttempts, "device_accounts": c.DeviceAccounts},
		"card_number":    c.Pan,
	}
}

func getCase(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	c := store.LoadCase(r.Context(), r.PathValue("id"))
	if c == nil {
		http.Error(rw, "no such case", http.StatusNotFound)
		return
	}
	body := caseView(c)
	if r.Header.Get("X-Role") == "admin" {
		body["pan"] = c.Pan
	}
	writeJSON(rw, http.StatusOK, body)
}

// auditedPan is the raw card number for the review tooling, and whether there is one.
func auditedPan(ctx context.Context, actor, tenant, caseID string) (string, bool) {
	c := store.LoadCase(ctx, caseID)
	if c == nil {
		return "", false
	}
	return c.Pan, true
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/cases/{id}", getCase)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"fraud/store" // store.CaseOf, LoadCase, Audit
)

const (
	maskPrefix = "****"
	panScope   = "pan:read"
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func maskCard(pan string) string {
	if len(pan) < 4 {
		return maskPrefix
	}
	return maskPrefix + pan[len(pan)-4:]
}

// caseView is the review console's view of a case: the decision and its signals, the card masked.
func caseView(c *store.Case) map[string]any {
	return map[string]any{
		"case_id":        c.CaseID,
		"transaction_id": c.TransactionID,
		"account_ref":    c.AccountRef,
		"score":          c.Score,
		"band":           c.Band,
		"signals":        c.Signals,
		"velocity":       map[string]int64{"card_attempts": c.CardAttempts, "device_accounts": c.DeviceAccounts},
		"card_ref":       maskCard(c.Pan),
	}
}

func getCase(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	c := store.CaseOf(r.Context(), tenant, r.PathValue("id"))
	if c == nil {
		http.Error(rw, "no such case", http.StatusNotFound) // a foreign case looks like a missing one
		return
	}
	writeJSON(rw, http.StatusOK, caseView(c))
}

// auditedPan is the raw card number for the review tooling, and whether there is one: scoped to
// the tenant, one audit row per read, and no PAN when the row could not be written.
func auditedPan(ctx context.Context, actor, tenant, caseID string) (string, bool) {
	c := store.CaseOf(ctx, tenant, caseID)
	if c == nil {
		return "", false
	}
	if err := store.Audit(ctx, actor, panScope, caseID); err != nil {
		return "", false
	}
	return c.Pan, true
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/cases/{id}", getCase)
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>

#include "fraud/store.h"  // store::caseOf, loadCase, audit

using json = nlohmann::json;

const std::string kPanScope = "pan:read";

// The review console's view of a case.
json caseView(const store::Case& c) {
  return json{{"case_id", c.case_id},
              {"transaction_id", c.transaction_id},
              {"account_ref", c.account_ref},
              {"score", c.score},
              {"band", c.band},
              {"signals", c.signals},
              {"velocity", {{"card_attempts", c.card_attempts}, {"device_accounts", c.device_accounts}}},
              {"card_number", c.pan}};
}

void get_case(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto c = store::loadCase(req.matches[1]);
  if (!c) {
    res.status = 404;
    res.set_content("no such case", "text/plain");
    return;
  }
  json body = caseView(*c);
  if (req.get_header_value("X-Role") == "admin") body["pan"] = c->pan;
  res.set_content(body.dump(), "application/json");
}

// The raw card number for the review tooling.
std::optional<std::string> auditedPan(const std::string& actor, const std::string& tenant, const std::string& case_id) {
  const auto c = store::loadCase(case_id);
  if (!c) return std::nullopt;
  return c->pan;
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/cases/([\\w-]+))", get_case); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>

#include "fraud/store.h"  // store::caseOf, loadCase, audit

using json = nlohmann::json;

const std::string kMaskPrefix = "****";
const std::string kPanScope = "pan:read";

std::string maskCard(const std::string& pan) { return kMaskPrefix + (pan.size() >= 4 ? pan.substr(pan.size() - 4) : ""); }

// The review console's view of a case: the decision and its signals, the card masked.
json caseView(const store::Case& c) {
  return json{{"case_id", c.case_id},
              {"transaction_id", c.transaction_id},
              {"account_ref", c.account_ref},
              {"score", c.score},
              {"band", c.band},
              {"signals", c.signals},
              {"velocity", {{"card_attempts", c.card_attempts}, {"device_accounts", c.device_accounts}}},
              {"card_ref", maskCard(c.pan)}};
}

void get_case(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const auto c = store::caseOf(tenant, req.matches[1]);
  if (!c) {
    res.status = 404;  // a foreign case looks like a missing one
    res.set_content("no such case", "text/plain");
    return;
  }
  res.set_content(caseView(*c).dump(), "application/json");
}

// The raw card number for the review tooling: scoped to the tenant, one audit row per read.
std::optional<std::string> auditedPan(const std::string& actor, const std::string& tenant, const std::string& case_id) {
  const auto c = store::caseOf(tenant, case_id);
  if (!c) return std::nullopt;
  store::audit(actor, kPanScope, case_id);
  return c->pan;
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/cases/([\\w-]+))", get_case); }
`,
    },
  },
  harness: {
    python: `from fraud import store

CASE_1 = {"case_id": "case-1", "tenant": "t-1", "transaction_id": "tx-1", "account_ref": "acct-9", "score": 0.82, "band": "decline",
          "signals": ["prior_chargebacks", "new_account"], "card_attempts": 6, "device_accounts": 2, "pan": "4111111111114242"}
CASE_2 = {"case_id": "case-2", "tenant": "t-2", "transaction_id": "tx-2", "account_ref": "acct-5", "score": 0.45, "band": "review",
          "signals": ["fallback"], "card_attempts": 1, "device_accounts": 1, "pan": "5500000000005100"}
# A 19-digit card: the mask keeps the last four digits whatever the length.
CASE_3 = {"case_id": "case-3", "tenant": "t-1", "transaction_id": "tx-3", "account_ref": "acct-9", "score": 0.5, "band": "review",
          "signals": ["velocity"], "card_attempts": 2, "device_accounts": 1, "pan": "6011000990139420123"}


def _seed():
    store.put_case(CASE_1)
    store.put_case(CASE_2)
    store.put_case(CASE_3)


def _read(ctx):
    _seed()
    return ctx.client(ctx.load("read").app)


async def check_route_param(ctx):
    async with _read(ctx) as c:
        r = await c.get("/v1/cases/case-1", headers={"X-Tenant-Id": "t-1"})
    assert r.status_code == 200, f"GET /v1/cases/case-1 for its own tenant answered {r.status_code}: {r.text}"
    body = r.json()
    got = (body.get("case_id"), body.get("score"), body.get("band"), body.get("signals"), body.get("velocity"))
    want = ("case-1", 0.82, "decline", ["prior_chargebacks", "new_account"], {"card_attempts": 6, "device_accounts": 2})
    assert got == want, f"the case must carry (case_id, score, band, signals, velocity) = {want}, got {got}"


async def check_tenant_scope(ctx):
    async with _read(ctx) as c:
        foreign = await c.get("/v1/cases/case-1", headers={"X-Tenant-Id": "t-2"})
        missing = await c.get("/v1/cases/case-404", headers={"X-Tenant-Id": "t-2"})
        anonymous = await c.get("/v1/cases/case-1")
        by_query = await c.get("/v1/cases/case-1?tenant=t-1&tenant_id=t-1")
    assert foreign.status_code == 404, f"tenant t-2 reading t-1's case answered {foreign.status_code}: {foreign.text}. A foreign case must be 404, like a missing one"
    assert "decline" not in foreign.text and "4242" not in foreign.text, f"the 404 for a foreign case leaks its content: {foreign.text}"
    assert missing.status_code == 404, f"a missing case answered {missing.status_code}"
    assert foreign.text.replace("case-1", "<id>") == missing.text.replace("case-404", "<id>"), f"a foreign case answered {foreign.text} and a missing one {missing.text}: the difference tells a caller which ids exist in other tenants. Answer both the same"
    assert anonymous.status_code == 401, f"a read without X-Tenant-Id answered {anonymous.status_code}, expected 401"
    assert by_query.status_code == 401, f"a read without X-Tenant-Id but with ?tenant=t-1 answered {by_query.status_code}: {by_query.text}. The tenant comes from the X-Tenant-Id header only, expected 401"


async def check_masking(ctx):
    async with _read(ctx) as c:
        r = await c.get("/v1/cases/case-1", headers={"X-Tenant-Id": "t-1"})
    assert r.status_code == 200, f"GET /v1/cases/case-1 answered {r.status_code}: {r.text}"
    assert CASE_1["pan"] not in r.text, f"the case body carries the full card number: {r.text}. Mask it in case_view"
    assert r.json().get("card_ref") == "****4242", f"card_ref must be MASK_PREFIX plus the last four digits (****4242), got {r.json().get('card_ref')!r}"
    async with _read(ctx) as c:
        long_card = await c.get("/v1/cases/case-3", headers={"X-Tenant-Id": "t-1"})
    assert long_card.status_code == 200 and CASE_3["pan"] not in long_card.text, f"GET /v1/cases/case-3 answered {long_card.status_code}: {long_card.text}"
    assert long_card.json().get("card_ref") == "****0123", f"case-3's card has 19 digits: card_ref must be MASK_PREFIX plus its last four (****0123), got {long_card.json().get('card_ref')!r}"


async def check_role_header(ctx):
    async with _read(ctx) as c:
        r = await c.get("/v1/cases/case-1", headers={"X-Tenant-Id": "t-1", "X-Role": "admin"})
    assert r.status_code == 200, f"GET /v1/cases/case-1 with X-Role: admin answered {r.status_code}: {r.text}"
    assert CASE_1["pan"] not in r.text, f"a caller who sent X-Role: admin got the card number: {r.text}. The client writes that header; raw card data goes through audited_pan only"


def check_audited_tool(ctx):
    _seed()
    m = ctx.load("read")
    pan = m.audited_pan("analyst-7", "t-1", "case-1")
    assert pan == CASE_1["pan"], f"audited_pan for the case's own tenant returned {pan!r}, expected the PAN"
    log = store.audit_log()
    assert log == [{"actor": "analyst-7", "scope": "pan:read", "case_id": "case-1"}], f"reading a PAN must write one audit row (actor, PAN_SCOPE, case_id) first, the audit log is {log}"
    foreign = m.audited_pan("analyst-7", "t-2", "case-1")
    assert foreign is None, f"audited_pan for another tenant's case returned {foreign!r}: scope it with store.case_of"
    assert len(store.audit_log()) == 1, f"a refused read must not add a row, the audit log is {store.audit_log()}"
    ctx.redis.delete("audit:pan")
    ctx.redis.set("audit:pan", "not a list")
    try:
        unaudited = m.audited_pan("analyst-7", "t-1", "case-1")
    except Exception:
        unaudited = None
    assert unaudited is None, f"the audit row could not be written (audit:pan is not a list) and audited_pan still returned {unaudited!r}: a PAN read that leaves no trace must not return the PAN"
`,
    typescript: `const CASE_1 = {case_id: 'case-1', tenant: 't-1', transaction_id: 'tx-1', account_ref: 'acct-9', score: 0.82, band: 'decline',
  signals: ['prior_chargebacks', 'new_account'], card_attempts: 6, device_accounts: 2, pan: '4111111111114242'};
const CASE_2 = {case_id: 'case-2', tenant: 't-2', transaction_id: 'tx-2', account_ref: 'acct-5', score: 0.45, band: 'review',
  signals: ['fallback'], card_attempts: 1, device_accounts: 1, pan: '5500000000005100'};
// A 19-digit card: the mask keeps the last four digits whatever the length.
const CASE_3 = {case_id: 'case-3', tenant: 't-1', transaction_id: 'tx-3', account_ref: 'acct-9', score: 0.5, band: 'review',
  signals: ['velocity'], card_attempts: 2, device_accounts: 1, pan: '6011000990139420123'};

async function seed(ctx) {
  const store = ctx.load('/support/fraud/store.ts');
  await store.putCase(CASE_1);
  await store.putCase(CASE_2);
  await store.putCase(CASE_3);
  return store;
}

export async function check_route_param(ctx) {
  await seed(ctx);
  const c = ctx.client(ctx.load('read').app);
  const r = await c.get('/v1/cases/case-1', {headers: {'X-Tenant-Id': 't-1'}});
  assert.equal(r.status, 200, \`GET /v1/cases/case-1 for its own tenant answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const got = [body.case_id, body.score, body.band, body.signals, body.velocity];
  const want = ['case-1', 0.82, 'decline', ['prior_chargebacks', 'new_account'], {card_attempts: 6, device_accounts: 2}];
  assert.deepStrictEqual(got, want, \`the case must carry (case_id, score, band, signals, velocity) = \${JSON.stringify(want)}, got \${JSON.stringify(got)}\`);
}

export async function check_tenant_scope(ctx) {
  await seed(ctx);
  const c = ctx.client(ctx.load('read').app);
  const foreign = await c.get('/v1/cases/case-1', {headers: {'X-Tenant-Id': 't-2'}});
  const missing = await c.get('/v1/cases/case-404', {headers: {'X-Tenant-Id': 't-2'}});
  const anonymous = await c.get('/v1/cases/case-1');
  const byQuery = await c.get('/v1/cases/case-1?tenant=t-1&tenant_id=t-1');
  assert.equal(foreign.status, 404, \`tenant t-2 reading t-1's case answered \${foreign.status}: \${foreign.text}. A foreign case must be 404, like a missing one\`);
  assert(!foreign.text.includes('decline') && !foreign.text.includes('4242'), \`the 404 for a foreign case leaks its content: \${foreign.text}\`);
  assert.equal(missing.status, 404, \`a missing case answered \${missing.status}\`);
  assert.equal(foreign.text.replaceAll('case-1', '<id>'), missing.text.replaceAll('case-404', '<id>'), \`a foreign case answered \${foreign.text} and a missing one \${missing.text}: the difference tells a caller which ids exist in other tenants. Answer both the same\`);
  assert.equal(anonymous.status, 401, \`a read without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
  assert.equal(byQuery.status, 401, \`a read without X-Tenant-Id but with ?tenant=t-1 answered \${byQuery.status}: \${byQuery.text}. The tenant comes from the X-Tenant-Id header only, expected 401\`);
}

export async function check_masking(ctx) {
  await seed(ctx);
  const c = ctx.client(ctx.load('read').app);
  const r = await c.get('/v1/cases/case-1', {headers: {'X-Tenant-Id': 't-1'}});
  assert.equal(r.status, 200, \`GET /v1/cases/case-1 answered \${r.status}: \${r.text}\`);
  assert(!r.text.includes(CASE_1.pan), \`the case body carries the full card number: \${r.text}. Mask it in caseView\`);
  assert.equal(r.json().card_ref, '****4242', \`card_ref must be MASK_PREFIX plus the last four digits (****4242), got \${JSON.stringify(r.json().card_ref)}\`);
  const longCard = await c.get('/v1/cases/case-3', {headers: {'X-Tenant-Id': 't-1'}});
  assert(longCard.status === 200 && !longCard.text.includes(CASE_3.pan), \`GET /v1/cases/case-3 answered \${longCard.status}: \${longCard.text}\`);
  assert.equal(longCard.json().card_ref, '****0123', \`case-3's card has 19 digits: card_ref must be MASK_PREFIX plus its last four (****0123), got \${JSON.stringify(longCard.json().card_ref)}\`);
}

export async function check_role_header(ctx) {
  await seed(ctx);
  const c = ctx.client(ctx.load('read').app);
  const r = await c.get('/v1/cases/case-1', {headers: {'X-Tenant-Id': 't-1', 'X-Role': 'admin'}});
  assert.equal(r.status, 200, \`GET /v1/cases/case-1 with X-Role: admin answered \${r.status}: \${r.text}\`);
  assert(!r.text.includes(CASE_1.pan), \`a caller who sent X-Role: admin got the card number: \${r.text}. The client writes that header; raw card data goes through auditedPan only\`);
}

export async function check_audited_tool(ctx) {
  const store = await seed(ctx);
  const m = ctx.load('read');
  const pan = await m.auditedPan('analyst-7', 't-1', 'case-1');
  assert.equal(pan, CASE_1.pan, \`auditedPan for the case's own tenant returned \${JSON.stringify(pan)}, expected the PAN\`);
  const log = await store.auditLog();
  assert.deepStrictEqual(log, [{actor: 'analyst-7', scope: 'pan:read', case_id: 'case-1'}], \`reading a PAN must write one audit row (actor, PAN_SCOPE, case_id) first, the audit log is \${JSON.stringify(log)}\`);
  const foreign = await m.auditedPan('analyst-7', 't-2', 'case-1');
  assert.equal(foreign, null, \`auditedPan for another tenant's case returned \${JSON.stringify(foreign)}: scope it with caseOf\`);
  assert.equal((await store.auditLog()).length, 1, 'a refused read must not add an audit row');
  ctx.redis.del('audit:pan');
  ctx.redis.set('audit:pan', 'not a list');
  let unaudited = null;
  try {
    unaudited = await m.auditedPan('analyst-7', 't-1', 'case-1');
  } catch {
    unaudited = null;
  }
  assert.equal(unaudited, null, \`the audit row could not be written (audit:pan is not a list) and auditedPan still returned \${JSON.stringify(unaudited)}: a PAN read that leaves no trace must not return the PAN\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"fraud/store"

	"leetbuild/harness"
)

var (
	harnessBg    = context.Background()
	harnessCase1 = store.Case{CaseID: "case-1", Tenant: "t-1", TransactionID: "tx-1", AccountRef: "acct-9", Score: 0.82, Band: "decline",
		Signals: []string{"prior_chargebacks", "new_account"}, CardAttempts: 6, DeviceAccounts: 2, Pan: "4111111111114242"}
	harnessCase2 = store.Case{CaseID: "case-2", Tenant: "t-2", TransactionID: "tx-2", AccountRef: "acct-5", Score: 0.45, Band: "review",
		Signals: []string{"fallback"}, CardAttempts: 1, DeviceAccounts: 1, Pan: "5500000000005100"}
	// A 19-digit card: the mask keeps the last four digits whatever the length.
	harnessCase3 = store.Case{CaseID: "case-3", Tenant: "t-1", TransactionID: "tx-3", AccountRef: "acct-9", Score: 0.5, Band: "review",
		Signals: []string{"velocity"}, CardAttempts: 2, DeviceAccounts: 1, Pan: "6011000990139420123"}
)

func harnessSeedCases() {
	store.PutCase(harnessBg, harnessCase1)
	store.PutCase(harnessBg, harnessCase2)
	store.PutCase(harnessBg, harnessCase3)
}

func harnessReadAPI(ctx *harness.Ctx) *harness.HTTP {
	harnessSeedCases()
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func CheckRouteParam(ctx *harness.Ctx) {
	c := harnessReadAPI(ctx)
	r := c.Get("/v1/cases/case-1", "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 200, "GET /v1/cases/case-1 for its own tenant (%s)", r.Text())
	var body struct {
		CaseID   string           \`json:"case_id"\`
		Score    float64          \`json:"score"\`
		Band     string           \`json:"band"\`
		Signals  []string         \`json:"signals"\`
		Velocity map[string]int64 \`json:"velocity"\`
	}
	r.Decode(&body)
	ctx.Assert(body.CaseID == "case-1" && body.Score == 0.82 && body.Band == "decline" && len(body.Signals) == 2 &&
		body.Velocity["card_attempts"] == 6 && body.Velocity["device_accounts"] == 2,
		"the case must carry case_id, score 0.82, band decline, both signals and velocity {6, 2}, got %s", r.Text())
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := harnessReadAPI(ctx)
	foreign := c.Get("/v1/cases/case-1", "X-Tenant-Id", "t-2")
	missing := c.Get("/v1/cases/case-404", "X-Tenant-Id", "t-2")
	anonymous := c.Get("/v1/cases/case-1")
	byQuery := c.Get("/v1/cases/case-1?tenant=t-1&tenant_id=t-1")
	ctx.Equal(foreign.Status, 404, "tenant t-2 reading t-1's case must be 404, like a missing one (%s)", foreign.Text())
	ctx.Assert(!strings.Contains(foreign.Text(), "decline") && !strings.Contains(foreign.Text(), "4242"), "the 404 for a foreign case leaks its content: %s", foreign.Text())
	ctx.Equal(missing.Status, 404, "a missing case")
	ctx.Assert(strings.ReplaceAll(foreign.Text(), "case-1", "<id>") == strings.ReplaceAll(missing.Text(), "case-404", "<id>"),
		"a foreign case answered %q and a missing one %q: the difference tells a caller which ids exist in other tenants. Answer both the same", foreign.Text(), missing.Text())
	ctx.Equal(anonymous.Status, 401, "a read without X-Tenant-Id")
	ctx.Equal(byQuery.Status, 401, "a read without X-Tenant-Id but with ?tenant=t-1 (the tenant comes from the X-Tenant-Id header only)")
}

func CheckMasking(ctx *harness.Ctx) {
	c := harnessReadAPI(ctx)
	r := c.Get("/v1/cases/case-1", "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 200, "GET /v1/cases/case-1 (%s)", r.Text())
	ctx.Assert(!strings.Contains(r.Text(), harnessCase1.Pan), "the case body carries the full card number: %s. Mask it in caseView", r.Text())
	var body struct {
		CardRef string \`json:"card_ref"\`
	}
	r.Decode(&body)
	ctx.Equal(body.CardRef, "****4242", "card_ref must be maskPrefix plus the last four digits")
	longCard := c.Get("/v1/cases/case-3", "X-Tenant-Id", "t-1")
	ctx.Assert(longCard.Status == 200 && !strings.Contains(longCard.Text(), harnessCase3.Pan), "GET /v1/cases/case-3 answered %d: %s", longCard.Status, longCard.Text())
	body.CardRef = ""
	longCard.Decode(&body)
	ctx.Equal(body.CardRef, "****0123", "case-3's card has 19 digits: card_ref must be maskPrefix plus its last four")
}

func CheckRoleHeader(ctx *harness.Ctx) {
	c := harnessReadAPI(ctx)
	r := c.Get("/v1/cases/case-1", "X-Tenant-Id", "t-1", "X-Role", "admin")
	ctx.Equal(r.Status, 200, "GET /v1/cases/case-1 with X-Role: admin (%s)", r.Text())
	ctx.Assert(!strings.Contains(r.Text(), harnessCase1.Pan), "a caller who sent X-Role: admin got the card number: %s. The client writes that header; raw card data goes through auditedPan only", r.Text())
}

func CheckAuditedTool(ctx *harness.Ctx) {
	harnessSeedCases()
	pan, ok := auditedPan(harnessBg, "analyst-7", "t-1", "case-1")
	ctx.Assert(ok && pan == harnessCase1.Pan, "auditedPan for the case's own tenant returned %q, %v; expected the PAN", pan, ok)
	log := store.AuditLog(harnessBg)
	ctx.Assert(len(log) == 1 && log[0] == store.AuditEntry{Actor: "analyst-7", Scope: "pan:read", CaseID: "case-1"},
		"reading a PAN must write one audit row (actor, panScope, case_id) first, the audit log is %+v", log)
	foreign, ok := auditedPan(harnessBg, "analyst-7", "t-2", "case-1")
	ctx.Assert(!ok && foreign == "", "auditedPan for another tenant's case returned %q: scope it with store.CaseOf", foreign)
	ctx.Equal(len(store.AuditLog(harnessBg)), 1, "a refused read must not add an audit row; the rows")
	ctx.Redis.Do("DEL", "audit:pan")
	ctx.Redis.Set("audit:pan", "not a list")
	unaudited, ok := auditedPan(harnessBg, "analyst-7", "t-1", "case-1")
	ctx.Assert(!ok && unaudited == "", "the audit row could not be written (audit:pan is not a list) and auditedPan still returned %q: a PAN read that leaves no trace must not return the PAN", unaudited)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <optional>
#include <string>

#include "fraud/store.h"

namespace {

const store::Case kHarnessCase1{"case-1", "t-1", "tx-1", "acct-9", 0.82, "decline", {"prior_chargebacks", "new_account"}, 6, 2, "4111111111114242"};
const store::Case kHarnessCase2{"case-2", "t-2", "tx-2", "acct-5", 0.45, "review", {"fallback"}, 1, 1, "5500000000005100"};
// A 19-digit card: the mask keeps the last four digits whatever the length.
const store::Case kHarnessCase3{"case-3", "t-1", "tx-3", "acct-9", 0.5, "review", {"velocity"}, 2, 1, "6011000990139420123"};

void harnessSeedCases() {
  store::putCase(kHarnessCase1);
  store::putCase(kHarnessCase2);
  store::putCase(kHarnessCase3);
}

harness::HTTP harnessReadAPI(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  harnessSeedCases();
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

nlohmann::json harnessBody(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

std::string harnessReplaceAll(std::string text, const std::string& from, const std::string& to) {
  for (size_t at = text.find(from); at != std::string::npos; at = text.find(from, at + to.size())) text.replace(at, from.size(), to);
  return text;
}

}  // namespace

void CheckRouteParam(harness::Ctx& ctx) {
  auto c = harnessReadAPI(ctx);
  const auto r = c.Get("/v1/cases/case-1", "X-Tenant-Id", "t-1");
  ctx.Equal(r.Status, 200, "GET /v1/cases/case-1 for its own tenant (%s)", r.Text());
  const auto body = harnessBody(r);
  const nlohmann::json velocity = {{"card_attempts", 6}, {"device_accounts", 2}};
  ctx.Assert(body.is_object() && body.value("case_id", "") == "case-1" && body.value("score", 0.0) == 0.82 && body.value("band", "") == "decline" &&
                 body.value("signals", nlohmann::json::array()) == nlohmann::json({"prior_chargebacks", "new_account"}) && body.value("velocity", nlohmann::json()) == velocity,
             "the case must carry case_id, score 0.82, band decline, both signals and velocity {6, 2}, got %s", r.Text());
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = harnessReadAPI(ctx);
  const auto foreign = c.Get("/v1/cases/case-1", "X-Tenant-Id", "t-2");
  const auto missing = c.Get("/v1/cases/case-404", "X-Tenant-Id", "t-2");
  const auto anonymous = c.Get("/v1/cases/case-1");
  const auto byQuery = c.Get("/v1/cases/case-1?tenant=t-1&tenant_id=t-1");
  ctx.Equal(foreign.Status, 404, "tenant t-2 reading t-1's case must be 404, like a missing one (%s)", foreign.Text());
  ctx.Assert(foreign.Text().find("decline") == std::string::npos && foreign.Text().find("4242") == std::string::npos, "the 404 for a foreign case leaks its content: %s", foreign.Text());
  ctx.Equal(missing.Status, 404, "a missing case");
  ctx.Assert(harnessReplaceAll(foreign.Text(), "case-1", "<id>") == harnessReplaceAll(missing.Text(), "case-404", "<id>"),
             "a foreign case answered %q and a missing one %q: the difference tells a caller which ids exist in other tenants. Answer both the same", foreign.Text(), missing.Text());
  ctx.Equal(anonymous.Status, 401, "a read without X-Tenant-Id");
  ctx.Equal(byQuery.Status, 401, "a read without X-Tenant-Id but with ?tenant=t-1 (the tenant comes from the X-Tenant-Id header only)");
}

void CheckMasking(harness::Ctx& ctx) {
  auto c = harnessReadAPI(ctx);
  const auto r = c.Get("/v1/cases/case-1", "X-Tenant-Id", "t-1");
  ctx.Equal(r.Status, 200, "GET /v1/cases/case-1 (%s)", r.Text());
  ctx.Assert(r.Text().find(kHarnessCase1.pan) == std::string::npos, "the case body carries the full card number: %s. Mask it in caseView", r.Text());
  ctx.Equal(harnessBody(r).value("card_ref", ""), "****4242", "card_ref must be kMaskPrefix plus the last four digits");
  const auto longCard = c.Get("/v1/cases/case-3", "X-Tenant-Id", "t-1");
  ctx.Assert(longCard.Status == 200 && longCard.Text().find(kHarnessCase3.pan) == std::string::npos, "GET /v1/cases/case-3 answered %d: %s", longCard.Status, longCard.Text());
  const auto longBody = harnessBody(longCard);
  ctx.Equal(longBody.is_object() ? longBody.value("card_ref", "") : "", "****0123", "case-3's card has 19 digits: card_ref must be kMaskPrefix plus its last four");
}

void CheckRoleHeader(harness::Ctx& ctx) {
  auto c = harnessReadAPI(ctx);
  const auto r = c.Get("/v1/cases/case-1", "X-Tenant-Id", "t-1", "X-Role", "admin");
  ctx.Equal(r.Status, 200, "GET /v1/cases/case-1 with X-Role: admin (%s)", r.Text());
  ctx.Assert(r.Text().find(kHarnessCase1.pan) == std::string::npos,
             "a caller who sent X-Role: admin got the card number: %s. The client writes that header; raw card data goes through auditedPan only", r.Text());
}

void CheckAuditedTool(harness::Ctx& ctx) {
  harnessSeedCases();
  const auto pan = auditedPan("analyst-7", "t-1", "case-1");
  ctx.Equal(pan, std::optional<std::string>(kHarnessCase1.pan), "auditedPan for the case's own tenant must return the PAN");
  const auto log = store::auditLog();
  ctx.Assert(log.size() == 1 && log[0].actor == "analyst-7" && log[0].scope == "pan:read" && log[0].case_id == "case-1",
             "reading a PAN must write one audit row (actor, kPanScope, case_id) first, the audit log has %d row(s)", log.size());
  const auto foreign = auditedPan("analyst-7", "t-2", "case-1");
  ctx.Assert(!foreign, "auditedPan for another tenant's case returned %s: scope it with store::caseOf", foreign.value_or(""));
  ctx.Equal(store::auditLog().size(), 1, "a refused read must not add an audit row; the rows");
  ctx.Redis.Del("audit:pan");
  ctx.Redis.Set("audit:pan", "not a list");
  std::optional<std::string> unaudited;
  try {
    unaudited = auditedPan("analyst-7", "t-1", "case-1");
  } catch (const std::exception&) {
    unaudited.reset();
  }
  ctx.Assert(!unaudited, "the audit row could not be written (audit:pan is not a list) and auditedPan still returned %s: a PAN read that leaves no trace must not return the PAN",
             unaudited.value_or(""));
}
`,
  },
  hints: [
    "Ask for another tenant's case id: 200 and its card number. Ask for your own: the full number is in `card_number`. Call `audited_pan`: the audit log stays empty.",
    "`load_case` answers any tenant's case, `case_view` copies the PAN as it is, the admin branch trusts a header the client wrote, and `audited_pan` never calls `store.audit`.",
    'Read `X-Tenant-Id` (401 when absent) and `store.case_of(tenant, case_id)` (404 on None); replace `card_number` with `card_ref: mask_card(pan)`; delete the `X-Role` branch; in `audited_pan`, `case_of` then `store.audit(actor, PAN_SCOPE, case_id)`.',
  ],
  debrief: `A 404 for a foreign case is the scoping rule's other half: a 403 would confirm the id exists, which is itself a leak when ids can be guessed. Masking belongs in the response builder because every caller passes through it; a role check in the handler is a second code path that only needs one bug. Raw card data then has exactly one door, and the door writes its audit row before it opens. Production review tools go further: the PAN lives in a vault and the case holds a token, the audited read requires a ticket or a reason code, and the audit log is append-only and shipped off the host.`,
};
