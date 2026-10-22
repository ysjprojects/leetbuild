import type {Step} from '@/lib/types';

export const invoiceEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/invoices: drafts are mutable, finals are not',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers all three invoice
routes and serves the happy path, and it hides three production flaws. Review it like the service
owner, fix it, and prove the fix with the checks below.

Implement the draft/final lifecycle of an invoice:

- \`POST /v1/invoices\` — the tenant comes from the authenticated \`X-Tenant-Id\` header (**401** when
  missing) and the body is
  \`{"currency": "usd", "line_items": [{"description": "Consulting", "quantity": 2, "unit_price_cents": 25000}]}\`.
  It creates a **draft**: \`id\` server-side, \`status\` \`draft\`, \`number\` \`null\`. \`currency\` is
  one of \`usd\`, \`eur\`, \`gbp\` (**400** otherwise). At most **100** line items, each \`description\`
  **1..120** characters, \`quantity\` an integer in **1..1000** and \`unit_price_cents\` an integer in
  **0..10 000 000** (**400** otherwise). A draft may be created with no line items at all — that is
  exactly the state the finalize guard has to refuse.
- \`PATCH /v1/invoices/{id}\` replaces the line items of a **draft** and returns it. On a **finalized**
  invoice it answers **409** and changes nothing.
- \`POST /v1/invoices/{id}/finalize\` with an \`Idempotency-Key\` header (**400** when missing):
  validates the totals, locks the invoice, and returns it. An invoice with **no line items cannot
  finalize** (**422**). A replay of the same \`(tenant, Idempotency-Key)\` returns the ORIGINAL
  finalized invoice: one invoice, one number, never a second document.
- The number is not yours to compute here — the state step claims it atomically. Call the claim after
  validation has passed, and store the finalized document under the idempotency key.
- Money is integer minor units end to end: \`subtotal_cents = Σ quantity × unit_price_cents\`.

**Failure mode the checks target.** The draft treats \`finalize\` as a label instead of a lock. The
update handler never looks at \`status\`, so line items of an issued — even paid — invoice can be
re-written weeks later and every downstream reconciliation built on that document silently becomes
wrong. The finalize handler never looks at the line items, so an empty invoice is issued as a zero
total. And it always writes a fresh document, so a client retry after a timeout mints a duplicate
invoice with a second number. None of the three throws; all three corrupt the books.`,
  sequence: {
    participants: ['Issuer', 'Invoice Service', 'invoice store'],
    messages: [
      {from: 'Issuer', to: 'Invoice Service', label: 'POST /v1/invoices · X-Tenant-Id', kind: 'sync'},
      {
        from: 'Invoice Service',
        to: 'Invoice Service',
        label: 'validate currency · ≤100 lines · integer minor units',
        kind: 'sync',
      },
      {from: 'Invoice Service', to: 'invoice store', label: 'insert draft (status=draft, number=null)', kind: 'sync'},
      {from: 'invoice store', to: 'Invoice Service', label: 'draft {id}', kind: 'reply'},
      {from: 'Issuer', to: 'Invoice Service', label: 'PATCH /v1/invoices/{id}', kind: 'sync'},
      {from: 'Invoice Service', to: 'invoice store', label: 'load · require_draft → 409 when finalized', kind: 'sync'},
      {from: 'invoice store', to: 'Invoice Service', label: 'draft / 409', kind: 'reply'},
      {from: 'Issuer', to: 'Invoice Service', label: 'POST /v1/invoices/{id}/finalize · Idempotency-Key', kind: 'sync'},
      {
        from: 'Invoice Service',
        to: 'Invoice Service',
        label: 'replay? · no lines → 422 · subtotal_cents',
        kind: 'sync',
      },
      {
        from: 'Invoice Service',
        to: 'invoice store',
        label: 'claim number · put finalized under (tenant, key)',
        kind: 'async',
      },
      {from: 'Invoice Service', to: 'Issuer', label: '201 draft · 200 finalized · 409 · 422', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'routes',
      title: 'Registers create, draft update and finalize',
      detail:
        '`POST /v1/invoices`, `PATCH /v1/invoices/{id}` and `POST /v1/invoices/{id}/finalize` are all registered — the lifecycle has a create, a mutation that only drafts may pass and a finalize that locks the invoice.',
      match: {
        python: {
          all: [
            /@app\.post\(\s*["']\/v1\/invoices["']/,
            /@app\.patch\(\s*["']\/v1\/invoices\/\{invoice_id\}["']/,
            /@app\.post\(\s*["']\/v1\/invoices\/\{invoice_id\}\/finalize["']/,
          ],
        },
        typescript: {
          all: [
            /app\.post\(\s*'\/v1\/invoices'/,
            /app\.patch\(\s*'\/v1\/invoices\/:id'/,
            /app\.post\(\s*'\/v1\/invoices\/:id\/finalize'/,
          ],
        },
        go: {
          all: [
            /HandleFunc\(\s*"POST \/v1\/invoices"/,
            /HandleFunc\(\s*"PATCH \/v1\/invoices\/\{id\}"/,
            /HandleFunc\(\s*"POST \/v1\/invoices\/\{id\}\/finalize"/,
          ],
        },
        scala: {
          all: [/path\(\s*"v1"\s*\/\s*"invoices"\s*\)/, /\bpost\s*\{/, /\bpatch\s*\{/, /Segment\s*\/\s*"finalize"/],
        },
        cpp: {all: [/svr\.Post\(\s*"\/v1\/invoices"/, /svr\.Patch\(/, /\/finalize/]},
      },
    },
    {
      id: 'immutable-final',
      title: 'A finalized invoice rejects every field update with 409',
      detail:
        'The update path loads the invoice, refuses to touch it once its status is `finalized` and answers **409** — the lock, not the label. The draft has no such guard: it re-writes `line_items` of an issued invoice and returns 200, which is the incident the whole step exists for.',
      match: {
        python: {all: [/\bFINALIZED\s*=/, /def\s+require_draft\(/, /status_code\s*=\s*409/]},
        typescript: {all: [/const FINALIZED\s*=/, /function requireDraft\(/, /HttpError\(\s*409\b/]},
        go: {all: [/finalized\s*=\s*"finalized"/, /func requireDraft\(/, /StatusConflict/]},
        scala: {all: [/val Finalized\s*=/, /def requireDraft\(/, /StatusCodes\.Conflict/]},
        cpp: {all: [/kFinalized\s*=/, /requireDraft\(/, /\b409\b/]},
      },
    },
    {
      id: 'empty-final',
      title: 'An empty invoice cannot finalize',
      detail:
        'Finalization looks at the line items before it locks anything: an invoice with none is **422** `invoice has no line items`, so a zero-total document is never issued. The draft finalizes it happily, which is how a “valid” invoice with a total of 0 reaches the ledger.',
      match: {
        python: {
          all: [/len\(invoice\["line_items"\]\)\s*==\s*0/, /status_code\s*=\s*422/, /invoice has no line items/],
        },
        typescript: {all: [/line_items\.length\s*===\s*0/, /HttpError\(\s*422\b/, /invoice has no line items/]},
        go: {all: [/len\(invoice\.LineItems\)\s*==\s*0/, /StatusUnprocessableEntity/, /invoice has no line items/]},
        scala: {
          all: [/lineItems\.isEmpty/, /StatusCodes\.UnprocessableEntity/, /invoice has no line items/],
        },
        cpp: {all: [/line_items\.empty\(\)/, /\b422\b/, /invoice has no line items/]},
      },
    },
    {
      id: 'idempotent-finalize',
      title: 'A replayed finalize returns the original invoice',
      detail:
        '`Idempotency-Key` is required and the finalized document is looked up under `(tenant, key)` before anything else, then recorded under that key. A retry returns the stored invoice with the number it already has; the draft ignores the header and mints a second invoice on every replay.',
      match: {
        python: {all: [/Idempotency-Key/, /finalize_store\.get\(/, /finalize_store\.put\(/]},
        typescript: {all: [/idempotency-key/i, /finalizeStore\.get\(/, /finalizeStore\.put\(/]},
        go: {all: [/Idempotency-Key/, /finalizeStore\.Get\(/, /finalizeStore\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /finalizeStore\.get\(/, /finalizeStore\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /finalizeStore\.get\(/, /finalizeStore\.put\(/]},
      },
    },
    {
      id: 'line-items-validated',
      title: 'Line items and money are validated in integer minor units',
      detail:
        'Every line item is checked against the caps — at most 100 lines, `quantity` 1..1000, `unit_price_cents` 0..10 000 000 — and the total is summed as integer minor units and stored as `subtotal_cents`. No float ever touches money: a `0.1 + 0.2` total is a receivable that never balances.',
      match: {
        python: {
          all: [/MAX_LINE_ITEMS/, /MAX_QUANTITY/, /MAX_UNIT_PRICE_CENTS/, /ALLOWED_CURRENCIES/, /subtotal_cents/],
          none: [/float\(/],
        },
        typescript: {
          all: [/MAX_LINE_ITEMS/, /MAX_QUANTITY/, /MAX_UNIT_PRICE_CENTS/, /ALLOWED_CURRENCIES/, /subtotalCents/],
          none: [/parseFloat|Math\.round/],
        },
        go: {
          all: [/maxLineItems/, /maxQuantity/, /maxUnitPriceCents/, /allowedCurrencies/, /SubtotalCents/],
          none: [/ParseFloat/],
        },
        scala: {
          all: [/MaxLineItems/, /MaxQuantity/, /MaxUnitPriceCents/, /AllowedCurrencies/, /subtotalCents/],
          none: [/toDouble/],
        },
        cpp: {
          all: [/kMaxLineItems/, /kMaxQuantity/, /kMaxUnitPriceCents/, /kAllowedCurrencies/, /subtotal_cents/],
          none: [/\bdouble\b/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""api.py — a model-generated first draft of the invoice lifecycle."""
import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

app = FastAPI()

DRAFTS: dict[str, dict] = {}


class LineItem(BaseModel):
    description: str
    quantity: int
    unit_price_cents: int


class InvoiceDraft(BaseModel):
    currency: str = "usd"
    line_items: list[LineItem] = Field(default_factory=list)


# TODO: this draft treats finalize as a label instead of a lock — an update still lands on a
# finalized invoice, an invoice with no line items finalizes with a zero total, and every retry
# mints another invoice because Idempotency-Key is ignored. Review all three.


@app.post("/v1/invoices")
def create_invoice(body: InvoiceDraft, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    invoice = {
        "id": str(uuid.uuid4()),
        "tenant_id": tenant,
        "currency": body.currency,
        "status": "draft",
        "number": None,
        "line_items": [line.model_dump() for line in body.line_items],
    }
    DRAFTS[invoice["id"]] = invoice
    return JSONResponse(invoice, status_code=201)


@app.patch("/v1/invoices/{invoice_id}")
def update_invoice(
    invoice_id: str, body: InvoiceDraft, tenant: str = Header(alias="X-Tenant-Id")
) -> JSONResponse:
    invoice = DRAFTS.get(invoice_id, {})
    invoice["currency"] = body.currency
    invoice["line_items"] = [line.model_dump() for line in body.line_items]
    return JSONResponse(invoice, status_code=200)


@app.post("/v1/invoices/{invoice_id}/finalize")
def finalize_invoice(invoice_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    invoice = DRAFTS.get(invoice_id, {})
    invoice["status"] = "finalized"
    invoice["subtotal_cents"] = sum(
        line["quantity"] * line["unit_price_cents"] for line in invoice["line_items"]
    )
    return JSONResponse(invoice, status_code=200)
`,
      solution: `"""POST /v1/invoices · PATCH /v1/invoices/{id} · POST /v1/invoices/{id}/finalize.

Drafts are mutable containers; finalization validates the totals, locks the invoice and replays a
retry instead of creating a second document.
"""

import uuid
from datetime import datetime, timezone

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

app = FastAPI()

DRAFT = "draft"
FINALIZED = "finalized"
MAX_LINE_ITEMS = 100
MIN_QUANTITY = 1
MAX_QUANTITY = 1000
MAX_UNIT_PRICE_CENTS = 10_000_000
MAX_DESCRIPTION_CHARS = 120
ALLOWED_CURRENCIES = {"usd", "eur", "gbp"}


class LineItem(BaseModel):
    description: str
    quantity: int
    unit_price_cents: int


class InvoiceDraft(BaseModel):
    currency: str = "usd"
    line_items: list[LineItem] = Field(default_factory=list)


class InvoiceStore:
    """Persistence seams. The state step implements the atomic claim behind claim_next_number."""

    def create(self, tenant: str, invoice: dict) -> dict:
        """Persist a new draft and return it with its id."""
        raise NotImplementedError

    def get(self, tenant: str, invoice_id: str) -> dict | None:
        """The invoice with this id when it belongs to this tenant."""
        raise NotImplementedError

    def save(self, invoice: dict) -> None:
        """Persist an updated invoice."""
        raise NotImplementedError

    def claim_next_number(self, tenant: str, invoice_id: str) -> int:
        """Atomically move the draft to finalized and return its per-tenant number."""
        raise NotImplementedError


class FinalizeStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The finalized invoice already recorded for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, invoice: dict) -> None:
        """Record the finalized invoice under (tenant, idem_key)."""
        raise NotImplementedError


store = InvoiceStore()
finalize_store = FinalizeStore()


def require_tenant(tenant: str | None) -> str:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    return tenant


def validate_lines(lines: list[dict]) -> None:
    if len(lines) > MAX_LINE_ITEMS:
        raise HTTPException(status_code=400, detail="too many line items")
    for line in lines:
        if not 1 <= len(line["description"]) <= MAX_DESCRIPTION_CHARS:
            raise HTTPException(status_code=400, detail="description must be 1..120 characters")
        if not MIN_QUANTITY <= line["quantity"] <= MAX_QUANTITY:
            raise HTTPException(status_code=400, detail="quantity must be 1..1000")
        if not 0 <= line["unit_price_cents"] <= MAX_UNIT_PRICE_CENTS:
            raise HTTPException(status_code=400, detail="unit_price_cents is out of range")


def subtotal_cents(lines: list[dict]) -> int:
    """Sum in integer minor units: money never touches a float."""
    return sum(line["quantity"] * line["unit_price_cents"] for line in lines)


def require_draft(invoice: dict) -> None:
    if invoice["status"] == FINALIZED:
        raise HTTPException(status_code=409, detail="a finalized invoice cannot be changed")


@app.post("/v1/invoices")
def create_invoice(
    body: InvoiceDraft, tenant: str | None = Header(default=None, alias="X-Tenant-Id")
) -> JSONResponse:
    tenant_id = require_tenant(tenant)
    if body.currency not in ALLOWED_CURRENCIES:
        raise HTTPException(status_code=400, detail="unsupported currency")
    lines = [line.model_dump() for line in body.line_items]
    validate_lines(lines)
    invoice = {
        "id": str(uuid.uuid4()),
        "tenant_id": tenant_id,
        "currency": body.currency,
        "status": DRAFT,
        "number": None,
        "line_items": lines,
        "subtotal_cents": 0,
    }
    return JSONResponse(store.create(tenant_id, invoice), status_code=201)


@app.patch("/v1/invoices/{invoice_id}")
def update_invoice(
    invoice_id: str,
    body: InvoiceDraft,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    tenant_id = require_tenant(tenant)
    invoice = store.get(tenant_id, invoice_id)
    if invoice is None:
        raise HTTPException(status_code=404, detail="not found")
    require_draft(invoice)
    if body.currency not in ALLOWED_CURRENCIES:
        raise HTTPException(status_code=400, detail="unsupported currency")
    lines = [line.model_dump() for line in body.line_items]
    validate_lines(lines)
    invoice["currency"] = body.currency
    invoice["line_items"] = lines
    store.save(invoice)
    return JSONResponse(invoice, status_code=200)


@app.post("/v1/invoices/{invoice_id}/finalize")
def finalize_invoice(
    invoice_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    tenant_id = require_tenant(tenant)
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    replayed = finalize_store.get(tenant_id, idem_key)
    if replayed is not None:
        return JSONResponse(replayed, status_code=200)
    invoice = store.get(tenant_id, invoice_id)
    if invoice is None:
        raise HTTPException(status_code=404, detail="not found")
    require_draft(invoice)
    if len(invoice["line_items"]) == 0:
        raise HTTPException(status_code=422, detail="invoice has no line items")
    validate_lines(invoice["line_items"])
    number = store.claim_next_number(tenant_id, invoice_id)
    finalized = dict(invoice)
    finalized.update(
        {
            "status": FINALIZED,
            "number": number,
            "subtotal_cents": subtotal_cents(invoice["line_items"]),
            "finalized_at": datetime.now(timezone.utc).isoformat(),
        }
    )
    store.save(finalized)
    finalize_store.put(tenant_id, idem_key, finalized)
    return JSONResponse(finalized, status_code=200)
`,
    },
    typescript: {
      starter: `/** api.ts — a model-generated first draft of the invoice lifecycle. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

interface LineItem {
  description: string;
  quantity: number;
  unit_price_cents: number;
}

interface Invoice {
  id: string;
  tenant_id: string;
  currency: string;
  status: string;
  number: number | null;
  line_items: LineItem[];
  subtotal_cents: number;
}

const drafts = new Map<string, Invoice>();

// TODO: this draft treats finalize as a label instead of a lock — an update still lands on a
// finalized invoice, an invoice with no line items finalizes with a zero total, and every retry
// mints another invoice because Idempotency-Key is ignored. Review all three.

app.post('/v1/invoices', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const body = (request.body ?? {}) as {currency?: string; line_items?: LineItem[]};
  const invoice: Invoice = {
    id: randomUUID(),
    tenant_id: tenant,
    currency: body.currency ?? 'usd',
    status: 'draft',
    number: null,
    line_items: body.line_items ?? [],
    subtotal_cents: 0,
  };
  drafts.set(invoice.id, invoice);
  return reply.code(201).send(invoice);
});

app.patch('/v1/invoices/:id', async (request, reply) => {
  const {id} = request.params as {id: string};
  const body = (request.body ?? {}) as {currency?: string; line_items?: LineItem[]};
  const invoice = drafts.get(id)!;
  invoice.currency = body.currency ?? invoice.currency;
  invoice.line_items = body.line_items ?? [];
  return reply.code(200).send(invoice);
});

app.post('/v1/invoices/:id/finalize', async (request, reply) => {
  const {id} = request.params as {id: string};
  const invoice = drafts.get(id)!;
  invoice.status = 'finalized';
  invoice.subtotal_cents = invoice.line_items.reduce(
    (sum, line) => sum + line.quantity * line.unit_price_cents,
    0,
  );
  return reply.code(200).send(invoice);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/invoices · PATCH /v1/invoices/:id · POST /v1/invoices/:id/finalize.

Drafts are mutable containers; finalization validates the totals, locks the invoice and replays a
retry instead of creating a second document.
*/
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const DRAFT = 'draft';
const FINALIZED = 'finalized';
const MAX_LINE_ITEMS = 100;
const MIN_QUANTITY = 1;
const MAX_QUANTITY = 1000;
const MAX_UNIT_PRICE_CENTS = 10_000_000;
const MAX_DESCRIPTION_CHARS = 120;
const ALLOWED_CURRENCIES: Record<string, true> = {usd: true, eur: true, gbp: true};

interface LineItem {
  description: string;
  quantity: number;
  unit_price_cents: number;
}

interface InvoiceDraft {
  currency?: string;
  line_items?: LineItem[];
}

interface Invoice {
  id: string;
  tenant_id: string;
  currency: string;
  status: string;
  number: number | null;
  line_items: LineItem[];
  subtotal_cents: number;
  finalized_at?: string;
}


/** Implemented by the state step: claimNextNumber is the atomic number + draft → finalized step. */
class InvoiceStore {
  async create(_tenant: string, _invoice: Invoice): Promise<Invoice> {
    throw new Error('not implemented');
  }

  async get(_tenant: string, _invoiceId: string): Promise<Invoice | null> {
    throw new Error('not implemented');
  }

  async save(_invoice: Invoice): Promise<void> {
    throw new Error('not implemented');
  }

  async claimNextNumber(_tenant: string, _invoiceId: string): Promise<number> {
    throw new Error('not implemented');
  }
}

const store = new InvoiceStore();
const finalizeStore = {
  async get(_tenant: string, _idemKey: string): Promise<Invoice | null> {
    return null;
  },
  async put(_tenant: string, _idemKey: string, _invoice: Invoice): Promise<void> {},
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function requireTenant(tenant: unknown): string {
  if (typeof tenant !== 'string' || tenant === '') throw new HttpError(401, 'missing X-Tenant-Id');
  return tenant;
}

function validateLines(lines: LineItem[]): void {
  if (lines.length > MAX_LINE_ITEMS) throw new HttpError(400, 'too many line items');
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < MIN_QUANTITY || line.quantity > MAX_QUANTITY)
      throw new HttpError(400, 'quantity must be 1..1000');
    if (
      !Number.isInteger(line.unit_price_cents) ||
      line.unit_price_cents < 0 ||
      line.unit_price_cents > MAX_UNIT_PRICE_CENTS
    )
      throw new HttpError(400, 'unit_price_cents is out of range');
    if (line.description.length < 1 || line.description.length > MAX_DESCRIPTION_CHARS)
      throw new HttpError(400, 'description must be 1..120 characters');
  }
}

function subtotalCents(lines: LineItem[]): number {
  return lines.reduce((sum, line) => sum + line.quantity * line.unit_price_cents, 0);
}

function requireDraft(invoice: Invoice): void {
  if (invoice.status === FINALIZED) throw new HttpError(409, 'a finalized invoice cannot be changed');
}

app.setErrorHandler((error, request, reply) => {
  if (error instanceof HttpError) return reply.code(error.status).send({error: error.message});
  request.log.error({err: error}, 'invoice request failed');
  return reply.code(500).send({error: 'internal error'});
});

app.post('/v1/invoices', async (request, reply) => {
  const tenant = requireTenant(request.headers['x-tenant-id']);
  const body = (request.body ?? {}) as InvoiceDraft;
  const currency = body.currency ?? 'usd';
  if (ALLOWED_CURRENCIES[currency] !== true) throw new HttpError(400, 'unsupported currency');
  const lines = body.line_items ?? [];
  validateLines(lines);
  const invoice: Invoice = {
    id: randomUUID(),
    tenant_id: tenant,
    currency,
    status: DRAFT,
    number: null,
    line_items: lines,
    subtotal_cents: 0,
  };
  return reply.code(201).send(await store.create(tenant, invoice));
});

app.patch('/v1/invoices/:id', async (request, reply) => {
  const tenant = requireTenant(request.headers['x-tenant-id']);
  const {id} = request.params as {id: string};
  const invoice = await store.get(tenant, id);
  if (invoice === null) throw new HttpError(404, 'not found');
  requireDraft(invoice);
  const body = (request.body ?? {}) as InvoiceDraft;
  const currency = body.currency ?? invoice.currency;
  if (ALLOWED_CURRENCIES[currency] !== true) throw new HttpError(400, 'unsupported currency');
  const lines = body.line_items ?? [];
  validateLines(lines);
  const updated: Invoice = {...invoice, currency, line_items: lines};
  await store.save(updated);
  return reply.code(200).send(updated);
});

app.post('/v1/invoices/:id/finalize', async (request, reply) => {
  const tenant = requireTenant(request.headers['x-tenant-id']);
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    throw new HttpError(400, 'Idempotency-Key is required');
  const replayed = await finalizeStore.get(tenant, idemKey);
  if (replayed !== null) return reply.code(200).send(replayed);
  const {id} = request.params as {id: string};
  const invoice = await store.get(tenant, id);
  if (invoice === null) throw new HttpError(404, 'not found');
  requireDraft(invoice);
  if (invoice.line_items.length === 0) throw new HttpError(422, 'invoice has no line items');
  validateLines(invoice.line_items);
  const number = await store.claimNextNumber(tenant, id);
  const finalizedInvoice: Invoice = {
    ...invoice,
    status: FINALIZED,
    number,
    subtotal_cents: subtotalCents(invoice.line_items),
    finalized_at: new Date().toISOString(),
  };
  await store.save(finalizedInvoice);
  await finalizeStore.put(tenant, idemKey, finalizedInvoice);
  return reply.code(200).send(finalizedInvoice);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `// api.go — a model-generated first draft of the invoice lifecycle.
package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

type LineItem struct {
	Description    string \`json:"description"\`
	Quantity       int    \`json:"quantity"\`
	UnitPriceCents int    \`json:"unit_price_cents"\`
}

type Invoice struct {
	ID         string     \`json:"id"\`
	TenantID   string     \`json:"tenant_id"\`
	Currency   string     \`json:"currency"\`
	Status     string     \`json:"status"\`
	Number     *int       \`json:"number"\`
	LineItems  []LineItem \`json:"line_items"\`
	TotalCents int        \`json:"subtotal_cents"\`
}

var drafts = map[string]Invoice{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// TODO: this draft treats finalize as a label instead of a lock — an update still lands on a
// finalized invoice, an invoice with no line items finalizes with a zero total, and every retry
// mints another invoice because Idempotency-Key is ignored. Review all three.

func createInvoice(rw http.ResponseWriter, r *http.Request) {
	var body struct {
		Currency  string     \`json:"currency"\`
		LineItems []LineItem \`json:"line_items"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	currency := body.Currency
	if currency == "" {
		currency = "usd"
	}
	invoice := Invoice{
		ID:        uuid.NewString(),
		TenantID:  r.Header.Get("X-Tenant-Id"),
		Currency:  currency,
		Status:    "draft",
		LineItems: body.LineItems,
	}
	drafts[invoice.ID] = invoice
	writeJSON(rw, http.StatusCreated, invoice)
}

func updateInvoice(rw http.ResponseWriter, r *http.Request) {
	var body struct {
		Currency  string     \`json:"currency"\`
		LineItems []LineItem \`json:"line_items"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	invoice := drafts[r.PathValue("id")]
	invoice.Currency = body.Currency
	invoice.LineItems = body.LineItems
	drafts[invoice.ID] = invoice
	writeJSON(rw, http.StatusOK, invoice)
}

func finalizeInvoice(rw http.ResponseWriter, r *http.Request) {
	invoice := drafts[r.PathValue("id")]
	invoice.Status = "finalized"
	for _, line := range invoice.LineItems {
		invoice.TotalCents += line.Quantity * line.UnitPriceCents
	}
	drafts[invoice.ID] = invoice
	writeJSON(rw, http.StatusOK, invoice)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/invoices", createInvoice)
	mux.HandleFunc("PATCH /v1/invoices/{id}", updateInvoice)
	mux.HandleFunc("POST /v1/invoices/{id}/finalize", finalizeInvoice)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `// POST /v1/invoices · PATCH /v1/invoices/{id} · POST /v1/invoices/{id}/finalize.
//
// Drafts are mutable containers; finalization validates the totals, locks the invoice and replays a
// retry instead of creating a second document.
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
)

const (
	draft               = "draft"
	finalized           = "finalized"
	maxLineItems        = 100
	minQuantity         = 1
	maxQuantity         = 1000
	maxUnitPriceCents   = 10000000
	maxDescriptionChars = 120
)

var allowedCurrencies = map[string]bool{"usd": true, "eur": true, "gbp": true}

type LineItem struct {
	Description    string \`json:"description"\`
	Quantity       int    \`json:"quantity"\`
	UnitPriceCents int    \`json:"unit_price_cents"\`
}

type Invoice struct {
	ID            string     \`json:"id"\`
	TenantID      string     \`json:"tenant_id"\`
	Currency      string     \`json:"currency"\`
	Status        string     \`json:"status"\`
	Number        *int       \`json:"number"\`
	LineItems     []LineItem \`json:"line_items"\`
	SubtotalCents int        \`json:"subtotal_cents"\`
	FinalizedAt   string     \`json:"finalized_at,omitempty"\`
}

// InvoiceStore is implemented by the state step. ClaimNextNumber moves the invoice from draft to
// finalized and returns its per-tenant number as one atomic operation, so it is only ever called
// after the totals have been validated.
type InvoiceStore interface {
	Create(tenant string, invoice *Invoice) (*Invoice, error)
	Get(tenant, invoiceID string) (*Invoice, error)
	Save(invoice *Invoice) error
	ClaimNextNumber(tenant, invoiceID string) (int, error)
}

var store InvoiceStore

// finalizeKeyStore remembers which (tenant, Idempotency-Key) already produced a finalized invoice.
type finalizeKeyStore struct{}

func (s *finalizeKeyStore) Get(tenant, idemKey string) (*Invoice, error) { return nil, nil }

func (s *finalizeKeyStore) Put(tenant, idemKey string, invoice *Invoice) error { return nil }

var finalizeStore = &finalizeKeyStore{}

type apiError struct {
	status  int
	message string
}

func (e apiError) Error() string { return e.message }

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func fail(rw http.ResponseWriter, err error) {
	if apiErr, ok := err.(apiError); ok {
		writeJSON(rw, apiErr.status, map[string]string{"error": apiErr.message})
		return
	}
	writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}

func requireTenant(r *http.Request) (string, error) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		return "", apiError{http.StatusUnauthorized, "missing X-Tenant-Id"}
	}
	return tenant, nil
}

func validateLines(lines []LineItem) error {
	if len(lines) > maxLineItems {
		return apiError{http.StatusBadRequest, "too many line items"}
	}
	for _, line := range lines {
		if len(line.Description) < 1 || len(line.Description) > maxDescriptionChars {
			return apiError{http.StatusBadRequest, "description must be 1..120 characters"}
		}
		if line.Quantity < minQuantity || line.Quantity > maxQuantity {
			return apiError{http.StatusBadRequest, "quantity must be 1..1000"}
		}
		if line.UnitPriceCents < 0 || line.UnitPriceCents > maxUnitPriceCents {
			return apiError{http.StatusBadRequest, "unit_price_cents is out of range"}
		}
	}
	return nil
}

func subtotalCents(lines []LineItem) int {
	total := 0
	for _, line := range lines {
		total += line.Quantity * line.UnitPriceCents
	}
	return total
}

func requireDraft(invoice *Invoice) error {
	if invoice.Status == finalized {
		return apiError{http.StatusConflict, "a finalized invoice cannot be changed"}
	}
	return nil
}

type invoiceDraft struct {
	Currency  string     \`json:"currency"\`
	LineItems []LineItem \`json:"line_items"\`
}

func createInvoice(rw http.ResponseWriter, r *http.Request) {
	tenant, err := requireTenant(r)
	if err != nil {
		fail(rw, err)
		return
	}
	var body invoiceDraft
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		fail(rw, apiError{http.StatusBadRequest, "invalid json"})
		return
	}
	if body.Currency == "" {
		body.Currency = "usd"
	}
	if !allowedCurrencies[body.Currency] {
		fail(rw, apiError{http.StatusBadRequest, "unsupported currency"})
		return
	}
	if err := validateLines(body.LineItems); err != nil {
		fail(rw, err)
		return
	}
	invoice := &Invoice{
		ID:        uuid.NewString(),
		TenantID:  tenant,
		Currency:  body.Currency,
		Status:    draft,
		LineItems: body.LineItems,
	}
	saved, err := store.Create(tenant, invoice)
	if err != nil {
		fail(rw, err)
		return
	}
	writeJSON(rw, http.StatusCreated, saved)
}

func updateInvoice(rw http.ResponseWriter, r *http.Request) {
	tenant, err := requireTenant(r)
	if err != nil {
		fail(rw, err)
		return
	}
	invoiceID := r.PathValue("id")
	invoice, err := store.Get(tenant, invoiceID)
	if err != nil {
		fail(rw, err)
		return
	}
	if invoice == nil {
		fail(rw, apiError{http.StatusNotFound, "not found"})
		return
	}
	if err := requireDraft(invoice); err != nil {
		fail(rw, err)
		return
	}
	var body invoiceDraft
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		fail(rw, apiError{http.StatusBadRequest, "invalid json"})
		return
	}
	currency := body.Currency
	if currency == "" {
		currency = invoice.Currency
	}
	if !allowedCurrencies[currency] {
		fail(rw, apiError{http.StatusBadRequest, "unsupported currency"})
		return
	}
	if err := validateLines(body.LineItems); err != nil {
		fail(rw, err)
		return
	}
	invoice.Currency = currency
	invoice.LineItems = body.LineItems
	if err := store.Save(invoice); err != nil {
		fail(rw, err)
		return
	}
	writeJSON(rw, http.StatusOK, invoice)
}

func finalizeInvoice(rw http.ResponseWriter, r *http.Request) {
	tenant, err := requireTenant(r)
	if err != nil {
		fail(rw, err)
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		fail(rw, apiError{http.StatusBadRequest, "Idempotency-Key is required"})
		return
	}
	replayed, err := finalizeStore.Get(tenant, idemKey)
	if err != nil {
		fail(rw, err)
		return
	}
	if replayed != nil {
		writeJSON(rw, http.StatusOK, replayed)
		return
	}
	invoiceID := r.PathValue("id")
	invoice, err := store.Get(tenant, invoiceID)
	if err != nil {
		fail(rw, err)
		return
	}
	if invoice == nil {
		fail(rw, apiError{http.StatusNotFound, "not found"})
		return
	}
	if err := requireDraft(invoice); err != nil {
		fail(rw, err)
		return
	}
	if len(invoice.LineItems) == 0 {
		fail(rw, apiError{http.StatusUnprocessableEntity, "invoice has no line items"})
		return
	}
	if err := validateLines(invoice.LineItems); err != nil {
		fail(rw, err)
		return
	}
	number, err := store.ClaimNextNumber(tenant, invoiceID)
	if err != nil {
		fail(rw, err)
		return
	}
	invoice.Status = finalized
	invoice.Number = &number
	invoice.SubtotalCents = subtotalCents(invoice.LineItems)
	invoice.FinalizedAt = time.Now().UTC().Format(time.RFC3339)
	if err := store.Save(invoice); err != nil {
		fail(rw, err)
		return
	}
	if err := finalizeStore.Put(tenant, idemKey, invoice); err != nil {
		fail(rw, err)
		return
	}
	writeJSON(rw, http.StatusOK, invoice)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/invoices", createInvoice)
	mux.HandleFunc("PATCH /v1/invoices/{id}", updateInvoice)
	mux.HandleFunc("POST /v1/invoices/{id}/finalize", finalizeInvoice)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `// Api.scala — a model-generated first draft of the invoice lifecycle.
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class LineItem(description: String, quantity: Int, unit_price_cents: Int)
final case class InvoiceDraft(currency: String, line_items: List[LineItem])
final case class Invoice(
    id: String,
    tenant_id: String,
    currency: String,
    status: String,
    number: Option[Long],
    line_items: List[LineItem],
    subtotal_cents: Long
)

object InvoiceApi {
  implicit val system: ActorSystem = ActorSystem("invoiced")
  implicit val lineItemFormat: RootJsonFormat[LineItem] = jsonFormat3(LineItem)
  implicit val draftFormat: RootJsonFormat[InvoiceDraft] = jsonFormat2(InvoiceDraft)
  implicit val invoiceFormat: RootJsonFormat[Invoice] = jsonFormat7(Invoice)

  var drafts: Map[String, Invoice] = Map.empty

  def subtotalCents(lines: List[LineItem]): Long =
    lines.map(line => line.quantity.toLong * line.unit_price_cents).sum

  // TODO: this draft treats finalize as a label instead of a lock — an update still lands on a
  // finalized invoice, an invoice with no line items finalizes with a zero total, and every retry
  // mints another invoice because Idempotency-Key is ignored. Review all three.

  val routes: Route =
    path("v1" / "invoices") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[InvoiceDraft]) { body =>
            val invoice = Invoice(
              UUID.randomUUID().toString,
              tenant,
              body.currency,
              "draft",
              None,
              body.line_items,
              0L
            )
            drafts = drafts.updated(invoice.id, invoice)
            complete(StatusCodes.Created, invoice)
          }
        }
      }
    } ~
      path("v1" / "invoices" / Segment) { invoiceId =>
        patch {
          entity(as[InvoiceDraft]) { body =>
            val invoice = drafts(invoiceId).copy(currency = body.currency, line_items = body.line_items)
            drafts = drafts.updated(invoice.id, invoice)
            complete(StatusCodes.OK, invoice)
          }
        }
      } ~
      path("v1" / "invoices" / Segment / "finalize") { invoiceId =>
        post {
          val invoice = drafts(invoiceId)
          val finalizedInvoice =
            invoice.copy(status = "finalized", subtotal_cents = subtotalCents(invoice.line_items))
          drafts = drafts.updated(invoice.id, finalizedInvoice)
          complete(StatusCodes.OK, finalizedInvoice)
        }
      }

  def main(args: Array[String]): Unit = Http().newServerAt("0.0.0.0", 8443).bind(routes)
}
`,
      solution: `// POST /v1/invoices · PATCH /v1/invoices/{id} · POST /v1/invoices/{id}/finalize.
//
// Drafts are mutable containers; finalization validates the totals, locks the invoice and replays a
// retry instead of creating a second document.
import java.time.Instant
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.{ExceptionHandler, Route}
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class LineItem(description: String, quantity: Int, unit_price_cents: Int)
final case class InvoiceDraft(currency: String, line_items: List[LineItem])
final case class Invoice(
    id: String,
    tenant_id: String,
    currency: String,
    status: String,
    number: Option[Long],
    line_items: List[LineItem],
    subtotal_cents: Long,
    finalized_at: Option[String]
)

final case class ApiError(status: StatusCode, message: String) extends RuntimeException(message)

object InvoiceApi {
  implicit val system: ActorSystem = ActorSystem("invoiced")
  implicit val lineItemFormat: RootJsonFormat[LineItem] = jsonFormat3(LineItem)
  implicit val draftFormat: RootJsonFormat[InvoiceDraft] = jsonFormat2(InvoiceDraft)
  implicit val invoiceFormat: RootJsonFormat[Invoice] = jsonFormat8(Invoice)

  val Draft = "draft"
  val Finalized = "finalized"
  val MaxLineItems = 100
  val MinQuantity = 1
  val MaxQuantity = 1000
  val MaxUnitPriceCents = 10000000L
  val MaxDescriptionChars = 120
  val AllowedCurrencies = Set("usd", "eur", "gbp")

  // Both stores are implemented by the state step: claimNextNumber moves the invoice from draft to
  // finalized and returns its per-tenant number atomically.
  val store: InvoiceStore = InvoiceStore.open()
  val finalizeStore: FinalizeStore = FinalizeStore.open()

  def subtotalCents(lines: List[LineItem]): Long =
    lines.map(line => line.quantity.toLong * line.unit_price_cents).sum

  def validateLines(lines: List[LineItem]): Unit = {
    if (lines.size > MaxLineItems) throw ApiError(StatusCodes.BadRequest, "too many line items")
    lines.foreach { line =>
      if (line.description.isEmpty || line.description.length > MaxDescriptionChars)
        throw ApiError(StatusCodes.BadRequest, "description must be 1..120 characters")
      if (line.quantity < MinQuantity || line.quantity > MaxQuantity)
        throw ApiError(StatusCodes.BadRequest, "quantity must be 1..1000")
      if (line.unit_price_cents < 0 || line.unit_price_cents > MaxUnitPriceCents)
        throw ApiError(StatusCodes.BadRequest, "unit_price_cents is out of range")
    }
  }

  def requireDraft(invoice: Invoice): Unit =
    if (invoice.status == Finalized)
      throw ApiError(StatusCodes.Conflict, "a finalized invoice cannot be changed")

  val handler: ExceptionHandler = ExceptionHandler { case ApiError(status, message) =>
    complete(status, s"""{"error":"$message"}""")
  }

  val routes: Route = handleExceptions(handler) {
    path("v1" / "invoices") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[InvoiceDraft]) { body =>
            if (!AllowedCurrencies.contains(body.currency))
              throw ApiError(StatusCodes.BadRequest, "unsupported currency")
            validateLines(body.line_items)
            val invoice = Invoice(
              UUID.randomUUID().toString,
              tenant,
              body.currency,
              Draft,
              None,
              body.line_items,
              0L,
              None
            )
            complete(StatusCodes.Created, store.create(tenant, invoice))
          }
        }
      }
    } ~
      path("v1" / "invoices" / Segment) { invoiceId =>
        patch {
          headerValueByName("X-Tenant-Id") { tenant =>
            entity(as[InvoiceDraft]) { body =>
              store.get(tenant, invoiceId) match {
                case None => complete(StatusCodes.NotFound, """{"error":"not found"}""")
                case Some(invoice) =>
                  requireDraft(invoice)
                  if (!AllowedCurrencies.contains(body.currency))
                    throw ApiError(StatusCodes.BadRequest, "unsupported currency")
                  validateLines(body.line_items)
                  val updated = invoice.copy(currency = body.currency, line_items = body.line_items)
                  store.save(updated)
                  complete(StatusCodes.OK, updated)
              }
            }
          }
        }
      } ~
      path("v1" / "invoices" / Segment / "finalize") { invoiceId =>
        post {
          headerValueByName("X-Tenant-Id") { tenant =>
            optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
              if (!idemOpt.exists(_.nonEmpty))
                throw ApiError(StatusCodes.BadRequest, "Idempotency-Key is required")
              val idemKey = idemOpt.get
              finalizeStore.get(tenant, idemKey) match {
                case Some(replayed) => complete(StatusCodes.OK, replayed)
                case None =>
                  store.get(tenant, invoiceId) match {
                    case None => complete(StatusCodes.NotFound, """{"error":"not found"}""")
                    case Some(invoice) =>
                      requireDraft(invoice)
                      if (invoice.lineItems.isEmpty)
                        throw ApiError(StatusCodes.UnprocessableEntity, "invoice has no line items")
                      validateLines(invoice.line_items)
                      val number = store.claimNextNumber(tenant, invoiceId)
                      val finalizedInvoice = invoice.copy(
                        status = Finalized,
                        number = Some(number),
                        subtotal_cents = subtotalCents(invoice.line_items),
                        finalized_at = Some(Instant.now.toString)
                      )
                      store.save(finalizedInvoice)
                      finalizeStore.put(tenant, idemKey, finalizedInvoice)
                      complete(StatusCodes.OK, finalizedInvoice)
                  }
              }
            }
          }
        }
      }
  }

  def main(args: Array[String]): Unit = Http().newServerAt("0.0.0.0", 8443).bind(routes)
}
`,
    },
    cpp: {
      starter: `// api.cpp — a model-generated first draft of the invoice lifecycle.
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <map>
#include <string>

using json = nlohmann::json;

std::map<std::string, json> drafts;

int main() {
  httplib::Server svr;

  svr.Post("/v1/invoices", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    json invoice = {
        {"id", "inv-" + std::to_string(drafts.size() + 1)},
        {"tenant_id", req.get_header_value("X-Tenant-Id")},
        {"currency", body.value("currency", std::string("usd"))},
        {"status", "draft"},
        {"number", nullptr},
        {"line_items", body.value("line_items", json::array())},
        {"subtotal_cents", 0},
    };
    drafts[invoice["id"]] = invoice;
    res.status = 201;
    res.set_content(invoice.dump(), "application/json");
  });

  // TODO: this draft treats finalize as a label instead of a lock — an update still lands on a
  // finalized invoice, an invoice with no line items finalizes with a zero total, and every retry
  // mints another invoice because Idempotency-Key is ignored. Review all three.

  svr.Patch(R"(/v1/invoices/(\\d+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto invoiceId = req.matches[1].str();
    json body = json::parse(req.body, nullptr, false);
    json invoice = drafts[invoiceId];
    invoice["currency"] = body.value("currency", invoice.value("currency", std::string("usd")));
    invoice["line_items"] = body.value("line_items", json::array());
    drafts[invoiceId] = invoice;
    res.status = 200;
    res.set_content(invoice.dump(), "application/json");
  });

  svr.Post(R"(/v1/invoices/(\\d+)/finalize)", [](const httplib::Request& req, httplib::Response& res) {
    const auto invoiceId = req.matches[1].str();
    json invoice = drafts[invoiceId];
    long total = 0;
    for (const auto& line : invoice["line_items"]) {
      total += line.value("quantity", 0L) * line.value("unit_price_cents", 0L);
    }
    invoice["status"] = "finalized";
    invoice["subtotal_cents"] = total;
    drafts[invoiceId] = invoice;
    res.status = 200;
    res.set_content(invoice.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `// POST /v1/invoices · PATCH /v1/invoices/(id) · POST /v1/invoices/(id)/finalize.
//
// Drafts are mutable containers; finalization validates the totals, locks the invoice and replays a
// retry instead of creating a second document.
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <ctime>
#include <iostream>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>

using json = nlohmann::json;

const std::string kDraft = "draft";
const std::string kFinalized = "finalized";
constexpr std::size_t kMaxLineItems = 100;
constexpr long kMinQuantity = 1;
constexpr long kMaxQuantity = 1000;
constexpr long kMaxUnitPriceCents = 10000000;
constexpr std::size_t kMaxDescriptionChars = 120;
const std::set<std::string> kAllowedCurrencies = {"usd", "eur", "gbp"};

struct ApiError {
  int status;
  std::string message;
};

// Implemented by the state step: claimNextNumber moves the invoice from draft to finalized and
// returns its per-tenant number atomically, so it is never called before the totals validate.
struct InvoiceStore {
  json create(const std::string& tenant, const json& invoice);
  std::optional<json> get(const std::string& tenant, const std::string& invoiceId);
  void save(const json& invoice);
  long claimNextNumber(const std::string& tenant, const std::string& invoiceId);
};

struct FinalizeStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& invoice);
};

InvoiceStore store;
FinalizeStore finalizeStore;

std::string uuidString();

std::string nowIso() {
  const std::time_t now = std::time(nullptr);
  char buffer[32];
  std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", std::gmtime(&now));
  return std::string(buffer);
}

void sendJson(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

std::string requireTenant(const httplib::Request& req) {
  const auto tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) throw ApiError{401, "missing X-Tenant-Id"};
  return tenant;
}

void validateLines(const json& lines) {
  if (lines.size() > kMaxLineItems) throw ApiError{400, "too many line items"};
  for (const auto& line : lines) {
    const auto description = line.value("description", std::string());
    if (description.empty() || description.size() > kMaxDescriptionChars)
      throw ApiError{400, "description must be 1..120 characters"};
    const long quantity = line.value("quantity", 0L);
    if (quantity < kMinQuantity || quantity > kMaxQuantity) throw ApiError{400, "quantity must be 1..1000"};
    const long unitPrice = line.value("unit_price_cents", -1L);
    if (unitPrice < 0 || unitPrice > kMaxUnitPriceCents)
      throw ApiError{400, "unit_price_cents is out of range"};
  }
}

long subtotal_cents(const json& lines) {
  long total = 0;
  for (const auto& line : lines) total += line.value("quantity", 0L) * line.value("unit_price_cents", 0L);
  return total;
}

void requireDraft(const json& invoice) {
  if (invoice.value("status", std::string()) == kFinalized)
    throw ApiError{409, "a finalized invoice cannot be changed"};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/invoices", [](const httplib::Request& req, httplib::Response& res) {
    try {
      const auto tenant = requireTenant(req);
      json body = json::parse(req.body, nullptr, false);
      if (!body.is_object()) throw ApiError{400, "invalid json"};
      const auto currency = body.value("currency", std::string("usd"));
      if (kAllowedCurrencies.count(currency) == 0) throw ApiError{400, "unsupported currency"};
      const json lines = body.value("line_items", json::array());
      validateLines(lines);
      const json invoice = {
          {"id", uuidString()},
          {"tenant_id", tenant},
          {"currency", currency},
          {"status", kDraft},
          {"number", nullptr},
          {"line_items", lines},
          {"subtotal_cents", 0},
      };
      sendJson(res, 201, store.create(tenant, invoice));
    } catch (const ApiError& err) {
      sendJson(res, err.status, json{{"error", err.message}});
    }
  });

  svr.Patch(R"(/v1/invoices/([0-9a-f-]+))", [](const httplib::Request& req, httplib::Response& res) {
    try {
      const auto tenant = requireTenant(req);
      const auto invoiceId = req.matches[1].str();
      const auto invoice = store.get(tenant, invoiceId);
      if (!invoice) {
        sendJson(res, 404, json{{"error", "not found"}});
        return;
      }
      requireDraft(*invoice);
      json body = json::parse(req.body, nullptr, false);
      if (!body.is_object()) throw ApiError{400, "invalid json"};
      const auto currency = body.value("currency", invoice->value("currency", std::string("usd")));
      if (kAllowedCurrencies.count(currency) == 0) throw ApiError{400, "unsupported currency"};
      const json lines = body.value("line_items", json::array());
      validateLines(lines);
      json updated = *invoice;
      updated["currency"] = currency;
      updated["line_items"] = lines;
      store.save(updated);
      sendJson(res, 200, updated);
    } catch (const ApiError& err) {
      sendJson(res, err.status, json{{"error", err.message}});
    }
  });

  svr.Post(R"(/v1/invoices/([0-9a-f-]+)/finalize)", [](const httplib::Request& req, httplib::Response& res) {
    try {
      const auto tenant = requireTenant(req);
      const auto idemKey = req.get_header_value("Idempotency-Key");
      if (idemKey.empty()) throw ApiError{400, "Idempotency-Key is required"};
      const auto replayed = finalizeStore.get(tenant, idemKey);
      if (replayed) {
        sendJson(res, 200, *replayed);
        return;
      }
      const auto invoiceId = req.matches[1].str();
      const auto invoice = store.get(tenant, invoiceId);
      if (!invoice) {
        sendJson(res, 404, json{{"error", "not found"}});
        return;
      }
      requireDraft(*invoice);
      const json line_items = invoice->value("line_items", json::array());
      if (line_items.empty()) throw ApiError{422, "invoice has no line items"};
      validateLines(line_items);
      const long number = store.claimNextNumber(tenant, invoiceId);
      json finalizedInvoice = *invoice;
      finalizedInvoice["status"] = kFinalized;
      finalizedInvoice["number"] = number;
      finalizedInvoice["subtotal_cents"] = subtotal_cents(line_items);
      finalizedInvoice["finalized_at"] = nowIso();
      store.save(finalizedInvoice);
      finalizeStore.put(tenant, idemKey, finalizedInvoice);
      sendJson(res, 200, finalizedInvoice);
    } catch (const ApiError& err) {
      sendJson(res, err.status, json{{"error", err.message}});
    }
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses in cost order and never let an update reach a finalized invoice: load by `(tenant, id)`, `require_draft(invoice)` → **409**, and only then touch `line_items`. A `status` field is not protection; the check in front of the write is.',
    'Finalization has four refusals in front of the claim: missing tenant, missing `Idempotency-Key`, an invoice that is already finalized (replay the stored one instead), and an invoice with no line items (**422**). Only after those does the state step hand out a number.',
    'Key the retry by `(tenant, Idempotency-Key)` and store the finalized document, not the request: a replay must answer with the number the first attempt already issued. Money stays in integer minor units — `subtotal_cents = Σ quantity × unit_price_cents` — because a float total is an invoice that will never balance.',
  ],
  debrief: `The interviewer is testing whether you review a generated billing handler as a state machine, not as CRUD. The draft reads fine because every demo request is well formed, hits a draft, and never retries. The three defects are one defect repeated: the code never asks what state the invoice is in. An update that does not check \`status\` turns a finalized — already taxed, already sent, possibly already paid — document into a mutable one, which invalidates every ledger row, PDF and reconciliation built on it. A finalize that does not check the line items issues a zero-total invoice that no one will query for. A finalize that does not check \`Idempotency-Key\` mints a second invoice with its own number for a request the client never saw acknowledged, which is exactly how duplicate billing happens in production. Real services add an append-only status history, a freeze on the whole document (not just the lines), and an amendment/credit-note path for the rare correction, so "changing a finalized invoice" becomes a new document instead of an update.`,
};
