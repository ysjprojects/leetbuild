/**
 * Hand-written support module the ledger steps import but no step builds: `ledger.db`, the
 * runtime's Postgres handle holding the `transactions` and `entries` tables.
 */
export const supportModules: Record<string, string> = {
  'ledger/db.py': `"""The ledger database: \`async with db.transaction() as cur:\` begins, runs the block, commits
(rolls back when the block raises). \`await cur.execute(sql, params)\` with %s placeholders;
\`cur.rowcount\` is the affected-row count; \`await cur.fetchall()\` returns dict rows.

Tables:
    transactions (id text primary key, event_id text unique, description text, settles text, posted_at bigint)
    entries      (transaction_id text, account text, currency text, amount bigint, posted_at bigint)
"""
from leetbuild.db import DB as db

__all__ = ["db"]
`,
};
