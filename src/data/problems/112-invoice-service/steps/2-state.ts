import type {Step} from '@/lib/types';

export const invoiceStateStep: Step = {
  id: 'state',
  title: 'Redis gapless numbering with atomic claim',
  concept: 'redis',
  guides: ['atomic-state'],
  file: 'state',
  focus: ['api', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter is the numbering every finalize path shares:
\`claim_number(tenant, invoice_id)\` reads the invoice's \`status\` (\`HGET\`), \`GET\`s the counter
\`invoice:seq\`, adds one in the client, \`SET\`s it back and writes \`status\` \`finalized\` and the
number on \`invoice:{id}\`; \`finalize_invoice(tenant, invoice_id)\` claims a number, then runs
\`validate_totals\` and, on a rejection, reopens the invoice (\`store.reopen\`) and raises
\`InvoiceRejected\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** Every tenant draws from one counter, so a seller's invoice
numbers jump; two finalizes racing read the same last number and two invoices share it; a finalize
racing another on the same invoice spends a second number; and a rejected invoice leaves a hole in
the series.

- The counter is per tenant: \`seq_key(tenant)\` is \`invoice:seq:{tenant}\`.
- The claim is **one Lua script** (\`CLAIM_LUA\`, run with \`EVAL\`): it reads the invoice's
  \`status\` and answers \`0\` unless it is \`draft\`, \`INCR\`s the tenant's counter and \`HSET\`s
  \`status\` \`finalized\` and the number, so nothing runs between the read and the writes.
  \`claim_number\` answers \`None\` for a non-draft.
- \`finalize_invoice\` runs \`validate_totals\` **before** \`claim_number\`: a rejection raises
  \`InvoiceRejected\` with no number claimed.`,
  sequence: {
    participants: ['Finalize path', 'Redis'],
    messages: [
      {
        from: 'Finalize path',
        to: 'Finalize path',
        label: 'validate_totals(invoice) → InvoiceRejected, nothing claimed',
        kind: 'sync',
      },
      {
        from: 'Finalize path',
        to: 'Redis',
        label: 'EVAL CLAIM_LUA · KEYS invoice:{id}, invoice:seq:{tenant}',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Redis', label: 'HGET status ≠ draft → 0 · INCR · HSET finalized, number', kind: 'sync'},
      {from: 'Redis', to: 'Finalize path', label: 'number · 0 when no longer a draft', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'sequence-key',
      title: 'Numbers each tenant from its own counter',
      detail:
        "The counter key is `invoice:seq:{tenant}` (`seq_key`/`seqKey`); one shared `invoice:seq` makes every seller's series jump whenever another seller issues an invoice.",
      match: {
        python: {all: [/f["']invoice:seq:\{tenant\}["']/], none: [/["']invoice:seq["']/]},
        typescript: {all: [/invoice:seq:\$\{tenant\}/], none: [/['"]invoice:seq['"]/]},
        go: {all: [/"invoice:seq:"\s*\+\s*tenant/], none: [/"invoice:seq"/]},
        scala: {all: [/s"invoice:seq:\$tenant"/], none: [/"invoice:seq"/]},
        cpp: {all: [/"invoice:seq:"\s*\+\s*tenant/], none: [/"invoice:seq"/]},
      },
    },
    {
      id: 'atomic-claim',
      title: 'Takes the next number with INCR inside one script',
      detail:
        'The number comes from `INCR` inside the claim script (`register_script`/`eval`, `defineCommand`, `NewScript`, `jedis.eval`, `redis.eval`), never from a `GET` and a `SET` in the client, between which another finalize reads the same last number.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]INCR['"]/],
          none: [/\br\.get\(/, /\br\.set\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]INCR['"]/],
          none: [/redis\.get\(/, /redis\.set\(/],
        },
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]INCR['"]/], none: [/rdb\.Get\(/, /rdb\.Set\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]INCR['"]/], none: [/jedis\.get\(/, /jedis\.set\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]INCR['"]/], none: [/redis\.get\(/, /redis\.set\(/]},
      },
    },
    {
      id: 'status-in-claim',
      title: 'Checks the draft status inside the claim',
      detail:
        "The script reads `status` itself (`redis.call('HGET', KEYS[1], 'status')`) and answers 0 for a non-draft; a status read in the client is a separate command, and a finalize of the same invoice landing after it spends a second number.",
      match: {
        python: {all: [/redis\.call\(\s*['"]HGET['"][^)\n]*status/], none: [/\.hget\(/i]},
        typescript: {all: [/redis\.call\(\s*['"]HGET['"][^)\n]*status/], none: [/\.hget\(/i]},
        go: {all: [/redis\.call\(\s*['"]HGET['"][^)\n]*status/], none: [/\.HGet\(/]},
        scala: {all: [/redis\.call\(\s*['"]HGET['"][^)\n]*status/], none: [/\.hget\(/i]},
        cpp: {all: [/redis\.call\(\s*['"]HGET['"][^)\n]*status/], none: [/\.hget\(/i]},
      },
    },
    {
      id: 'no-burn',
      title: 'Validates before it claims a number',
      detail:
        '`finalize_invoice`/`finalizeInvoice` runs `validate_totals`/`validateTotals` before the claim and raises `InvoiceRejected` with no number taken; claiming first and reopening on a rejection leaves a hole in the series.',
      match: {
        python: {order: [/def finalize_invoice\(/, /validate_totals\(/, /claim_number\(/], none: [/store\.reopen\(/]},
        typescript: {order: [/function finalizeInvoice\(/, /validateTotals\(/, /claimNumber\(/], none: [/\breopen\(/]},
        go: {order: [/func finalizeInvoice\(/, /validateTotals\(/, /claimNumber\(/], none: [/store\.Reopen\(/]},
        scala: {order: [/def finalizeInvoice\(/, /validateTotals\(/, /claimNumber\(/], none: [/Store\.reopen\(/]},
        cpp: {order: [/long finalizeInvoice\(/, /validateTotals\(/, /claimNumber\(/], none: [/store::reopen\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from invoice import store  # store.get, invoice_key, subtotal, reopen

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SEQ_KEY = "invoice:seq"


class InvoiceRejected(Exception):
    """The invoice cannot be issued as it stands: the message says why."""


def claim_number(tenant: str, invoice_id: str) -> int | None:
    """The invoice's number, claimed and written with status finalized; None when it is no longer a draft."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    key = store.invoice_key(invoice_id)
    if r.hget(key, "status") != "draft":
        return None
    n = int(r.get(SEQ_KEY) or 0) + 1
    r.set(SEQ_KEY, n)
    r.hset(key, mapping={"status": "finalized", "number": n})
    return n


def validate_totals(invoice: dict) -> str | None:
    """Why the invoice cannot be issued, or None."""
    if not invoice["line_items"]:
        return "an invoice with no line items cannot be finalized"
    if invoice["subtotal_cents"] != store.subtotal(invoice["line_items"]):
        return "the subtotal does not match the line items"
    return None


def finalize_invoice(tenant: str, invoice_id: str) -> int | None:
    """Issue the tenant's draft: its number, or None when it is no longer a draft. Raises InvoiceRejected."""
    invoice = store.get(invoice_id)
    if invoice is None or invoice["tenant_id"] != tenant:
        raise InvoiceRejected(f"no invoice {invoice_id}")
    n = claim_number(tenant, invoice_id)
    if n is None:
        return None
    reason = validate_totals(invoice)
    if reason is not None:
        store.reopen(invoice_id)  # back to a draft the issuer can fix
        raise InvoiceRejected(reason)
    return n
`,
      solution: `import redis

from invoice import store  # store.get, invoice_key, subtotal, reopen

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# Refuses an invoice that is no longer a draft (0), else takes the tenant's next number and finalizes
# the invoice. Redis runs the script whole: no other client lands between the read and the writes.
CLAIM_LUA = """
if redis.call('HGET', KEYS[1], 'status') ~= 'draft' then return 0 end
local n = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'status', 'finalized', 'number', n)
return n
"""
claim = r.register_script(CLAIM_LUA)


class InvoiceRejected(Exception):
    """The invoice cannot be issued as it stands: the message says why."""


def seq_key(tenant: str) -> str:
    return f"invoice:seq:{tenant}"


def claim_number(tenant: str, invoice_id: str) -> int | None:
    """The invoice's number, claimed and written with status finalized; None when it is no longer a draft."""
    n = claim(keys=[store.invoice_key(invoice_id), seq_key(tenant)])
    return int(n) if n else None


def validate_totals(invoice: dict) -> str | None:
    """Why the invoice cannot be issued, or None."""
    if not invoice["line_items"]:
        return "an invoice with no line items cannot be finalized"
    if invoice["subtotal_cents"] != store.subtotal(invoice["line_items"]):
        return "the subtotal does not match the line items"
    return None


def finalize_invoice(tenant: str, invoice_id: str) -> int | None:
    """Issue the tenant's draft: its number, or None when it is no longer a draft. Raises InvoiceRejected."""
    invoice = store.get(invoice_id)
    if invoice is None or invoice["tenant_id"] != tenant:
        raise InvoiceRejected(f"no invoice {invoice_id}")
    # Validate first: a number claimed for a rejected invoice is a hole in the tenant's series.
    reason = validate_totals(invoice)
    if reason is not None:
        raise InvoiceRejected(reason)
    return claim_number(tenant, invoice_id)
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {type Invoice, get, invoiceKey, reopen, subtotal} from 'invoice/store';

const redis = new Redis({host: 'redis', port: 6379});

export const SEQ_KEY = 'invoice:seq';

/** The invoice cannot be issued as it stands: the message says why. */
export class InvoiceRejected extends Error {}

/** The invoice's number, claimed and written with status finalized; null when it is no longer a draft. */
export async function claimNumber(tenant: string, invoiceId: string): Promise<number | null> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const key = invoiceKey(invoiceId);
  if ((await redis.hget(key, 'status')) !== 'draft') return null;
  const n = Number((await redis.get(SEQ_KEY)) ?? 0) + 1;
  await redis.set(SEQ_KEY, n);
  await redis.hset(key, {status: 'finalized', number: String(n)});
  return n;
}

/** Why the invoice cannot be issued, or null. */
export function validateTotals(invoice: Invoice): string | null {
  if (invoice.line_items.length === 0) return 'an invoice with no line items cannot be finalized';
  if (invoice.subtotal_cents !== subtotal(invoice.line_items)) return 'the subtotal does not match the line items';
  return null;
}

/** Issue the tenant's draft: its number, or null when it is no longer a draft. Throws InvoiceRejected. */
export async function finalizeInvoice(tenant: string, invoiceId: string): Promise<number | null> {
  const invoice = await get(invoiceId);
  if (invoice === null || invoice.tenant_id !== tenant) throw new InvoiceRejected(\`no invoice \${invoiceId}\`);
  const n = await claimNumber(tenant, invoiceId);
  if (n === null) return null;
  const reason = validateTotals(invoice);
  if (reason !== null) {
    await reopen(invoiceId); // back to a draft the issuer can fix
    throw new InvoiceRejected(reason);
  }
  return n;
}
`,
      solution: `import Redis from 'ioredis';

import {type Invoice, get, invoiceKey, reopen, subtotal} from 'invoice/store';

// Refuses an invoice that is no longer a draft (0), else takes the tenant's next number and finalizes
// the invoice. Redis runs the script whole: no other client lands between the read and the writes.
export const CLAIM_LUA = \`
if redis.call('HGET', KEYS[1], 'status') ~= 'draft' then return 0 end
local n = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'status', 'finalized', 'number', n)
return n
\`;

interface ClaimRedis extends Redis {
  claim(invoiceKey: string, seqKey: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ClaimRedis;
redis.defineCommand('claim', {numberOfKeys: 2, lua: CLAIM_LUA});

/** The invoice cannot be issued as it stands: the message says why. */
export class InvoiceRejected extends Error {}

export const seqKey = (tenant: string): string => \`invoice:seq:\${tenant}\`;

/** The invoice's number, claimed and written with status finalized; null when it is no longer a draft. */
export async function claimNumber(tenant: string, invoiceId: string): Promise<number | null> {
  const n = Number(await redis.claim(invoiceKey(invoiceId), seqKey(tenant)));
  return n > 0 ? n : null;
}

/** Why the invoice cannot be issued, or null. */
export function validateTotals(invoice: Invoice): string | null {
  if (invoice.line_items.length === 0) return 'an invoice with no line items cannot be finalized';
  if (invoice.subtotal_cents !== subtotal(invoice.line_items)) return 'the subtotal does not match the line items';
  return null;
}

/** Issue the tenant's draft: its number, or null when it is no longer a draft. Throws InvoiceRejected. */
export async function finalizeInvoice(tenant: string, invoiceId: string): Promise<number | null> {
  const invoice = await get(invoiceId);
  if (invoice === null || invoice.tenant_id !== tenant) throw new InvoiceRejected(\`no invoice \${invoiceId}\`);
  // Validate first: a number claimed for a rejected invoice is a hole in the tenant's series.
  const reason = validateTotals(invoice);
  if (reason !== null) throw new InvoiceRejected(reason);
  return claimNumber(tenant, invoiceId);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"fmt"

	"github.com/redis/go-redis/v9"

	"invoice/store" // store.Get, InvoiceKey, Subtotal, Reopen
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const seqName = "invoice:seq"

// ErrInvoiceRejected: the invoice cannot be issued as it stands.
var ErrInvoiceRejected = errors.New("invoice rejected")

// claimNumber is the invoice's number, claimed and written with status finalized; 0 when it is no
// longer a draft.
func claimNumber(ctx context.Context, tenant, invoiceID string) (int64, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	key := store.InvoiceKey(invoiceID)
	if rdb.HGet(ctx, key, "status").Val() != "draft" {
		return 0, nil
	}
	n, _ := rdb.Get(ctx, seqName).Int64()
	n++
	if err := rdb.Set(ctx, seqName, n, 0).Err(); err != nil {
		return 0, err
	}
	return n, rdb.HSet(ctx, key, "status", "finalized", "number", n).Err()
}

// validateTotals is why the invoice cannot be issued, or "".
func validateTotals(invoice *store.Invoice) string {
	if len(invoice.LineItems) == 0 {
		return "an invoice with no line items cannot be finalized"
	}
	if invoice.SubtotalCents != store.Subtotal(invoice.LineItems) {
		return "the subtotal does not match the line items"
	}
	return ""
}

// finalizeInvoice issues the tenant's draft: its number, or 0 when it is no longer a draft. A
// rejection wraps ErrInvoiceRejected.
func finalizeInvoice(ctx context.Context, tenant, invoiceID string) (int64, error) {
	invoice := store.Get(ctx, invoiceID)
	if invoice == nil || invoice.TenantID != tenant {
		return 0, fmt.Errorf("%w: no invoice %s", ErrInvoiceRejected, invoiceID)
	}
	n, err := claimNumber(ctx, tenant, invoiceID)
	if err != nil || n == 0 {
		return 0, err
	}
	if reason := validateTotals(invoice); reason != "" {
		store.Reopen(ctx, invoiceID) // back to a draft the issuer can fix
		return 0, fmt.Errorf("%w: %s", ErrInvoiceRejected, reason)
	}
	return n, nil
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"

	"github.com/redis/go-redis/v9"

	"invoice/store" // store.Get, InvoiceKey, Subtotal, Reopen
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// claim refuses an invoice that is no longer a draft (0), else takes the tenant's next number and
// finalizes the invoice. Redis runs the script whole: no other client lands between the read and
// the writes.
var claim = redis.NewScript(\`
if redis.call('HGET', KEYS[1], 'status') ~= 'draft' then return 0 end
local n = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'status', 'finalized', 'number', n)
return n
\`)

// ErrInvoiceRejected: the invoice cannot be issued as it stands.
var ErrInvoiceRejected = errors.New("invoice rejected")

func seqKey(tenant string) string { return "invoice:seq:" + tenant }

// claimNumber is the invoice's number, claimed and written with status finalized; 0 when it is no
// longer a draft.
func claimNumber(ctx context.Context, tenant, invoiceID string) (int64, error) {
	return claim.Run(ctx, rdb, []string{store.InvoiceKey(invoiceID), seqKey(tenant)}).Int64()
}

// validateTotals is why the invoice cannot be issued, or "".
func validateTotals(invoice *store.Invoice) string {
	if len(invoice.LineItems) == 0 {
		return "an invoice with no line items cannot be finalized"
	}
	if invoice.SubtotalCents != store.Subtotal(invoice.LineItems) {
		return "the subtotal does not match the line items"
	}
	return ""
}

// finalizeInvoice issues the tenant's draft: its number, or 0 when it is no longer a draft. A
// rejection wraps ErrInvoiceRejected.
func finalizeInvoice(ctx context.Context, tenant, invoiceID string) (int64, error) {
	invoice := store.Get(ctx, invoiceID)
	if invoice == nil || invoice.TenantID != tenant {
		return 0, fmt.Errorf("%w: no invoice %s", ErrInvoiceRejected, invoiceID)
	}
	// Validate first: a number claimed for a rejected invoice is a hole in the tenant's series.
	if reason := validateTotals(invoice); reason != "" {
		return 0, fmt.Errorf("%w: %s", ErrInvoiceRejected, reason)
	}
	return claimNumber(ctx, tenant, invoiceID)
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import invoice.Store // Store.get, invoiceKey, subtotal, reopen

/** The invoice cannot be issued as it stands: the message says why. */
final class InvoiceRejected(message: String) extends Exception(message)

object State {
  val jedis = new JedisPooled("redis", 6379)

  val SeqKey = "invoice:seq"

  /** The invoice's number, claimed and written with status finalized; None when it is no longer a draft. */
  def claimNumber(tenant: String, invoiceId: String): Option[Long] = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val key = Store.invoiceKey(invoiceId)
    if (jedis.hget(key, "status") != "draft") None
    else {
      val n = Option(jedis.get(SeqKey)).map(_.toLong).getOrElse(0L) + 1
      jedis.set(SeqKey, n.toString)
      jedis.hset(key, Map("status" -> "finalized", "number" -> n.toString).asJava)
      Some(n)
    }
  }

  /** Why the invoice cannot be issued, if it cannot. */
  def validateTotals(invoice: Store.Invoice): Option[String] =
    if (invoice.lineItems.isEmpty) Some("an invoice with no line items cannot be finalized")
    else if (invoice.subtotalCents != Store.subtotal(invoice.lineItems)) Some("the subtotal does not match the line items")
    else None

  /** Issue the tenant's draft: its number, or None when it is no longer a draft. Throws InvoiceRejected. */
  def finalizeInvoice(tenant: String, invoiceId: String): Option[Long] = {
    val invoice = Store.get(invoiceId).filter(_.tenantId == tenant).getOrElse(throw new InvoiceRejected(s"no invoice $invoiceId"))
    val n = claimNumber(tenant, invoiceId)
    if (n.isDefined) validateTotals(invoice).foreach { reason =>
      Store.reopen(invoiceId) // back to a draft the issuer can fix
      throw new InvoiceRejected(reason)
    }
    n
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import invoice.Store // Store.get, invoiceKey, subtotal, reopen

/** The invoice cannot be issued as it stands: the message says why. */
final class InvoiceRejected(message: String) extends Exception(message)

object State {
  val jedis = new JedisPooled("redis", 6379)

  /**
   * Refuses an invoice that is no longer a draft (0), else takes the tenant's next number and
   * finalizes the invoice. Redis runs the script whole: no other client lands between the read and
   * the writes.
   */
  val ClaimLua: String =
    """if redis.call('HGET', KEYS[1], 'status') ~= 'draft' then return 0 end
      |local n = redis.call('INCR', KEYS[2])
      |redis.call('HSET', KEYS[1], 'status', 'finalized', 'number', n)
      |return n
      |""".stripMargin

  def seqKey(tenant: String): String = s"invoice:seq:$tenant"

  /** The invoice's number, claimed and written with status finalized; None when it is no longer a draft. */
  def claimNumber(tenant: String, invoiceId: String): Option[Long] = {
    val keys = List(Store.invoiceKey(invoiceId), seqKey(tenant)).asJava
    val n = jedis.eval(ClaimLua, keys, List.empty[String].asJava).asInstanceOf[java.lang.Long].longValue
    if (n > 0) Some(n) else None
  }

  /** Why the invoice cannot be issued, if it cannot. */
  def validateTotals(invoice: Store.Invoice): Option[String] =
    if (invoice.lineItems.isEmpty) Some("an invoice with no line items cannot be finalized")
    else if (invoice.subtotalCents != Store.subtotal(invoice.lineItems)) Some("the subtotal does not match the line items")
    else None

  /** Issue the tenant's draft: its number, or None when it is no longer a draft. Throws InvoiceRejected. */
  def finalizeInvoice(tenant: String, invoiceId: String): Option[Long] = {
    val invoice = Store.get(invoiceId).filter(_.tenantId == tenant).getOrElse(throw new InvoiceRejected(s"no invoice $invoiceId"))
    // Validate first: a number claimed for a rejected invoice is a hole in the tenant's series.
    validateTotals(invoice).foreach(reason => throw new InvoiceRejected(reason))
    claimNumber(tenant, invoiceId)
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <stdexcept>
#include <string>

#include "invoice/store.h"  // store::get, invoiceKey, subtotal, reopen

sw::redis::Redis redis("tcp://redis:6379");

const std::string kSeqKey = "invoice:seq";

// The invoice cannot be issued as it stands: the message says why.
struct InvoiceRejected : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// The invoice's number, claimed and written with status finalized; 0 when it is no longer a draft.
long claimNumber(const std::string& tenant, const std::string& invoice_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string key = store::invoiceKey(invoice_id);
  if (redis.hget(key, "status").value_or("") != "draft") return 0;
  const auto last = redis.get(kSeqKey);
  const long n = (last ? std::stol(*last) : 0) + 1;
  redis.set(kSeqKey, std::to_string(n));
  redis.hset(key, {{"status", "finalized"}, {"number", std::to_string(n)}});
  return n;
}

// Why the invoice cannot be issued, or "".
std::string validateTotals(const store::Invoice& invoice) {
  if (invoice.line_items.empty()) return "an invoice with no line items cannot be finalized";
  if (invoice.subtotal_cents != store::subtotal(invoice.line_items)) return "the subtotal does not match the line items";
  return "";
}

// Issue the tenant's draft: its number, or 0 when it is no longer a draft. Throws InvoiceRejected.
long finalizeInvoice(const std::string& tenant, const std::string& invoice_id) {
  const auto invoice = store::get(invoice_id);
  if (!invoice || invoice->tenant_id != tenant) throw InvoiceRejected("no invoice " + invoice_id);
  const long n = claimNumber(tenant, invoice_id);
  if (n == 0) return 0;
  const std::string reason = validateTotals(*invoice);
  if (!reason.empty()) {
    store::reopen(invoice_id);  // back to a draft the issuer can fix
    throw InvoiceRejected(reason);
  }
  return n;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <stdexcept>
#include <string>

#include "invoice/store.h"  // store::get, invoiceKey, subtotal, reopen

sw::redis::Redis redis("tcp://redis:6379");

// Refuses an invoice that is no longer a draft (0), else takes the tenant's next number and finalizes
// the invoice. Redis runs the script whole: no other client lands between the read and the writes.
const std::string kClaimLua = R"lua(
if redis.call('HGET', KEYS[1], 'status') ~= 'draft' then return 0 end
local n = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'status', 'finalized', 'number', n)
return n
)lua";

// The invoice cannot be issued as it stands: the message says why.
struct InvoiceRejected : std::runtime_error {
  using std::runtime_error::runtime_error;
};

std::string seqKey(const std::string& tenant) { return "invoice:seq:" + tenant; }

// The invoice's number, claimed and written with status finalized; 0 when it is no longer a draft.
long claimNumber(const std::string& tenant, const std::string& invoice_id) {
  return static_cast<long>(redis.eval<long long>(kClaimLua, {store::invoiceKey(invoice_id), seqKey(tenant)}, {}));
}

// Why the invoice cannot be issued, or "".
std::string validateTotals(const store::Invoice& invoice) {
  if (invoice.line_items.empty()) return "an invoice with no line items cannot be finalized";
  if (invoice.subtotal_cents != store::subtotal(invoice.line_items)) return "the subtotal does not match the line items";
  return "";
}

// Issue the tenant's draft: its number, or 0 when it is no longer a draft. Throws InvoiceRejected.
long finalizeInvoice(const std::string& tenant, const std::string& invoice_id) {
  const auto invoice = store::get(invoice_id);
  if (!invoice || invoice->tenant_id != tenant) throw InvoiceRejected("no invoice " + invoice_id);
  // Validate first: a number claimed for a rejected invoice is a hole in the tenant's series.
  const std::string reason = validateTotals(*invoice);
  if (!reason.empty()) throw InvoiceRejected(reason);
  return claimNumber(tenant, invoice_id);
}
`,
    },
  },
  harness: {
    python: `from invoice import store

LINES = [{"description": "Consulting", "quantity": 2, "unit_price_cents": 25000}]


def _draft(tenant="t-1", lines=LINES):
    return store.create(tenant, "usd", lines)["id"]


def _counter(ctx):
    """What the claims spent, whichever key the code counts on."""
    return ctx.redis.get("invoice:seq:t-1") or ctx.redis.get("invoice:seq")


def check_sequence_key(ctx):
    m = ctx.load("state")
    a, b, other = _draft(), _draft(), _draft("t-2")
    got = [m.claim_number("t-1", a), m.claim_number("t-1", b), m.claim_number("t-2", other)]
    assert got == [1, 2, 1], f"t-1's two invoices and t-2's first got numbers {got}, expected [1, 2, 1]: each tenant's series is its own"
    seqs = (ctx.redis.get("invoice:seq:t-1"), ctx.redis.get("invoice:seq:t-2"))
    assert seqs == ("2", "1"), f"invoice:seq:t-1 and invoice:seq:t-2 hold {seqs}, expected ('2', '1') (keys: {sorted(ctx.redis.keys('invoice:seq*'))})"


def check_atomic_claim(ctx):
    m = ctx.load("state")
    a, b = _draft(), _draft()
    rival = {}

    def race():
        # Another worker finalizes invoice b between this claim's commands.
        if "n" not in rival:
            rival["n"] = None
            rival["n"] = m.claim_number("t-1", b)
        return rival["n"]

    probes = [ctx.redis_after(key, race) for key in ("invoice:seq:t-1", "invoice:seq")]
    mine = m.claim_number("t-1", a)
    assert any(p.fired for p in probes), "claim_number never touched the tenant's counter"
    for p in probes:
        if p.error is not None:
            raise p.error
    numbers = (store.get(a)["number"], store.get(b)["number"])
    assert sorted([mine, rival["n"]]) == [1, 2] and sorted(numbers) == [1, 2], f"two finalizes racing got numbers {mine} and {rival['n']} (stored {numbers}): both read the same last number. Take it with INCR inside the claim script"


def check_status_in_claim(ctx):
    m = ctx.load("state")
    a = _draft()
    # A second finalize of the same invoice lands right after this claim first touches the invoice.
    rival = ctx.redis_after(store.invoice_key(a), lambda: m.claim_number("t-1", a))
    mine = m.claim_number("t-1", a)
    assert rival.fired, "claim_number never touched the invoice"
    if rival.error is not None:
        raise rival.error
    claimed = [n for n in (mine, rival.result) if n is not None]
    assert len(claimed) == 1, f"two finalizes of one invoice answered {mine} and {rival.result}: exactly one may claim a number, the other must get None. Read the status inside the claim script"
    assert _counter(ctx) == "1", f"one invoice was finalized and the counter is at {_counter(ctx)}: a number was spent on nothing"
    assert store.get(a)["number"] == claimed[0], f"the invoice holds number {store.get(a)['number']}, the claim answered {claimed[0]}"


def check_no_burn(ctx):
    m = ctx.load("state")
    empty = _draft(lines=[])
    stale = _draft()
    ctx.redis.hset(store.invoice_key(stale), "subtotal_cents", 1)
    for invoice_id, what in ((empty, "with no line items"), (stale, "whose subtotal does not match its lines")):
        try:
            m.finalize_invoice("t-1", invoice_id)
        except m.InvoiceRejected:
            pass
        else:
            raise AssertionError(f"finalizing an invoice {what} must raise InvoiceRejected")
        stored = store.get(invoice_id)
        assert stored["status"] == "draft" and stored["number"] is None, f"an invoice {what} must stay a draft without a number, the store holds {stored['status']} number {stored['number']}"
    assert _counter(ctx) in (None, "0"), f"two rejected finalizes left the counter at {_counter(ctx)}: their numbers are holes in the series. Validate before claim_number"
    good = _draft()
    n = m.finalize_invoice("t-1", good)
    assert n == 1, f"the first invoice that validates got number {n}, expected 1"
`,
    typescript: `const LINES = [{description: 'Consulting', quantity: 2, unit_price_cents: 25000}];

function state(ctx) {
  return {m: ctx.load('state'), store: ctx.load('/support/invoice/store.ts')};
}

async function draft(store, tenant = 't-1', lines = LINES): Promise<string> {
  return (await store.create(tenant, 'usd', lines)).id;
}

const counter = ctx => ctx.redis.get('invoice:seq:t-1') ?? ctx.redis.get('invoice:seq');

export async function check_sequence_key(ctx) {
  const {m, store} = state(ctx);
  const a = await draft(store);
  const b = await draft(store);
  const other = await draft(store, 't-2');
  const got = [await m.claimNumber('t-1', a), await m.claimNumber('t-1', b), await m.claimNumber('t-2', other)];
  assert.deepStrictEqual(got, [1, 2, 1], \`t-1's two invoices and t-2's first got numbers \${JSON.stringify(got)}, expected [1, 2, 1]: each tenant's series is its own\`);
  const seqs = [ctx.redis.get('invoice:seq:t-1'), ctx.redis.get('invoice:seq:t-2')];
  assert.deepStrictEqual(seqs, ['2', '1'], \`invoice:seq:t-1 and invoice:seq:t-2 hold \${JSON.stringify(seqs)}, expected ["2", "1"] (keys: \${JSON.stringify(ctx.redis.keys('invoice:seq*'))})\`);
}

export async function check_atomic_claim(ctx) {
  const {m, store} = state(ctx);
  const a = await draft(store);
  const b = await draft(store);
  let rival: Promise<number | null> | null = null;
  // Another worker finalizes invoice b between this claim's commands.
  const race = () => (rival ??= m.claimNumber('t-1', b));
  const probes = ['invoice:seq:t-1', 'invoice:seq'].map(key => ctx.redisAfter(key, race));
  const mine = await m.claimNumber('t-1', a);
  assert(probes.some(p => p.fired), 'claimNumber never touched the tenant\\'s counter');
  for (const p of probes) if (p.error !== undefined) throw p.error;
  const theirs = await rival;
  const numbers = [(await store.get(a)).number, (await store.get(b)).number].sort();
  assert(JSON.stringify([mine, theirs].sort()) === '[1,2]' && JSON.stringify(numbers) === '[1,2]', \`two finalizes racing got numbers \${mine} and \${theirs} (stored \${JSON.stringify(numbers)}): both read the same last number. Take it with INCR inside the claim script\`);
}

export async function check_status_in_claim(ctx) {
  const {m, store} = state(ctx);
  const a = await draft(store);
  // A second finalize of the same invoice lands right after this claim first touches the invoice.
  const rival = ctx.redisAfter(store.invoiceKey(a), () => m.claimNumber('t-1', a));
  const mine = await m.claimNumber('t-1', a);
  assert(rival.fired, 'claimNumber never touched the invoice');
  if (rival.error !== undefined) throw rival.error;
  const theirs = await rival.result;
  const claimed = [mine, theirs].filter(n => n !== null);
  assert.equal(claimed.length, 1, \`two finalizes of one invoice answered \${mine} and \${theirs}: exactly one may claim a number, the other must get null. Read the status inside the claim script\`);
  assert.equal(counter(ctx), '1', \`one invoice was finalized and the counter is at \${counter(ctx)}: a number was spent on nothing\`);
  assert.equal((await store.get(a)).number, claimed[0], 'the invoice must hold the number the claim answered');
}

export async function check_no_burn(ctx) {
  const {m, store} = state(ctx);
  const empty = await draft(store, 't-1', []);
  const stale = await draft(store);
  ctx.redis.hset(store.invoiceKey(stale), 'subtotal_cents', '1');
  for (const [invoiceId, what] of [[empty, 'with no line items'], [stale, 'whose subtotal does not match its lines']]) {
    await assert.rejects(m.finalizeInvoice('t-1', invoiceId), m.InvoiceRejected, \`finalizing an invoice \${what} must throw InvoiceRejected\`);
    const stored = await store.get(invoiceId);
    assert(stored.status === 'draft' && stored.number === null, \`an invoice \${what} must stay a draft without a number, the store holds \${stored.status} number \${stored.number}\`);
  }
  assert([null, '0'].includes(counter(ctx)), \`two rejected finalizes left the counter at \${counter(ctx)}: their numbers are holes in the series. Validate before claimNumber\`);
  const good = await draft(store);
  const n = await m.finalizeInvoice('t-1', good);
  assert.equal(n, 1, \`the first invoice that validates got number \${n}, expected 1\`);
}
`,
    go: `package main

import (
	"context"
	"errors"

	"invoice/store"

	"leetbuild/harness"
)

var (
	stateBg    = context.Background()
	stateLines = []store.Line{{Description: "Consulting", Quantity: 2, UnitPriceCents: 25000}}
)

func draftOf(tenant string, lines []store.Line) string {
	return store.Create(stateBg, tenant, "usd", lines, "", "", "").ID
}

func mustClaim(ctx *harness.Ctx, tenant, invoiceID string) int64 {
	n, err := claimNumber(stateBg, tenant, invoiceID)
	ctx.NoError(err, "claimNumber(%s, %s) failed", tenant, invoiceID)
	return n
}

// counter is what the claims spent, whichever key the code counts on.
func counter(ctx *harness.Ctx) string {
	if v, ok := ctx.Redis.Get("invoice:seq:t-1"); ok {
		return v
	}
	v, _ := ctx.Redis.Get("invoice:seq")
	return v
}

func CheckSequenceKey(ctx *harness.Ctx) {
	a, b, other := draftOf("t-1", stateLines), draftOf("t-1", stateLines), draftOf("t-2", stateLines)
	got := []int64{mustClaim(ctx, "t-1", a), mustClaim(ctx, "t-1", b), mustClaim(ctx, "t-2", other)}
	ctx.Equal(got, []int64{1, 2, 1}, "t-1's two invoices and t-2's first must get numbers 1, 2 and 1 (each tenant's series is its own); the numbers")
	s1, _ := ctx.Redis.Get("invoice:seq:t-1")
	s2, _ := ctx.Redis.Get("invoice:seq:t-2")
	ctx.Equal([]string{s1, s2}, []string{"2", "1"}, "invoice:seq:t-1 and invoice:seq:t-2 (keys: %q)", ctx.Redis.Keys("invoice:seq*"))
}

func CheckAtomicClaim(ctx *harness.Ctx) {
	a, b := draftOf("t-1", stateLines), draftOf("t-1", stateLines)
	var theirs int64 = -1
	// Another worker finalizes invoice b between this claim's commands.
	race := func() any {
		if theirs == -1 {
			theirs = 0
			n, err := claimNumber(stateBg, "t-1", b)
			ctx.NoError(err, "the rival claim failed")
			theirs = n
		}
		return theirs
	}
	p1 := ctx.Redis.After("invoice:seq:t-1", race)
	p2 := ctx.Redis.After("invoice:seq", race)
	mine := mustClaim(ctx, "t-1", a)
	ctx.Assert(p1.Fired || p2.Fired, "claimNumber never touched the tenant's counter")
	sa, sb := store.Get(stateBg, a).Number, store.Get(stateBg, b).Number
	ctx.Assert(mine+theirs == 3 && mine != theirs && sa+sb == 3 && sa != sb, "two finalizes racing got numbers %d and %d (stored %d and %d): both read the same last number. Take it with INCR inside the claim script", mine, theirs, sa, sb)
}

func CheckStatusInClaim(ctx *harness.Ctx) {
	a := draftOf("t-1", stateLines)
	// A second finalize of the same invoice lands right after this claim first touches the invoice.
	rival := ctx.Redis.After(store.InvoiceKey(a), func() any {
		n, err := claimNumber(stateBg, "t-1", a)
		ctx.NoError(err, "the rival claim failed")
		return n
	})
	mine := mustClaim(ctx, "t-1", a)
	ctx.Assert(rival.Fired, "claimNumber never touched the invoice")
	theirs, _ := rival.Result.(int64)
	ctx.Assert((mine == 0) != (theirs == 0), "two finalizes of one invoice answered %d and %d: exactly one may claim a number, the other must get 0. Read the status inside the claim script", mine, theirs)
	ctx.Equal(counter(ctx), "1", "one invoice was finalized: a number was spent on nothing; the counter")
	ctx.Equal(store.Get(stateBg, a).Number, mine+theirs, "the invoice must hold the number the claim answered; its number")
}

func CheckNoBurn(ctx *harness.Ctx) {
	empty := draftOf("t-1", nil)
	stale := draftOf("t-1", stateLines)
	ctx.Redis.Do("HSET", store.InvoiceKey(stale), "subtotal_cents", "1")
	for _, c := range []struct{ id, what string }{{empty, "with no line items"}, {stale, "whose subtotal does not match its lines"}} {
		n, err := finalizeInvoice(stateBg, "t-1", c.id)
		ctx.Assert(errors.Is(err, ErrInvoiceRejected), "finalizing an invoice %s must return an error wrapping ErrInvoiceRejected, got %d, %v", c.what, n, err)
		stored := store.Get(stateBg, c.id)
		ctx.Assert(stored.Status == "draft" && stored.Number == 0, "an invoice %s must stay a draft without a number, the store holds %s number %d", c.what, stored.Status, stored.Number)
	}
	ctx.Assert(counter(ctx) == "" || counter(ctx) == "0", "two rejected finalizes left the counter at %s: their numbers are holes in the series. Validate before claimNumber", counter(ctx))
	n, err := finalizeInvoice(stateBg, "t-1", draftOf("t-1", stateLines))
	ctx.NoError(err, "finalizing a valid invoice failed")
	ctx.Equal(n, int64(1), "the first invoice that validates; its number")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "invoice/store.h"

namespace {

const std::vector<store::Line> kLines = {{"Consulting", 2, 25000}};

std::string draftOf(const std::string& tenant, const std::vector<store::Line>& lines) { return store::create(tenant, "usd", lines).id; }

// What the claims spent, whichever key the code counts on.
std::string counter(harness::Ctx& ctx) {
  if (const auto v = ctx.Redis.Get("invoice:seq:t-1")) return *v;
  return ctx.Redis.Get("invoice:seq").value_or("");
}

struct Rival {
  bool fired = false;
  long number = -1;
  std::optional<std::string> err;
};

}  // namespace

void CheckSequenceKey(harness::Ctx& ctx) {
  const std::string a = draftOf("t-1", kLines), b = draftOf("t-1", kLines), other = draftOf("t-2", kLines);
  const std::vector<long> got = {claimNumber("t-1", a), claimNumber("t-1", b), claimNumber("t-2", other)};
  ctx.Equal(got, {1L, 2L, 1L}, "t-1's two invoices and t-2's first must get numbers 1, 2 and 1 (each tenant's series is its own); the numbers");
  const std::vector<std::string> seqs = {ctx.Redis.Get("invoice:seq:t-1").value_or(""), ctx.Redis.Get("invoice:seq:t-2").value_or("")};
  ctx.Equal(seqs, {"2", "1"}, "invoice:seq:t-1 and invoice:seq:t-2 (keys: %q)", ctx.Redis.Keys("invoice:seq*"));
}

void CheckAtomicClaim(harness::Ctx& ctx) {
  const std::string a = draftOf("t-1", kLines), b = draftOf("t-1", kLines);
  auto rival = std::make_shared<Rival>();
  // Another worker finalizes invoice b between this claim's commands.
  const auto race = [rival, b] {
    if (rival->fired) return;
    rival->fired = true;
    try {
      rival->number = claimNumber("t-1", b);
    } catch (const std::exception& e) {
      rival->err = e.what();
    }
  };
  ctx.Redis.After("invoice:seq:t-1", race);
  ctx.Redis.After("invoice:seq", race);
  const long mine = claimNumber("t-1", a);
  ctx.Assert(rival->fired, "claimNumber never touched the tenant's counter");
  ctx.Assert(!rival->err, "the rival claim failed: %s", rival->err.value_or(""));
  const long sa = store::get(a)->number, sb = store::get(b)->number;
  ctx.Assert(mine + rival->number == 3 && mine != rival->number && sa + sb == 3 && sa != sb,
             "two finalizes racing got numbers %d and %d (stored %d and %d): both read the same last number. Take it with INCR inside the claim script", mine,
             rival->number, sa, sb);
}

void CheckStatusInClaim(harness::Ctx& ctx) {
  const std::string a = draftOf("t-1", kLines);
  auto rival = std::make_shared<Rival>();
  // A second finalize of the same invoice lands right after this claim first touches the invoice.
  ctx.Redis.After(store::invoiceKey(a), [rival, a] {
    rival->fired = true;
    try {
      rival->number = claimNumber("t-1", a);
    } catch (const std::exception& e) {
      rival->err = e.what();
    }
  });
  const long mine = claimNumber("t-1", a);
  ctx.Assert(rival->fired, "claimNumber never touched the invoice");
  ctx.Assert(!rival->err, "the rival claim failed: %s", rival->err.value_or(""));
  ctx.Assert((mine == 0) != (rival->number == 0),
             "two finalizes of one invoice answered %d and %d: exactly one may claim a number, the other must get 0. Read the status inside the claim script", mine,
             rival->number);
  ctx.Equal(counter(ctx), "1", "one invoice was finalized: a number was spent on nothing; the counter");
  ctx.Equal(store::get(a)->number, mine + rival->number, "the invoice must hold the number the claim answered; its number");
}

void CheckNoBurn(harness::Ctx& ctx) {
  const std::string empty = draftOf("t-1", {});
  const std::string stale = draftOf("t-1", kLines);
  ctx.Redis.Do("HSET", store::invoiceKey(stale), "subtotal_cents", "1");
  for (const auto& [id, what] : std::vector<std::pair<std::string, std::string>>{{empty, "with no line items"}, {stale, "whose subtotal does not match its lines"}}) {
    bool rejected = false;
    long n = 0;
    try {
      n = finalizeInvoice("t-1", id);
    } catch (const InvoiceRejected&) {
      rejected = true;
    }
    ctx.Assert(rejected, "finalizing an invoice %s must throw InvoiceRejected, got number %d", what, n);
    const auto stored = store::get(id);
    ctx.Assert(stored->status == "draft" && stored->number == 0, "an invoice %s must stay a draft without a number, the store holds %s number %d", what,
               stored->status, stored->number);
  }
  ctx.Assert(counter(ctx).empty() || counter(ctx) == "0", "two rejected finalizes left the counter at %s: their numbers are holes in the series. Validate before claimNumber",
             counter(ctx));
  ctx.Equal(finalizeInvoice("t-1", draftOf("t-1", kLines)), 1, "the first invoice that validates; its number");
}
`,
  },
  hints: [
    "Finalize two invoices of one tenant at the same moment: both carry the same number. A second tenant's first invoice is not number 1, and an invoice the validation rejects leaves a hole in the series.",
    'The number is read with GET, incremented in the client and written back with SET, on one key for every tenant; the status is read by a separate command. The finalize claims first, then validates and reopens.',
    'Key the counter `invoice:seq:{tenant}`; put the status read, `INCR` and `HSET` into one Lua script run with `EVAL` (`register_script`), answering 0 for a non-draft; call `validate_totals` before `claim_number` and drop the `reopen`.',
  ],
  debrief: `A gapless series is a promise about numbers that cannot be taken back, so every part of the claim lives in one script: Redis runs it to completion, and the status read, the increment and the status write see no other client in between. The counter is per tenant because each seller's numbering is its own legal series. Validation comes first because reopening an invoice does not return its number; the hole stays, and an auditor asks about it. A billing database keeps the counter in the same transaction as the invoice row and backs it with a unique index on (tenant, number), and some jurisdictions require a separate series per year or per document type, which turns the key into \`invoice:seq:{tenant}:{year}\`.`,
};
