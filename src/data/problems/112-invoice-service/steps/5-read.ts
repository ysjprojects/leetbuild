import type {Step} from '@/lib/types';

export const invoiceReadStep: Step = {
  id: 'read',
  concept: 'http',
  file: 'read',
  title: "GET /v1/invoices/{id}: the issuer's copy and the customer's copy",
  focus: ['client', 'api', 'db', 'auditor'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/invoices/{id}\`: it reads the role from a query
parameter that defaults to \`customer\`, looks the invoice up by id alone, and returns the stored
document to whoever asked. It compiles, serves the demo (one tenant, one role) and hides four flaws.

**Failure mode the checks target.** The customer who fetches their first invoice sees
\`internal_notes\` and \`cost_margin\`, because one payload serves everyone and the role is whatever
the caller typed. A customer can read a draft that does not exist yet and can still change. Any
authenticated caller reads another tenant's invoice, and the id becomes an existence oracle. And the
issuer's copy names no \`line_items\`, \`tax_breakdown\` or \`history\`, so an auditor gets whatever
the store holds.

- The role comes from the authenticated context, the gateway's \`X-Role\` header, not a query
  parameter or the body. Only \`issuer\` and \`customer\` are known roles; anything else, including no
  role, is **403**.
- The tenant comes from \`X-Tenant-Id\` and is compared with the stored invoice's \`tenant_id\`. A
  mismatch is **404**, exactly like an invoice that does not exist.
- Two projections, selected server-side: \`issuer_view\` is the full document with \`line_items\`,
  \`tax_breakdown\`, \`history\` and the internal fields; \`customer_view\` is built from an allowlist
  that never contains \`internal_notes\` or \`cost_margin\`.
- A \`customer\` reading an invoice whose \`status != FINALIZED\` gets **404**, not the draft body
  and not 403. The status gate runs before anything is rendered.`,
  sequence: {
    participants: ['Client', 'Invoice Service', 'invoice store', 'Auditor'],
    messages: [
      {from: 'Client', to: 'Invoice Service', label: 'GET /v1/invoices/{id} · X-Role: customer', kind: 'sync'},
      {from: 'Auditor', to: 'Invoice Service', label: 'GET /v1/invoices/{id} · X-Role: issuer', kind: 'sync'},
      {from: 'Invoice Service', to: 'Invoice Service', label: 'role ∈ {issuer, customer} · else 403', kind: 'sync'},
      {from: 'Invoice Service', to: 'invoice store', label: 'get(id)', kind: 'sync'},
      {from: 'invoice store', to: 'Invoice Service', label: 'invoice · tenant_id · status', kind: 'reply'},
      {
        from: 'Invoice Service',
        to: 'Invoice Service',
        label: 'foreign tenant or draft-for-customer → 404',
        kind: 'sync',
      },
      {from: 'Invoice Service', to: 'Invoice Service', label: 'build projection server-side', kind: 'sync'},
      {
        from: 'Invoice Service',
        to: 'Client',
        label: '200 · customer view (no internal notes, no margin)',
        kind: 'reply',
      },
      {
        from: 'Invoice Service',
        to: 'Auditor',
        label: '200 · issuer view · line_items · tax_breakdown · history',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/invoices/{id}',
      detail: 'Register the read route on `GET /v1/invoices/{id}`. The starter already does this.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/invoices\/\{/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/invoices\/:/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/invoices\/\{/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"invoices"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\s*\/v1\/invoices\/\(/]},
      },
    },
    {
      id: 'role-view',
      title: 'Reads the role from the authenticated context and serves two projections',
      detail:
        "The role is read from the gateway's `X-Role` (never a query parameter or the body), an unknown or missing role is **403**, and two distinct projections exist — an issuer builder and a customer builder. The customer builder is built from an allowlist that omits `internal_notes` and `cost_margin`; popping the internal fields off the issuer payload in the response layer still leaks them (leaked margins).",
      match: {
        python: {
          all: [/X-Role/, /status_code\s*=\s*403/, /customer_view/, /issuer_view/],
          none: [
            /\bpop\(\s*["'](?:internal_notes|cost_margin)["']/,
            /Query\([^)]*role/,
            /CUSTOMER_VIEW_FIELDS[^\n]*(?:internal_notes|internalNotes|cost_margin|costMargin)/,
          ],
        },
        typescript: {
          all: [/x-role/, /403/, /customerView/, /issuerView/],
          none: [
            /\bdelete\s+\w+\.(?:internal_notes|internalNotes|cost_margin|costMargin)/,
            /request\.query[^\n]*role/,
            /CUSTOMER_VIEW_FIELDS[^\n]*(?:internal_notes|internalNotes|cost_margin|costMargin)/,
          ],
        },
        go: {
          all: [/X-Role/, /StatusForbidden/, /customerView|CustomerView/, /issuerView|IssuerView/],
          none: [
            /delete\(\s*\w+\s*,\s*"(?:internal_notes|cost_margin)"\s*\)/,
            /URL\.Query\(\)[^\n]*role/,
            /customerViewFields[^\n]*(?:internal_notes|internalNotes|InternalNotes|cost_margin|costMargin|CostMargin)/,
          ],
        },
        scala: {
          all: [/X-Role/, /StatusCodes\.Forbidden/, /customerView|CustomerView/, /issuerView|IssuerView/],
          none: [
            /-=\s*"(?:internal_notes|internalNotes|cost_margin|costMargin)"/,
            /parameter\(\s*"role"/,
            /CustomerViewFields[^\n]*(?:internal_notes|internalNotes|InternalNotes|cost_margin|costMargin|CostMargin)/,
          ],
        },
        cpp: {
          all: [/X-Role/, /\b403\b/, /customerView|CustomerView/, /issuerView|IssuerView/],
          none: [
            /\berase\(\s*"(?:internal_notes|cost_margin)"\s*\)/,
            /get_param_value\(\s*"role"/,
            /kCustomerViewFields[^\n]*(?:internal_notes|internalNotes|kInternalNotes|cost_margin|costMargin|kCostMargin)/,
          ],
        },
      },
    },
    {
      id: 'drafts-hidden',
      title: 'Hides non-finalized invoices from customers with 404',
      detail:
        'A `customer` reading an invoice whose `status` is not the finalized constant gets **404** — not 403, and never the draft body. The status is compared with the finalized constant before anything is rendered, so the draft never reaches the customer (draft exposure).',
      match: {
        python: {all: [/FINALIZED\s*=\s*["']finalized["']/, /!=\s*FINALIZED/, /status_code\s*=\s*404/]},
        typescript: {all: [/FINALIZED\s*=\s*['"]finalized['"]/, /!==\s*FINALIZED/, /code\(\s*404\s*\)/]},
        go: {all: [/statusFinalized\s*=\s*"finalized"/, /!=\s*statusFinalized/, /StatusNotFound/]},
        scala: {all: [/Finalized\s*=\s*"finalized"/, /status\s*==\s*Finalized/, /StatusCodes\.NotFound/]},
        cpp: {all: [/kFinalized\s*=\s*"finalized"/, /!=\s*kFinalized/, /\b404\b/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Scope the lookup to the authenticated tenant',
      detail:
        "The invoice's `tenant_id` is compared with the tenant from the authenticated `X-Tenant-Id` header, and a mismatch returns **404** — the same answer as an unknown id, so another tenant's invoice is never rendered and ids cannot be enumerated by existence (id enumeration).",
      match: {
        python: {
          all: [/X-Tenant-Id/, /tenant_id/, /tenant_id["']\]\s*!=\s*tenant/, /status_code\s*=\s*404/],
        },
        typescript: {all: [/x-tenant-id/, /tenant_id/, /tenant_id\s*!==\s*tenant/, /code\(\s*404\s*\)/]},
        go: {all: [/X-Tenant-Id/, /TenantID/, /TenantID\s*!=\s*tenant/, /StatusNotFound/]},
        scala: {all: [/X-Tenant-Id/, /tenant_id/, /tenant_id\s*==\s*tenant/, /StatusCodes\.NotFound/]},
        cpp: {all: [/X-Tenant-Id/, /tenant_id/, /tenant_id[^;]*!=\s*tenant/, /\b404\b/]},
      },
    },
    {
      id: 'issuer-detail',
      title: "The issuer's copy carries the full document",
      detail:
        'The issuer projection returns `line_items`, `tax_breakdown` and `history` — the audit trail of status changes an auditor reads. The starter returns whatever the store holds without naming any of them.',
      match: {
        python: {all: [/def issuer_view/, /line_items/, /tax_breakdown/, /history/]},
        typescript: {all: [/function issuerView/, /line_items|lineItems/, /tax_breakdown|taxBreakdown/, /history/]},
        go: {all: [/func issuerView/, /LineItems|line_items/, /TaxBreakdown|tax_breakdown/, /History|history/]},
        scala: {all: [/def issuerView/, /lineItems|line_items/, /taxBreakdown|tax_breakdown/, /history/]},
        cpp: {all: [/json issuerView/, /line_items/, /tax_breakdown/, /history/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("invoiced")


class InvoiceStore:
    def get(self, invoice_id: str) -> dict | None:
        """The stored invoice document, or None."""
        raise NotImplementedError


invoices = InvoiceStore()


@app.get("/v1/invoices/{invoice_id}")
def get_invoice(invoice_id: str, role: str = "customer") -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    invoice = invoices.get(invoice_id)
    if invoice is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    logger.info("read invoice=%s role=%s", invoice_id, role)
    return JSONResponse(invoice, status_code=200)
`,
      solution: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("invoiced")

FINALIZED = "finalized"
ROLE_ISSUER = "issuer"
ROLE_CUSTOMER = "customer"

# The customer's copy is an allowlist: adding a field to it is a deliberate act.
CUSTOMER_VIEW_FIELDS = ("id", "number", "status", "currency", "total", "issued_at", "line_items", "tax_breakdown", "history")


class InvoiceStore:
    def get(self, invoice_id: str) -> dict | None:
        """The stored invoice document, or None."""
        raise NotImplementedError


invoices = InvoiceStore()


def issuer_view(invoice: dict) -> dict:
    """The issuer's copy: the whole document, internal fields included."""
    return {
        "id": invoice["id"],
        "number": invoice["number"],
        "status": invoice["status"],
        "currency": invoice["currency"],
        "total": invoice["total"],
        "line_items": invoice["line_items"],
        "tax_breakdown": invoice["tax_breakdown"],
        "internal_notes": invoice["internal_notes"],
        "cost_margin": invoice["cost_margin"],
        "history": invoice["history"],
    }


def customer_view(invoice: dict) -> dict:
    """The customer's copy, built from fields the customer is allowed to see."""
    return {field: invoice[field] for field in CUSTOMER_VIEW_FIELDS}


@app.get("/v1/invoices/{invoice_id}")
def get_invoice(
    invoice_id: str,
    x_role: str | None = Header(default=None, alias="X-Role"),
    x_tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if x_role not in (ROLE_ISSUER, ROLE_CUSTOMER):
        return JSONResponse({"error": "unknown role"}, status_code=403)
    tenant = x_tenant or ""
    invoice = invoices.get(invoice_id)
    if invoice is None or invoice["tenant_id"] != tenant:
        return JSONResponse({"error": "not found"}, status_code=404)
    if x_role == ROLE_CUSTOMER and invoice["status"] != FINALIZED:
        logger.info("held draft invoice=%s from customer", invoice_id)
        return JSONResponse({"error": "not found"}, status_code=404)
    if x_role == ROLE_ISSUER:
        return JSONResponse(issuer_view(invoice), status_code=200)
    return JSONResponse(customer_view(invoice), status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/invoices/:id — flawed code that hands one payload to every caller. */
import Fastify from 'fastify';

import {invoices} from './store';

export const app = Fastify();

app.get('/v1/invoices/:id', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {id} = request.params as {id: string};
  const role = (request.query as {role?: string}).role ?? 'customer';
  const invoice = invoices.get(id);
  if (invoice === undefined) return reply.code(404).send({error: 'not found'});
  request.log.info({id, role}, 'read invoice');
  return reply.code(200).send(invoice);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/invoices/:id — the issuer's copy and the customer's copy, chosen server-side. */
import Fastify from 'fastify';

import {invoices} from './store';

export const app = Fastify();

const FINALIZED = 'finalized';
const ROLE_ISSUER = 'issuer';
const ROLE_CUSTOMER = 'customer';

interface Invoice {
  id: string;
  tenant_id: string;
  number: string;
  status: string;
  currency: string;
  total: number;
  line_items: unknown[];
  tax_breakdown: Record<string, number>;
  internal_notes: string;
  cost_margin: number;
  history: unknown[];
}

// The customer's copy is an allowlist: adding a field to it is a deliberate act.
const CUSTOMER_VIEW_FIELDS = ['id', 'number', 'status', 'currency', 'total', 'issued_at', 'line_items', 'tax_breakdown', 'history'] as const;

function issuerView(invoice: Invoice): Record<string, unknown> {
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    currency: invoice.currency,
    total: invoice.total,
    line_items: invoice.line_items,
    tax_breakdown: invoice.tax_breakdown,
    internal_notes: invoice.internal_notes,
    cost_margin: invoice.cost_margin,
    history: invoice.history,
  };
}

function customerView(invoice: Invoice): Record<string, unknown> {
  const source = invoice as unknown as Record<string, unknown>;
  const view: Record<string, unknown> = {};
  for (const field of CUSTOMER_VIEW_FIELDS) view[field] = source[field];
  return view;
}

app.get('/v1/invoices/:id', async (request, reply) => {
  const role = request.headers['x-role'];
  if (role !== ROLE_ISSUER && role !== ROLE_CUSTOMER)
    return reply.code(403).send({error: 'unknown role'});
  const tenant = request.headers['x-tenant-id'];
  const {id} = request.params as {id: string};
  const invoice = invoices.get(id);
  if (invoice === undefined || invoice.tenant_id !== tenant)
    return reply.code(404).send({error: 'not found'});
  if (role === ROLE_CUSTOMER && invoice.status !== FINALIZED)
    return reply.code(404).send({error: 'not found'});
  return reply.code(200).send(role === ROLE_ISSUER ? issuerView(invoice) : customerView(invoice));
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

var invoices = map[string]map[string]any{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func getInvoice(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	id := r.PathValue("id")
	role := r.URL.Query().Get("role")
	invoice, ok := invoices[id]
	if !ok {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	log.Printf("read invoice=%s role=%s", id, role)
	writeJSON(rw, http.StatusOK, invoice)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/invoices/{id}", getInvoice)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

const (
	statusFinalized = "finalized"
	roleIssuer      = "issuer"
	roleCustomer    = "customer"
)

type Invoice struct {
	ID            string           \`json:"id"\`
	TenantID      string           \`json:"tenant_id"\`
	Number        string           \`json:"number"\`
	Status        string           \`json:"status"\`
	Currency      string           \`json:"currency"\`
	Total         int              \`json:"total"\`
	LineItems     []map[string]any \`json:"line_items"\`
	TaxBreakdown  map[string]any   \`json:"tax_breakdown"\`
	InternalNotes string           \`json:"internal_notes"\`
	CostMargin    int              \`json:"cost_margin"\`
	History       []map[string]any \`json:"history"\`
}

// customerViewFields is the allowlist behind the customer's copy: adding a field is deliberate.
var customerViewFields = []string{"id", "number", "status", "currency", "total", "issued_at", "line_items", "tax_breakdown", "history"}

var invoices = map[string]*Invoice{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// issuerView is the issuer's copy: the whole document, internal fields included.
func issuerView(inv *Invoice) map[string]any {
	return map[string]any{
		"id":             inv.ID,
		"number":         inv.Number,
		"status":         inv.Status,
		"currency":       inv.Currency,
		"total":          inv.Total,
		"line_items":     inv.LineItems,
		"tax_breakdown":  inv.TaxBreakdown,
		"internal_notes": inv.InternalNotes,
		"cost_margin":    inv.CostMargin,
		"history":        inv.History,
	}
}

// customerView is built from the allowlist, never by deleting fields off the issuer's copy.
func customerView(inv *Invoice) map[string]any {
	full := issuerView(inv)
	view := make(map[string]any, len(customerViewFields))
	for _, field := range customerViewFields {
		view[field] = full[field]
	}
	return view
}

func getInvoice(rw http.ResponseWriter, r *http.Request) {
	role := r.Header.Get("X-Role")
	if role != roleIssuer && role != roleCustomer {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "unknown role"})
		return
	}
	tenant := r.Header.Get("X-Tenant-Id")
	inv, ok := invoices[r.PathValue("id")]
	if !ok || inv.TenantID != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if role == roleCustomer && inv.Status != statusFinalized {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if role == roleIssuer {
		writeJSON(rw, http.StatusOK, issuerView(inv))
		return
	}
	writeJSON(rw, http.StatusOK, customerView(inv))
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/invoices/{id}", getInvoice)
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

object InvoiceApi {
  implicit val system: ActorSystem = ActorSystem("invoiced")

  val invoices = InvoiceStore.open()

  val route: Route =
    path("v1" / "invoices" / Segment) { id =>
      get {
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        parameter("role".?) { role =>
          system.log.info(s"read invoice=$id role=\${role.getOrElse("")}")
          invoices.get(id) match {
            case Some(invoice) => complete(StatusCodes.OK, invoice)
            case None => complete(StatusCodes.NotFound, """{"error":"not found"}""")
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
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

final case class Invoice(
    id: String,
    tenant_id: String,
    number: String,
    status: String,
    currency: String,
    total: BigDecimal,
    line_items: List[String],
    tax_breakdown: Map[String, BigDecimal],
    internal_notes: String,
    cost_margin: BigDecimal,
    history: List[String],
)

trait InvoiceStore {
  def get(id: String): Option[Invoice]
}

object InvoiceApi {
  implicit val system: ActorSystem = ActorSystem("invoiced")

  val Finalized = "finalized"
  val RoleIssuer = "issuer"
  val RoleCustomer = "customer"

  // The customer's copy is an allowlist: adding a field to it is a deliberate act.
  val CustomerViewFields = Seq("id", "number", "status", "currency", "total", "issued_at", "line_items", "tax_breakdown", "history")

  val invoices = InvoiceStore.open()

  // issuerView is the issuer's copy: the whole document, internal fields included.
  def issuerView(invoice: Invoice): Map[String, Any] = Map(
    "id" -> invoice.id,
    "number" -> invoice.number,
    "status" -> invoice.status,
    "currency" -> invoice.currency,
    "total" -> invoice.total,
    "line_items" -> invoice.line_items,
    "tax_breakdown" -> invoice.tax_breakdown,
    "internal_notes" -> invoice.internal_notes,
    "cost_margin" -> invoice.cost_margin,
    "history" -> invoice.history,
  )

  // customerView is built from the allowlist, never by deleting fields off the issuer's copy.
  def customerView(invoice: Invoice): Map[String, Any] =
    issuerView(invoice).filter { case (field, _) => CustomerViewFields.contains(field) }

  val route: Route =
    path("v1" / "invoices" / Segment) { id =>
      get {
        optionalHeaderValueByName("X-Role") { roleOpt =>
          optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
            val role = roleOpt.getOrElse("")
            if (role != RoleIssuer && role != RoleCustomer) {
              complete(StatusCodes.Forbidden, """{"error":"unknown role"}""")
            } else {
              invoices.get(id) match {
                case Some(invoice)
                    if invoice.tenant_id == tenantOpt.getOrElse("") &&
                      (role != RoleCustomer || invoice.status == Finalized) =>
                  complete(StatusCodes.OK, if (role == RoleIssuer) issuerView(invoice) else customerView(invoice))
                case _ =>
                  complete(StatusCodes.NotFound, """{"error":"not found"}""")
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

struct InvoiceStore {
  std::optional<json> get(const std::string& id);
};

InvoiceStore store;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/invoices/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    const auto id = req.matches[1].str();
    const auto role = req.get_param_value("role");
    const auto invoice = store.get(id);
    if (!invoice) {
      res.status = 404;
      res.set_content(R"({"error":"not found"})", "application/json");
      return;
    }
    std::cerr << "read invoice=" << id << " role=" << role << "\\n";
    res.status = 200;
    res.set_content(invoice->dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kFinalized = "finalized";
const std::string kRoleIssuer = "issuer";
const std::string kRoleCustomer = "customer";

// The customer's copy is an allowlist: adding a field to it is a deliberate act.
const std::vector<std::string> kCustomerViewFields = {"id", "number", "status", "currency", "total", "issued_at", "line_items", "tax_breakdown", "history"};

struct InvoiceStore {
  std::optional<json> get(const std::string& id);
};

InvoiceStore store;

// issuerView is the issuer's copy: the whole document, internal fields included.
json issuerView(const json& invoice) {
  return json{
      {"id", invoice["id"]},
      {"number", invoice["number"]},
      {"status", invoice["status"]},
      {"currency", invoice["currency"]},
      {"total", invoice["total"]},
      {"line_items", invoice["line_items"]},
      {"tax_breakdown", invoice["tax_breakdown"]},
      {"internal_notes", invoice["internal_notes"]},
      {"cost_margin", invoice["cost_margin"]},
      {"history", invoice["history"]},
  };
}

// customerView is built from the allowlist, never by erasing fields off the issuer's copy.
json customerView(const json& invoice) {
  const json full = issuerView(invoice);
  json view = json::object();
  for (const auto& field : kCustomerViewFields) {
    if (full.contains(field)) view[field] = full[field];
  }
  return view;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/invoices/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto role = req.get_header_value("X-Role");
    if (role != kRoleIssuer && role != kRoleCustomer) {
      res.status = 403;
      res.set_content(R"({"error":"unknown role"})", "application/json");
      return;
    }
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto id = req.matches[1].str();
    const auto invoice = store.get(id);
    if (!invoice || invoice->value("tenant_id", std::string()) != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"not found"})", "application/json");
      return;
    }
    if (role == kRoleCustomer && invoice->value("status", std::string()) != kFinalized) {
      res.status = 404;
      res.set_content(R"({"error":"not found"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(role == kRoleIssuer ? issuerView(*invoice).dump() : customerView(*invoice).dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'A customer opens an invoice link and sees a `cost_margin` column, and a support ticket shows a customer quoting a draft total that changed before it was issued.',
    '`role: str = "customer"` is a query parameter, so the caller chooses it; the handler returns `invoice` unchanged for every role and compares neither `status` nor `tenant_id` before rendering.',
    'Read `X-Role` and `X-Tenant-Id` (403 unknown role, 404 tenant mismatch); for `customer` answer 404 when `status != FINALIZED`; return `issuer_view(invoice)` or `customer_view(invoice)` built from `CUSTOMER_VIEW_FIELDS`.',
  ],
  debrief: `The read is where an invoice service either keeps a business's data separated or quietly gives it away, and the fix is three properties in order. The role comes from the gateway's session header because anything the caller can set on the request is the caller's claim, not the platform's. The draft gate and the tenant comparison both answer 404 so a draft the customer cannot see yet and another tenant's invoice are indistinguishable from a missing one. The projection discipline matters more than it looks: building the customer copy from an allowlist means the next internal field has to be added deliberately, while deleting fields from a shared payload means the next internal field leaks by default. Production services log every read with the invoice id and the requesting tenant, and serve the customer copy from a projection written at finalize time so the read never re-derives it.`,
};
