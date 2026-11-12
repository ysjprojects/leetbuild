import type {Step} from '@/lib/types';

export const invoiceReadStep: Step = {
  id: 'read',
  title: "GET /v1/invoices/{id}: the issuer's copy and the customer's copy",
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'auditor'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/invoices/{id}\` on the invoice store: it takes the
caller's role from a \`?role=\` query parameter (default \`issuer\`, **403** for anything but
\`ROLES\`), looks the invoice up by id alone (\`store.get\`, **404** when missing) and returns the
stored invoice, \`internal_notes\` and all, to whoever asked. It serves the demo (one tenant, the
issuer) and hides four flaws.

**Failure mode the checks target.** A customer who adds \`?role=issuer\` reads the issuer's copy; the
customer's copy carries the issuer's internal notes; a customer reads a draft that can still change;
and any tenant reads another tenant's invoice by guessing its id.

- The role comes from the gateway's \`X-Role\` header, never the query string: \`issuer\` or
  \`customer\` (\`ROLES\`), anything else or none is **403**.
- The customer's copy is \`customer_view(invoice)\`: exactly \`CUSTOMER_FIELDS\` (\`id\`, \`number\`,
  \`status\`, \`currency\`, \`line_items\`, \`subtotal_cents\`, \`tax_cents\`). The issuer gets the stored
  invoice.
- A customer asking for a draft gets **404**.
- The tenant comes from \`X-Tenant-Id\` (**401** without it); an invoice of another tenant answers
  **404**, the same as one that does not exist.`,
  sequence: {
    participants: ['Customer', 'Gateway', 'Invoice Service', 'invoice store'],
    messages: [
      {from: 'Customer', to: 'Gateway', label: 'GET /v1/invoices/{id} · session', kind: 'sync'},
      {from: 'Gateway', to: 'Invoice Service', label: 'X-Tenant-Id · X-Role: customer', kind: 'sync'},
      {from: 'Invoice Service', to: 'invoice store', label: 'get(id)', kind: 'sync'},
      {from: 'Invoice Service', to: 'Invoice Service', label: 'other tenant or draft → 404', kind: 'sync'},
      {from: 'Invoice Service', to: 'Customer', label: '200 customer_view: CUSTOMER_FIELDS only', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves an invoice to its issuer',
      detail: 'Register `GET /v1/invoices/{id}`: the issuer reads its finalized invoice, notes included.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/invoices\/\{/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/invoices\/:/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/invoices\/\{/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"invoices"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/invoices\//]},
      },
    },
    {
      id: 'role-header',
      title: 'Takes the role from X-Role, not the query',
      detail:
        "The role is the gateway's `X-Role` header, checked against `ROLES` (403 otherwise, a missing header included); a query parameter is whatever the caller typed, so `?role=issuer` must change nothing.",
      match: {
        python: {all: [/x-role/i, /\b403\b/], none: [/query_params/]},
        typescript: {all: [/x-role/i, /\b403\b/], none: [/request\.query/]},
        go: {all: [/X-Role/i, /StatusForbidden|\b403\b/], none: [/URL\.Query\(\)/]},
        scala: {all: [/X-Role/i, /Forbidden|\b403\b/], none: [/\bparameter\(/]},
        cpp: {all: [/X-Role/i, /\b403\b/], none: [/get_param_value|has_param/]},
      },
    },
    {
      id: 'customer-view',
      title: 'Serves the customer a projection, not the stored invoice',
      detail:
        "The customer's copy holds exactly `CUSTOMER_FIELDS` (`customer_view`/`customerView`); the issuer's `internal_notes`, `customer_id`, `tenant_id` and tax bookkeeping stay out of it.",
      match: {
        python: {all: [/CUSTOMER_FIELDS/, /customer_view\(/]},
        typescript: {all: [/CUSTOMER_FIELDS/, /customerView\(/]},
        go: {all: [/customerFields/, /customerView\(/]},
        scala: {all: [/CustomerFields/, /customerView\(/]},
        cpp: {all: [/kCustomerFields/, /customer_view\(/]},
      },
    },
    {
      id: 'drafts-hidden',
      title: 'A customer never sees a draft',
      detail:
        'A customer asking for an invoice whose `status` is not `finalized` gets **404**: a draft can still change, and showing it makes it look issued.',
      match: {
        python: {all: [/status\W*!=\s*["']finalized["']/]},
        typescript: {all: [/status\W*!==?\s*['"]finalized['"]/]},
        go: {all: [/Status\s*!=\s*"finalized"/]},
        scala: {all: [/status\s*[!=]=\s*"finalized"/]},
        cpp: {all: [/status\s*!=\s*"finalized"/]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Another tenant's invoice is 404",
      detail:
        "The tenant from `X-Tenant-Id` is compared with the invoice's `tenant_id`; a mismatch answers **404** exactly like a missing invoice, so the id is not an existence oracle.",
      match: {
        python: {all: [/x-tenant-id/i, /tenant_id["']\]\s*!=\s*tenant/]},
        typescript: {all: [/x-tenant-id/i, /tenant_id\s*!==\s*tenant/]},
        go: {all: [/X-Tenant-Id/i, /TenantID\s*!=\s*tenant/]},
        scala: {all: [/X-Tenant-Id/i, /tenantId\s*[!=]=\s*tenant/]},
        cpp: {all: [/X-Tenant-Id/i, /tenant_id\s*!=\s*tenant/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from invoice import store  # store.get

app = FastAPI()

ROLES = ("issuer", "customer")


@app.get("/v1/invoices/{invoice_id}")
def read_invoice(invoice_id: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    role = request.query_params.get("role", "issuer")
    if role not in ROLES:
        raise HTTPException(status_code=403, detail="unknown role")
    invoice = store.get(invoice_id)
    if invoice is None:
        raise HTTPException(status_code=404, detail="no such invoice")
    return invoice
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from invoice import store  # store.get

app = FastAPI()

ROLES = ("issuer", "customer")
CUSTOMER_FIELDS = ("id", "number", "status", "currency", "line_items", "subtotal_cents", "tax_cents")


def customer_view(invoice: dict) -> dict:
    """The customer's copy: the document, without the issuer's notes and bookkeeping."""
    return {name: invoice[name] for name in CUSTOMER_FIELDS}


@app.get("/v1/invoices/{invoice_id}")
def read_invoice(invoice_id: str, request: Request) -> dict:
    # The gateway authenticated the caller and set X-Role; a query parameter is whatever the caller typed.
    role = request.headers.get("x-role", "")
    if role not in ROLES:
        raise HTTPException(status_code=403, detail="unknown role")
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    invoice = store.get(invoice_id)
    # Another tenant's invoice, and a draft a customer may not see, answer exactly like a missing one.
    if invoice is None or invoice["tenant_id"] != tenant or (role == "customer" and invoice["status"] != "finalized"):
        raise HTTPException(status_code=404, detail="no such invoice")
    return invoice if role == "issuer" else customer_view(invoice)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {get} from 'invoice/store';

export const app = Fastify();

export const ROLES = ['issuer', 'customer'];

app.get('/v1/invoices/:invoiceId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {role = 'issuer'} = request.query as {role?: string};
  if (!ROLES.includes(role)) return reply.code(403).send({error: 'unknown role'});
  const {invoiceId} = request.params as {invoiceId: string};
  const invoice = await get(invoiceId);
  if (invoice === null) return reply.code(404).send({error: 'no such invoice'});
  return invoice;
});
`,
      solution: `import Fastify from 'fastify';

import {type Invoice, get} from 'invoice/store';

export const app = Fastify();

export const ROLES = ['issuer', 'customer'];
export const CUSTOMER_FIELDS = ['id', 'number', 'status', 'currency', 'line_items', 'subtotal_cents', 'tax_cents'] as const;

/** The customer's copy: the document, without the issuer's notes and bookkeeping. */
export function customerView(invoice: Invoice): Partial<Invoice> {
  return Object.fromEntries(CUSTOMER_FIELDS.map(name => [name, invoice[name]]));
}

app.get('/v1/invoices/:invoiceId', async (request, reply) => {
  // The gateway authenticated the caller and set X-Role; a query parameter is whatever the caller typed.
  const role = request.headers['x-role'];
  if (typeof role !== 'string' || !ROLES.includes(role)) return reply.code(403).send({error: 'unknown role'});
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {invoiceId} = request.params as {invoiceId: string};
  const invoice = await get(invoiceId);
  // Another tenant's invoice, and a draft a customer may not see, answer exactly like a missing one.
  if (invoice === null || invoice.tenant_id !== tenant || (role === 'customer' && invoice.status !== 'finalized')) {
    return reply.code(404).send({error: 'no such invoice'});
  }
  return role === 'issuer' ? invoice : customerView(invoice);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"slices"

	"invoice/store" // store.Get
)

var roles = []string{"issuer", "customer"}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readInvoice(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	role := r.URL.Query().Get("role")
	if role == "" {
		role = "issuer"
	}
	if !slices.Contains(roles, role) {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "unknown role"})
		return
	}
	invoice := store.Get(r.Context(), r.PathValue("id"))
	if invoice == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such invoice"})
		return
	}
	writeJSON(rw, http.StatusOK, invoice)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/invoices/{id}", readInvoice)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"slices"

	"invoice/store" // store.Get
)

var (
	roles          = []string{"issuer", "customer"}
	customerFields = []string{"id", "number", "status", "currency", "line_items", "subtotal_cents", "tax_cents"}
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// customerView is the customer's copy: the document, without the issuer's notes and bookkeeping.
func customerView(invoice *store.Invoice) map[string]any {
	raw, _ := json.Marshal(invoice)
	var all map[string]any
	json.Unmarshal(raw, &all)
	view := map[string]any{}
	for _, name := range customerFields {
		view[name] = all[name]
	}
	return view
}

func readInvoice(rw http.ResponseWriter, r *http.Request) {
	// The gateway authenticated the caller and set X-Role; a query parameter is whatever the caller typed.
	role := r.Header.Get("X-Role")
	if !slices.Contains(roles, role) {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "unknown role"})
		return
	}
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	invoice := store.Get(r.Context(), r.PathValue("id"))
	// Another tenant's invoice, and a draft a customer may not see, answer exactly like a missing one.
	if invoice == nil || invoice.TenantID != tenant || (role == "customer" && invoice.Status != "finalized") {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such invoice"})
		return
	}
	if role == "issuer" {
		writeJSON(rw, http.StatusOK, invoice)
		return
	}
	writeJSON(rw, http.StatusOK, customerView(invoice))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/invoices/{id}", readInvoice)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import invoice.Store // Store.get, linesJson

object Read {
  val Roles: Set[String] = Set("issuer", "customer")

  /** The stored invoice as JSON. */
  def document(invoice: Store.Invoice): JsObject = JsObject(
    "id" -> JsString(invoice.id),
    "tenant_id" -> JsString(invoice.tenantId),
    "customer_id" -> JsString(invoice.customerId),
    "currency" -> JsString(invoice.currency),
    "jurisdiction" -> JsString(invoice.jurisdiction),
    "status" -> JsString(invoice.status),
    "number" -> invoice.number.map(JsNumber(_)).getOrElse(JsNull),
    "line_items" -> Store.linesJson(invoice.lineItems),
    "subtotal_cents" -> JsNumber(invoice.subtotalCents),
    "tax_cents" -> invoice.taxCents.map(JsNumber(_)).getOrElse(JsNull),
    "tax_source" -> invoice.taxSource.map(JsString(_)).getOrElse(JsNull),
    "internal_notes" -> JsString(invoice.internalNotes))

  private def json(body: JsObject): HttpResponse = HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "invoices" / Segment) { invoiceId =>
    get {
      parameter("role".withDefault("issuer")) { role =>
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        if (!Roles.contains(role)) complete(StatusCodes.Forbidden -> "unknown role")
        else
          Store.get(invoiceId) match {
            case None => complete(StatusCodes.NotFound -> "no such invoice")
            case Some(found) => complete(json(document(found)))
          }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import invoice.Store // Store.get, linesJson

object Read {
  val Roles: Set[String] = Set("issuer", "customer")
  val CustomerFields: Seq[String] = Seq("id", "number", "status", "currency", "line_items", "subtotal_cents", "tax_cents")

  /** The stored invoice as JSON. */
  def document(invoice: Store.Invoice): JsObject = JsObject(
    "id" -> JsString(invoice.id),
    "tenant_id" -> JsString(invoice.tenantId),
    "customer_id" -> JsString(invoice.customerId),
    "currency" -> JsString(invoice.currency),
    "jurisdiction" -> JsString(invoice.jurisdiction),
    "status" -> JsString(invoice.status),
    "number" -> invoice.number.map(JsNumber(_)).getOrElse(JsNull),
    "line_items" -> Store.linesJson(invoice.lineItems),
    "subtotal_cents" -> JsNumber(invoice.subtotalCents),
    "tax_cents" -> invoice.taxCents.map(JsNumber(_)).getOrElse(JsNull),
    "tax_source" -> invoice.taxSource.map(JsString(_)).getOrElse(JsNull),
    "internal_notes" -> JsString(invoice.internalNotes))

  /** The customer's copy: the document, without the issuer's notes and bookkeeping. */
  def customerView(invoice: Store.Invoice): JsObject = JsObject(document(invoice).fields.filter { case (name, _) => CustomerFields.contains(name) })

  private def json(body: JsObject): HttpResponse = HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "invoices" / Segment) { invoiceId =>
    get {
      // The gateway authenticated the caller and set X-Role; a query parameter is whatever the caller typed.
      optionalHeaderValueByName("X-Role") { role =>
        optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
          (role.filter(Roles.contains), tenantHeader.filter(_.nonEmpty)) match {
            case (None, _) => complete(StatusCodes.Forbidden -> "unknown role")
            case (_, None) => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
            case (Some(who), Some(tenant)) =>
              // Another tenant's invoice, and a draft a customer may not see, answer exactly like a missing one.
              Store.get(invoiceId).filter(_.tenantId == tenant) match {
                case Some(found) if who == "issuer" => complete(json(document(found)))
                case Some(found) if found.status == "finalized" => complete(json(customerView(found)))
                case _ => complete(StatusCodes.NotFound -> "no such invoice")
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

#include <algorithm>
#include <string>
#include <vector>

#include "invoice/store.h"  // store::get, linesJson

using json = nlohmann::json;

const std::vector<std::string> kRoles = {"issuer", "customer"};

// The stored invoice as JSON.
json document(const store::Invoice& invoice) {
  return json{{"id", invoice.id},
              {"tenant_id", invoice.tenant_id},
              {"customer_id", invoice.customer_id},
              {"currency", invoice.currency},
              {"jurisdiction", invoice.jurisdiction},
              {"status", invoice.status},
              {"number", invoice.number > 0 ? json(invoice.number) : json(nullptr)},
              {"line_items", store::linesJson(invoice.line_items)},
              {"subtotal_cents", invoice.subtotal_cents},
              {"tax_cents", invoice.tax_source.empty() ? json(nullptr) : json(invoice.tax_cents)},
              {"tax_source", invoice.tax_source.empty() ? json(nullptr) : json(invoice.tax_source)},
              {"internal_notes", invoice.internal_notes}};
}

void send(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void read_invoice(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string role = req.has_param("role") ? req.get_param_value("role") : "issuer";
  if (std::find(kRoles.begin(), kRoles.end(), role) == kRoles.end()) return send(res, 403, json{{"error", "unknown role"}});
  const auto invoice = store::get(req.matches[1]);
  if (!invoice) return send(res, 404, json{{"error", "no such invoice"}});
  send(res, 200, document(*invoice));
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/invoices/([\\w-]+))", read_invoice); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "invoice/store.h"  // store::get, linesJson

using json = nlohmann::json;

const std::vector<std::string> kRoles = {"issuer", "customer"};
const std::vector<std::string> kCustomerFields = {"id", "number", "status", "currency", "line_items", "subtotal_cents", "tax_cents"};

// The stored invoice as JSON.
json document(const store::Invoice& invoice) {
  return json{{"id", invoice.id},
              {"tenant_id", invoice.tenant_id},
              {"customer_id", invoice.customer_id},
              {"currency", invoice.currency},
              {"jurisdiction", invoice.jurisdiction},
              {"status", invoice.status},
              {"number", invoice.number > 0 ? json(invoice.number) : json(nullptr)},
              {"line_items", store::linesJson(invoice.line_items)},
              {"subtotal_cents", invoice.subtotal_cents},
              {"tax_cents", invoice.tax_source.empty() ? json(nullptr) : json(invoice.tax_cents)},
              {"tax_source", invoice.tax_source.empty() ? json(nullptr) : json(invoice.tax_source)},
              {"internal_notes", invoice.internal_notes}};
}

// The customer's copy: the document, without the issuer's notes and bookkeeping.
json customer_view(const store::Invoice& invoice) {
  const json all = document(invoice);
  json view = json::object();
  for (const std::string& name : kCustomerFields) view[name] = all[name];
  return view;
}

void send(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void read_invoice(const httplib::Request& req, httplib::Response& res) {
  // The gateway authenticated the caller and set X-Role; a query parameter is whatever the caller typed.
  const std::string role = req.get_header_value("X-Role");
  if (std::find(kRoles.begin(), kRoles.end(), role) == kRoles.end()) return send(res, 403, json{{"error", "unknown role"}});
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return send(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const auto invoice = store::get(req.matches[1]);
  // Another tenant's invoice, and a draft a customer may not see, answer exactly like a missing one.
  if (!invoice || invoice->tenant_id != tenant || (role == "customer" && invoice->status != "finalized")) {
    return send(res, 404, json{{"error", "no such invoice"}});
  }
  send(res, 200, role == "issuer" ? document(*invoice) : customer_view(*invoice));
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/invoices/([\\w-]+))", read_invoice); }
`,
    },
  },
  harness: {
    python: `from invoice import sequence, store

LINES = [{"description": "Consulting", "quantity": 2, "unit_price_cents": 25000}]
NOTES = "margin 40%, do not discount"
CUSTOMER_FIELDS = {"id", "number", "status", "currency", "line_items", "subtotal_cents", "tax_cents"}


def _issued(tenant="t-1"):
    invoice_id = store.create(tenant, "eur", LINES, "cus-1", "DE", NOTES)["id"]
    store.set_tax(invoice_id, 9500, "quote")
    sequence.claim_number(tenant, invoice_id)
    return invoice_id


def _draft():
    return store.create("t-1", "eur", LINES, "cus-1", "DE", NOTES)["id"]


def _api(ctx):
    return ctx.client(ctx.load("read").app)


def _as(role, tenant="t-1"):
    return {"X-Tenant-Id": tenant, "X-Role": role}


async def check_route(ctx):
    a = _issued()
    async with _api(ctx) as c:
        r = await c.get(f"/v1/invoices/{a}", headers=_as("issuer"))
    assert r.status_code == 200, f"the issuer reading its invoice got {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("id") == a and body.get("number") == 1 and body.get("line_items") == LINES, f"the issuer's copy must carry the id, number 1 and the lines, got {body}"
    assert body.get("internal_notes") == NOTES, f"the issuer's copy must carry its internal notes, got {body}"


async def check_role_header(ctx):
    a = _issued()
    async with _api(ctx) as c:
        r = await c.get(f"/v1/invoices/{a}", headers={"X-Tenant-Id": "t-1"})
        assert r.status_code == 403, f"a request without X-Role answered {r.status_code}, expected 403: the role comes from the gateway, not a default"
        r = await c.get(f"/v1/invoices/{a}", headers=_as("auditor"))
        assert r.status_code == 403, f"X-Role auditor answered {r.status_code}, expected 403"
        plain = await c.get(f"/v1/invoices/{a}", headers=_as("customer"))
        tricked = await c.get(f"/v1/invoices/{a}?role=issuer", headers=_as("customer"))
    assert plain.status_code == 200, f"a customer reading a finalized invoice got {plain.status_code}: {plain.text}"
    assert tricked.status_code == plain.status_code and tricked.json() == plain.json(), f"a customer who adds ?role=issuer got {tricked.text} instead of their own copy {plain.text}: the role is X-Role, not the query string"


async def check_customer_view(ctx):
    a = _issued()
    async with _api(ctx) as c:
        r = await c.get(f"/v1/invoices/{a}?role=customer", headers=_as("customer"))
        issuer = await c.get(f"/v1/invoices/{a}?role=issuer", headers=_as("issuer"))
    assert r.status_code == 200, f"a customer reading a finalized invoice got {r.status_code}: {r.text}"
    body = r.json()
    assert set(body) == CUSTOMER_FIELDS, f"the customer's copy has fields {sorted(body)}, expected exactly {sorted(CUSTOMER_FIELDS)}"
    assert NOTES not in r.text, "the customer's copy carries the issuer's internal notes"
    assert body["line_items"] == LINES and body["number"] == 1 and body["tax_cents"] == 9500, f"the customer's copy must carry the lines, number 1 and the tax, got {body}"
    assert issuer.status_code == 200 and issuer.json().get("internal_notes") == NOTES, f"the issuer's copy must still carry its notes, got {issuer.status_code} {issuer.text}"


async def check_drafts_hidden(ctx):
    d = _draft()
    async with _api(ctx) as c:
        r = await c.get(f"/v1/invoices/{d}?role=customer", headers=_as("customer"))
        assert r.status_code == 404, f"a customer reading a draft got {r.status_code}, expected 404: a draft can still change"
        r = await c.get(f"/v1/invoices/{d}?role=issuer", headers=_as("issuer"))
    assert r.status_code == 200 and r.json().get("status") == "draft", f"the issuer reading its draft got {r.status_code} {r.text}"


async def check_tenant_scope(ctx):
    a = _issued()
    async with _api(ctx) as c:
        foreign = await c.get(f"/v1/invoices/{a}?role=issuer", headers=_as("issuer", "t-2"))
        missing = await c.get("/v1/invoices/inv-404?role=issuer", headers=_as("issuer", "t-2"))
        assert foreign.status_code == 404, f"tenant t-2 reading t-1's invoice got {foreign.status_code}, expected 404"
        assert foreign.text == missing.text, f"another tenant's invoice answered {foreign.text}, a missing one {missing.text}: the difference tells a caller the id exists"
        r = await c.get(f"/v1/invoices/{a}?role=issuer", headers={"X-Role": "issuer"})
    assert r.status_code == 401, f"a request without X-Tenant-Id answered {r.status_code}, expected 401"
`,
    typescript: `const LINES = [{description: 'Consulting', quantity: 2, unit_price_cents: 25000}];
const NOTES = 'margin 40%, do not discount';
const CUSTOMER_FIELDS = ['currency', 'id', 'line_items', 'number', 'status', 'subtotal_cents', 'tax_cents'];

async function setup(ctx) {
  const store = ctx.load('/support/invoice/store.ts');
  const {claimNumber} = ctx.load('/support/invoice/sequence.ts');
  const issued = async (tenant = 't-1'): Promise<string> => {
    const {id} = await store.create(tenant, 'eur', LINES, 'cus-1', 'DE', NOTES);
    await store.setTax(id, 9500, 'quote');
    await claimNumber(tenant, id);
    return id;
  };
  const draft = async (): Promise<string> => (await store.create('t-1', 'eur', LINES, 'cus-1', 'DE', NOTES)).id;
  return {c: ctx.client(ctx.load('read').app), issued, draft};
}

const as = (role: string, tenant = 't-1') => ({'X-Tenant-Id': tenant, 'X-Role': role});

export async function check_route(ctx) {
  const {c, issued} = await setup(ctx);
  const a = await issued();
  const r = await c.get(\`/v1/invoices/\${a}\`, {headers: as('issuer')});
  assert.equal(r.status, 200, \`the issuer reading its invoice got \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.id === a && body.number === 1 && JSON.stringify(body.line_items) === JSON.stringify(LINES), \`the issuer's copy must carry the id, number 1 and the lines, got \${r.text}\`);
  assert.equal(body.internal_notes, NOTES, \`the issuer's copy must carry its internal notes, got \${r.text}\`);
}

export async function check_role_header(ctx) {
  const {c, issued} = await setup(ctx);
  const a = await issued();
  let r = await c.get(\`/v1/invoices/\${a}\`, {headers: {'X-Tenant-Id': 't-1'}});
  assert.equal(r.status, 403, \`a request without X-Role answered \${r.status}, expected 403: the role comes from the gateway, not a default\`);
  r = await c.get(\`/v1/invoices/\${a}\`, {headers: as('auditor')});
  assert.equal(r.status, 403, \`X-Role auditor answered \${r.status}, expected 403\`);
  const plain = await c.get(\`/v1/invoices/\${a}\`, {headers: as('customer')});
  const tricked = await c.get(\`/v1/invoices/\${a}?role=issuer\`, {headers: as('customer')});
  assert.equal(plain.status, 200, \`a customer reading a finalized invoice got \${plain.status}: \${plain.text}\`);
  assert(tricked.status === plain.status && tricked.text === plain.text, \`a customer who adds ?role=issuer got \${tricked.text} instead of their own copy \${plain.text}: the role is X-Role, not the query string\`);
}

export async function check_customer_view(ctx) {
  const {c, issued} = await setup(ctx);
  const a = await issued();
  const r = await c.get(\`/v1/invoices/\${a}?role=customer\`, {headers: as('customer')});
  const issuer = await c.get(\`/v1/invoices/\${a}?role=issuer\`, {headers: as('issuer')});
  assert.equal(r.status, 200, \`a customer reading a finalized invoice got \${r.status}: \${r.text}\`);
  const body = r.json();
  assert.deepStrictEqual(Object.keys(body).sort(), CUSTOMER_FIELDS, \`the customer's copy has fields \${JSON.stringify(Object.keys(body).sort())}, expected exactly \${JSON.stringify(CUSTOMER_FIELDS)}\`);
  assert(!r.text.includes(NOTES), "the customer's copy carries the issuer's internal notes");
  assert(JSON.stringify(body.line_items) === JSON.stringify(LINES) && body.number === 1 && body.tax_cents === 9500, \`the customer's copy must carry the lines, number 1 and the tax, got \${r.text}\`);
  assert(issuer.status === 200 && issuer.json().internal_notes === NOTES, \`the issuer's copy must still carry its notes, got \${issuer.status} \${issuer.text}\`);
}

export async function check_drafts_hidden(ctx) {
  const {c, draft} = await setup(ctx);
  const d = await draft();
  let r = await c.get(\`/v1/invoices/\${d}?role=customer\`, {headers: as('customer')});
  assert.equal(r.status, 404, \`a customer reading a draft got \${r.status}, expected 404: a draft can still change\`);
  r = await c.get(\`/v1/invoices/\${d}?role=issuer\`, {headers: as('issuer')});
  assert(r.status === 200 && r.json().status === 'draft', \`the issuer reading its draft got \${r.status} \${r.text}\`);
}

export async function check_tenant_scope(ctx) {
  const {c, issued} = await setup(ctx);
  const a = await issued();
  const foreign = await c.get(\`/v1/invoices/\${a}?role=issuer\`, {headers: as('issuer', 't-2')});
  const missing = await c.get('/v1/invoices/inv-404?role=issuer', {headers: as('issuer', 't-2')});
  assert.equal(foreign.status, 404, \`tenant t-2 reading t-1's invoice got \${foreign.status}, expected 404\`);
  assert.equal(foreign.text, missing.text, \`another tenant's invoice answered \${foreign.text}, a missing one \${missing.text}: the difference tells a caller the id exists\`);
  const r = await c.get(\`/v1/invoices/\${a}?role=issuer\`, {headers: {'X-Role': 'issuer'}});
  assert.equal(r.status, 401, \`a request without X-Tenant-Id answered \${r.status}, expected 401\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"sort"
	"strings"

	"invoice/sequence"
	"invoice/store"

	"leetbuild/harness"
)

var (
	readBg    = context.Background()
	readLines = []store.Line{{Description: "Consulting", Quantity: 2, UnitPriceCents: 25000}}
	readNotes = "margin 40%, do not discount"
)

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func issued(tenant string) string {
	id := store.Create(readBg, tenant, "eur", readLines, "cus-1", "DE", readNotes).ID
	store.SetTax(readBg, id, 9500, "quote")
	sequence.ClaimNumber(readBg, tenant, id)
	return id
}

func bodyOf(ctx *harness.Ctx, r *harness.Response) map[string]any {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the response is not a JSON object: %s", r.Text())
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	a := issued("t-1")
	r := readAPI(ctx).Get("/v1/invoices/"+a, "X-Tenant-Id", "t-1", "X-Role", "issuer")
	ctx.Equal(r.Status, 200, "the issuer reading its invoice (%s)", r.Text())
	body := bodyOf(ctx, r)
	ctx.Assert(body["id"] == a && body["number"] == float64(1) && strings.Contains(r.Text(), "Consulting"), "the issuer's copy must carry the id, number 1 and the lines, got %s", r.Text())
	ctx.Equal(body["internal_notes"], readNotes, "the issuer's copy must carry its internal notes")
}

func CheckRoleHeader(ctx *harness.Ctx) {
	a := issued("t-1")
	c := readAPI(ctx)
	r := c.Get("/v1/invoices/"+a, "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 403, "a request without X-Role (the role comes from the gateway, not a default)")
	r = c.Get("/v1/invoices/"+a, "X-Tenant-Id", "t-1", "X-Role", "auditor")
	ctx.Equal(r.Status, 403, "X-Role auditor")
	plain := c.Get("/v1/invoices/"+a, "X-Tenant-Id", "t-1", "X-Role", "customer")
	tricked := c.Get("/v1/invoices/"+a+"?role=issuer", "X-Tenant-Id", "t-1", "X-Role", "customer")
	ctx.Equal(plain.Status, 200, "a customer reading a finalized invoice (%s)", plain.Text())
	ctx.Assert(tricked.Status == plain.Status && tricked.Text() == plain.Text(), "a customer who adds ?role=issuer got %s instead of their own copy %s: the role is X-Role, not the query string", tricked.Text(), plain.Text())
}

func CheckCustomerView(ctx *harness.Ctx) {
	a := issued("t-1")
	c := readAPI(ctx)
	r := c.Get("/v1/invoices/"+a+"?role=customer", "X-Tenant-Id", "t-1", "X-Role", "customer")
	issuer := c.Get("/v1/invoices/"+a+"?role=issuer", "X-Tenant-Id", "t-1", "X-Role", "issuer")
	ctx.Equal(r.Status, 200, "a customer reading a finalized invoice (%s)", r.Text())
	body := bodyOf(ctx, r)
	fields := []string{}
	for name := range body {
		fields = append(fields, name)
	}
	sort.Strings(fields)
	ctx.Equal(fields, []string{"currency", "id", "line_items", "number", "status", "subtotal_cents", "tax_cents"}, "the customer's copy must hold exactly the customer fields; its fields")
	ctx.Assert(!strings.Contains(r.Text(), readNotes), "the customer's copy carries the issuer's internal notes")
	ctx.Assert(body["number"] == float64(1) && body["tax_cents"] == float64(9500) && strings.Contains(r.Text(), "Consulting"), "the customer's copy must carry the lines, number 1 and the tax, got %s", r.Text())
	ctx.Assert(issuer.Status == 200 && strings.Contains(issuer.Text(), readNotes), "the issuer's copy must still carry its notes, got %d %s", issuer.Status, issuer.Text())
}

func CheckDraftsHidden(ctx *harness.Ctx) {
	d := store.Create(readBg, "t-1", "eur", readLines, "cus-1", "DE", readNotes).ID
	c := readAPI(ctx)
	r := c.Get("/v1/invoices/"+d+"?role=customer", "X-Tenant-Id", "t-1", "X-Role", "customer")
	ctx.Equal(r.Status, 404, "a customer reading a draft (a draft can still change)")
	r = c.Get("/v1/invoices/"+d+"?role=issuer", "X-Tenant-Id", "t-1", "X-Role", "issuer")
	ctx.Assert(r.Status == 200 && bodyOf(ctx, r)["status"] == "draft", "the issuer reading its draft got %d %s", r.Status, r.Text())
}

func CheckTenantScope(ctx *harness.Ctx) {
	a := issued("t-1")
	c := readAPI(ctx)
	foreign := c.Get("/v1/invoices/"+a+"?role=issuer", "X-Tenant-Id", "t-2", "X-Role", "issuer")
	missing := c.Get("/v1/invoices/inv-404?role=issuer", "X-Tenant-Id", "t-2", "X-Role", "issuer")
	ctx.Equal(foreign.Status, 404, "tenant t-2 reading t-1's invoice")
	ctx.Equal(foreign.Text(), missing.Text(), "another tenant's invoice must answer like a missing one, or the difference tells a caller the id exists; the body")
	r := c.Get("/v1/invoices/"+a+"?role=issuer", "X-Role", "issuer")
	ctx.Equal(r.Status, 401, "a request without X-Tenant-Id")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "invoice/sequence.h"
#include "invoice/store.h"

namespace {

using json = nlohmann::json;

const std::vector<store::Line> kReadLines = {{"Consulting", 2, 25000}};
const std::string kReadNotes = "margin 40%, do not discount";

harness::HTTP readApi(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string issued(const std::string& tenant) {
  const std::string id = store::create(tenant, "eur", kReadLines, "cus-1", "DE", kReadNotes).id;
  store::setTax(id, 9500, "quote");
  sequence::claimNumber(tenant, id);
  return id;
}

json bodyOf(harness::Ctx& ctx, const harness::Response& r) {
  try {
    return json::parse(r.Text());
  } catch (const std::exception&) {
    ctx.Fatalf("the response is not JSON: %s", r.Text());
  }
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  const std::string a = issued("t-1");
  auto c = readApi(ctx);
  const auto r = c.Get("/v1/invoices/" + a, "X-Tenant-Id", "t-1", "X-Role", "issuer");
  ctx.Equal(r.Status, 200, "the issuer reading its invoice (%s)", r.Text());
  const json body = bodyOf(ctx, r);
  ctx.Assert(body.value("id", "") == a && body.value("number", 0L) == 1 && r.Text().find("Consulting") != std::string::npos,
             "the issuer's copy must carry the id, number 1 and the lines, got %s", r.Text());
  ctx.Equal(body.value("internal_notes", ""), kReadNotes, "the issuer's copy must carry its internal notes");
}

void CheckRoleHeader(harness::Ctx& ctx) {
  const std::string a = issued("t-1");
  auto c = readApi(ctx);
  auto r = c.Get("/v1/invoices/" + a, "X-Tenant-Id", "t-1");
  ctx.Equal(r.Status, 403, "a request without X-Role (the role comes from the gateway, not a default)");
  r = c.Get("/v1/invoices/" + a, "X-Tenant-Id", "t-1", "X-Role", "auditor");
  ctx.Equal(r.Status, 403, "X-Role auditor");
  const auto plain = c.Get("/v1/invoices/" + a, "X-Tenant-Id", "t-1", "X-Role", "customer");
  const auto tricked = c.Get("/v1/invoices/" + a + "?role=issuer", "X-Tenant-Id", "t-1", "X-Role", "customer");
  ctx.Equal(plain.Status, 200, "a customer reading a finalized invoice (%s)", plain.Text());
  ctx.Assert(tricked.Status == plain.Status && tricked.Text() == plain.Text(),
             "a customer who adds ?role=issuer got %s instead of their own copy %s: the role is X-Role, not the query string", tricked.Text(), plain.Text());
}

void CheckCustomerView(harness::Ctx& ctx) {
  const std::string a = issued("t-1");
  auto c = readApi(ctx);
  const auto r = c.Get("/v1/invoices/" + a + "?role=customer", "X-Tenant-Id", "t-1", "X-Role", "customer");
  const auto issuer = c.Get("/v1/invoices/" + a + "?role=issuer", "X-Tenant-Id", "t-1", "X-Role", "issuer");
  ctx.Equal(r.Status, 200, "a customer reading a finalized invoice (%s)", r.Text());
  const json body = bodyOf(ctx, r);
  std::vector<std::string> fields;
  for (const auto& [name, value] : body.items()) fields.push_back(name);
  std::sort(fields.begin(), fields.end());
  ctx.Equal(fields, {"currency", "id", "line_items", "number", "status", "subtotal_cents", "tax_cents"}, "the customer's copy must hold exactly the customer fields; its fields");
  ctx.Assert(r.Text().find(kReadNotes) == std::string::npos, "the customer's copy carries the issuer's internal notes");
  ctx.Assert(body.value("number", 0L) == 1 && body.value("tax_cents", 0L) == 9500 && r.Text().find("Consulting") != std::string::npos,
             "the customer's copy must carry the lines, number 1 and the tax, got %s", r.Text());
  ctx.Assert(issuer.Status == 200 && issuer.Text().find(kReadNotes) != std::string::npos, "the issuer's copy must still carry its notes, got %d %s", issuer.Status, issuer.Text());
}

void CheckDraftsHidden(harness::Ctx& ctx) {
  const std::string d = store::create("t-1", "eur", kReadLines, "cus-1", "DE", kReadNotes).id;
  auto c = readApi(ctx);
  auto r = c.Get("/v1/invoices/" + d + "?role=customer", "X-Tenant-Id", "t-1", "X-Role", "customer");
  ctx.Equal(r.Status, 404, "a customer reading a draft (a draft can still change)");
  r = c.Get("/v1/invoices/" + d + "?role=issuer", "X-Tenant-Id", "t-1", "X-Role", "issuer");
  ctx.Assert(r.Status == 200 && bodyOf(ctx, r).value("status", "") == "draft", "the issuer reading its draft got %d %s", r.Status, r.Text());
}

void CheckTenantScope(harness::Ctx& ctx) {
  const std::string a = issued("t-1");
  auto c = readApi(ctx);
  const auto foreign = c.Get("/v1/invoices/" + a + "?role=issuer", "X-Tenant-Id", "t-2", "X-Role", "issuer");
  const auto missing = c.Get("/v1/invoices/inv-404?role=issuer", "X-Tenant-Id", "t-2", "X-Role", "issuer");
  ctx.Equal(foreign.Status, 404, "tenant t-2 reading t-1's invoice");
  ctx.Equal(foreign.Text(), missing.Text(), "another tenant's invoice must answer like a missing one, or the difference tells a caller the id exists; the body");
  const auto r = c.Get("/v1/invoices/" + a + "?role=issuer", "X-Role", "issuer");
  ctx.Equal(r.Status, 401, "a request without X-Tenant-Id");
}
`,
  },
  hints: [
    "Read an invoice as a customer and add `?role=issuer`: the response carries `internal_notes`. Without it the notes are there too, a draft comes back, and another tenant's id answers 200.",
    'The role is a query parameter defaulting to `issuer`, so the caller picks it. The handler returns the stored invoice to every role, never compares `tenant_id` with `X-Tenant-Id`, and never reads `status`.',
    "Read `X-Role` and answer 403 unless it is in `ROLES`; 401 without `X-Tenant-Id`; 404 when the invoice is missing, another tenant's, or a draft read by a customer; return `customer_view` (`CUSTOMER_FIELDS`) to customers.",
  ],
  debrief: `The read serves two documents from one stored invoice, and the server picks which one: the role comes from the gateway that authenticated the caller, so nothing the caller types can widen it. The customer projection lists the fields it keeps rather than the ones it drops, so a field added to the store later stays private until someone decides otherwise. A foreign invoice and a customer's draft answer exactly like a missing one, which keeps invoice ids from becoming a way to probe another tenant. Billing products add a third copy for auditors with the full history, sign the customer's PDF so a forwarded copy can be checked, and log every issuer read of an invoice for the tenant's own audit trail.`,
};
