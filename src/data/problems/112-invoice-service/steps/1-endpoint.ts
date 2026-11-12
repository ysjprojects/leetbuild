import type {Step} from '@/lib/types';

export const invoiceEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/invoices: drafts are mutable, finals are not',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Starting point.** The starter serves the write side on the invoice store (\`invoice.store\`,
provided): \`POST /v1/invoices\` with \`X-Tenant-Id\` and
\`{"currency": "usd", "customer_id": "cus-1", "line_items": [{"description": "Consulting", "quantity": 2, "unit_price_cents": 25000}]}\`
creates a draft, \`PATCH /v1/invoices/{id}\` replaces its line items through \`store.replace_lines\`,
and \`POST /v1/invoices/{id}/finalize\` takes a number with \`sequence.claim_number\` (provided) and
answers \`{id, status: "finalized", number, currency, subtotal_cents}\`. It serves the demo and hides
four flaws.

**Failure mode the checks target.** A paid invoice's lines are rewritten weeks later; an invoice
with no lines is issued with a number and a total of 0; a client that retries its finalize gets a
409 instead of its number; and any currency, quantity or price lands in the store.

- A **finalized** invoice is immutable: \`PATCH\` answers **409** and changes nothing.
- Finalizing an invoice with no line items is **422**, before any number is claimed.
- A finalize carries an \`Idempotency-Key\` (**400** without one): look \`(tenant, key)\` up with
  \`store.finalize_result\` first, answer the recorded result on a replay, and record a new one with
  \`store.record_finalize\`.
- \`currency\` is one of \`CURRENCIES\` (\`usd\`, \`eur\`, \`gbp\`); at most \`MAX_LINES\` = 100 line items,
  each \`description\` 1 to 120 characters, \`quantity\` 1 to \`MAX_QUANTITY\` (1000),
  \`unit_price_cents\` 0 to \`MAX_UNIT_PRICE_CENTS\` (10 000 000). Anything else is **400**, on create
  and on \`PATCH\`.`,
  sequence: {
    participants: ['Issuer', 'Invoice Service', 'invoice store', 'Redis sequence'],
    messages: [
      {from: 'Issuer', to: 'Invoice Service', label: 'POST /v1/invoices · X-Tenant-Id', kind: 'sync'},
      {from: 'Invoice Service', to: 'Invoice Service', label: 'CURRENCIES · MAX_* limits → 400', kind: 'sync'},
      {from: 'Invoice Service', to: 'invoice store', label: 'create → draft, number null', kind: 'sync'},
      {from: 'Issuer', to: 'Invoice Service', label: 'PATCH /v1/invoices/{id} · 409 unless draft', kind: 'sync'},
      {from: 'Issuer', to: 'Invoice Service', label: 'POST /v1/invoices/{id}/finalize · Idempotency-Key', kind: 'sync'},
      {
        from: 'Invoice Service',
        to: 'invoice store',
        label: 'finalize_result(tenant, key) → recorded / none',
        kind: 'sync',
      },
      {from: 'Invoice Service', to: 'Invoice Service', label: 'no line items → 422', kind: 'sync'},
      {from: 'Invoice Service', to: 'Redis sequence', label: 'claim_number(tenant, id)', kind: 'sync'},
      {from: 'Invoice Service', to: 'invoice store', label: 'record_finalize(tenant, key, result)', kind: 'sync'},
      {from: 'Invoice Service', to: 'Issuer', label: '200 {status: "finalized", number}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'routes',
      title: 'Registers the create, edit and finalize routes',
      detail:
        'Register `POST /v1/invoices`, `PATCH /v1/invoices/{id}` and `POST /v1/invoices/{id}/finalize`, the tenant from `X-Tenant-Id`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/invoices["']/, /@app\.patch\(/, /\/finalize["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/invoices['"]/, /app\.patch\(/, /\/finalize['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/invoices"/, /"PATCH \/v1\/invoices\/\{/, /\/finalize"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"invoices"\s*\)/, /\bpatch\s*\{/, /"finalize"/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/invoices"/, /svr\.Patch\(/, /\/finalize/]},
      },
    },
    {
      id: 'immutable-final',
      title: 'An edit of a finalized invoice is 409 and changes nothing',
      detail:
        "The edit handler reads the invoice's `status` and answers **409** unless it is a draft, before `replace_lines` writes anything: the store writes whatever the status.",
      match: {
        python: {all: [/def edit_invoice\((?:(?!\n@app)[\s\S])*?\b409\b/]},
        typescript: {all: [/app\.patch\((?:(?!\napp\.)[\s\S])*?\b409\b/]},
        go: {all: [/func editInvoice\((?:(?!\n\}\n)[\s\S])*?(?:StatusConflict|\b409\b)/]},
        scala: {all: [/\bpatch\s*\{(?:(?!\bpost\s*\{)[\s\S])*?(?:Conflict|\b409\b)/]},
        cpp: {all: [/void edit_invoice\((?:(?!\n\}\n)[\s\S])*?\b409\b/]},
      },
    },
    {
      id: 'empty-final',
      title: 'An invoice with no line items cannot be finalized',
      detail:
        'A finalize of an invoice without line items answers **422** before `claim_number`/`claimNumber` runs, so no number is spent on a document that cannot be issued.',
      match: {
        python: {order: [/\b422\b/, /sequence\.claim_number\(/]},
        typescript: {order: [/\b422\b/, /claimNumber\(/]},
        go: {order: [/StatusUnprocessableEntity|\b422\b/, /sequence\.ClaimNumber\(/]},
        scala: {order: [/UnprocessableEntity|\b422\b/, /Sequence\.claimNumber\(/]},
        cpp: {order: [/\b422\b/, /sequence::claimNumber\(/]},
      },
    },
    {
      id: 'idempotent-finalize',
      title: 'Keys a finalize by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required (400 without it); the recorded result is looked up (`finalize_result`/`finalizeResult`) before the claim and answered on a replay, and a new finalize records its result.',
      match: {
        python: {
          all: [/idempotency-key/i, /store\.finalize_result\(/, /store\.record_finalize\(/, /\b400\b/],
          order: [/store\.finalize_result\(/, /sequence\.claim_number\(/],
        },
        typescript: {
          all: [/idempotency-key/i, /finalizeResult\(/, /recordFinalize\(/, /\b400\b/],
          order: [/finalizeResult\(/, /claimNumber\(/],
        },
        go: {
          all: [/Idempotency-Key/i, /store\.FinalizeResult\(/, /store\.RecordFinalize\(/, /StatusBadRequest|\b400\b/],
          order: [/store\.FinalizeResult\(/, /sequence\.ClaimNumber\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Store\.finalizeResult\(/, /Store\.recordFinalize\(/, /BadRequest|\b400\b/],
          order: [/Store\.finalizeResult\(/, /Sequence\.claimNumber\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /store::finalizeResult\(/, /store::recordFinalize\(/, /\b400\b/],
          order: [/store::finalizeResult\(/, /sequence::claimNumber\(/],
        },
      },
    },
    {
      id: 'line-items-validated',
      title: 'Validates currency and line items on create and edit',
      detail:
        'The currency is checked against `CURRENCIES` and every line against the `MAX_*` limits (description 1 to 120 characters, quantity 1 to 1000, unit price 0 to 10 000 000, at most 100 lines), on create and on edit; a violation is **400** and stores nothing.',
      match: {
        python: {all: [/CURRENCIES/, /MAX_LINES/, /MAX_QUANTITY/, /MAX_UNIT_PRICE_CENTS/, /\b400\b/]},
        typescript: {all: [/CURRENCIES/, /MAX_LINES/, /MAX_QUANTITY/, /MAX_UNIT_PRICE_CENTS/, /\b400\b/]},
        go: {all: [/currencies/, /maxLines/, /maxQuantity/, /maxUnitPriceCents/, /StatusBadRequest|\b400\b/]},
        scala: {all: [/Currencies/, /MaxLines/, /MaxQuantity/, /MaxUnitPriceCents/, /BadRequest|\b400\b/]},
        cpp: {all: [/kCurrencies/, /kMaxLines/, /kMaxQuantity/, /kMaxUnitPriceCents/, /\b400\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from invoice import sequence, store  # store.create, get, replace_lines, finalize_result, record_finalize; sequence.claim_number

app = FastAPI()


class Line(BaseModel):
    description: str
    quantity: int
    unit_price_cents: int


class InvoiceCreate(BaseModel):
    currency: str
    customer_id: str = ""
    jurisdiction: str = ""
    internal_notes: str = ""
    line_items: list[Line] = []


class InvoiceEdit(BaseModel):
    line_items: list[Line]


def tenant_of(request: Request) -> str:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    return tenant


def owned(tenant: str, invoice_id: str) -> dict:
    invoice = store.get(invoice_id)
    if invoice is None or invoice["tenant_id"] != tenant:
        raise HTTPException(status_code=404, detail="no such invoice")
    return invoice


def summary(invoice: dict) -> dict:
    return {key: invoice[key] for key in ("id", "status", "number", "currency", "subtotal_cents")}


@app.post("/v1/invoices", status_code=201)
def create_invoice(body: InvoiceCreate, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = tenant_of(request)
    lines = [line.model_dump() for line in body.line_items]
    return summary(store.create(tenant, body.currency, lines, body.customer_id, body.jurisdiction, body.internal_notes))


@app.patch("/v1/invoices/{invoice_id}")
def edit_invoice(invoice_id: str, body: InvoiceEdit, request: Request) -> dict:
    owned(tenant_of(request), invoice_id)
    return summary(store.replace_lines(invoice_id, [line.model_dump() for line in body.line_items]))


@app.post("/v1/invoices/{invoice_id}/finalize")
def finalize_invoice(invoice_id: str, request: Request) -> dict:
    tenant = tenant_of(request)
    invoice = owned(tenant, invoice_id)
    if invoice["status"] != "draft" or sequence.claim_number(tenant, invoice_id) is None:
        raise HTTPException(status_code=409, detail="the invoice is already finalized")
    return summary(store.get(invoice_id))
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from invoice import sequence, store  # store.create, get, replace_lines, finalize_result, record_finalize; sequence.claim_number

app = FastAPI()

CURRENCIES = ("usd", "eur", "gbp")
MAX_LINES = 100
MAX_DESCRIPTION = 120
MAX_QUANTITY = 1000
MAX_UNIT_PRICE_CENTS = 10_000_000


class Line(BaseModel):
    description: str
    quantity: int
    unit_price_cents: int


class InvoiceCreate(BaseModel):
    currency: str
    customer_id: str = ""
    jurisdiction: str = ""
    internal_notes: str = ""
    line_items: list[Line] = []


class InvoiceEdit(BaseModel):
    line_items: list[Line]


def tenant_of(request: Request) -> str:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    return tenant


def owned(tenant: str, invoice_id: str) -> dict:
    invoice = store.get(invoice_id)
    if invoice is None or invoice["tenant_id"] != tenant:
        raise HTTPException(status_code=404, detail="no such invoice")
    return invoice


def summary(invoice: dict) -> dict:
    return {key: invoice[key] for key in ("id", "status", "number", "currency", "subtotal_cents")}


def validated_lines(lines: list[Line]) -> list[dict]:
    """The line items as the store takes them; 400 on the first one out of range."""
    if len(lines) > MAX_LINES:
        raise HTTPException(status_code=400, detail=f"at most {MAX_LINES} line items")
    for line in lines:
        if not 1 <= len(line.description) <= MAX_DESCRIPTION:
            raise HTTPException(status_code=400, detail=f"a description is 1 to {MAX_DESCRIPTION} characters")
        if not 1 <= line.quantity <= MAX_QUANTITY:
            raise HTTPException(status_code=400, detail=f"quantity must be 1 to {MAX_QUANTITY}")
        if not 0 <= line.unit_price_cents <= MAX_UNIT_PRICE_CENTS:
            raise HTTPException(status_code=400, detail=f"unit_price_cents must be 0 to {MAX_UNIT_PRICE_CENTS}")
    return [line.model_dump() for line in lines]


@app.post("/v1/invoices", status_code=201)
def create_invoice(body: InvoiceCreate, request: Request) -> dict:
    tenant = tenant_of(request)
    if body.currency not in CURRENCIES:
        raise HTTPException(status_code=400, detail=f"currency must be one of {', '.join(CURRENCIES)}")
    lines = validated_lines(body.line_items)
    return summary(store.create(tenant, body.currency, lines, body.customer_id, body.jurisdiction, body.internal_notes))


@app.patch("/v1/invoices/{invoice_id}")
def edit_invoice(invoice_id: str, body: InvoiceEdit, request: Request) -> dict:
    invoice = owned(tenant_of(request), invoice_id)
    lines = validated_lines(body.line_items)
    # The store writes whatever the status: an issued document is refused here.
    if invoice["status"] != "draft":
        raise HTTPException(status_code=409, detail="a finalized invoice cannot be edited")
    return summary(store.replace_lines(invoice_id, lines))


@app.post("/v1/invoices/{invoice_id}/finalize")
def finalize_invoice(invoice_id: str, request: Request) -> dict:
    tenant = tenant_of(request)
    key = request.headers.get("idempotency-key", "")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    recorded = store.finalize_result(tenant, key)
    if recorded is not None:
        return recorded  # a replay answers what the first attempt answered
    invoice = owned(tenant, invoice_id)
    if invoice["status"] != "draft":
        raise HTTPException(status_code=409, detail="the invoice is already finalized")
    if not invoice["line_items"]:
        raise HTTPException(status_code=422, detail="an invoice with no line items cannot be finalized")
    if sequence.claim_number(tenant, invoice_id) is None:
        raise HTTPException(status_code=409, detail="the invoice is already finalized")
    result = summary(store.get(invoice_id))
    store.record_finalize(tenant, key, result)
    return result
`,
    },
    typescript: {
      starter: `import Fastify, {type FastifyRequest} from 'fastify';

import {claimNumber} from 'invoice/sequence';
import {type Invoice, type Line, create, finalizeResult, get, recordFinalize, replaceLines} from 'invoice/store';

export const app = Fastify();

interface InvoiceBody {
  currency: string;
  customer_id?: string;
  jurisdiction?: string;
  internal_notes?: string;
  line_items?: Line[];
}

function tenantOf(request: FastifyRequest): string | null {
  const tenant = request.headers['x-tenant-id'];
  return typeof tenant === 'string' && tenant !== '' ? tenant : null;
}

function summary(invoice: Invoice) {
  const {id, status, number, currency, subtotal_cents} = invoice;
  return {id, status, number, currency, subtotal_cents};
}

app.post('/v1/invoices', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = tenantOf(request);
  if (tenant === null) return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = request.body as InvoiceBody;
  const invoice = await create(tenant, body.currency, body.line_items ?? [], body.customer_id ?? '', body.jurisdiction ?? '', body.internal_notes ?? '');
  return reply.code(201).send(summary(invoice));
});

app.patch('/v1/invoices/:invoiceId', async (request, reply) => {
  const tenant = tenantOf(request);
  if (tenant === null) return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {invoiceId} = request.params as {invoiceId: string};
  const invoice = await get(invoiceId);
  if (invoice === null || invoice.tenant_id !== tenant) return reply.code(404).send({error: 'no such invoice'});
  return summary(await replaceLines(invoiceId, (request.body as InvoiceBody).line_items ?? []));
});

app.post('/v1/invoices/:invoiceId/finalize', async (request, reply) => {
  const tenant = tenantOf(request);
  if (tenant === null) return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {invoiceId} = request.params as {invoiceId: string};
  const invoice = await get(invoiceId);
  if (invoice === null || invoice.tenant_id !== tenant) return reply.code(404).send({error: 'no such invoice'});
  if (invoice.status !== 'draft' || (await claimNumber(tenant, invoiceId)) === null) {
    return reply.code(409).send({error: 'the invoice is already finalized'});
  }
  return summary((await get(invoiceId)) as Invoice);
});
`,
      solution: `import Fastify, {type FastifyRequest} from 'fastify';

import {claimNumber} from 'invoice/sequence';
import {type Invoice, type Line, create, finalizeResult, get, recordFinalize, replaceLines} from 'invoice/store';

export const app = Fastify();

export const CURRENCIES = ['usd', 'eur', 'gbp'];
export const MAX_LINES = 100;
export const MAX_DESCRIPTION = 120;
export const MAX_QUANTITY = 1000;
export const MAX_UNIT_PRICE_CENTS = 10_000_000;

interface InvoiceBody {
  currency: string;
  customer_id?: string;
  jurisdiction?: string;
  internal_notes?: string;
  line_items?: Line[];
}

function tenantOf(request: FastifyRequest): string | null {
  const tenant = request.headers['x-tenant-id'];
  return typeof tenant === 'string' && tenant !== '' ? tenant : null;
}

function summary(invoice: Invoice) {
  const {id, status, number, currency, subtotal_cents} = invoice;
  return {id, status, number, currency, subtotal_cents};
}

/** Why the line items are refused, or null. */
function invalidLines(lines: Line[]): string | null {
  if (lines.length > MAX_LINES) return \`at most \${MAX_LINES} line items\`;
  for (const line of lines) {
    const {description, quantity, unit_price_cents: price} = line;
    if (typeof description !== 'string' || description.length < 1 || description.length > MAX_DESCRIPTION) {
      return \`a description is 1 to \${MAX_DESCRIPTION} characters\`;
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) return \`quantity must be 1 to \${MAX_QUANTITY}\`;
    if (!Number.isInteger(price) || price < 0 || price > MAX_UNIT_PRICE_CENTS) return \`unit_price_cents must be 0 to \${MAX_UNIT_PRICE_CENTS}\`;
  }
  return null;
}

app.post('/v1/invoices', async (request, reply) => {
  const tenant = tenantOf(request);
  if (tenant === null) return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = request.body as InvoiceBody;
  const lines = body.line_items ?? [];
  if (!CURRENCIES.includes(body.currency)) return reply.code(400).send({error: \`currency must be one of \${CURRENCIES.join(', ')}\`});
  const invalid = invalidLines(lines);
  if (invalid !== null) return reply.code(400).send({error: invalid});
  const invoice = await create(tenant, body.currency, lines, body.customer_id ?? '', body.jurisdiction ?? '', body.internal_notes ?? '');
  return reply.code(201).send(summary(invoice));
});

app.patch('/v1/invoices/:invoiceId', async (request, reply) => {
  const tenant = tenantOf(request);
  if (tenant === null) return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {invoiceId} = request.params as {invoiceId: string};
  const invoice = await get(invoiceId);
  if (invoice === null || invoice.tenant_id !== tenant) return reply.code(404).send({error: 'no such invoice'});
  const lines = (request.body as InvoiceBody).line_items ?? [];
  const invalid = invalidLines(lines);
  if (invalid !== null) return reply.code(400).send({error: invalid});
  // The store writes whatever the status: an issued document is refused here.
  if (invoice.status !== 'draft') return reply.code(409).send({error: 'a finalized invoice cannot be edited'});
  return summary(await replaceLines(invoiceId, lines));
});

app.post('/v1/invoices/:invoiceId/finalize', async (request, reply) => {
  const tenant = tenantOf(request);
  if (tenant === null) return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const recorded = await finalizeResult(tenant, key);
  if (recorded !== null) return recorded; // a replay answers what the first attempt answered
  const {invoiceId} = request.params as {invoiceId: string};
  const invoice = await get(invoiceId);
  if (invoice === null || invoice.tenant_id !== tenant) return reply.code(404).send({error: 'no such invoice'});
  if (invoice.status !== 'draft') return reply.code(409).send({error: 'the invoice is already finalized'});
  if (invoice.line_items.length === 0) return reply.code(422).send({error: 'an invoice with no line items cannot be finalized'});
  if ((await claimNumber(tenant, invoiceId)) === null) return reply.code(409).send({error: 'the invoice is already finalized'});
  const result = summary((await get(invoiceId)) as Invoice);
  await recordFinalize(tenant, key, result);
  return result;
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"invoice/sequence" // sequence.ClaimNumber
	"invoice/store"    // store.Create, Get, ReplaceLines, FinalizeResult, RecordFinalize
)

type invoiceBody struct {
	Currency      string       \`json:"currency"\`
	CustomerID    string       \`json:"customer_id"\`
	Jurisdiction  string       \`json:"jurisdiction"\`
	InternalNotes string       \`json:"internal_notes"\`
	LineItems     []store.Line \`json:"line_items"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func summary(invoice *store.Invoice) map[string]any {
	var number any
	if invoice.Number > 0 {
		number = invoice.Number
	}
	return map[string]any{"id": invoice.ID, "status": invoice.Status, "number": number, "currency": invoice.Currency, "subtotal_cents": invoice.SubtotalCents}
}

// owned is the tenant's invoice, or nil after answering 401 or 404.
func owned(rw http.ResponseWriter, r *http.Request) (string, *store.Invoice) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return "", nil
	}
	invoice := store.Get(r.Context(), r.PathValue("id"))
	if invoice == nil || invoice.TenantID != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such invoice"})
		return "", nil
	}
	return tenant, invoice
}

func createInvoice(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	var body invoiceBody
	json.NewDecoder(r.Body).Decode(&body)
	invoice := store.Create(r.Context(), tenant, body.Currency, body.LineItems, body.CustomerID, body.Jurisdiction, body.InternalNotes)
	writeJSON(rw, http.StatusCreated, summary(invoice))
}

func editInvoice(rw http.ResponseWriter, r *http.Request) {
	_, invoice := owned(rw, r)
	if invoice == nil {
		return
	}
	var body invoiceBody
	json.NewDecoder(r.Body).Decode(&body)
	writeJSON(rw, http.StatusOK, summary(store.ReplaceLines(r.Context(), invoice.ID, body.LineItems)))
}

func finalizeInvoice(rw http.ResponseWriter, r *http.Request) {
	tenant, invoice := owned(rw, r)
	if invoice == nil {
		return
	}
	if invoice.Status != "draft" {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "the invoice is already finalized"})
		return
	}
	if n, err := sequence.ClaimNumber(r.Context(), tenant, invoice.ID); err != nil || n == 0 {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "the invoice is already finalized"})
		return
	}
	writeJSON(rw, http.StatusOK, summary(store.Get(r.Context(), invoice.ID)))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/invoices", createInvoice)
	mux.HandleFunc("PATCH /v1/invoices/{id}", editInvoice)
	mux.HandleFunc("POST /v1/invoices/{id}/finalize", finalizeInvoice)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"unicode/utf8"

	"invoice/sequence" // sequence.ClaimNumber
	"invoice/store"    // store.Create, Get, ReplaceLines, FinalizeResult, RecordFinalize
)

var currencies = []string{"usd", "eur", "gbp"}

const (
	maxLines          = 100
	maxDescription    = 120
	maxQuantity       = 1000
	maxUnitPriceCents = 10_000_000
)

type invoiceBody struct {
	Currency      string       \`json:"currency"\`
	CustomerID    string       \`json:"customer_id"\`
	Jurisdiction  string       \`json:"jurisdiction"\`
	InternalNotes string       \`json:"internal_notes"\`
	LineItems     []store.Line \`json:"line_items"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func summary(invoice *store.Invoice) map[string]any {
	var number any
	if invoice.Number > 0 {
		number = invoice.Number
	}
	return map[string]any{"id": invoice.ID, "status": invoice.Status, "number": number, "currency": invoice.Currency, "subtotal_cents": invoice.SubtotalCents}
}

// owned is the tenant's invoice, or nil after answering 401 or 404.
func owned(rw http.ResponseWriter, r *http.Request) (string, *store.Invoice) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return "", nil
	}
	invoice := store.Get(r.Context(), r.PathValue("id"))
	if invoice == nil || invoice.TenantID != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such invoice"})
		return "", nil
	}
	return tenant, invoice
}

// invalidLines is why the line items are refused, or "".
func invalidLines(lines []store.Line) string {
	if len(lines) > maxLines {
		return fmt.Sprintf("at most %d line items", maxLines)
	}
	for _, line := range lines {
		if n := utf8.RuneCountInString(line.Description); n < 1 || n > maxDescription {
			return fmt.Sprintf("a description is 1 to %d characters", maxDescription)
		}
		if line.Quantity < 1 || line.Quantity > maxQuantity {
			return fmt.Sprintf("quantity must be 1 to %d", maxQuantity)
		}
		if line.UnitPriceCents < 0 || line.UnitPriceCents > maxUnitPriceCents {
			return fmt.Sprintf("unit_price_cents must be 0 to %d", maxUnitPriceCents)
		}
	}
	return ""
}

func createInvoice(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	var body invoiceBody
	json.NewDecoder(r.Body).Decode(&body)
	if !slices.Contains(currencies, body.Currency) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "currency must be one of usd, eur, gbp"})
		return
	}
	if invalid := invalidLines(body.LineItems); invalid != "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": invalid})
		return
	}
	invoice := store.Create(r.Context(), tenant, body.Currency, body.LineItems, body.CustomerID, body.Jurisdiction, body.InternalNotes)
	writeJSON(rw, http.StatusCreated, summary(invoice))
}

func editInvoice(rw http.ResponseWriter, r *http.Request) {
	_, invoice := owned(rw, r)
	if invoice == nil {
		return
	}
	var body invoiceBody
	json.NewDecoder(r.Body).Decode(&body)
	if invalid := invalidLines(body.LineItems); invalid != "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": invalid})
		return
	}
	// The store writes whatever the status: an issued document is refused here.
	if invoice.Status != "draft" {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "a finalized invoice cannot be edited"})
		return
	}
	writeJSON(rw, http.StatusOK, summary(store.ReplaceLines(r.Context(), invoice.ID, body.LineItems)))
}

func finalizeInvoice(rw http.ResponseWriter, r *http.Request) {
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	if tenant := r.Header.Get("X-Tenant-Id"); tenant != "" {
		if recorded := store.FinalizeResult(r.Context(), tenant, key); recorded != nil {
			writeJSON(rw, http.StatusOK, recorded) // a replay answers what the first attempt answered
			return
		}
	}
	tenant, invoice := owned(rw, r)
	if invoice == nil {
		return
	}
	if invoice.Status != "draft" {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "the invoice is already finalized"})
		return
	}
	if len(invoice.LineItems) == 0 {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "an invoice with no line items cannot be finalized"})
		return
	}
	if n, err := sequence.ClaimNumber(r.Context(), tenant, invoice.ID); err != nil || n == 0 {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "the invoice is already finalized"})
		return
	}
	result := summary(store.Get(r.Context(), invoice.ID))
	store.RecordFinalize(r.Context(), tenant, key, result)
	writeJSON(rw, http.StatusOK, result)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/invoices", createInvoice)
	mux.HandleFunc("PATCH /v1/invoices/{id}", editInvoice)
	mux.HandleFunc("POST /v1/invoices/{id}/finalize", finalizeInvoice)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import invoice.{Sequence, Store} // Store.create, get, replaceLines, finalizeResult, recordFinalize; Sequence.claimNumber

object Api {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def summary(invoice: Store.Invoice): JsObject = JsObject(
    "id" -> JsString(invoice.id),
    "status" -> JsString(invoice.status),
    "number" -> invoice.number.map(JsNumber(_)).getOrElse(JsNull),
    "currency" -> JsString(invoice.currency),
    "subtotal_cents" -> JsNumber(invoice.subtotalCents))

  private def text(body: JsObject, name: String): String = body.fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  private def lines(body: JsObject): Seq[Store.Line] =
    body.fields.get("line_items").collect { case JsArray(items) => items.map(Store.lineOf) }.getOrElse(Seq.empty)

  val route: Route = optionalHeaderValueByName("X-Tenant-Id") {
    case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
    case Some(tenant) =>
      concat(
        path("v1" / "invoices") {
          post {
            entity(as[String]) { raw =>
              // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
              val body = raw.parseJson.asJsObject
              val created = Store.create(tenant, text(body, "currency"), lines(body), text(body, "customer_id"), text(body, "jurisdiction"), text(body, "internal_notes"))
              complete(json(StatusCodes.Created, summary(created)))
            }
          }
        },
        path("v1" / "invoices" / Segment) { invoiceId =>
          patch {
            entity(as[String]) { raw =>
              Store.get(invoiceId).filter(_.tenantId == tenant) match {
                case None => complete(error(StatusCodes.NotFound, "no such invoice"))
                case Some(_) => complete(json(StatusCodes.OK, summary(Store.replaceLines(invoiceId, lines(raw.parseJson.asJsObject)))))
              }
            }
          }
        },
        path("v1" / "invoices" / Segment / "finalize") { invoiceId =>
          post {
            Store.get(invoiceId).filter(_.tenantId == tenant) match {
              case None => complete(error(StatusCodes.NotFound, "no such invoice"))
              case Some(found) if found.status != "draft" || Sequence.claimNumber(tenant, invoiceId).isEmpty =>
                complete(error(StatusCodes.Conflict, "the invoice is already finalized"))
              case Some(_) => complete(json(StatusCodes.OK, summary(Store.get(invoiceId).get)))
            }
          }
        },
      )
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import invoice.{Sequence, Store} // Store.create, get, replaceLines, finalizeResult, recordFinalize; Sequence.claimNumber

object Api {
  val Currencies: Set[String] = Set("usd", "eur", "gbp")
  val MaxLines = 100
  val MaxDescription = 120
  val MaxQuantity = 1000L
  val MaxUnitPriceCents = 10000000L

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def summary(invoice: Store.Invoice): JsObject = JsObject(
    "id" -> JsString(invoice.id),
    "status" -> JsString(invoice.status),
    "number" -> invoice.number.map(JsNumber(_)).getOrElse(JsNull),
    "currency" -> JsString(invoice.currency),
    "subtotal_cents" -> JsNumber(invoice.subtotalCents))

  private def text(body: JsObject, name: String): String = body.fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  private def lines(body: JsObject): Seq[Store.Line] =
    body.fields.get("line_items").collect { case JsArray(items) => items.map(Store.lineOf) }.getOrElse(Seq.empty)

  /** Why the line items are refused, if they are. */
  private def invalidLines(lines: Seq[Store.Line]): Option[String] =
    if (lines.size > MaxLines) Some(s"at most $MaxLines line items")
    else
      lines.collectFirst {
        case line if line.description.isEmpty || line.description.codePointCount(0, line.description.length) > MaxDescription =>
          s"a description is 1 to $MaxDescription characters"
        case line if line.quantity < 1 || line.quantity > MaxQuantity => s"quantity must be 1 to $MaxQuantity"
        case line if line.unitPriceCents < 0 || line.unitPriceCents > MaxUnitPriceCents => s"unit_price_cents must be 0 to $MaxUnitPriceCents"
      }

  private def finalize(tenant: String, invoiceId: String, key: String): HttpResponse =
    Store.finalizeResult(tenant, key) match {
      case Some(recorded) => json(StatusCodes.OK, recorded) // a replay answers what the first attempt answered
      case None =>
        Store.get(invoiceId).filter(_.tenantId == tenant) match {
          case None => error(StatusCodes.NotFound, "no such invoice")
          case Some(found) if found.status != "draft" => error(StatusCodes.Conflict, "the invoice is already finalized")
          case Some(found) if found.lineItems.isEmpty => error(StatusCodes.UnprocessableEntity, "an invoice with no line items cannot be finalized")
          case Some(_) =>
            Sequence.claimNumber(tenant, invoiceId) match {
              case None => error(StatusCodes.Conflict, "the invoice is already finalized")
              case Some(_) =>
                val result = summary(Store.get(invoiceId).get)
                Store.recordFinalize(tenant, key, result)
                json(StatusCodes.OK, result)
            }
        }
    }

  val route: Route = optionalHeaderValueByName("X-Tenant-Id") {
    case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
    case Some(tenant) =>
      concat(
        path("v1" / "invoices") {
          post {
            entity(as[String]) { raw =>
              val body = raw.parseJson.asJsObject
              val items = lines(body)
              if (!Currencies.contains(text(body, "currency"))) complete(error(StatusCodes.BadRequest, "currency must be one of usd, eur, gbp"))
              else
                invalidLines(items) match {
                  case Some(invalid) => complete(error(StatusCodes.BadRequest, invalid))
                  case None =>
                    val created = Store.create(tenant, text(body, "currency"), items, text(body, "customer_id"), text(body, "jurisdiction"), text(body, "internal_notes"))
                    complete(json(StatusCodes.Created, summary(created)))
                }
            }
          }
        },
        path("v1" / "invoices" / Segment) { invoiceId =>
          patch {
            entity(as[String]) { raw =>
              val items = lines(raw.parseJson.asJsObject)
              Store.get(invoiceId).filter(_.tenantId == tenant) match {
                case None => complete(error(StatusCodes.NotFound, "no such invoice"))
                case Some(_) if invalidLines(items).isDefined => complete(error(StatusCodes.BadRequest, invalidLines(items).get))
                // The store writes whatever the status: an issued document is refused here.
                case Some(found) if found.status != "draft" => complete(error(StatusCodes.Conflict, "a finalized invoice cannot be edited"))
                case Some(_) => complete(json(StatusCodes.OK, summary(Store.replaceLines(invoiceId, items))))
              }
            }
          }
        },
        path("v1" / "invoices" / Segment / "finalize") { invoiceId =>
          post {
            optionalHeaderValueByName("Idempotency-Key") {
              case None | Some("") => complete(error(StatusCodes.BadRequest, "Idempotency-Key is required"))
              case Some(key) => complete(finalize(tenant, invoiceId, key))
            }
          }
        },
      )
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "invoice/sequence.h"  // sequence::claimNumber
#include "invoice/store.h"     // store::create, get, replaceLines, finalizeResult, recordFinalize

using json = nlohmann::json;

void send(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

json summary(const store::Invoice& invoice) {
  return json{{"id", invoice.id}, {"status", invoice.status}, {"number", invoice.number > 0 ? json(invoice.number) : json(nullptr)},
              {"currency", invoice.currency}, {"subtotal_cents", invoice.subtotal_cents}};
}

std::vector<store::Line> linesOf(const json& body) {
  std::vector<store::Line> lines;
  for (const auto& item : body.value("line_items", json::array())) lines.push_back(store::lineOf(item));
  return lines;
}

// The tenant's invoice, or none after answering 401 or 404.
std::optional<store::Invoice> owned(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    send(res, 401, json{{"error", "X-Tenant-Id is required"}});
    return std::nullopt;
  }
  const auto invoice = store::get(req.matches[1]);
  if (!invoice || invoice->tenant_id != tenant) {
    send(res, 404, json{{"error", "no such invoice"}});
    return std::nullopt;
  }
  return invoice;
}

void create_invoice(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return send(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body);
  const store::Invoice invoice = store::create(tenant, body.value("currency", ""), linesOf(body), body.value("customer_id", ""),
                                               body.value("jurisdiction", ""), body.value("internal_notes", ""));
  send(res, 201, summary(invoice));
}

void edit_invoice(const httplib::Request& req, httplib::Response& res) {
  const auto invoice = owned(req, res);
  if (!invoice) return;
  send(res, 200, summary(store::replaceLines(invoice->id, linesOf(json::parse(req.body)))));
}

void finalize_invoice(const httplib::Request& req, httplib::Response& res) {
  const auto invoice = owned(req, res);
  if (!invoice) return;
  if (invoice->status != "draft" || sequence::claimNumber(invoice->tenant_id, invoice->id) == 0) {
    return send(res, 409, json{{"error", "the invoice is already finalized"}});
  }
  send(res, 200, summary(*store::get(invoice->id)));
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/invoices", create_invoice);
  svr.Patch(R"(/v1/invoices/([\\w-]+))", edit_invoice);
  svr.Post(R"(/v1/invoices/([\\w-]+)/finalize)", finalize_invoice);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "invoice/sequence.h"  // sequence::claimNumber
#include "invoice/store.h"     // store::create, get, replaceLines, finalizeResult, recordFinalize

using json = nlohmann::json;

const std::vector<std::string> kCurrencies = {"usd", "eur", "gbp"};
constexpr size_t kMaxLines = 100;
constexpr long kMaxDescription = 120;
constexpr long kMaxQuantity = 1000;
constexpr long kMaxUnitPriceCents = 10'000'000;

void send(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

json summary(const store::Invoice& invoice) {
  return json{{"id", invoice.id}, {"status", invoice.status}, {"number", invoice.number > 0 ? json(invoice.number) : json(nullptr)},
              {"currency", invoice.currency}, {"subtotal_cents", invoice.subtotal_cents}};
}

std::vector<store::Line> linesOf(const json& body) {
  std::vector<store::Line> lines;
  for (const auto& item : body.value("line_items", json::array())) lines.push_back(store::lineOf(item));
  return lines;
}

// The tenant's invoice, or none after answering 401 or 404.
std::optional<store::Invoice> owned(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    send(res, 401, json{{"error", "X-Tenant-Id is required"}});
    return std::nullopt;
  }
  const auto invoice = store::get(req.matches[1]);
  if (!invoice || invoice->tenant_id != tenant) {
    send(res, 404, json{{"error", "no such invoice"}});
    return std::nullopt;
  }
  return invoice;
}

// Why the line items are refused, or "".
std::string invalid_lines(const std::vector<store::Line>& lines) {
  if (lines.size() > kMaxLines) return "at most 100 line items";
  for (const store::Line& line : lines) {
    // Characters, not bytes: a UTF-8 continuation byte does not start one.
    const long chars = std::count_if(line.description.begin(), line.description.end(), [](char c) { return (c & 0xC0) != 0x80; });
    if (chars < 1 || chars > kMaxDescription) return "a description is 1 to 120 characters";
    if (line.quantity < 1 || line.quantity > kMaxQuantity) return "quantity must be 1 to 1000";
    if (line.unit_price_cents < 0 || line.unit_price_cents > kMaxUnitPriceCents) return "unit_price_cents must be 0 to 10000000";
  }
  return "";
}

void create_invoice(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return send(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body);
  const std::string currency = body.value("currency", "");
  if (std::find(kCurrencies.begin(), kCurrencies.end(), currency) == kCurrencies.end()) {
    return send(res, 400, json{{"error", "currency must be one of usd, eur, gbp"}});
  }
  const std::vector<store::Line> lines = linesOf(body);
  const std::string invalid = invalid_lines(lines);
  if (!invalid.empty()) return send(res, 400, json{{"error", invalid}});
  const store::Invoice invoice = store::create(tenant, currency, lines, body.value("customer_id", ""), body.value("jurisdiction", ""),
                                               body.value("internal_notes", ""));
  send(res, 201, summary(invoice));
}

void edit_invoice(const httplib::Request& req, httplib::Response& res) {
  const auto invoice = owned(req, res);
  if (!invoice) return;
  const std::vector<store::Line> lines = linesOf(json::parse(req.body));
  const std::string invalid = invalid_lines(lines);
  if (!invalid.empty()) return send(res, 400, json{{"error", invalid}});
  // The store writes whatever the status: an issued document is refused here.
  if (invoice->status != "draft") return send(res, 409, json{{"error", "a finalized invoice cannot be edited"}});
  send(res, 200, summary(store::replaceLines(invoice->id, lines)));
}

void finalize_invoice(const httplib::Request& req, httplib::Response& res) {
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return send(res, 400, json{{"error", "Idempotency-Key is required"}});
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (const auto recorded = store::finalizeResult(tenant, key); recorded && !tenant.empty()) {
    return send(res, 200, *recorded);  // a replay answers what the first attempt answered
  }
  const auto invoice = owned(req, res);
  if (!invoice) return;
  if (invoice->status != "draft") return send(res, 409, json{{"error", "the invoice is already finalized"}});
  if (invoice->line_items.empty()) return send(res, 422, json{{"error", "an invoice with no line items cannot be finalized"}});
  if (sequence::claimNumber(tenant, invoice->id) == 0) return send(res, 409, json{{"error", "the invoice is already finalized"}});
  const json result = summary(*store::get(invoice->id));
  store::recordFinalize(tenant, key, result);
  send(res, 200, result);
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/invoices", create_invoice);
  svr.Patch(R"(/v1/invoices/([\\w-]+))", edit_invoice);
  svr.Post(R"(/v1/invoices/([\\w-]+)/finalize)", finalize_invoice);
}
`,
    },
  },
  harness: {
    python: `from invoice import store

T1 = {"X-Tenant-Id": "t-1"}
LINES = [
    {"description": "Consulting", "quantity": 2, "unit_price_cents": 25000},
    {"description": "Travel", "quantity": 1, "unit_price_cents": 12000},
]


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _create(c, lines=LINES):
    r = await c.post("/v1/invoices", headers=T1, json={"currency": "usd", "customer_id": "cus-1", "line_items": lines})
    assert r.status_code in (200, 201), f"POST /v1/invoices answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("status") == "draft" and body.get("number") is None, f"a new invoice must be a draft without a number, got {body}"
    return body["id"]


async def _finalize(c, invoice_id, key="k-1"):
    return await c.post(f"/v1/invoices/{invoice_id}/finalize", headers={**T1, "Idempotency-Key": key})


async def check_routes(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/invoices", json={"currency": "usd", "line_items": LINES})
        assert r.status_code == 401, f"POST /v1/invoices without X-Tenant-Id answered {r.status_code}, expected 401"
        invoice_id = await _create(c, LINES[:1])
        r = await c.patch(f"/v1/invoices/{invoice_id}", headers=T1, json={"line_items": LINES})
        assert r.status_code == 200, f"PATCH /v1/invoices/{invoice_id} answered {r.status_code}: {r.text}"
        assert r.json().get("subtotal_cents") == 62000, f"after replacing the lines the subtotal must be 62000, got {r.json()}"
        r = await _finalize(c, invoice_id)
    assert r.status_code == 200, f"POST /v1/invoices/{invoice_id}/finalize answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("status") == "finalized" and body.get("number") == 1 and body.get("subtotal_cents") == 62000, f"the finalize must answer number 1, finalized, subtotal 62000, got {body}"
    stored = store.get(invoice_id)
    assert stored["status"] == "finalized" and stored["number"] == 1, f"after the finalize the store holds {stored}"


async def check_immutable_final(ctx):
    async with _api(ctx) as c:
        invoice_id = await _create(c)
        r = await _finalize(c, invoice_id)
        assert r.status_code == 200, f"the finalize answered {r.status_code}: {r.text}"
        r = await c.patch(f"/v1/invoices/{invoice_id}", headers=T1, json={"line_items": [{"description": "Consulting", "quantity": 20, "unit_price_cents": 25000}]})
        assert r.status_code == 409, f"an edit of a finalized invoice answered {r.status_code}, expected 409"
        stored = store.get(invoice_id)
        assert stored["line_items"] == LINES and stored["subtotal_cents"] == 62000, f"the issued invoice changed under its customer: the store now holds {stored['line_items']} ({stored['subtotal_cents']}). Refuse the edit before writing"
        draft_id = await _create(c)
        r = await c.patch(f"/v1/invoices/{draft_id}", headers=T1, json={"line_items": LINES[:1]})
    assert r.status_code == 200, f"an edit of a draft answered {r.status_code}: drafts stay editable"


async def check_empty_final(ctx):
    async with _api(ctx) as c:
        invoice_id = await _create(c, [])
        r = await _finalize(c, invoice_id)
        assert r.status_code == 422, f"finalizing an invoice with no line items answered {r.status_code}, expected 422"
        stored = store.get(invoice_id)
        assert stored["status"] == "draft" and stored["number"] is None, f"an empty invoice must stay a draft without a number, the store holds {stored['status']} number {stored['number']}"
        assert ctx.redis.get("invoice:seq:t-1") is None, f"the rejected finalize claimed number {ctx.redis.get('invoice:seq:t-1')}: refuse it before claim_number"
        await c.patch(f"/v1/invoices/{invoice_id}", headers=T1, json={"line_items": LINES})
        r = await _finalize(c, invoice_id, "k-2")
    assert r.status_code == 200 and r.json().get("number") == 1, f"once it has lines the invoice must finalize as number 1, got {r.status_code} {r.text}"


async def check_idempotent_finalize(ctx):
    async with _api(ctx) as c:
        invoice_id = await _create(c)
        first = await _finalize(c, invoice_id, "k-1")
        assert first.status_code == 200, f"the first finalize answered {first.status_code}: {first.text}"
        replay = await _finalize(c, invoice_id, "k-1")
        assert replay.status_code == 200 and replay.json() == first.json(), f"a retry with the same Idempotency-Key must answer the first result {first.json()}, got {replay.status_code} {replay.text}"
        assert ctx.redis.get("invoice:seq:t-1") == "1", f"the tenant's sequence is at {ctx.redis.get('invoice:seq:t-1')} after one finalize and its retry, expected 1"
        other = await _create(c)
        none = await c.post(f"/v1/invoices/{other}/finalize", headers=T1)
        assert none.status_code == 400, f"a finalize without Idempotency-Key answered {none.status_code}, expected 400"
    assert store.get(other)["status"] == "draft", "a finalize refused for its missing key must not finalize the invoice"


async def check_line_items_validated(ctx):
    ok = {"description": "Consulting", "quantity": 1, "unit_price_cents": 100}
    bad = [
        ("currency xyz", {"currency": "xyz", "line_items": [ok]}),
        ("quantity 0", {"currency": "usd", "line_items": [{**ok, "quantity": 0}]}),
        ("quantity 1001", {"currency": "usd", "line_items": [{**ok, "quantity": 1001}]}),
        ("unit_price_cents -1", {"currency": "usd", "line_items": [{**ok, "unit_price_cents": -1}]}),
        ("unit_price_cents 10000001", {"currency": "usd", "line_items": [{**ok, "unit_price_cents": 10_000_001}]}),
        ("an empty description", {"currency": "usd", "line_items": [{**ok, "description": ""}]}),
        ("a 121-character description", {"currency": "usd", "line_items": [{**ok, "description": "x" * 121}]}),
        ("101 line items", {"currency": "usd", "line_items": [ok] * 101}),
    ]
    async with _api(ctx) as c:
        for what, body in bad:
            r = await c.post("/v1/invoices", headers=T1, json=body)
            assert r.status_code == 400, f"an invoice with {what} answered {r.status_code}, expected 400"
        assert ctx.redis.keys("invoice:inv-*") == [], f"rejected invoices were stored: {sorted(ctx.redis.keys('invoice:inv-*'))}"
        edge = [{"description": "x" * 120, "quantity": 1000, "unit_price_cents": 10_000_000}] + [ok] * 99
        r = await c.post("/v1/invoices", headers=T1, json={"currency": "eur", "line_items": edge})
        assert r.status_code == 201, f"an invoice at every limit (100 lines, quantity 1000, price 10000000, 120 characters) answered {r.status_code}: {r.text}"
        invoice_id = await _create(c)
        r = await c.patch(f"/v1/invoices/{invoice_id}", headers=T1, json={"line_items": [{**ok, "quantity": 0}]})
        assert r.status_code == 400, f"an edit with quantity 0 answered {r.status_code}, expected 400"
    assert store.get(invoice_id)["line_items"] == LINES, f"a rejected edit changed the lines to {store.get(invoice_id)['line_items']}"
`,
    typescript: `const T1 = {'X-Tenant-Id': 't-1'};
const LINES = [
  {description: 'Consulting', quantity: 2, unit_price_cents: 25000},
  {description: 'Travel', quantity: 1, unit_price_cents: 12000},
];

function api(ctx) {
  const m = ctx.load('api');
  return {c: ctx.client(m.app), store: ctx.load('/support/invoice/store.ts')};
}

async function create(c, lines = LINES): Promise<string> {
  const r = await c.post('/v1/invoices', {headers: T1, json: {currency: 'usd', customer_id: 'cus-1', line_items: lines}});
  assert(r.status === 200 || r.status === 201, \`POST /v1/invoices answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.status === 'draft' && body.number === null, \`a new invoice must be a draft without a number, got \${r.text}\`);
  return body.id;
}

const finalize = (c, invoiceId: string, key = 'k-1') => c.post(\`/v1/invoices/\${invoiceId}/finalize\`, {headers: {...T1, 'Idempotency-Key': key}});

export async function check_routes(ctx) {
  const {c, store} = api(ctx);
  let r = await c.post('/v1/invoices', {json: {currency: 'usd', line_items: LINES}});
  assert.equal(r.status, 401, \`POST /v1/invoices without X-Tenant-Id answered \${r.status}, expected 401\`);
  const invoiceId = await create(c, LINES.slice(0, 1));
  r = await c.patch(\`/v1/invoices/\${invoiceId}\`, {headers: T1, json: {line_items: LINES}});
  assert.equal(r.status, 200, \`PATCH /v1/invoices/\${invoiceId} answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().subtotal_cents, 62000, \`after replacing the lines the subtotal must be 62000, got \${r.text}\`);
  r = await finalize(c, invoiceId);
  assert.equal(r.status, 200, \`POST /v1/invoices/\${invoiceId}/finalize answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.status === 'finalized' && body.number === 1 && body.subtotal_cents === 62000, \`the finalize must answer number 1, finalized, subtotal 62000, got \${r.text}\`);
  const stored = await store.get(invoiceId);
  assert(stored.status === 'finalized' && stored.number === 1, \`after the finalize the store holds \${JSON.stringify(stored)}\`);
}

export async function check_immutable_final(ctx) {
  const {c, store} = api(ctx);
  const invoiceId = await create(c);
  let r = await finalize(c, invoiceId);
  assert.equal(r.status, 200, \`the finalize answered \${r.status}: \${r.text}\`);
  r = await c.patch(\`/v1/invoices/\${invoiceId}\`, {headers: T1, json: {line_items: [{description: 'Consulting', quantity: 20, unit_price_cents: 25000}]}});
  assert.equal(r.status, 409, \`an edit of a finalized invoice answered \${r.status}, expected 409\`);
  const stored = await store.get(invoiceId);
  assert(JSON.stringify(stored.line_items) === JSON.stringify(LINES) && stored.subtotal_cents === 62000, \`the issued invoice changed under its customer: the store now holds \${JSON.stringify(stored.line_items)} (\${stored.subtotal_cents}). Refuse the edit before writing\`);
  const draftId = await create(c);
  r = await c.patch(\`/v1/invoices/\${draftId}\`, {headers: T1, json: {line_items: LINES.slice(0, 1)}});
  assert.equal(r.status, 200, \`an edit of a draft answered \${r.status}: drafts stay editable\`);
}

export async function check_empty_final(ctx) {
  const {c, store} = api(ctx);
  const invoiceId = await create(c, []);
  let r = await finalize(c, invoiceId);
  assert.equal(r.status, 422, \`finalizing an invoice with no line items answered \${r.status}, expected 422\`);
  const stored = await store.get(invoiceId);
  assert(stored.status === 'draft' && stored.number === null, \`an empty invoice must stay a draft without a number, the store holds \${stored.status} number \${stored.number}\`);
  assert.equal(ctx.redis.get('invoice:seq:t-1'), null, \`the rejected finalize claimed number \${ctx.redis.get('invoice:seq:t-1')}: refuse it before claimNumber\`);
  await c.patch(\`/v1/invoices/\${invoiceId}\`, {headers: T1, json: {line_items: LINES}});
  r = await finalize(c, invoiceId, 'k-2');
  assert(r.status === 200 && r.json().number === 1, \`once it has lines the invoice must finalize as number 1, got \${r.status} \${r.text}\`);
}

export async function check_idempotent_finalize(ctx) {
  const {c, store} = api(ctx);
  const invoiceId = await create(c);
  const first = await finalize(c, invoiceId, 'k-1');
  assert.equal(first.status, 200, \`the first finalize answered \${first.status}: \${first.text}\`);
  const replay = await finalize(c, invoiceId, 'k-1');
  assert(replay.status === 200 && JSON.stringify(replay.json()) === JSON.stringify(first.json()), \`a retry with the same Idempotency-Key must answer the first result \${first.text}, got \${replay.status} \${replay.text}\`);
  assert.equal(ctx.redis.get('invoice:seq:t-1'), '1', \`the tenant's sequence is at \${ctx.redis.get('invoice:seq:t-1')} after one finalize and its retry, expected 1\`);
  const other = await create(c);
  const none = await c.post(\`/v1/invoices/\${other}/finalize\`, {headers: T1});
  assert.equal(none.status, 400, \`a finalize without Idempotency-Key answered \${none.status}, expected 400\`);
  assert.equal((await store.get(other)).status, 'draft', 'a finalize refused for its missing key must not finalize the invoice');
}

export async function check_line_items_validated(ctx) {
  const {c, store} = api(ctx);
  const ok = {description: 'Consulting', quantity: 1, unit_price_cents: 100};
  const bad: [string, object][] = [
    ['currency xyz', {currency: 'xyz', line_items: [ok]}],
    ['quantity 0', {currency: 'usd', line_items: [{...ok, quantity: 0}]}],
    ['quantity 1001', {currency: 'usd', line_items: [{...ok, quantity: 1001}]}],
    ['unit_price_cents -1', {currency: 'usd', line_items: [{...ok, unit_price_cents: -1}]}],
    ['unit_price_cents 10000001', {currency: 'usd', line_items: [{...ok, unit_price_cents: 10_000_001}]}],
    ['an empty description', {currency: 'usd', line_items: [{...ok, description: ''}]}],
    ['a 121-character description', {currency: 'usd', line_items: [{...ok, description: 'x'.repeat(121)}]}],
    ['101 line items', {currency: 'usd', line_items: Array(101).fill(ok)}],
  ];
  for (const [what, body] of bad) {
    const r = await c.post('/v1/invoices', {headers: T1, json: body});
    assert.equal(r.status, 400, \`an invoice with \${what} answered \${r.status}, expected 400\`);
  }
  assert.deepStrictEqual(ctx.redis.keys('invoice:inv-*'), [], \`rejected invoices were stored: \${JSON.stringify(ctx.redis.keys('invoice:inv-*'))}\`);
  const edge = [{description: 'x'.repeat(120), quantity: 1000, unit_price_cents: 10_000_000}, ...Array(99).fill(ok)];
  let r = await c.post('/v1/invoices', {headers: T1, json: {currency: 'eur', line_items: edge}});
  assert.equal(r.status, 201, \`an invoice at every limit (100 lines, quantity 1000, price 10000000, 120 characters) answered \${r.status}: \${r.text}\`);
  const invoiceId = await create(c);
  r = await c.patch(\`/v1/invoices/\${invoiceId}\`, {headers: T1, json: {line_items: [{...ok, quantity: 0}]}});
  assert.equal(r.status, 400, \`an edit with quantity 0 answered \${r.status}, expected 400\`);
  const stored = await store.get(invoiceId);
  assert.equal(JSON.stringify(stored.line_items), JSON.stringify(LINES), \`a rejected edit changed the lines to \${JSON.stringify(stored.line_items)}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"invoice/store"

	"leetbuild/harness"
)

var (
	apiBg = context.Background()
	lines = []map[string]any{
		{"description": "Consulting", "quantity": 2, "unit_price_cents": 25000},
		{"description": "Travel", "quantity": 1, "unit_price_cents": 12000},
	}
	wantLines = []store.Line{{Description: "Consulting", Quantity: 2, UnitPriceCents: 25000}, {Description: "Travel", Quantity: 1, UnitPriceCents: 12000}}
)

type summaryBody struct {
	ID            string \`json:"id"\`
	Status        string \`json:"status"\`
	Number        *int64 \`json:"number"\`
	SubtotalCents int64  \`json:"subtotal_cents"\`
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func decode(r *harness.Response) summaryBody {
	var body summaryBody
	r.Decode(&body)
	return body
}

func create(ctx *harness.Ctx, c *harness.HTTP, items []map[string]any) string {
	r := c.Post("/v1/invoices", map[string]any{"currency": "usd", "customer_id": "cus-1", "line_items": items}, "X-Tenant-Id", "t-1")
	ctx.Assert(r.Status == 200 || r.Status == 201, "POST /v1/invoices answered %d: %s", r.Status, r.Text())
	body := decode(r)
	ctx.Assert(body.Status == "draft" && body.Number == nil, "a new invoice must be a draft without a number, got %s", r.Text())
	return body.ID
}

func finalize(c *harness.HTTP, invoiceID, key string) *harness.Response {
	return c.Post("/v1/invoices/"+invoiceID+"/finalize", nil, "X-Tenant-Id", "t-1", "Idempotency-Key", key)
}

func numberOf(body summaryBody) int64 {
	if body.Number == nil {
		return 0
	}
	return *body.Number
}

func CheckRoutes(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/invoices", map[string]any{"currency": "usd", "line_items": lines})
	ctx.Equal(r.Status, 401, "POST /v1/invoices without X-Tenant-Id")
	invoiceID := create(ctx, c, lines[:1])
	r = c.Patch("/v1/invoices/"+invoiceID, map[string]any{"line_items": lines}, "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 200, "PATCH /v1/invoices/%s (%s)", invoiceID, r.Text())
	ctx.Equal(decode(r).SubtotalCents, 62000, "after replacing the lines, the subtotal")
	r = finalize(c, invoiceID, "k-1")
	ctx.Equal(r.Status, 200, "POST /v1/invoices/%s/finalize (%s)", invoiceID, r.Text())
	body := decode(r)
	ctx.Assert(body.Status == "finalized" && numberOf(body) == 1 && body.SubtotalCents == 62000, "the finalize must answer number 1, finalized, subtotal 62000, got %s", r.Text())
	stored := store.Get(apiBg, invoiceID)
	ctx.Assert(stored.Status == "finalized" && stored.Number == 1, "after the finalize the store holds %s number %d", stored.Status, stored.Number)
}

func CheckImmutableFinal(ctx *harness.Ctx) {
	c := api(ctx)
	invoiceID := create(ctx, c, lines)
	r := finalize(c, invoiceID, "k-1")
	ctx.Equal(r.Status, 200, "the finalize (%s)", r.Text())
	r = c.Patch("/v1/invoices/"+invoiceID, map[string]any{"line_items": []map[string]any{{"description": "Consulting", "quantity": 20, "unit_price_cents": 25000}}}, "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 409, "an edit of a finalized invoice")
	stored := store.Get(apiBg, invoiceID)
	ctx.Assert(stored.SubtotalCents == 62000 && len(stored.LineItems) == 2, "the issued invoice changed under its customer: the store now holds %v (%d). Refuse the edit before writing", stored.LineItems, stored.SubtotalCents)
	ctx.Equal(stored.LineItems, wantLines, "the issued invoice's lines")
	draftID := create(ctx, c, lines)
	r = c.Patch("/v1/invoices/"+draftID, map[string]any{"line_items": lines[:1]}, "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 200, "an edit of a draft (drafts stay editable)")
}

func CheckEmptyFinal(ctx *harness.Ctx) {
	c := api(ctx)
	invoiceID := create(ctx, c, []map[string]any{})
	r := finalize(c, invoiceID, "k-1")
	ctx.Equal(r.Status, 422, "finalizing an invoice with no line items")
	stored := store.Get(apiBg, invoiceID)
	ctx.Assert(stored.Status == "draft" && stored.Number == 0, "an empty invoice must stay a draft without a number, the store holds %s number %d", stored.Status, stored.Number)
	seq, claimed := ctx.Redis.Get("invoice:seq:t-1")
	ctx.Assert(!claimed, "the rejected finalize claimed number %s: refuse it before sequence.ClaimNumber", seq)
	c.Patch("/v1/invoices/"+invoiceID, map[string]any{"line_items": lines}, "X-Tenant-Id", "t-1")
	r = finalize(c, invoiceID, "k-2")
	ctx.Assert(r.Status == 200 && numberOf(decode(r)) == 1, "once it has lines the invoice must finalize as number 1, got %d %s", r.Status, r.Text())
}

func CheckIdempotentFinalize(ctx *harness.Ctx) {
	c := api(ctx)
	invoiceID := create(ctx, c, lines)
	first := finalize(c, invoiceID, "k-1")
	ctx.Equal(first.Status, 200, "the first finalize (%s)", first.Text())
	replay := finalize(c, invoiceID, "k-1")
	ctx.Assert(replay.Status == 200 && numberOf(decode(replay)) == numberOf(decode(first)) && decode(replay).Status == "finalized", "a retry with the same Idempotency-Key must answer the first result %s, got %d %s", first.Text(), replay.Status, replay.Text())
	seq, _ := ctx.Redis.Get("invoice:seq:t-1")
	ctx.Equal(seq, "1", "the tenant's sequence after one finalize and its retry")
	other := create(ctx, c, lines)
	none := c.Post("/v1/invoices/"+other+"/finalize", nil, "X-Tenant-Id", "t-1")
	ctx.Equal(none.Status, 400, "a finalize without Idempotency-Key")
	ctx.Equal(store.Get(apiBg, other).Status, "draft", "a finalize refused for its missing key must not finalize the invoice; its status")
}

func CheckLineItemsValidated(ctx *harness.Ctx) {
	c := api(ctx)
	ok := map[string]any{"description": "Consulting", "quantity": 1, "unit_price_cents": 100}
	with := func(key string, value any) []map[string]any {
		line := map[string]any{}
		for k, v := range ok {
			line[k] = v
		}
		line[key] = value
		return []map[string]any{line}
	}
	many := []map[string]any{}
	for i := 0; i < 101; i++ {
		many = append(many, ok)
	}
	bad := []struct {
		what string
		body map[string]any
	}{
		{"currency xyz", map[string]any{"currency": "xyz", "line_items": []map[string]any{ok}}},
		{"quantity 0", map[string]any{"currency": "usd", "line_items": with("quantity", 0)}},
		{"quantity 1001", map[string]any{"currency": "usd", "line_items": with("quantity", 1001)}},
		{"unit_price_cents -1", map[string]any{"currency": "usd", "line_items": with("unit_price_cents", -1)}},
		{"unit_price_cents 10000001", map[string]any{"currency": "usd", "line_items": with("unit_price_cents", 10_000_001)}},
		{"an empty description", map[string]any{"currency": "usd", "line_items": with("description", "")}},
		{"a 121-character description", map[string]any{"currency": "usd", "line_items": with("description", strings.Repeat("x", 121))}},
		{"101 line items", map[string]any{"currency": "usd", "line_items": many}},
	}
	for _, b := range bad {
		r := c.Post("/v1/invoices", b.body, "X-Tenant-Id", "t-1")
		ctx.Equal(r.Status, 400, "an invoice with %s", b.what)
	}
	ctx.Equal(len(ctx.Redis.Keys("invoice:inv-*")), 0, "rejected invoices were stored (%q); the invoices", ctx.Redis.Keys("invoice:inv-*"))
	edge := append([]map[string]any{{"description": strings.Repeat("x", 120), "quantity": 1000, "unit_price_cents": 10_000_000}}, many[:99]...)
	r := c.Post("/v1/invoices", map[string]any{"currency": "eur", "line_items": edge}, "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 201, "an invoice at every limit (100 lines, quantity 1000, price 10000000, 120 characters) (%s)", r.Text())
	invoiceID := create(ctx, c, lines)
	r = c.Patch("/v1/invoices/"+invoiceID, map[string]any{"line_items": with("quantity", 0)}, "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 400, "an edit with quantity 0")
	ctx.Equal(store.Get(apiBg, invoiceID).LineItems, wantLines, "a rejected edit must leave the lines; the lines")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <utility>
#include <vector>

#include "invoice/store.h"

namespace {

using json = nlohmann::json;

const json kLines = json::array({{{"description", "Consulting"}, {"quantity", 2}, {"unit_price_cents", 25000}},
                                 {{"description", "Travel"}, {"quantity", 1}, {"unit_price_cents", 12000}}});

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

json bodyOf(const harness::Response& r) {
  try {
    return json::parse(r.Text());
  } catch (const std::exception&) {
    return json::object();
  }
}

long numberOf(const harness::Response& r) {
  const json body = bodyOf(r);
  return body.contains("number") && body["number"].is_number() ? body["number"].get<long>() : 0L;
}

std::string create(harness::Ctx& ctx, harness::HTTP& c, const json& lines) {
  const auto r = c.Post("/v1/invoices", json{{"currency", "usd"}, {"customer_id", "cus-1"}, {"line_items", lines}}.dump(), "Content-Type",
                        "application/json", "X-Tenant-Id", "t-1");
  ctx.Assert(r.Status == 200 || r.Status == 201, "POST /v1/invoices answered %d: %s", r.Status, r.Text());
  const json body = bodyOf(r);
  ctx.Assert(body.value("status", "") == "draft" && body.contains("number") && body["number"].is_null(),
             "a new invoice must be a draft without a number, got %s", r.Text());
  return body.value("id", "");
}

harness::Response patch(harness::HTTP& c, const std::string& invoice_id, const json& lines) {
  return c.Patch("/v1/invoices/" + invoice_id, json{{"line_items", lines}}.dump(), "Content-Type", "application/json", "X-Tenant-Id", "t-1");
}

harness::Response finalize(harness::HTTP& c, const std::string& invoice_id, const std::string& key) {
  return c.Post("/v1/invoices/" + invoice_id + "/finalize", "", "X-Tenant-Id", "t-1", "Idempotency-Key", key);
}

}  // namespace

void CheckRoutes(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = c.Post("/v1/invoices", json{{"currency", "usd"}, {"line_items", kLines}}.dump(), "Content-Type", "application/json");
  ctx.Equal(r.Status, 401, "POST /v1/invoices without X-Tenant-Id");
  const std::string invoice_id = create(ctx, c, json::array({kLines[0]}));
  r = patch(c, invoice_id, kLines);
  ctx.Equal(r.Status, 200, "PATCH /v1/invoices/%s (%s)", invoice_id, r.Text());
  ctx.Equal(bodyOf(r).value("subtotal_cents", 0L), 62000, "after replacing the lines, the subtotal");
  r = finalize(c, invoice_id, "k-1");
  ctx.Equal(r.Status, 200, "POST /v1/invoices/%s/finalize (%s)", invoice_id, r.Text());
  const json body = bodyOf(r);
  ctx.Assert(body.value("status", "") == "finalized" && numberOf(r) == 1 && body.value("subtotal_cents", 0L) == 62000,
             "the finalize must answer number 1, finalized, subtotal 62000, got %s", r.Text());
  const auto stored = store::get(invoice_id);
  ctx.Assert(stored && stored->status == "finalized" && stored->number == 1, "after the finalize the store holds %s number %d",
             stored ? stored->status : "nothing", stored ? stored->number : 0L);
}

void CheckImmutableFinal(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string invoice_id = create(ctx, c, kLines);
  auto r = finalize(c, invoice_id, "k-1");
  ctx.Equal(r.Status, 200, "the finalize (%s)", r.Text());
  r = patch(c, invoice_id, json::array({{{"description", "Consulting"}, {"quantity", 20}, {"unit_price_cents", 25000}}}));
  ctx.Equal(r.Status, 409, "an edit of a finalized invoice");
  const auto stored = store::get(invoice_id);
  ctx.Assert(stored->subtotal_cents == 62000 && store::linesJson(stored->line_items) == kLines,
             "the issued invoice changed under its customer: the store now holds %s (%d). Refuse the edit before writing",
             store::linesJson(stored->line_items).dump(), stored->subtotal_cents);
  const std::string draft_id = create(ctx, c, kLines);
  r = patch(c, draft_id, json::array({kLines[0]}));
  ctx.Equal(r.Status, 200, "an edit of a draft (drafts stay editable)");
}

void CheckEmptyFinal(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string invoice_id = create(ctx, c, json::array());
  auto r = finalize(c, invoice_id, "k-1");
  ctx.Equal(r.Status, 422, "finalizing an invoice with no line items");
  const auto stored = store::get(invoice_id);
  ctx.Assert(stored->status == "draft" && stored->number == 0, "an empty invoice must stay a draft without a number, the store holds %s number %d",
             stored->status, stored->number);
  const auto seq = ctx.Redis.Get("invoice:seq:t-1");
  ctx.Assert(!seq, "the rejected finalize claimed number %s: refuse it before sequence::claimNumber", seq.value_or(""));
  patch(c, invoice_id, kLines);
  r = finalize(c, invoice_id, "k-2");
  ctx.Assert(r.Status == 200 && numberOf(r) == 1, "once it has lines the invoice must finalize as number 1, got %d %s", r.Status, r.Text());
}

void CheckIdempotentFinalize(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string invoice_id = create(ctx, c, kLines);
  const auto first = finalize(c, invoice_id, "k-1");
  ctx.Equal(first.Status, 200, "the first finalize (%s)", first.Text());
  const auto replay = finalize(c, invoice_id, "k-1");
  ctx.Assert(replay.Status == 200 && bodyOf(replay) == bodyOf(first), "a retry with the same Idempotency-Key must answer the first result %s, got %d %s",
             first.Text(), replay.Status, replay.Text());
  ctx.Equal(ctx.Redis.Get("invoice:seq:t-1"), std::optional<std::string>("1"), "the tenant's sequence after one finalize and its retry");
  const std::string other = create(ctx, c, kLines);
  const auto none = c.Post("/v1/invoices/" + other + "/finalize", "", "X-Tenant-Id", "t-1");
  ctx.Equal(none.Status, 400, "a finalize without Idempotency-Key");
  ctx.Equal(store::get(other)->status, "draft", "a finalize refused for its missing key must not finalize the invoice; its status");
}

void CheckLineItemsValidated(harness::Ctx& ctx) {
  auto c = api(ctx);
  const json ok = {{"description", "Consulting"}, {"quantity", 1}, {"unit_price_cents", 100}};
  const auto with = [&ok](const std::string& key, const json& value) {
    json line = ok;
    line[key] = value;
    return json::array({line});
  };
  json many = json::array();
  for (int i = 0; i < 101; i++) many.push_back(ok);
  const std::vector<std::pair<std::string, json>> bad = {
      {"currency xyz", {{"currency", "xyz"}, {"line_items", json::array({ok})}}},
      {"quantity 0", {{"currency", "usd"}, {"line_items", with("quantity", 0)}}},
      {"quantity 1001", {{"currency", "usd"}, {"line_items", with("quantity", 1001)}}},
      {"unit_price_cents -1", {{"currency", "usd"}, {"line_items", with("unit_price_cents", -1)}}},
      {"unit_price_cents 10000001", {{"currency", "usd"}, {"line_items", with("unit_price_cents", 10000001)}}},
      {"an empty description", {{"currency", "usd"}, {"line_items", with("description", "")}}},
      {"a 121-character description", {{"currency", "usd"}, {"line_items", with("description", std::string(121, 'x'))}}},
      {"101 line items", {{"currency", "usd"}, {"line_items", many}}},
  };
  for (const auto& [what, body] : bad) {
    const auto r = c.Post("/v1/invoices", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", "t-1");
    ctx.Equal(r.Status, 400, "an invoice with %s", what);
  }
  ctx.Equal(ctx.Redis.Keys("invoice:inv-*").size(), 0, "rejected invoices were stored; the invoices");
  json edge = json::array({{{"description", std::string(120, 'x')}, {"quantity", 1000}, {"unit_price_cents", 10000000}}});
  for (int i = 0; i < 99; i++) edge.push_back(ok);
  auto r = c.Post("/v1/invoices", json{{"currency", "eur"}, {"line_items", edge}}.dump(), "Content-Type", "application/json", "X-Tenant-Id", "t-1");
  ctx.Equal(r.Status, 201, "an invoice at every limit (100 lines, quantity 1000, price 10000000, 120 characters) (%s)", r.Text());
  const std::string invoice_id = create(ctx, c, kLines);
  r = patch(c, invoice_id, with("quantity", 0));
  ctx.Equal(r.Status, 400, "an edit with quantity 0");
  ctx.Assert(store::linesJson(store::get(invoice_id)->line_items) == kLines, "a rejected edit changed the lines to %s",
             store::linesJson(store::get(invoice_id)->line_items).dump());
}
`,
  },
  hints: [
    'Finalize an invoice and PATCH its lines: the issued document changes. Finalize one with no lines: it gets number 1 and a total of 0. Retry a finalize: the client gets 409 instead of its number.',
    'The edit handler never reads `status`, and `replace_lines` writes whatever the status is. The finalize handler checks only the status, so any draft gets a number, and it keeps no record of what it answered. No handler checks a range.',
    'In `PATCH`, answer 409 unless the invoice is a draft. In finalize: 400 without `Idempotency-Key`, `finalize_result` first, 422 on empty `line_items` before `claim_number`, `record_finalize` after. Check `CURRENCIES` and the `MAX_*` limits, 400.',
  ],
  debrief: `The store does not care about status, so the edit route does: the guard runs before \`replace_lines\` because nothing downstream re-reads an issued document. The empty-invoice rule runs before \`claim_number\` because a number is a legal identifier that cannot be taken back. The idempotency record is keyed by tenant and client key and holds the response, so a retry after a timeout reads the number the first attempt issued. Validation at the edge keeps every later step on integer minor units within known ranges. Stripe, for one, expires idempotency keys after 24 hours and rejects a replay whose parameters differ from the first request; billing systems also correct an issued invoice with a credit note rather than an edit.`,
};
