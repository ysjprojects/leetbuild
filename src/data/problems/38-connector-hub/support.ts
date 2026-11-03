/**
 * Hand-written support modules the connector-hub steps import but no step builds: the `hub`
 * package. `hub.store` is the connector registry (every connector a Redis hash, the course's
 * stand-in for the connectors table): registration rows, the Idempotency-Key record, the disable
 * switch. `hub.ledger` is the sync ledger of step 2 as later steps use it: `load_cursor` and
 * `commit_page` (the page claim and the cursor move in one Lua script). The five languages keep the
 * same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'hub/__init__.py': '',
  'hub/store.py': `"""
The connector registry (provided): every connector is a Redis hash connector:{id} with connector_id,
tenant, source_type, host, token_ref, status (enabled or disabled), disabled_reason and
sync_interval_s. tenant:{tenant}:idem:{key} names the connector a registration with that
Idempotency-Key created. A row is a dict; sync_interval_s is an int.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

DEFAULT_SYNC_INTERVAL_S = 900


def connector_key(connector_id: str) -> str:
    return f"connector:{connector_id}"


def get(connector_id: str) -> dict | None:
    """The connector's row, or None."""
    raw = r.hgetall(connector_key(connector_id))
    if not raw:
        return None
    return {**raw, "sync_interval_s": int(raw.get("sync_interval_s") or DEFAULT_SYNC_INTERVAL_S)}


def create(tenant: str, source_type: str, host: str, token_ref: str, sync_interval_s: int) -> dict:
    """A new enabled connector; returns its row."""
    connector_id = f"c-{r.incr('connector:seq')}"
    r.hset(
        connector_key(connector_id),
        mapping={
            "connector_id": connector_id,
            "tenant": tenant,
            "source_type": source_type,
            "host": host,
            "token_ref": token_ref,
            "status": "enabled",
            "disabled_reason": "",
            "sync_interval_s": sync_interval_s,
        },
    )
    return get(connector_id)


def find_by_key(tenant: str, key: str) -> dict | None:
    """The connector the tenant's registration with this Idempotency-Key created, or None."""
    connector_id = r.get(f"tenant:{tenant}:idem:{key}")
    return get(connector_id) if connector_id else None


def remember_key(tenant: str, key: str, connector_id: str) -> None:
    """Record that the tenant's registration with this Idempotency-Key created connector_id."""
    r.set(f"tenant:{tenant}:idem:{key}", connector_id)


def disable(connector_id: str, reason: str) -> None:
    """Stop the connector's syncs, with a reason an operator can read."""
    r.hset(connector_key(connector_id), mapping={"status": "disabled", "disabled_reason": reason})
`,
  'hub/ledger.py': `"""
The sync ledger (provided; step 2 builds the same two functions): cursor:{connector_id} is the
connector's durable checkpoint, page:{connector_id}:{page_token} the claim of one page. commit_page
claims the page and moves the cursor in one Lua script; a page already claimed changes nothing and
reports the cursor the ledger holds.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

COMMIT_LUA = """
if redis.call('SET', KEYS[1], '1', 'NX') then
  redis.call('SET', KEYS[2], ARGV[1])
  return {'1', ARGV[1]}
end
return {'0', redis.call('GET', KEYS[2]) or ''}
"""
commit = r.register_script(COMMIT_LUA)


def cursor_key(connector_id: str) -> str:
    return f"cursor:{connector_id}"


def page_key(connector_id: str, page_token: str) -> str:
    return f"page:{connector_id}:{page_token}"


def load_cursor(connector_id: str) -> str | None:
    """The checkpoint the connector's next sync starts from, or None before its first page."""
    return r.get(cursor_key(connector_id))


def commit_page(connector_id: str, page_token: str, next_cursor: str) -> dict:
    """Claim the page and move the cursor to next_cursor: {applied, cursor}, cursor being what the ledger holds."""
    applied, cursor = commit(keys=[page_key(connector_id, page_token), cursor_key(connector_id)], args=[next_cursor])
    return {"applied": applied == "1", "cursor": cursor}
`,
};

export const supportModulesTs: Record<string, string> = {
  'hub/store.ts': `/**
 * The connector registry (provided): every connector is a Redis hash connector:{id} with
 * connector_id, tenant, source_type, host, token_ref, status (enabled or disabled), disabled_reason
 * and sync_interval_s. tenant:{tenant}:idem:{key} names the connector a registration with that
 * Idempotency-Key created.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const DEFAULT_SYNC_INTERVAL_S = 900;

export interface Connector {
  connector_id: string;
  tenant: string;
  source_type: string;
  host: string;
  token_ref: string;
  status: string;
  disabled_reason: string;
  sync_interval_s: number;
}

export const connectorKey = (connectorId: string): string => \`connector:\${connectorId}\`;

/** The connector's row, or null. */
export async function get(connectorId: string): Promise<Connector | null> {
  const raw = await redis.hgetall(connectorKey(connectorId));
  if (Object.keys(raw).length === 0) return null;
  return {
    connector_id: raw.connector_id,
    tenant: raw.tenant ?? '',
    source_type: raw.source_type ?? '',
    host: raw.host ?? '',
    token_ref: raw.token_ref ?? '',
    status: raw.status ?? 'enabled',
    disabled_reason: raw.disabled_reason ?? '',
    sync_interval_s: Number(raw.sync_interval_s) || DEFAULT_SYNC_INTERVAL_S,
  };
}

