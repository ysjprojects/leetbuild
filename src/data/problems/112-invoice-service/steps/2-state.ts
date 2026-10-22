import type {Step} from '@/lib/types';

export const invoiceStateStep: Step = {
  id: 'state',
  title: 'Redis gapless numbering with atomic claim',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'db'],
  task: `## Task

Finalizing an invoice is the one-way transition from a mutable draft to an issued document: it takes
the tenant's next number, marks the invoice finalized, and only then is the number part of the
tenant's books. Numbers are **gapless per tenant** — a number that has been handed out is carried by
an invoice, and two invoices of one tenant may never share one.

The starter is a plausible model-generated draft: the happy path finalizes and returns a number, so
the demo passes. It reads the tenant's last number with \`GET\`, adds one **in the handler** and
writes it back with \`SET\`; and it takes that number **before** it validates the totals, so every
rejected finalize burns a number.

Implement the finalize path:

- The sequence is **per tenant**: the key is \`inv:seq:{tenant}\`, built from the authenticated
  tenant. A tenant-less key hands one tenant's numbers to another; a key without the tenant can
  never be reconciled per tenant.
- The **increment happens inside Redis**: one Lua script run with \`EVAL\` (or a single \`INCR\`)
  does the arithmetic. A \`GET\`-then-\`SET\` read-modify-write in the handler lets two concurrent
  finalizes read the same last number and both write \`last + 1\`.
- **Claim and transition are one atomic step**: the script reads the claim's \`status\`, refuses
  anything that is no longer a draft, \`INCR\`s the sequence and writes \`finalized\` plus the claimed
  number on the same key. Two concurrent finalizes must receive **distinct** numbers and the loser
  must be told the invoice is already finalized.
- **Validate before you claim**: the totals (\`validate_totals\`) are checked first, and a failed
  finalize consumes **no** number and leaves the draft untouched. Claiming first turns every
  validation failure into a permanent gap in the tenant's sequence.
- **Reconcile the counter**: \`reconcile_sequence(tenant)\` compares the Redis counter with the
  highest number among that tenant's issued invoices and repairs the counter upward with \`SET\`, so
  a lost or flushed counter is detected instead of reissuing numbers.
- **Let the store enforce uniqueness**: the invoice rows carry \`UNIQUE (tenant_id, number)\`, so a
  bug that persists the same number twice fails loudly instead of shipping two documents that share
  a legal identifier.

**Failure mode the checks target.** Two concurrent finalizes both read the last number and both
write the same one; a validation failure after the claim burns a number no invoice will ever carry;
a flushed counter starts from zero and reissues numbers that are already on issued documents; and a
store with no constraint keeps both duplicates without a word.`,
  sequence: {
    participants: ['Client', 'Invoice Service', 'Redis', 'Invoice store'],
    messages: [
      {from: 'Client', to: 'Invoice Service', label: 'POST /v1/invoices/inv_01/finalize', kind: 'sync'},
      {from: 'Invoice Service', to: 'Invoice store', label: 'load draft inv_01', kind: 'sync'},
      {
        from: 'Invoice Service',
        to: 'Invoice Service',
        label: 'validate_totals(draft) — a rejection here claims nothing',
        kind: 'sync',
      },
      {from: 'Invoice Service', to: 'Redis', label: 'EVAL claim · KEYS[inv:claim:inv_01, inv:seq:acme]', kind: 'sync'},
      {from: 'Redis', to: 'Invoice Service', label: '{1, 1042} · draft→finalized in the same script', kind: 'reply'},
      {
        from: 'Invoice Service',
        to: 'Invoice store',
        label: 'UPDATE number 1042 · UNIQUE (tenant_id, number)',
        kind: 'sync',
      },
      {from: 'Invoice Service', to: 'Client', label: '201 {status: finalized, number: 1042}', kind: 'reply'},
      {
        from: 'Redis',
        to: 'Invoice Service',
        label: '{0, 1042} on a concurrent finalize · 409, no new number',
        kind: 'reply',
      },
    ],
  },
  hints: [
    "A `GET` followed by a `SET` is two operations with a window between them: two concurrent finalizes both read the same last number. Move the read and the increment into one `EVAL` with `redis.call('incr', KEYS[2])`, so Redis serializes the claim for you.",
    'The claim is worthless if it is taken before the invoice is known to be valid. Validate the totals first; the claim must be the first and only mutation in the finalize path, and it must refuse a claim whose status is no longer `draft`, returning the already-issued number so the caller can answer 409.',
    'Redis can lose the counter (flush, failover without persistence, a deleted key). `reconcile_sequence(tenant)` reads `MAX(number)` for the tenant from the invoice store and writes it back with `SET` when the counter is behind, and the store itself keeps `UNIQUE (tenant_id, number)` as the last line of defence.',
  ],
  checks: [
    {
      id: 'sequence-key',
      title: 'Per-tenant key, incremented inside Redis',
      detail:
        'The counter is `inv:seq:{tenant}`, built from the tenant, and it is incremented by `INCR` **inside** the Lua script the service `EVAL`s. A client-side `GET`-then-`SET` races: two concurrent finalizes read the same last number and both write `last + 1`, so two invoices of one tenant carry the same number.',
      match: {
        python: {all: [/CLAIM_SCRIPT/, /inv:seq:\{tenant\}/, /\.eval\(/, /INCR/]},
        typescript: {all: [/CLAIM_SCRIPT/, /inv:seq:\$\{tenant\}/, /\.eval\(/, /INCR/]},
        go: {all: [/claimScript/, /inv:seq:%s/, /\.Eval\(/, /INCR/]},
        scala: {all: [/ClaimScript/, /inv:seq:\$tenant/, /\.eval\(/, /INCR/]},
        cpp: {all: [/kClaimScript/, /"inv:seq:"\)\s*\+/, /\.eval</, /INCR/]},
      },
    },
    {
      id: 'atomic-claim',
      title: 'Claim and finalize in one atomic step',
      detail:
        'One script (`EVAL`, or `WATCH`/`MULTI`/`EXEC` on the claim key) reads the claim state, refuses anything that is no longer `draft`, `INCR`s the sequence and `HSET`s the same key to `finalized` with the number it just took. Two concurrent finalizes therefore get distinct numbers instead of the same one, and the loser is told the invoice is already finalized.',
      match: {
        python: {all: [/CLAIM_SCRIPT/, /'draft'/, /INCR/, /HSET/]},
        typescript: {all: [/CLAIM_SCRIPT/, /'draft'/, /INCR/, /HSET/]},
        go: {all: [/claimScript/, /'draft'/, /INCR/, /HSET/]},
        scala: {all: [/ClaimScript/, /'draft'/, /INCR/, /HSET/]},
        cpp: {all: [/kClaimScript/, /'draft'/, /INCR/, /HSET/]},
      },
    },
    {
      id: 'no-burn',
      title: 'Validation runs before the claim',
      detail:
        "The handler validates the totals (`validate_totals`) **before** it calls the claim, so a rejected finalize consumes no number and leaves no gap in the tenant's sequence. The draft claims first and validates afterwards: every 422 burns a number that no invoice will ever carry, and the sequence is no longer gapless.",
      match: {
        python: {order: [/validate_totals\(invoice\)/, /claim_number\(tenant, invoice_id\)/]},
        typescript: {order: [/validateTotals\(invoice\)/, /claimNumber\(tenant, id\)/]},
        go: {order: [/validateTotals\(invoice\.Lines\)/, /claimNumber\(r\.Context\(\), tenant, invoice\.ID\)/]},
        scala: {order: [/validateTotals\(invoice\.lines\)/, /claimNumber\(tenant, invoiceId\)/]},
        cpp: {order: [/validateTotals\(invoice\["lines"\]\)/, /claimNumber\(redis, tenant, invoiceId\)/]},
      },
    },
    {
      id: 'reconcile',
      title: 'The counter reconciles against issued invoices',
      detail:
        "`reconcile_sequence(tenant)` asks the invoice store for `MAX(number)` among that tenant's issued invoices and writes the counter back up to it with `SET` when Redis is behind. Without it a flushed counter restarts at zero and reissues numbers that are already printed on issued documents.",
      match: {
        python: {all: [/reconcile_sequence/, /MAX\(number\)/i, /\.set\(/, /inv:seq:/]},
        typescript: {all: [/reconcileSequence/, /MAX\(number\)/i, /\.set\(/, /inv:seq:/]},
        go: {all: [/reconcileSequence/, /MAX\(number\)/i, /\.Set\(/, /inv:seq:/]},
        scala: {all: [/reconcileSequence/, /MAX\(number\)/i, /\.set\(/, /inv:seq:/]},
        cpp: {all: [/reconcileSequence/, /MAX\(number\)/i, /\.set\(/, /inv:seq:/]},
      },
    },
    {
      id: 'unique-number',
      title: 'The store rejects a duplicate number per tenant',
      detail:
        'The invoice table carries `UNIQUE (tenant_id, number)` and the write path turns a violation into a conflict instead of a second row. Whatever a bug does to the counter, two invoices of one tenant must never persist with the same number — the constraint is the guarantee the sequence cannot give on its own.',
      match: {
        python: {all: [/UNIQUE \(tenant_id, number\)/, /IntegrityError/]},
        typescript: {all: [/UNIQUE \(tenant_id, number\)/, /SQLITE_CONSTRAINT_UNIQUE/]},
        go: {all: [/UNIQUE \(tenant_id, number\)/, /ErrConstraint|UNIQUE constraint failed/]},
        scala: {all: [/UNIQUE \(tenant_id, number\)/, /SQLIntegrityConstraintViolationException/]},
        cpp: {all: [/UNIQUE \(tenant_id, number\)/, /UNIQUE constraint failed/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import sqlite3

import redis.asyncio as redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)
db = sqlite3.connect("invoices.db", check_same_thread=False)

SEQUENCE_KEY_PREFIX = "inv:seq:"

SCHEMA = """
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  number INTEGER,
  currency TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  lines TEXT NOT NULL
)
"""

db.execute(SCHEMA)
db.commit()


class Line(BaseModel):
    description: str
    quantity: int
    unit_cents: int


def load_draft(invoice_id: str) -> dict:
    row = db.execute(
        "SELECT tenant_id, status, lines FROM invoices WHERE id = ?", (invoice_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="invoice not found")
    return {
        "id": invoice_id,
        "tenant_id": row[0],
        "status": row[1],
        "lines": [Line(**line) for line in json.loads(row[2])],
    }


def validate_totals(invoice: dict) -> int:
    lines = invoice["lines"]
    total = sum(line.quantity * line.unit_cents for line in lines)
    if not lines or total <= 0:
        raise HTTPException(status_code=422, detail="invoice has no billable lines")
    return total


async def next_number(tenant: str) -> int:
    # TODO: the counter is read and written in the handler, and the number is claimed before the
    # totals are validated. Claim inside one atomic Redis script taken after validation, guard it on
    # the draft state, reconcile the counter against the issued invoices, and let the store reject a
    # duplicate (tenant_id, number).
    key = f"{SEQUENCE_KEY_PREFIX}{tenant}"
    last = int(await r.get(key) or 0)
    number = last + 1
    await r.set(key, number)
    return number


@app.post("/v1/invoices/{invoice_id}/finalize")
async def finalize(invoice_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    invoice = load_draft(invoice_id)
    if invoice["status"] != "draft":
        raise HTTPException(status_code=409, detail="invoice is already finalized")
    number = await next_number(tenant)
    total = validate_totals(invoice)
    db.execute(
        "UPDATE invoices SET status = 'finalized', number = ?, total_cents = ? WHERE id = ?",
        (number, total, invoice_id),
    )
    db.commit()
    return {"id": invoice_id, "status": "finalized", "number": number}
`,
      solution: `import json
import sqlite3

import redis.asyncio as redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)
db = sqlite3.connect("invoices.db", check_same_thread=False)

SEQUENCE_KEY_PREFIX = "inv:seq:"

SCHEMA = """
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  number INTEGER,
  currency TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  lines TEXT NOT NULL,
  UNIQUE (tenant_id, number)
)
"""

CLAIM_SCRIPT = """
local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'draft' then
  return {0, tonumber(redis.call('HGET', KEYS[1], 'number') or '0')}
end
local number = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'status', 'finalized')
redis.call('HSET', KEYS[1], 'number', number)
return {1, number}
"""

db.execute(SCHEMA)
db.commit()


class Line(BaseModel):
    description: str
    quantity: int
    unit_cents: int


def load_draft(invoice_id: str) -> dict:
    row = db.execute(
        "SELECT tenant_id, status, lines FROM invoices WHERE id = ?", (invoice_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="invoice not found")
    return {
        "id": invoice_id,
        "tenant_id": row[0],
        "status": row[1],
        "lines": [Line(**line) for line in json.loads(row[2])],
    }


def sequence_key(tenant: str) -> str:
    return f"inv:seq:{tenant}"


def claim_key(invoice_id: str) -> str:
    return f"inv:claim:{invoice_id}"


async def ensure_claim(invoice_id: str, tenant: str) -> None:
    # HSETNX, not HSET: replaying finalize must not push a finalized claim back to draft.
    await r.hsetnx(claim_key(invoice_id), "tenant", tenant)
    await r.hsetnx(claim_key(invoice_id), "status", "draft")


def validate_totals(invoice: dict) -> int:
    lines = invoice["lines"]
    total = sum(line.quantity * line.unit_cents for line in lines)
    if not lines or total <= 0:
        raise HTTPException(status_code=422, detail="invoice has no billable lines")
    return total


async def claim_number(tenant: str, invoice_id: str) -> tuple[bool, int]:
    claimed, number = await r.eval(CLAIM_SCRIPT, 2, claim_key(invoice_id), sequence_key(tenant))
    return bool(claimed), int(number)


def persist_final(invoice_id: str, tenant: str, number: int, total: int) -> None:
    try:
        db.execute(
            "UPDATE invoices SET status = 'finalized', number = ?, total_cents = ? WHERE id = ?",
            (number, total, invoice_id),
        )
        db.commit()
    except sqlite3.IntegrityError as conflict:
        raise HTTPException(
            status_code=409, detail=f"number {number} already issued for tenant {tenant}"
        ) from conflict


async def reconcile_sequence(tenant: str) -> int:
    row = db.execute(
        "SELECT COALESCE(MAX(number), 0) FROM invoices WHERE tenant_id = ? AND number IS NOT NULL",
        (tenant,),
    ).fetchone()
    highest = int(row[0])
    current = int(await r.get(sequence_key(tenant)) or 0)
    if current < highest:
        # Redis lost the counter: repair it upward instead of reissuing numbers already issued.
        await r.set(sequence_key(tenant), highest)
    return max(current, highest)


@app.post("/v1/invoices/{invoice_id}/finalize")
async def finalize(invoice_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    invoice = load_draft(invoice_id)
    await ensure_claim(invoice_id, tenant)
    total = validate_totals(invoice)
    claimed, number = await claim_number(tenant, invoice_id)
    if not claimed:
        raise HTTPException(status_code=409, detail="invoice is already finalized")
    persist_final(invoice_id, tenant, number, total)
    return {"id": invoice_id, "status": "finalized", "number": number}
`,
    },
    typescript: {
      starter: `/** POST /v1/invoices/:id/finalize: a model-generated draft that counts numbers in the handler. */
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');
const db = new Database('invoices.db');

const SEQUENCE_KEY_PREFIX = 'inv:seq:';

const SCHEMA = \`
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  number INTEGER,
  currency TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  lines TEXT NOT NULL
)
\`;

db.exec(SCHEMA);

interface Line {
  description: string;
  quantity: number;
  unit_cents: number;
}

interface Invoice {
  id: string;
  tenant_id: string;
  status: string;
  lines: Line[];
}

function loadDraft(invoiceId: string): Invoice {
  const row = db
    .prepare('SELECT tenant_id, status, lines FROM invoices WHERE id = ?')
    .get(invoiceId) as {tenant_id: string; status: string; lines: string} | undefined;
  if (row === undefined) throw Object.assign(new Error('invoice not found'), {statusCode: 404});
  return {id: invoiceId, tenant_id: row.tenant_id, status: row.status, lines: JSON.parse(row.lines)};
}

function validateTotals(invoice: Invoice): number {
  const total = invoice.lines.reduce((sum, line) => sum + line.quantity * line.unit_cents, 0);
  if (invoice.lines.length === 0 || total <= 0)
    throw Object.assign(new Error('invoice has no billable lines'), {statusCode: 422});
  return total;
}

async function nextNumber(tenant: string): Promise<number> {
  // TODO: the counter is read and written in the handler, and the number is claimed before the
  // totals are validated. Claim inside one atomic Redis script taken after validation, guard it on
  // the draft state, reconcile the counter against the issued invoices, and let the store reject a
  // duplicate (tenant_id, number).
  const key = \`\${SEQUENCE_KEY_PREFIX}\${tenant}\`;
  const last = Number((await r.get(key)) ?? 0);
  const number = last + 1;
  await r.set(key, number);
  return number;
}

app.post('/v1/invoices/:id/finalize', async (request, reply) => {
  const {id} = request.params as {id: string};
  const tenant = request.headers['x-tenant-id'] as string;
  const invoice = loadDraft(id);
  if (invoice.status !== 'draft') return reply.code(409).send({error: 'invoice is already finalized'});
  const number = await nextNumber(tenant);
  const total = validateTotals(invoice);
  db.prepare("UPDATE invoices SET status = 'finalized', number = ?, total_cents = ? WHERE id = ?").run(
    number,
    total,
    id,
  );
  return reply.code(201).send({id, status: 'finalized', number});
});
`,
      solution: `/** POST /v1/invoices/:id/finalize: one atomic claim takes the number and moves the draft. */
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');
const db = new Database('invoices.db');

const SEQUENCE_KEY_PREFIX = 'inv:seq:';

const SCHEMA = \`
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  number INTEGER,
  currency TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  lines TEXT NOT NULL,
  UNIQUE (tenant_id, number)
)
\`;

const CLAIM_SCRIPT = \`
local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'draft' then
  return {0, tonumber(redis.call('HGET', KEYS[1], 'number') or '0')}
end
local number = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'status', 'finalized')
redis.call('HSET', KEYS[1], 'number', number)
return {1, number}
\`;

db.exec(SCHEMA);

interface Line {
  description: string;
  quantity: number;
  unit_cents: number;
}

interface Invoice {
  id: string;
  tenant_id: string;
  status: string;
  lines: Line[];
}

function sequenceKey(tenant: string): string {
  return \`inv:seq:\${tenant}\`;
}

function claimKey(invoiceId: string): string {
  return \`inv:claim:\${invoiceId}\`;
}

function loadDraft(invoiceId: string): Invoice {
  const row = db
    .prepare('SELECT tenant_id, status, lines FROM invoices WHERE id = ?')
    .get(invoiceId) as {tenant_id: string; status: string; lines: string} | undefined;
  if (row === undefined) throw Object.assign(new Error('invoice not found'), {statusCode: 404});
  return {id: invoiceId, tenant_id: row.tenant_id, status: row.status, lines: JSON.parse(row.lines)};
}

async function ensureClaim(invoiceId: string, tenant: string): Promise<void> {
  // HSETNX, not HSET: replaying finalize must not push a finalized claim back to draft.
  await r.hsetnx(claimKey(invoiceId), 'tenant', tenant);
  await r.hsetnx(claimKey(invoiceId), 'status', 'draft');
}

function validateTotals(invoice: Invoice): number {
  const total = invoice.lines.reduce((sum, line) => sum + line.quantity * line.unit_cents, 0);
  if (invoice.lines.length === 0 || total <= 0)
    throw Object.assign(new Error('invoice has no billable lines'), {statusCode: 422});
  return total;
}

async function claimNumber(tenant: string, invoiceId: string): Promise<[boolean, number]> {
  const reply = (await r.eval(CLAIM_SCRIPT, 2, claimKey(invoiceId), sequenceKey(tenant))) as [
    number,
    number,
  ];
  return [reply[0] === 1, reply[1]];
}

function persistFinal(invoiceId: string, tenant: string, number: number, total: number): void {
  try {
    db.prepare("UPDATE invoices SET status = 'finalized', number = ?, total_cents = ? WHERE id = ?").run(
      number,
      total,
      invoiceId,
    );
  } catch (error) {
    if ((error as {code?: string}).code === 'SQLITE_CONSTRAINT_UNIQUE')
      throw Object.assign(new Error(\`number \${number} already issued for tenant \${tenant}\`), {statusCode: 409});
    throw error;
  }
}

async function reconcileSequence(tenant: string): Promise<number> {
  const row = db
    .prepare('SELECT COALESCE(MAX(number), 0) AS highest FROM invoices WHERE tenant_id = ? AND number IS NOT NULL')
    .get(tenant) as {highest: number};
  const current = Number((await r.get(sequenceKey(tenant))) ?? 0);
  if (current < row.highest) {
    // Redis lost the counter: repair it upward instead of reissuing numbers already issued.
    await r.set(sequenceKey(tenant), String(row.highest));
  }
  return Math.max(current, row.highest);
}

app.post('/v1/invoices/:id/finalize', async (request, reply) => {
  const {id} = request.params as {id: string};
  const tenant = request.headers['x-tenant-id'] as string;
  const invoice = loadDraft(id);
  await ensureClaim(id, tenant);
  const total = validateTotals(invoice);
  const [claimed, number] = await claimNumber(tenant, id);
  if (!claimed) return reply.code(409).send({error: 'invoice is already finalized'});
  persistFinal(id, tenant, number, total);
  return reply.code(201).send({id, status: 'finalized', number});
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/redis/go-redis/v9"
)

const sequenceKeyPrefix = "inv:seq:"

const schema = \`
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  number INTEGER,
  currency TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  lines TEXT NOT NULL
)
\`

type Line struct {
	Description string \`json:"description"\`
	Quantity    int64  \`json:"quantity"\`
	UnitCents   int64  \`json:"unit_cents"\`
}

type Invoice struct {
	ID       string \`json:"id"\`
	TenantID string \`json:"tenant_id"\`
	Status   string \`json:"status"\`
	Lines    []Line \`json:"lines"\`
}

var (
	rdb *redis.Client
	db  *sql.DB
)

func loadDraft(ctx context.Context, invoiceID string) (*Invoice, error) {
	var (
		tenantID string
		status   string
		lines    string
	)
	err := db.QueryRowContext(ctx,
		"SELECT tenant_id, status, lines FROM invoices WHERE id = ?", invoiceID).Scan(&tenantID, &status, &lines)
	if err != nil {
		return nil, err
	}
	invoice := &Invoice{ID: invoiceID, TenantID: tenantID, Status: status}
	if err := json.Unmarshal([]byte(lines), &invoice.Lines); err != nil {
		return nil, err
	}
	return invoice, nil
}

func validateTotals(lines []Line) (int64, error) {
	var total int64
	for _, line := range lines {
		total += line.Quantity * line.UnitCents
	}
	if len(lines) == 0 || total <= 0 {
		return 0, fmt.Errorf("invoice has no billable lines")
	}
	return total, nil
}

func nextNumber(ctx context.Context, tenant string) (int64, error) {
	// TODO: the counter is read and written in the handler, and the number is claimed before the
	// totals are validated. Claim inside one atomic Redis script taken after validation, guard it on
	// the draft state, reconcile the counter against the issued invoices, and let the store reject a
	// duplicate (tenant_id, number).
	key := fmt.Sprintf("%s%s", sequenceKeyPrefix, tenant)
	last, _ := rdb.Get(ctx, key).Int64()
	number := last + 1
	rdb.Set(ctx, key, number, 0)
	return number, nil
}

func finalize(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	invoice, err := loadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		http.Error(rw, \`{"error":"invoice not found"}\`, http.StatusNotFound)
		return
	}
	if invoice.Status != "draft" {
		http.Error(rw, \`{"error":"invoice is already finalized"}\`, http.StatusConflict)
		return
	}
	number, _ := nextNumber(r.Context(), tenant)
	total, err := validateTotals(invoice.Lines)
	if err != nil {
		http.Error(rw, fmt.Sprintf(\`{"error":%q}\`, err.Error()), http.StatusUnprocessableEntity)
		return
	}
	_, _ = db.ExecContext(r.Context(),
		"UPDATE invoices SET status = 'finalized', number = ?, total_cents = ? WHERE id = ?",
		number, total, invoice.ID)
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(fmt.Sprintf(\`{"id":%q,"status":"finalized","number":%d}\`, invoice.ID, number)))
}

func main() {}
`,
      solution: `package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/mattn/go-sqlite3"
	"github.com/redis/go-redis/v9"
)

const sequenceKeyPrefix = "inv:seq:"

const schema = \`
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  number INTEGER,
  currency TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  lines TEXT NOT NULL,
  UNIQUE (tenant_id, number)
)
\`

const claimScript = \`
local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'draft' then
  return {0, tonumber(redis.call('HGET', KEYS[1], 'number') or '0')}
end
local number = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'status', 'finalized')
redis.call('HSET', KEYS[1], 'number', number)
return {1, number}
\`

type Line struct {
	Description string \`json:"description"\`
	Quantity    int64  \`json:"quantity"\`
	UnitCents   int64  \`json:"unit_cents"\`
}

type Invoice struct {
	ID       string \`json:"id"\`
	TenantID string \`json:"tenant_id"\`
	Status   string \`json:"status"\`
	Lines    []Line \`json:"lines"\`
}

var (
	rdb *redis.Client
	db  *sql.DB
)

func loadDraft(ctx context.Context, invoiceID string) (*Invoice, error) {
	var (
		tenantID string
		status   string
		lines    string
	)
	err := db.QueryRowContext(ctx,
		"SELECT tenant_id, status, lines FROM invoices WHERE id = ?", invoiceID).Scan(&tenantID, &status, &lines)
	if err != nil {
		return nil, err
	}
	invoice := &Invoice{ID: invoiceID, TenantID: tenantID, Status: status}
	if err := json.Unmarshal([]byte(lines), &invoice.Lines); err != nil {
		return nil, err
	}
	return invoice, nil
}

func sequenceKey(tenant string) string {
	return fmt.Sprintf("inv:seq:%s", tenant)
}

func claimKey(invoiceID string) string {
	return "inv:claim:" + invoiceID
}

func ensureClaim(ctx context.Context, invoiceID string, tenant string) error {
	// HSetNX, not HSet: replaying finalize must not push a finalized claim back to draft.
	if err := rdb.HSetNX(ctx, claimKey(invoiceID), "tenant", tenant).Err(); err != nil {
		return err
	}
	return rdb.HSetNX(ctx, claimKey(invoiceID), "status", "draft").Err()
}

func validateTotals(lines []Line) (int64, error) {
	var total int64
	for _, line := range lines {
		total += line.Quantity * line.UnitCents
	}
	if len(lines) == 0 || total <= 0 {
		return 0, fmt.Errorf("invoice has no billable lines")
	}
	return total, nil
}

func claimNumber(ctx context.Context, tenant string, invoiceID string) (bool, int64, error) {
	values, err := rdb.Eval(ctx, claimScript, []string{claimKey(invoiceID), sequenceKey(tenant)}).Int64Slice()
	if err != nil {
		return false, 0, err
	}
	return values[0] == 1, values[1], nil
}

func persistFinal(ctx context.Context, invoiceID string, tenant string, number int64, total int64) error {
	_, err := db.ExecContext(ctx,
		"UPDATE invoices SET status = 'finalized', number = ?, total_cents = ? WHERE id = ?",
		number, total, invoiceID)
	var constraint sqlite3.Error
	if errors.As(err, &constraint) && errors.Is(constraint, sqlite3.ErrConstraint) {
		return fmt.Errorf("number %d already issued for tenant %s: %w", number, tenant, err)
	}
	return err
}

func reconcileSequence(ctx context.Context, tenant string) (int64, error) {
	var highest int64
	err := db.QueryRowContext(ctx,
		"SELECT COALESCE(MAX(number), 0) FROM invoices WHERE tenant_id = ? AND number IS NOT NULL",
		tenant).Scan(&highest)
	if err != nil {
		return 0, err
	}
	current, _ := rdb.Get(ctx, sequenceKey(tenant)).Int64()
	if current < highest {
		// Redis lost the counter: repair it upward instead of reissuing numbers already issued.
		if err := rdb.Set(ctx, sequenceKey(tenant), highest, 0).Err(); err != nil {
			return 0, err
		}
	}
	if current > highest {
		return current, nil
	}
	return highest, nil
}

func finalize(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	invoice, err := loadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		http.Error(rw, \`{"error":"invoice not found"}\`, http.StatusNotFound)
		return
	}
	if err := ensureClaim(r.Context(), invoice.ID, tenant); err != nil {
		http.Error(rw, \`{"error":"claim store unavailable"}\`, http.StatusBadGateway)
		return
	}
	total, err := validateTotals(invoice.Lines)
	if err != nil {
		http.Error(rw, fmt.Sprintf(\`{"error":%q}\`, err.Error()), http.StatusUnprocessableEntity)
		return
	}
	claimed, number, err := claimNumber(r.Context(), tenant, invoice.ID)
	if err != nil {
		http.Error(rw, \`{"error":"claim store unavailable"}\`, http.StatusBadGateway)
		return
	}
	if !claimed {
		http.Error(rw, \`{"error":"invoice is already finalized"}\`, http.StatusConflict)
		return
	}
	if err := persistFinal(r.Context(), invoice.ID, tenant, number, total); err != nil {
		http.Error(rw, fmt.Sprintf(\`{"error":%q}\`, err.Error()), http.StatusConflict)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(fmt.Sprintf(\`{"id":%q,"status":"finalized","number":%d}\`, invoice.ID, number)))
}

func main() {}
`,
    },
    scala: {
      starter: `import java.sql.{Connection, DriverManager}

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat
import spray.json._

final case class Line(description: String, quantity: Int, unit_cents: Int)

final case class Invoice(id: String, tenant_id: String, status: String, lines: List[Line])

object InvoiceStateApi {
  implicit val system: ActorSystem = ActorSystem("invoice-service")
  implicit val lineFormat: RootJsonFormat[Line] = jsonFormat3(Line)
  implicit val linesFormat: RootJsonFormat[List[Line]] = listFormat[Line]

  val SequenceKeyPrefix = "inv:seq:"
  val jedis = new Jedis("redis", 6379)
  val db: Connection = DriverManager.getConnection("jdbc:sqlite:invoices.db")

  val Schema =
    """
      |CREATE TABLE IF NOT EXISTS invoices (
      |  id TEXT PRIMARY KEY,
      |  tenant_id TEXT NOT NULL,
      |  status TEXT NOT NULL,
      |  number INTEGER,
      |  currency TEXT NOT NULL,
      |  total_cents INTEGER NOT NULL,
      |  lines TEXT NOT NULL
      |)
      |""".stripMargin

  db.createStatement().execute(Schema)

  def loadDraft(invoiceId: String): Invoice = {
    val rs = db
      .createStatement()
      .executeQuery(s"SELECT tenant_id, status, lines FROM invoices WHERE id = '$invoiceId'")
    if (!rs.next()) throw new NoSuchElementException(s"invoice $invoiceId not found")
    Invoice(invoiceId, rs.getString(1), rs.getString(2), rs.getString(3).parseJson.convertTo[List[Line]])
  }

  def validateTotals(lines: List[Line]): Long = {
    val total = lines.map(line => line.quantity.toLong * line.unit_cents).sum
    if (lines.isEmpty || total <= 0) throw new IllegalArgumentException("invoice has no billable lines")
    total
  }

  def nextNumber(tenant: String): Long = {
    // TODO: the counter is read and written in the handler, and the number is claimed before the
    // totals are validated. Claim inside one atomic Redis script taken after validation, guard it on
    // the draft state, reconcile the counter against the issued invoices, and let the store reject a
    // duplicate (tenant_id, number).
    val key = s"$SequenceKeyPrefix$tenant"
    val last = Option(jedis.get(key)).map(_.toLong).getOrElse(0L)
    val number = last + 1
    jedis.set(key, number.toString)
    number
  }

  val route: Route =
    path("v1" / "invoices" / Segment / "finalize") { invoiceId =>
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          val invoice = loadDraft(invoiceId)
          if (invoice.status != "draft") {
            complete(StatusCodes.Conflict, """{"error":"invoice is already finalized"}""")
          } else {
            val number = nextNumber(tenant)
            val total = validateTotals(invoice.lines)
            db.createStatement().execute(
              s"UPDATE invoices SET status = 'finalized', number = $number, total_cents = $total WHERE id = '$invoiceId'"
            )
            complete(StatusCodes.Created, s"""{"id":"$invoiceId","status":"finalized","number":$number}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.sql.{Connection, DriverManager}

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat
import spray.json._

final case class Line(description: String, quantity: Int, unit_cents: Int)

final case class Invoice(id: String, tenant_id: String, status: String, lines: List[Line])

object InvoiceStateApi {
  implicit val system: ActorSystem = ActorSystem("invoice-service")
  implicit val lineFormat: RootJsonFormat[Line] = jsonFormat3(Line)
  implicit val linesFormat: RootJsonFormat[List[Line]] = listFormat[Line]

  val SequenceKeyPrefix = "inv:seq:"
  val jedis = new Jedis("redis", 6379)
  val db: Connection = DriverManager.getConnection("jdbc:sqlite:invoices.db")

  val Schema =
    """
      |CREATE TABLE IF NOT EXISTS invoices (
      |  id TEXT PRIMARY KEY,
      |  tenant_id TEXT NOT NULL,
      |  status TEXT NOT NULL,
      |  number INTEGER,
      |  currency TEXT NOT NULL,
      |  total_cents INTEGER NOT NULL,
      |  lines TEXT NOT NULL,
      |  UNIQUE (tenant_id, number)
      |)
      |""".stripMargin

  val ClaimScript =
    """
      |local status = redis.call('HGET', KEYS[1], 'status')
      |if status ~= 'draft' then
      |  return {0, tonumber(redis.call('HGET', KEYS[1], 'number') or '0')}
      |end
      |local number = redis.call('INCR', KEYS[2])
      |redis.call('HSET', KEYS[1], 'status', 'finalized')
      |redis.call('HSET', KEYS[1], 'number', number)
      |return {1, number}
      |""".stripMargin

  db.createStatement().execute(Schema)

  def loadDraft(invoiceId: String): Invoice = {
    val rs = db
      .createStatement()
      .executeQuery(s"SELECT tenant_id, status, lines FROM invoices WHERE id = '$invoiceId'")
    if (!rs.next()) throw new NoSuchElementException(s"invoice $invoiceId not found")
    Invoice(invoiceId, rs.getString(1), rs.getString(2), rs.getString(3).parseJson.convertTo[List[Line]])
  }

  def ensureClaim(invoiceId: String, tenant: String): Unit = {
    // HSETNX, not HSET: replaying finalize must not push a finalized claim back to draft.
    jedis.hsetnx(s"inv:claim:$invoiceId", "tenant", tenant)
    jedis.hsetnx(s"inv:claim:$invoiceId", "status", "draft")
  }

  def validateTotals(lines: List[Line]): Long = {
    val total = lines.map(line => line.quantity.toLong * line.unit_cents).sum
    if (lines.isEmpty || total <= 0) throw new IllegalArgumentException("invoice has no billable lines")
    total
  }

  def claimNumber(tenant: String, invoiceId: String): (Boolean, Long) = {
    val result = jedis
      .eval(ClaimScript, 2, s"inv:claim:$invoiceId", s"inv:seq:$tenant")
      .asInstanceOf[java.util.List[Long]]
    (result.get(0) == 1L, result.get(1))
  }

  def persistFinal(invoiceId: String, tenant: String, number: Long, total: Long): Unit = {
    try {
      db.createStatement().execute(
        s"UPDATE invoices SET status = 'finalized', number = $number, total_cents = $total WHERE id = '$invoiceId'"
      )
    } catch {
      case conflict: java.sql.SQLIntegrityConstraintViolationException =>
        throw new IllegalStateException(
          s"number $number already issued for tenant $tenant: " + conflict.getMessage
        )
    }
  }

  def reconcileSequence(tenant: String): Long = {
    val rs = db.createStatement().executeQuery(
      s"SELECT COALESCE(MAX(number), 0) FROM invoices WHERE tenant_id = '$tenant' AND number IS NOT NULL"
    )
    rs.next()
    val highest = rs.getLong(1)
    val current = Option(jedis.get(s"inv:seq:$tenant")).map(_.toLong).getOrElse(0L)
    if (current < highest) {
      // Redis lost the counter: repair it upward instead of reissuing numbers already issued.
      jedis.set(s"inv:seq:$tenant", highest.toString)
    }
    math.max(current, highest)
  }

  val route: Route =
    path("v1" / "invoices" / Segment / "finalize") { invoiceId =>
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          try {
            val invoice = loadDraft(invoiceId)
            ensureClaim(invoiceId, tenant)
            val total = validateTotals(invoice.lines)
            val (claimed, number) = claimNumber(tenant, invoiceId)
            if (!claimed) {
              complete(StatusCodes.Conflict, """{"error":"invoice is already finalized"}""")
            } else {
              persistFinal(invoiceId, tenant, number, total)
              complete(StatusCodes.Created, s"""{"id":"$invoiceId","status":"finalized","number":$number}""")
            }
          } catch {
            case rejection: IllegalArgumentException =>
              complete(StatusCodes.UnprocessableEntity, s"""{"error":"\${rejection.getMessage}"}""")
            case missing: NoSuchElementException =>
              complete(StatusCodes.NotFound, s"""{"error":"\${missing.getMessage}"}""")
            case conflict: IllegalStateException =>
              complete(StatusCodes.Conflict, s"""{"error":"\${conflict.getMessage}"}""")
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
#include <sqlite3.h>
#include <sw/redis++/redis++.h>

#include <stdexcept>
#include <string>

using json = nlohmann::json;

constexpr const char* kSequenceKeyPrefix = "inv:seq:";

const char* kSchema = R"SQL(
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  number INTEGER,
  currency TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  lines TEXT NOT NULL
)
)SQL";

json loadDraft(sqlite3* db, const std::string& invoiceId) {
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db, "SELECT tenant_id, status, lines FROM invoices WHERE id = ?", -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, invoiceId.c_str(), -1, SQLITE_TRANSIENT);
  json invoice = json::object();
  if (sqlite3_step(stmt) == SQLITE_ROW) {
    invoice["id"] = invoiceId;
    invoice["tenant_id"] = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
    invoice["status"] = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
    invoice["lines"] = json::parse(reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2)));
  }
  sqlite3_finalize(stmt);
  return invoice;
}

long long validateTotals(const json& lines) {
  long long total = 0;
  for (const auto& line : lines) total += line["quantity"].get<long long>() * line["unit_cents"].get<long long>();
  if (lines.empty() || total <= 0) throw std::runtime_error("invoice has no billable lines");
  return total;
}

long long nextNumber(sw::redis::Redis& redis, const std::string& tenant) {
  // TODO: the counter is read and written in the handler, and the number is claimed before the
  // totals are validated. Claim inside one atomic Redis script taken after validation, guard it on
  // the draft state, reconcile the counter against the issued invoices, and let the store reject a
  // duplicate (tenant_id, number).
  const auto key = std::string(kSequenceKeyPrefix) + tenant;
  const auto last = redis.get(key);
  const long long number = (last ? std::stoll(*last) : 0) + 1;
  redis.set(key, std::to_string(number));
  return number;
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  sqlite3* db = nullptr;
  sqlite3_open("invoices.db", &db);
  sqlite3_exec(db, kSchema, nullptr, nullptr, nullptr);

  httplib::Server svr;
  svr.Post(R"(/v1/invoices/([^/]+)/finalize)", [&redis, db](const httplib::Request& req, httplib::Response& res) {
    const auto invoiceId = std::string(req.matches[1]);
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto invoice = loadDraft(db, invoiceId);
    if (invoice.empty()) {
      res.status = 404;
      res.set_content(R"({"error":"invoice not found"})", "application/json");
      return;
    }
    try {
      const long long number = nextNumber(redis, tenant);
      const long long total = validateTotals(invoice["lines"]);
      const auto sql = "UPDATE invoices SET status = 'finalized', number = " + std::to_string(number) +
                       ", total_cents = " + std::to_string(total) + " WHERE id = '" + invoiceId + "'";
      sqlite3_exec(db, sql.c_str(), nullptr, nullptr, nullptr);
      res.status = 201;
      res.set_content(json{{"id", invoiceId}, {"status", "finalized"}, {"number", number}}.dump(),
                      "application/json");
    } catch (const std::exception& error) {
      res.status = 422;
      res.set_content(json{{"error", error.what()}}.dump(), "application/json");
    }
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

constexpr const char* kSequenceKeyPrefix = "inv:seq:";

const char* kSchema = R"SQL(
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  number INTEGER,
  currency TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  lines TEXT NOT NULL,
  UNIQUE (tenant_id, number)
)
)SQL";

const char* kClaimScript = R"LUA(
local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'draft' then
  return {0, tonumber(redis.call('HGET', KEYS[1], 'number') or '0')}
end
local number = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'status', 'finalized')
redis.call('HSET', KEYS[1], 'number', number)
return {1, number}
)LUA";

json loadDraft(sqlite3* db, const std::string& invoiceId) {
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db, "SELECT tenant_id, status, lines FROM invoices WHERE id = ?", -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, invoiceId.c_str(), -1, SQLITE_TRANSIENT);
  json invoice = json::object();
  if (sqlite3_step(stmt) == SQLITE_ROW) {
    invoice["id"] = invoiceId;
    invoice["tenant_id"] = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
    invoice["status"] = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
    invoice["lines"] = json::parse(reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2)));
  }
  sqlite3_finalize(stmt);
  return invoice;
}

std::string sequenceKey(const std::string& tenant) {
  return std::string("inv:seq:") + tenant;
}

std::string claimKey(const std::string& invoiceId) {
  return "inv:claim:" + invoiceId;
}

void ensureClaim(sw::redis::Redis& redis, const std::string& invoiceId, const std::string& tenant) {
  // HSETNX, not HSET: replaying finalize must not push a finalized claim back to draft.
  redis.hsetnx(claimKey(invoiceId), "tenant", tenant);
  redis.hsetnx(claimKey(invoiceId), "status", "draft");
}

long long validateTotals(const json& lines) {
  long long total = 0;
  for (const auto& line : lines) total += line["quantity"].get<long long>() * line["unit_cents"].get<long long>();
  if (lines.empty() || total <= 0) throw std::runtime_error("invoice has no billable lines");
  return total;
}

std::pair<bool, long long> claimNumber(
    sw::redis::Redis& redis,
    const std::string& tenant,
    const std::string& invoiceId) {
  const auto result = redis.eval<std::vector<long long>>(kClaimScript, {claimKey(invoiceId), sequenceKey(tenant)}, {});
  return {result[0] == 1, result[1]};
}

void persistFinal(
    sqlite3* db,
    const std::string& invoiceId,
    const std::string& tenant,
    long long number,
    long long total) {
  const auto sql = "UPDATE invoices SET status = 'finalized', number = " + std::to_string(number) +
                   ", total_cents = " + std::to_string(total) + " WHERE id = '" + invoiceId + "'";
  char* error = nullptr;
  if (sqlite3_exec(db, sql.c_str(), nullptr, nullptr, &error) != SQLITE_OK) {
    const std::string message = error == nullptr ? std::string("constraint violation") : std::string(error);
    sqlite3_free(error);
    if (message.find("UNIQUE constraint failed") != std::string::npos) {
      throw std::runtime_error("number " + std::to_string(number) + " already issued for tenant " + tenant);
    }
    throw std::runtime_error(message);
  }
}

long long reconcileSequence(sw::redis::Redis& redis, sqlite3* db, const std::string& tenant) {
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(
      db,
      "SELECT COALESCE(MAX(number), 0) FROM invoices WHERE tenant_id = ? AND number IS NOT NULL",
      -1,
      &stmt,
      nullptr);
  sqlite3_bind_text(stmt, 1, tenant.c_str(), -1, SQLITE_TRANSIENT);
  long long highest = 0;
  if (sqlite3_step(stmt) == SQLITE_ROW) highest = sqlite3_column_int64(stmt, 0);
  sqlite3_finalize(stmt);
  const auto raw = redis.get(sequenceKey(tenant));
  const long long current = raw ? std::stoll(*raw) : 0;
  if (current < highest) {
    // Redis lost the counter: repair it upward instead of reissuing numbers already issued.
    redis.set(sequenceKey(tenant), std::to_string(highest));
  }
  return std::max(current, highest);
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  sqlite3* db = nullptr;
  sqlite3_open("invoices.db", &db);
  sqlite3_exec(db, kSchema, nullptr, nullptr, nullptr);

  httplib::Server svr;
  svr.Post(R"(/v1/invoices/([^/]+)/finalize)", [&redis, db](const httplib::Request& req, httplib::Response& res) {
    const auto invoiceId = std::string(req.matches[1]);
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto invoice = loadDraft(db, invoiceId);
    if (invoice.empty()) {
      res.status = 404;
      res.set_content(R"({"error":"invoice not found"})", "application/json");
      return;
    }
    try {
      ensureClaim(redis, invoiceId, tenant);
      const long long total = validateTotals(invoice["lines"]);
      const auto [claimed, number] = claimNumber(redis, tenant, invoiceId);
      if (!claimed) {
        res.status = 409;
        res.set_content(R"({"error":"invoice is already finalized"})", "application/json");
        return;
      }
      persistFinal(db, invoiceId, tenant, number, total);
      res.status = 201;
      res.set_content(json{{"id", invoiceId}, {"status", "finalized"}, {"number", number}}.dump(),
                      "application/json");
    } catch (const std::exception& error) {
      res.status = 422;
      res.set_content(json{{"error", error.what()}}.dump(), "application/json");
    }
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question behind this step is what "gapless numbering" costs. A counter in Redis looks like a one-liner until two finalizes arrive at once: read-modify-write in the handler gives both of them the same number, and the sequence is only gapless if the claim is also the transition — one script reads the draft state, refuses anything already finalized, takes the number with \`INCR\` and writes \`finalized\` on the same key, so Redis's single-threaded execution orders the claims for you. The second half is ordering: a claim taken before \`validate_totals\` burns a number on every rejection, and a burned number is invisible — the sequence stays monotonic while the invoices have a hole, which is exactly what an auditor looks for. Reconcile closes the remaining failure: Redis can lose the counter, so \`reconcile_sequence\` lifts it to \`MAX(number)\` of the tenant's issued invoices instead of restarting at one, and \`UNIQUE (tenant_id, number)\` makes a duplicate impossible to persist even if both of those guards are wrong. Real billing systems add per-tenant number formats and fiscal-year resets, reservation of ranges so a whole batch can be numbered without a round trip each, and an audit table of every claimed number so a gap can be explained rather than merely detected.`,
};
