/**
 * Hand-written support modules the merchant-payments starters import but no step builds:
 * `payments.db` (the runtime's Postgres handle) and `payments.ledger` (the non-idempotent poster
 * step 5 dedupes in front of).
 */
export const supportModules: Record<string, string> = {
  'payments/db.py': `"""The order database: \`async with db.transaction() as cur:\` begins, runs the block, commits
(rolls back when the block raises). \`await cur.execute(sql, params)\` with %s placeholders;
\`await cur.fetchall()\` returns dict rows."""
from leetbuild.db import DB as db

__all__ = ["db"]
`,
  'payments/ledger.py': `"""The ledger: post(event) books one payment.captured event as double-entry rows.

NOT idempotent: posting the same event twice books the money twice. \`posted\` is the journal."""

posted: list[dict] = []


def post(event: dict) -> None:
    """Book the event; every call appends a journal entry, duplicates included."""
    posted.append(dict(event))
`,
};
