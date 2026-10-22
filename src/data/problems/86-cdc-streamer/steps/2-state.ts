import type {Step} from '@/lib/types';

export const lsnCursorStep: Step = {
  id: 'state',
  title: 'Redis LSN cursor that survives everything',
  concept: 'redis',
  file: 'state',
  focus: ['redis', 'replicator', 'sink', 'pg'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the tailer reads the change
stream, applies each batch to the sink and keeps a cursor in Redis so the demo survives a restart.
It compiles, it replays the demo cleanly, and it hides three production flaws. Review it like the
replication owner, fix it, and prove the fix with the checks below.

Keep the durable cursor the tailer resumes from:

- The cursor key is \`cdc:cursor:{subscription}:{table}\`, built by \`cursor_key\`/\`cursorKey\`: exactly
  one durable cursor per (subscription, table). A single subscription-wide key lets two tables
  overwrite each other's LSN.
- The cursor is written with \`HSET\` and has **no expiry at all** — never \`EXPIRE\`, never
  \`SET ... EX\`, never a TTL. A cursor that expires is a cursor that forgets.
- \`confirm(conn, subscription, table, lsn)\` is the **only** writer of the cursor, and the tailer
  calls it only after the sink applied the batch (\`await sink.apply(...)\`). Advancing on read means
  a batch that was read but not applied is skipped forever after a crash.
- \`confirm\` refuses to move the cursor backwards: a stale or replayed confirmation is dropped by
  \`if lsn <= confirmed\` and the stored LSN stays where it was.
- \`load_cursor(...)\`/\`loadCursor(...)\` reads the confirmed LSN and the tailer resumes **exactly
  there** — never from the source head (\`head_lsn\`/\`current_lsn\`), which is where the changes it has
  not applied yet are.

**Failure mode the checks target.** The confirmed LSN per (subscription, table) has to be stored
durably and advanced only after downstream confirmation, with no expiry. The draft stores the cursor
in a cache key with a 12-hour TTL under a subscription-only key, so a quiet weekend resets the
stream to the current LSN and silently drops the backlog, and it advances the cursor as soon as the
changes are read. The fix has to prove the cursor has no expiry, that it moves only after
confirmation, and that a restart resumes exactly at the confirmed LSN rather than a later one.`,
  sequence: {
    participants: ['Tailer', 'Redis', 'Sink', 'Source DB'],
    messages: [
      {from: 'Tailer', to: 'Redis', label: 'HGET cdc:cursor:{subscription}:{table} lsn', kind: 'sync'},
      {from: 'Redis', to: 'Tailer', label: 'confirmed lsn · or nil, replay from the start', kind: 'reply'},
      {from: 'Tailer', to: 'Source DB', label: 'read changes from the confirmed lsn · never the head', kind: 'sync'},
      {from: 'Source DB', to: 'Tailer', label: 'ChangeBatch{lsn, rows}', kind: 'reply'},
      {from: 'Tailer', to: 'Sink', label: 'apply(subscription, table, rows)', kind: 'sync'},
      {from: 'Sink', to: 'Tailer', label: 'applied — the batch is downstream', kind: 'reply'},
      {from: 'Tailer', to: 'Redis', label: 'HSET lsn · no expiry, no TTL', kind: 'async'},
      {from: 'Tailer', to: 'Tailer', label: 'lsn <= confirmed → the cursor stays put', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'no-expiry',
      title: 'Writes the cursor with HSET and never expires it',
      detail:
        '`confirm` stores the LSN with `HSET` and sets **no** expiry: no `EXPIRE`, no `SET ... EX`, no TTL. A cursor with a TTL is forgotten on a quiet weekend, and the next restart either re-streams everything or skips the backlog.',
      match: {
        python: {all: [/def confirm\(/, /\.hset\(/], none: [/\bEXPIRE\b/, /\.expire\(/, /\bTTL\b/, /\bex\s*=/]},
        typescript: {
          all: [/function confirm\(/, /\.hset\(/],
          none: [/\bEXPIRE\b/, /\.expire\(/, /\bTTL\b/, /'EX'|"EX"/],
        },
        go: {
          all: [/func confirm\(/, /\.HSet\(/],
          none: [/\bEXPIRE\b/, /\.Expire\(/, /\bTTL\b/, /time\.(Hour|Minute|Second)/],
        },
        scala: {all: [/def confirm\(/, /\.hset\(/], none: [/\bEXPIRE\b/, /\.expire\(/, /\.setex\(/, /\bTTL\b/]},
        cpp: {all: [/confirm\(/, /hset\(/], none: [/\bEXPIRE\b/, /\.expire\(/, /setex/i, /\bTTL\b/]},
      },
    },
    {
      id: 'per-table-key',
      title: 'One cursor key per (subscription, table)',
      detail:
        'The key is `cdc:cursor:{subscription}:{table}`, built by `cursor_key`/`cursorKey`. The draft keeps one subscription-wide key, so two tables of the same subscription overwrite each other and one of them resumes from the other table’s LSN.',
      match: {
        python: {all: [/def cursor_key\(/, /cdc:cursor/, /\{subscription\}:\{table\}/]},
        typescript: {all: [/function cursorKey\(/, /cdc:cursor/, /\$\{subscription\}:\$\{table\}/]},
        go: {all: [/func cursorKey\(/, /cdc:cursor/, /%s:%s/]},
        scala: {all: [/def cursorKey\(/, /cdc:cursor/, /\$subscription:\$table/]},
        cpp: {all: [/cursorKey\(/, /"cdc:cursor:"/]},
      },
    },
    {
      id: 'after-confirmation',
      title: 'Advances the cursor only after the sink applied the batch',
      detail:
        '`confirm` runs after `sink.apply(...)`: the tailer applies the batch downstream first and moves the cursor second. The draft moves it as soon as the changes are read, so a crash between read and apply loses that batch forever.',
      match: {
        python: {order: [/sink\.apply\(/, /confirm\(/]},
        typescript: {order: [/sink\.apply\(/, /confirm\(/]},
        go: {order: [/sink\.Apply\(/, /confirm\(/]},
        scala: {order: [/sink\.apply\(/, /confirm\(/]},
        cpp: {order: [/sink\.apply\(|sink->apply\(/, /confirm\(/]},
      },
    },
    {
      id: 'resume-confirmed',
      title: 'A restart resumes at the confirmed LSN, never the head',
      detail:
        '`load_cursor`/`loadCursor` reads the confirmed LSN and the tailer starts exactly there. Asking the source for `head_lsn`/`current_lsn` resumes past everything that happened while the tailer was down — the draft does that and drops the backlog.',
      match: {
        python: {all: [/def load_cursor\(/], none: [/\bhead_lsn\(/, /\bcurrent_lsn\(/]},
        typescript: {all: [/function loadCursor\(/], none: [/headLsn\(|currentLsn\(/]},
        go: {all: [/func loadCursor\(/], none: [/headLSN\(|currentLSN\(/]},
        scala: {all: [/def loadCursor\(/], none: [/headLsn\(|currentLsn\(/]},
        cpp: {all: [/loadCursor\(/], none: [/headLsn\(|currentLsn\(/]},
      },
    },
    {
      id: 'monotonic',
      title: 'A stale confirmation never moves the cursor backwards',
      detail:
        '`confirm` compares against the stored LSN and drops anything at or below it (`if lsn <= confirmed`), so a retried or out-of-order confirmation leaves the cursor where it was instead of re-streaming applied changes.',
      match: {
        python: {all: [/def confirm\(/, /if lsn <= confirmed:/]},
        typescript: {all: [/function confirm\(/, /if \(lsn <= confirmed\)/]},
        go: {all: [/func confirm\(/, /if lsn <= confirmed \{/]},
        scala: {all: [/def confirm\(/, /if \(lsn <= confirmed\)/]},
        cpp: {all: [/confirm\(/, /if \(lsn <= confirmed\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import redis.asyncio as redis

logger = logging.getLogger("cdc")

CURSOR_EXPIRY_S = 12 * 60 * 60


class Source:
    def head_lsn(self) -> int:
        """The latest committed LSN the source has."""
        raise NotImplementedError

    def read_from(self, lsn: int):
        """Yield ChangeBatch(lsn, rows) starting at lsn."""
        raise NotImplementedError


class Sink:
    async def apply(self, table: str, rows: list[dict]) -> None:
        """Ship one batch to the downstream sink."""
        raise NotImplementedError


sink = Sink()


async def tail(conn: redis.Redis, source: Source, subscription: str, table: str) -> None:
    # TODO: this draft caches the cursor under a subscription-only key with a 12-hour expiry,
    # advances it as soon as the changes are read, and resumes from the source head, so a quiet
    # weekend silently drops the backlog. Review all three.
    key = f"cdc:cursor:{subscription}"
    lsn = int(await conn.get(key) or source.head_lsn())
    async for batch in source.read_from(lsn):
        lsn = batch.lsn
        await conn.set(key, str(lsn), ex=CURSOR_EXPIRY_S)
        await sink.apply(table, batch.rows)
        logger.info("cursor subscription=%s table=%s lsn=%s", subscription, table, lsn)
`,
      solution: `import logging

import redis.asyncio as redis

logger = logging.getLogger("cdc")


def cursor_key(subscription: str, table: str) -> str:
    """The one durable cursor key per (subscription, table) pair."""
    return f"cdc:cursor:{subscription}:{table}"


async def confirm(conn: redis.Redis, subscription: str, table: str, lsn: int) -> int:
    """Advance the confirmed LSN once the sink holds the batch. The only writer, never expired."""
    key = cursor_key(subscription, table)
    confirmed = int(await conn.hget(key, "lsn") or 0)
    if lsn <= confirmed:
        return confirmed
    await conn.hset(key, mapping={"lsn": str(lsn)})
    return lsn


async def load_cursor(conn: redis.Redis, subscription: str, table: str) -> int:
    """The confirmed LSN the tailer resumes from; 0 replays the stream from the beginning."""
    stored = await conn.hget(cursor_key(subscription, table), "lsn")
    return int(stored or 0)


class Source:
    def read_from(self, lsn: int):
        """Yield ChangeBatch(lsn, rows) starting exactly at the confirmed LSN."""
        raise NotImplementedError


class Sink:
    async def apply(self, subscription: str, table: str, rows: list[dict]) -> int:
        """Apply one batch downstream and return the LSN the sink durably holds."""
        raise NotImplementedError


async def tail(
    conn: redis.Redis,
    source: Source,
    sink: Sink,
    subscription: str,
    table: str,
) -> None:
    confirmed = await load_cursor(conn, subscription, table)
    async for batch in source.read_from(confirmed):
        applied = await sink.apply(subscription, table, batch.rows)
        if applied < batch.lsn:
            raise RuntimeError("the sink did not durably apply the whole batch")
        await confirm(conn, subscription, table, batch.lsn)
        logger.info("confirmed subscription=%s table=%s lsn=%s", subscription, table, batch.lsn)
`,
    },
    typescript: {
      starter: `/** CDC tailer: a model-generated draft that keeps the cursor in a cache key. */
import {Redis} from 'ioredis';

const CURSOR_EXPIRY_S = 12 * 60 * 60;

interface ChangeBatch {
  lsn: number;
  rows: Record<string, unknown>[];
}

interface Source {
  headLsn(): Promise<number>;
  readFrom(lsn: number): AsyncIterable<ChangeBatch>;
}

interface Sink {
  apply(table: string, rows: Record<string, unknown>[]): Promise<void>;
}

export async function tail(
  conn: Redis,
  source: Source,
  sink: Sink,
  subscription: string,
  table: string,
): Promise<void> {
  // TODO: this draft caches the cursor under a subscription-only key with a 12-hour expiry,
  // advances it as soon as the changes are read, and resumes from the source head, so a quiet
  // weekend silently drops the backlog. Review all three.
  const key = \`cdc:cursor:\${subscription}\`;
  let lsn = Number((await conn.get(key)) ?? (await source.headLsn()));
  for await (const batch of source.readFrom(lsn)) {
    lsn = batch.lsn;
    await conn.set(key, String(lsn), 'EX', CURSOR_EXPIRY_S);
    await sink.apply(table, batch.rows);
  }
}
`,
      solution: `/** CDC tailer: one durable LSN cursor per (subscription, table), advanced after the sink. */
import {Redis} from 'ioredis';

/** The one durable cursor key per (subscription, table) pair. */
export function cursorKey(subscription: string, table: string): string {
  return \`cdc:cursor:\${subscription}:\${table}\`;
}

/** Advance the confirmed LSN once the sink holds the batch: the only writer, never expired. */
export async function confirm(
  conn: Redis,
  subscription: string,
  table: string,
  lsn: number,
): Promise<number> {
  const key = cursorKey(subscription, table);
  const confirmed = Number((await conn.hget(key, 'lsn')) ?? 0);
  if (lsn <= confirmed) return confirmed;
  await conn.hset(key, 'lsn', String(lsn));
  return lsn;
}

/** The confirmed LSN the tailer resumes from; 0 replays the stream from the beginning. */
export async function loadCursor(conn: Redis, subscription: string, table: string): Promise<number> {
  return Number((await conn.hget(cursorKey(subscription, table), 'lsn')) ?? 0);
}

interface ChangeBatch {
  lsn: number;
  rows: Record<string, unknown>[];
}

interface Source {
  readFrom(lsn: number): AsyncIterable<ChangeBatch>;
}

interface Sink {
  apply(subscription: string, table: string, rows: Record<string, unknown>[]): Promise<number>;
}

export async function tail(
  conn: Redis,
  source: Source,
  sink: Sink,
  subscription: string,
  table: string,
): Promise<void> {
  const confirmed = await loadCursor(conn, subscription, table);
  for await (const batch of source.readFrom(confirmed)) {
    const applied = await sink.apply(subscription, table, batch.rows);
    if (applied < batch.lsn) throw new Error('the sink did not durably apply the whole batch');
    await confirm(conn, subscription, table, batch.lsn);
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const cursorExpiry = 12 * time.Hour

type ChangeBatch struct {
	LSN  int64
	Rows []map[string]any
}

type Source interface {
	headLSN(ctx context.Context) (int64, error)
	readFrom(ctx context.Context, lsn int64) (<-chan ChangeBatch, <-chan error)
}

type Sink interface {
	apply(ctx context.Context, table string, rows []map[string]any) error
}

func tail(ctx context.Context, conn *redis.Client, source Source, sink Sink, subscription, table string) error {
	// TODO: this draft caches the cursor under a subscription-only key with a 12-hour expiry,
	// advances it as soon as the changes are read, and resumes from the source head, so a quiet
	// weekend silently drops the backlog. Review all three.
	key := fmt.Sprintf("cdc:cursor:%s", subscription)
	head, err := source.headLSN(ctx)
	if err != nil {
		return err
	}
	lsn, err := conn.Get(ctx, key).Int64()
	if err == redis.Nil {
		lsn = head
	} else if err != nil {
		return err
	}
	batches, errs := source.readFrom(ctx, lsn)
	for batch := range batches {
		lsn = batch.LSN
		if err := conn.Set(ctx, key, lsn, cursorExpiry).Err(); err != nil {
			return err
		}
		if err := sink.apply(ctx, table, batch.Rows); err != nil {
			return err
		}
	}
	return <-errs
}

func main() {}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"log"

	"github.com/redis/go-redis/v9"
)

// cursorKey is the one durable cursor key per (subscription, table) pair.
func cursorKey(subscription, table string) string {
	return fmt.Sprintf("cdc:cursor:%s:%s", subscription, table)
}

// confirm advances the confirmed LSN once the sink holds the batch. It is the only writer of the
// cursor and it never puts an expiry on the key.
func confirm(ctx context.Context, conn *redis.Client, subscription, table string, lsn int64) (int64, error) {
	key := cursorKey(subscription, table)
	confirmed, err := conn.HGet(ctx, key, "lsn").Int64()
	if err == redis.Nil {
		confirmed = 0
	} else if err != nil {
		return 0, err
	}
	if lsn <= confirmed {
		return confirmed, nil
	}
	if err := conn.HSet(ctx, key, "lsn", lsn).Err(); err != nil {
		return confirmed, err
	}
	return lsn, nil
}

// loadCursor is the confirmed LSN the tailer resumes from; 0 replays the stream from the start.
func loadCursor(ctx context.Context, conn *redis.Client, subscription, table string) (int64, error) {
	confirmed, err := conn.HGet(ctx, cursorKey(subscription, table), "lsn").Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return confirmed, err
}

type ChangeBatch struct {
	LSN  int64
	Rows []map[string]any
}

type Source interface {
	ReadFrom(ctx context.Context, lsn int64) (<-chan ChangeBatch, <-chan error)
}

type Sink interface {
	Apply(ctx context.Context, subscription, table string, rows []map[string]any) (int64, error)
}

func tail(ctx context.Context, conn *redis.Client, source Source, sink Sink, subscription, table string) error {
	confirmed, err := loadCursor(ctx, conn, subscription, table)
	if err != nil {
		return err
	}
	batches, errs := source.ReadFrom(ctx, confirmed)
	for batch := range batches {
		applied, err := sink.Apply(ctx, subscription, table, batch.Rows)
		if err != nil {
			return err
		}
		if applied < batch.LSN {
			return fmt.Errorf("the sink did not durably apply the whole batch")
		}
		if _, err := confirm(ctx, conn, subscription, table, batch.LSN); err != nil {
			return err
		}
		log.Printf("confirmed subscription=%s table=%s lsn=%d", subscription, table, batch.LSN)
	}
	return <-errs
}

func main() {}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

case class ChangeBatch(lsn: Long, rows: Seq[Map[String, Any]])

trait Source {
  def headLsn(): Long
  def readFrom(lsn: Long): Iterator[ChangeBatch]
}

trait Sink {
  def apply(table: String, rows: Seq[Map[String, Any]]): Unit
}

object Tailer {
  val CursorExpirySeconds = 12L * 60 * 60

  // TODO: this draft caches the cursor under a subscription-only key with a 12-hour expiry,
  // advances it as soon as the changes are read, and resumes from the source head, so a quiet
  // weekend silently drops the backlog. Review all three.
  def tail(jedis: Jedis, source: Source, sink: Sink, subscription: String, table: String): Unit = {
    val key = s"cdc:cursor:$subscription"
    val head = source.headLsn()
    var lsn = Option(jedis.get(key)).map(_.toLong).getOrElse(head)
    source.readFrom(lsn).foreach { batch =>
      lsn = batch.lsn
      jedis.set(key, lsn.toString)
      jedis.expire(key, CursorExpirySeconds)
      sink.apply(table, batch.rows)
    }
  }
}
`,
      solution: `import java.util

import redis.clients.jedis.Jedis

case class ChangeBatch(lsn: Long, rows: Seq[Map[String, Any]])

trait Source {
  def readFrom(lsn: Long): Iterator[ChangeBatch]
}

trait Sink {
  def apply(subscription: String, table: String, rows: Seq[Map[String, Any]]): Long
}

object LsnCursor {
  /** The one durable cursor key per (subscription, table) pair. */
  def cursorKey(subscription: String, table: String): String = s"cdc:cursor:$subscription:$table"

  /** Advance the confirmed LSN once the sink holds the batch: the only writer, never expired. */
  def confirm(jedis: Jedis, subscription: String, table: String, lsn: Long): Long = {
    val key = cursorKey(subscription, table)
    val confirmed = Option(jedis.hget(key, "lsn")).map(_.toLong).getOrElse(0L)
    if (lsn <= confirmed) {
      confirmed
    } else {
      jedis.hset(key, util.Map.of("lsn", lsn.toString))
      lsn
    }
  }

  /** The confirmed LSN the tailer resumes from; 0 replays the stream from the beginning. */
  def loadCursor(jedis: Jedis, subscription: String, table: String): Long =
    Option(jedis.hget(cursorKey(subscription, table), "lsn")).map(_.toLong).getOrElse(0L)

  def tail(jedis: Jedis, source: Source, sink: Sink, subscription: String, table: String): Unit = {
    val confirmed = loadCursor(jedis, subscription, table)
    source.readFrom(confirmed).foreach { batch =>
      val applied = sink.apply(subscription, table, batch.rows)
      require(applied >= batch.lsn, "the sink did not durably apply the whole batch")
      confirm(jedis, subscription, table, batch.lsn)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <cstdint>
#include <string>
#include <vector>

constexpr std::int64_t kCursorExpirySeconds = 12 * 60 * 60;

struct ChangeBatch {
  std::int64_t lsn;
  std::vector<std::string> rows;
};

class Source {
 public:
  virtual std::int64_t headLsn() = 0;
  virtual std::vector<ChangeBatch> readFrom(std::int64_t lsn) = 0;
};

class Sink {
 public:
  virtual void apply(const std::string& table, const std::vector<std::string>& rows) = 0;
};

void tail(sw::redis::Redis& redis, Source& source, Sink& sink, const std::string& subscription,
          const std::string& table) {
  // TODO: this draft caches the cursor under a subscription-only key with a 12-hour expiry,
  // advances it as soon as the changes are read, and resumes from the source head, so a quiet
  // weekend silently drops the backlog. Review all three.
  const auto key = "cdc:cursor:" + subscription;
  const auto stored = redis.get(key);
  std::int64_t lsn = stored ? std::stoll(*stored) : source.headLsn();
  for (const auto& batch : source.readFrom(lsn)) {
    lsn = batch.lsn;
    redis.set(key, std::to_string(lsn));
    redis.expire(key, kCursorExpirySeconds);
    sink.apply(table, batch.rows);
  }
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <cstdint>
#include <string>
#include <vector>

// The one durable cursor key per (subscription, table) pair.
std::string cursorKey(const std::string& subscription, const std::string& table) {
  return "cdc:cursor:" + subscription + ":" + table;
}

// Advance the confirmed LSN once the sink holds the batch: the only writer, never expired.
std::int64_t confirm(sw::redis::Redis& redis, const std::string& subscription,
                     const std::string& table, std::int64_t lsn) {
  const auto key = cursorKey(subscription, table);
  const auto stored = redis.hget(key, "lsn");
  const std::int64_t confirmed = stored ? std::stoll(*stored) : 0;
  if (lsn <= confirmed) return confirmed;
  redis.hset(key, "lsn", std::to_string(lsn));
  return lsn;
}

// The confirmed LSN the tailer resumes from; 0 replays the stream from the beginning.
std::int64_t loadCursor(sw::redis::Redis& redis, const std::string& subscription,
                        const std::string& table) {
  const auto stored = redis.hget(cursorKey(subscription, table), "lsn");
  return stored ? std::stoll(*stored) : 0;
}

struct ChangeBatch {
  std::int64_t lsn;
  std::vector<std::string> rows;
};

class Source {
 public:
  virtual std::vector<ChangeBatch> readFrom(std::int64_t lsn) = 0;
};

class Sink {
 public:
  virtual std::int64_t apply(const std::string& subscription, const std::string& table,
                             const std::vector<std::string>& rows) = 0;
};

void tail(sw::redis::Redis& redis, Source& source, Sink& sink, const std::string& subscription,
          const std::string& table) {
  const auto confirmed = loadCursor(redis, subscription, table);
  for (const auto& batch : source.readFrom(confirmed)) {
    const auto applied = sink.apply(subscription, table, batch.rows);
    if (applied < batch.lsn) throw std::runtime_error("the sink did not durably apply the batch");
    confirm(redis, subscription, table, batch.lsn);
  }
}
`,
    },
  },
  hints: [
    'One key per table, not per subscription: `cursor_key(subscription, table)` returning `cdc:cursor:{subscription}:{table}`. With a subscription-wide key the second table writes its LSN over the first one’s, and whichever resumes later starts at the other table’s position.',
    '`confirm` is the only writer and it writes with `HSET` alone — no `EXPIRE`, no `SET ... EX`, no TTL anywhere on that key. And move it *after* `await sink.apply(...)`: advancing on read loses every batch that was read but not shipped when the process dies.',
    'A confirmation is monotonic: read the stored LSN, drop the write when `lsn <= confirmed`, and hand the sink’s applied LSN back. On restart, `load_cursor(...)` gives the starting position — never ask the source for its head, which is already past the changes you have not applied.',
  ],
  debrief: `The interviewer is testing whether you can review a generated replication loop whose whole correctness rests on one key. The draft works on the demo because the demo runs for a minute: the cursor is a cache entry with a 12-hour TTL, it is written as soon as changes are read, and the restart path asks the source for its head. Three defects are being checked. Durability is first — a cursor is bookkeeping, not a cache, so it is written with \`HSET\` and never given an expiry; a TTL here means a Monday morning that either re-delivers every change or, worse, resumes at the head and drops the weekend. Order of operations is second, and it is the one that is invisible until a crash: apply to the sink, then confirm, so the confirmed LSN never runs ahead of what downstream holds. Monotonicity is third — confirmations arrive out of order after retries, and a stale one must not drag the cursor backwards over already-applied changes. Real streamers add one cursor per (subscription, table) inside a single key or an HA store, compare the LSN against the slot’s restart point, and record the sink’s acknowledgement before the WAL slot is allowed to advance.`,
};