/** A new enabled connector; returns its row. */
export async function create(tenant: string, sourceType: string, host: string, tokenRef: string, syncIntervalS: number): Promise<Connector> {
  const connectorId = \`c-\${await redis.incr('connector:seq')}\`;
  await redis.hset(connectorKey(connectorId), {
    connector_id: connectorId,
    tenant,
    source_type: sourceType,
    host,
    token_ref: tokenRef,
    status: 'enabled',
    disabled_reason: '',
    sync_interval_s: String(syncIntervalS),
  });
  return (await get(connectorId)) as Connector;
}

/** The connector the tenant's registration with this Idempotency-Key created, or null. */
export async function findByKey(tenant: string, key: string): Promise<Connector | null> {
  const connectorId = await redis.get(\`tenant:\${tenant}:idem:\${key}\`);
  return connectorId ? get(connectorId) : null;
}

/** Record that the tenant's registration with this Idempotency-Key created connectorId. */
export async function rememberKey(tenant: string, key: string, connectorId: string): Promise<void> {
  await redis.set(\`tenant:\${tenant}:idem:\${key}\`, connectorId);
}

/** Stop the connector's syncs, with a reason an operator can read. */
export async function disable(connectorId: string, reason: string): Promise<void> {
  await redis.hset(connectorKey(connectorId), {status: 'disabled', disabled_reason: reason});
}
`,
  'hub/ledger.ts': `/**
 * The sync ledger (provided; step 2 builds the same two functions): cursor:{connector_id} is the
 * connector's durable checkpoint, page:{connector_id}:{page_token} the claim of one page. commitPage
 * claims the page and moves the cursor in one Lua script; a page already claimed changes nothing and
 * reports the cursor the ledger holds.
 */
import Redis from 'ioredis';

export const COMMIT_LUA = \`
if redis.call('SET', KEYS[1], '1', 'NX') then
  redis.call('SET', KEYS[2], ARGV[1])
  return {'1', ARGV[1]}
end
return {'0', redis.call('GET', KEYS[2]) or ''}
\`;

interface LedgerRedis extends Redis {
  commitPageScript(pageKey: string, cursorKey: string, nextCursor: string): Promise<[string, string]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as LedgerRedis;
redis.defineCommand('commitPageScript', {numberOfKeys: 2, lua: COMMIT_LUA});

export interface Commit {
  applied: boolean;
  cursor: string;
}

export const cursorKey = (connectorId: string): string => \`cursor:\${connectorId}\`;
export const pageKey = (connectorId: string, pageToken: string): string => \`page:\${connectorId}:\${pageToken}\`;

/** The checkpoint the connector's next sync starts from, or null before its first page. */
export async function loadCursor(connectorId: string): Promise<string | null> {
  return redis.get(cursorKey(connectorId));
}

/** Claim the page and move the cursor to nextCursor; cursor is what the ledger holds. */
export async function commitPage(connectorId: string, pageToken: string, nextCursor: string): Promise<Commit> {
  const [applied, cursor] = await redis.commitPageScript(pageKey(connectorId, pageToken), cursorKey(connectorId), nextCursor);
  return {applied: applied === '1', cursor};
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'hub/store/store.go': `// Package store is the connector registry (provided): every connector is a Redis hash
// connector:{id} with connector_id, tenant, source_type, host, token_ref, status (enabled or
// disabled), disabled_reason and sync_interval_s. tenant:{tenant}:idem:{key} names the connector a
// registration with that Idempotency-Key created.
package store

import (
	"context"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// DefaultSyncIntervalS is the sync interval of a registration that names none.
const DefaultSyncIntervalS = 900

// Connector is one registration row.
type Connector struct {
	ConnectorID    string \`json:"connector_id"\`
	Tenant         string \`json:"tenant"\`
	SourceType     string \`json:"source_type"\`
	Host           string \`json:"host"\`
	TokenRef       string \`json:"token_ref"\`
	Status         string \`json:"status"\`
	DisabledReason string \`json:"disabled_reason"\`
	SyncIntervalS  int    \`json:"sync_interval_s"\`
}

// ConnectorKey is the hash of one connector.
func ConnectorKey(connectorID string) string { return "connector:" + connectorID }

// Get is the connector's row, or nil.
func Get(ctx context.Context, connectorID string) *Connector {
	raw := rdb.HGetAll(ctx, ConnectorKey(connectorID)).Val()
	if len(raw) == 0 {
		return nil
	}
	interval, _ := strconv.Atoi(raw["sync_interval_s"])
	if interval == 0 {
		interval = DefaultSyncIntervalS
	}
	return &Connector{
		ConnectorID:    raw["connector_id"],
		Tenant:         raw["tenant"],
		SourceType:     raw["source_type"],
		Host:           raw["host"],
		TokenRef:       raw["token_ref"],
		Status:         raw["status"],
		DisabledReason: raw["disabled_reason"],
		SyncIntervalS:  interval,
	}
}

// Create makes a new enabled connector and returns its row.
func Create(ctx context.Context, tenant, sourceType, host, tokenRef string, syncIntervalS int) *Connector {
	connectorID := fmt.Sprintf("c-%d", rdb.Incr(ctx, "connector:seq").Val())
	rdb.HSet(ctx, ConnectorKey(connectorID), map[string]any{
		"connector_id":    connectorID,
		"tenant":          tenant,
		"source_type":     sourceType,
		"host":            host,
		"token_ref":       tokenRef,
		"status":          "enabled",
		"disabled_reason": "",
		"sync_interval_s": strconv.Itoa(syncIntervalS),
	})
	return Get(ctx, connectorID)
}

// FindByKey is the connector the tenant's registration with this Idempotency-Key created, or nil.
func FindByKey(ctx context.Context, tenant, key string) *Connector {
	connectorID, err := rdb.Get(ctx, "tenant:"+tenant+":idem:"+key).Result()
	if err != nil {
		return nil
	}
	return Get(ctx, connectorID)
}

// RememberKey records that the tenant's registration with this Idempotency-Key created connectorID.
func RememberKey(ctx context.Context, tenant, key, connectorID string) {
	rdb.Set(ctx, "tenant:"+tenant+":idem:"+key, connectorID, 0)
}

// Disable stops the connector's syncs, with a reason an operator can read.
func Disable(ctx context.Context, connectorID, reason string) {
	rdb.HSet(ctx, ConnectorKey(connectorID), map[string]any{"status": "disabled", "disabled_reason": reason})
}
`,
  'hub/ledger/ledger.go': `// Package ledger is the sync ledger (provided; step 2 builds the same two functions):
// cursor:{connector_id} is the connector's durable checkpoint, page:{connector_id}:{page_token} the
// claim of one page. CommitPage claims the page and moves the cursor in one Lua script; a page
// already claimed changes nothing and reports the cursor the ledger holds.
package ledger

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// commitScript claims KEYS[1] and, only when the claim is fresh, moves KEYS[2] to ARGV[1].
var commitScript = redis.NewScript(\`
if redis.call('SET', KEYS[1], '1', 'NX') then
  redis.call('SET', KEYS[2], ARGV[1])
  return {'1', ARGV[1]}
end
return {'0', redis.call('GET', KEYS[2]) or ''}
\`)

// Commit is what a page commit did: whether the page was applied, and the cursor the ledger holds.
type Commit struct {
	Applied bool   \`json:"applied"\`
	Cursor  string \`json:"cursor"\`
}

// CursorKey is the connector's checkpoint.
func CursorKey(connectorID string) string { return "cursor:" + connectorID }

// PageKey is the claim of one page.
func PageKey(connectorID, pageToken string) string { return "page:" + connectorID + ":" + pageToken }

// LoadCursor is the checkpoint the connector's next sync starts from ("" before its first page).
func LoadCursor(ctx context.Context, connectorID string) (string, error) {
	cursor, err := rdb.Get(ctx, CursorKey(connectorID)).Result()
	if err == redis.Nil {
		return "", nil
	}
	return cursor, err
}

// CommitPage claims the page and moves the cursor to nextCursor.
func CommitPage(ctx context.Context, connectorID, pageToken, nextCursor string) (Commit, error) {
	reply, err := commitScript.Run(ctx, rdb, []string{PageKey(connectorID, pageToken), CursorKey(connectorID)}, nextCursor).StringSlice()
	if err != nil {
		return Commit{}, err
	}
	return Commit{Applied: reply[0] == "1", Cursor: reply[1]}, nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'hub/store.h': `// The connector registry (provided): every connector is a Redis hash connector:{id} with
// connector_id, tenant, source_type, host, token_ref, status (enabled or disabled), disabled_reason
// and sync_interval_s. tenant:{tenant}:idem:{key} names the connector a registration with that
// Idempotency-Key created.
#pragma once

#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <unordered_map>

namespace store {

constexpr long kDefaultSyncIntervalS = 900;

struct Connector {
  std::string connector_id;
  std::string tenant;
  std::string source_type;
  std::string host;
  std::string token_ref;
  std::string status;
  std::string disabled_reason;
  long sync_interval_s = kDefaultSyncIntervalS;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string connectorKey(const std::string& connector_id) { return "connector:" + connector_id; }

// The connector's row, or none.
inline std::optional<Connector> get(const std::string& connector_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(connectorKey(connector_id));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  Connector row;
  row.connector_id = text("connector_id");
  row.tenant = text("tenant");
  row.source_type = text("source_type");
  row.host = text("host");
  row.token_ref = text("token_ref");
  row.status = text("status");
  row.disabled_reason = text("disabled_reason");
  row.sync_interval_s = text("sync_interval_s").empty() ? kDefaultSyncIntervalS : std::stol(text("sync_interval_s"));
  return row;
}

// A new enabled connector; returns its row.
inline Connector create(const std::string& tenant, const std::string& source_type, const std::string& host,
                        const std::string& token_ref, long sync_interval_s) {
  const std::string connector_id = "c-" + std::to_string(redis().incr("connector:seq"));
  redis().hset(connectorKey(connector_id), {{"connector_id", connector_id},
                                            {"tenant", tenant},
                                            {"source_type", source_type},
                                            {"host", host},
                                            {"token_ref", token_ref},
                                            {"status", "enabled"},
                                            {"disabled_reason", ""},
                                            {"sync_interval_s", std::to_string(sync_interval_s)}});
  return *get(connector_id);
}

// The connector the tenant's registration with this Idempotency-Key created, or none.
inline std::optional<Connector> findByKey(const std::string& tenant, const std::string& key) {
  const auto connector_id = redis().get("tenant:" + tenant + ":idem:" + key);
  if (!connector_id) return std::nullopt;
  return get(*connector_id);
}

// Record that the tenant's registration with this Idempotency-Key created connector_id.
inline void rememberKey(const std::string& tenant, const std::string& key, const std::string& connector_id) {
  redis().set("tenant:" + tenant + ":idem:" + key, connector_id);
}

// Stop the connector's syncs, with a reason an operator can read.
inline void disable(const std::string& connector_id, const std::string& reason) {
  redis().hset(connectorKey(connector_id), {{"status", "disabled"}, {"disabled_reason", reason}});
}

}  // namespace store
`,
  'hub/ledger.h': `// The sync ledger (provided; step 2 builds the same two functions): cursor:{connector_id} is the
// connector's durable checkpoint, page:{connector_id}:{page_token} the claim of one page. commitPage
// claims the page and moves the cursor in one Lua script; a page already claimed changes nothing
// and reports the cursor the ledger holds.
#pragma once

#include <sw/redis++/redis++.h>

#include <iterator>
#include <optional>
#include <string>
#include <vector>

namespace ledger {

struct Commit {
  bool applied = false;
  std::string cursor;
};

inline const std::string kCommitLua = R"lua(
if redis.call('SET', KEYS[1], '1', 'NX') then
  redis.call('SET', KEYS[2], ARGV[1])
  return {'1', ARGV[1]}
end
return {'0', redis.call('GET', KEYS[2]) or ''}
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string cursorKey(const std::string& connector_id) { return "cursor:" + connector_id; }

inline std::string pageKey(const std::string& connector_id, const std::string& page_token) {
  return "page:" + connector_id + ":" + page_token;
}

// The checkpoint the connector's next sync starts from, or none before its first page.
inline std::optional<std::string> loadCursor(const std::string& connector_id) {
  const auto cursor = redis().get(cursorKey(connector_id));
  if (!cursor) return std::nullopt;
  return *cursor;
}

// Claim the page and move the cursor to next_cursor; cursor is what the ledger holds.
inline Commit commitPage(const std::string& connector_id, const std::string& page_token, const std::string& next_cursor) {
  std::vector<std::string> reply;
  redis().eval(kCommitLua, {pageKey(connector_id, page_token), cursorKey(connector_id)}, {next_cursor}, std::back_inserter(reply));
  return Commit{reply.at(0) == "1", reply.at(1)};
}

}  // namespace ledger
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('hub', 'Store')]: `package hub

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The connector registry (provided): every connector is a Redis hash connector:{id} with
 * connector_id, tenant, source_type, host, token_ref, status (enabled or disabled), disabled_reason
 * and sync_interval_s. tenant:{tenant}:idem:{key} names the connector a registration with that
 * Idempotency-Key created.
 */
object Store {
  final case class Connector(
      connectorId: String,
      tenant: String,
      sourceType: String,
      host: String,
      tokenRef: String,
      status: String,
      disabledReason: String,
      syncIntervalS: Long)

  val DefaultSyncIntervalS = 900L

  val jedis = new JedisPooled("redis", 6379)

  def connectorKey(connectorId: String): String = s"connector:$connectorId"

  /** The connector's row, if it exists. */
  def get(connectorId: String): Option[Connector] = {
    val raw = jedis.hgetAll(connectorKey(connectorId)).asScala.toMap
    if (raw.isEmpty) None
    else {
      def text(name: String): String = raw.getOrElse(name, "")
      Some(Connector(text("connector_id"), text("tenant"), text("source_type"), text("host"), text("token_ref"), text("status"),
        text("disabled_reason"), text("sync_interval_s").toLongOption.getOrElse(DefaultSyncIntervalS)))
    }
  }

  /** A new enabled connector; returns its row. */
  def create(tenant: String, sourceType: String, host: String, tokenRef: String, syncIntervalS: Long): Connector = {
    val connectorId = s"c-\${jedis.incr("connector:seq")}"
    jedis.hset(connectorKey(connectorId), Map(
      "connector_id" -> connectorId, "tenant" -> tenant, "source_type" -> sourceType, "host" -> host, "token_ref" -> tokenRef,
      "status" -> "enabled", "disabled_reason" -> "", "sync_interval_s" -> syncIntervalS.toString).asJava)
    get(connectorId).get
  }

  /** The connector the tenant's registration with this Idempotency-Key created, if any. */
  def findByKey(tenant: String, key: String): Option[Connector] =
    Option(jedis.get(s"tenant:$tenant:idem:$key")).flatMap(get)

  /** Record that the tenant's registration with this Idempotency-Key created connectorId. */
  def rememberKey(tenant: String, key: String, connectorId: String): Unit =
    jedis.set(s"tenant:$tenant:idem:$key", connectorId)

  /** Stop the connector's syncs, with a reason an operator can read. */
  def disable(connectorId: String, reason: String): Unit =
    jedis.hset(connectorKey(connectorId), Map("status" -> "disabled", "disabled_reason" -> reason).asJava)
}
`,
  [scalaPath('hub', 'Ledger')]: `package hub

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The sync ledger (provided; step 2 builds the same two functions): cursor:{connector_id} is the
 * connector's durable checkpoint, page:{connector_id}:{page_token} the claim of one page. commitPage
 * claims the page and moves the cursor in one Lua script; a page already claimed changes nothing and
 * reports the cursor the ledger holds.
 */
object Ledger {
  final case class Commit(applied: Boolean, cursor: String)

  val jedis = new JedisPooled("redis", 6379)

  val CommitLua: String =
    """if redis.call('SET', KEYS[1], '1', 'NX') then
      |  redis.call('SET', KEYS[2], ARGV[1])
      |  return {'1', ARGV[1]}
      |end
      |return {'0', redis.call('GET', KEYS[2]) or ''}
      |""".stripMargin

  def cursorKey(connectorId: String): String = s"cursor:$connectorId"
  def pageKey(connectorId: String, pageToken: String): String = s"page:$connectorId:$pageToken"

  /** The checkpoint the connector's next sync starts from, if it has one. */
  def loadCursor(connectorId: String): Option[String] = Option(jedis.get(cursorKey(connectorId)))

  /** Claim the page and move the cursor to nextCursor; cursor is what the ledger holds. */
  def commitPage(connectorId: String, pageToken: String, nextCursor: String): Commit = {
    val keys = List(pageKey(connectorId, pageToken), cursorKey(connectorId)).asJava
    val reply = jedis.eval(CommitLua, keys, List(nextCursor).asJava).asInstanceOf[java.util.List[AnyRef]].asScala.map(String.valueOf)
    Commit(reply.head == "1", reply(1))
  }
}
`,
};
