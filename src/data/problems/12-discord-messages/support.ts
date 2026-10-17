/**
 * Hand-written support module the discord-messages starters import but no step builds:
 * `messages.db`, the runtime's Postgres handle with the `messages` schema beside it. Snowflakes are
 * 64-bit ids, wider than a JSON (or JavaScript) number, so the handle sends integer parameters as
 * text and the `numeric(20, 0)` id columns come back as strings — the same reason Discord's own API
 * serialises every id as a string.
 */
export const supportModules: Record<string, string> = {
  'messages/db.py': `"""The messages table (provided). \`await db.execute(sql, params)\` runs one statement and returns
dict rows; \`async with db.transaction() as cur:\` begins, runs the block, commits (rolls back when the
block raises). %s placeholders.

Ids are 64-bit snowflakes, wider than a JSON number: pass them as Python ints, they travel as text;
the numeric id columns come back as strings — \`int(row["message_id"])\`."""
from leetbuild.db import DB as _runtime
from leetbuild.db import Db

SCHEMA = """
CREATE TABLE messages (
    channel_id numeric(20, 0) NOT NULL,
    bucket integer NOT NULL,
    message_id numeric(20, 0) NOT NULL,
    author_id numeric(20, 0) NOT NULL,
    content text NOT NULL,
    PRIMARY KEY (channel_id, bucket, message_id)
);
"""


def _text(value):
    return str(value) if isinstance(value, int) and not isinstance(value, bool) else value


class _MessagesDb(Db):
    """The runtime's Postgres with integer parameters sent as text (a 64-bit id does not survive JSON)."""

    def __init__(self) -> None:
        pass

    @property
    def events(self):
        return _runtime.events

    @property
    def statements(self):
        return _runtime.statements

    async def reset(self, schema: str = "") -> None:
        await _runtime.reset(schema)

    async def _run(self, sql, params):
        return await _runtime._run(sql, [_text(p) for p in params])


db = _MessagesDb()

__all__ = ["SCHEMA", "db"]
`,
};
