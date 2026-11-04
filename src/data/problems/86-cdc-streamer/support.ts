/**
 * Hand-written support modules the cdc-streamer steps import but no step builds: the `cdc` package.
 * `cdc.store` is the subscription store and the source catalog: subscriptions as Redis hashes, the
 * Idempotency-Key records of their creates, the tables each tenant may stream, their columns and
 * the sensitive ones, and `digest`, the SHA-256 a change event carries instead of a row.
 * `cdc.cursor` is the LSN cursor of step 2 as the later steps use it: `confirm` (a monotonic
 * compare-and-set in Lua) and `load_cursor`. The five languages keep the same keys, so a harness
 * reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'cdc/__init__.py': '',
  'cdc/store.py': `"""
The subscription store and the source catalog (provided). A subscription is a Redis hash
cdc:sub:{id} with id, tenant, table, columns (a comma list), sink, slot and status (active, or
slot_lost once its replication slot is gone); cdc:idem:{tenant}:{key} names the subscription a
create with that Idempotency-Key made. The catalog says which tables each tenant may stream, the
columns of every table of the source database, and which of them are sensitive. A subscription is
returned as a dict with columns as a list.
"""
import hashlib

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

APPROVED_TABLES = {"acme": ["orders", "customers", "invoices"], "globex": ["orders", "invoices"]}
SCHEMA = {
    "orders": ["id", "customer_id", "status", "total_cents"],
    "customers": ["id", "name", "email", "country"],
    "invoices": ["id", "order_id", "amount_cents", "tax_id"],
    "auth_users": ["id", "email", "password_hash"],
    "sessions": ["id", "user_id", "token"],
}
SENSITIVE = {"customers": ["email"], "invoices": ["tax_id"], "auth_users": ["email", "password_hash"], "sessions": ["token"]}


def approved_tables(tenant: str) -> list[str]:
    """The tables the tenant's data agreement lets it stream."""
    return list(APPROVED_TABLES.get(tenant, []))


def table_columns(table: str) -> list[str] | None:
    """The table's columns in the source database, or None when there is no such table."""
    columns = SCHEMA.get(table)
    return None if columns is None else list(columns)


def sensitive_columns(table: str) -> list[str]:
    """The table's columns no subscription may stream."""
    return list(SENSITIVE.get(table, []))


def _subscription(raw: dict) -> dict | None:
    if not raw:
        return None
    return {
        "id": raw["id"],
        "tenant": raw["tenant"],
        "table": raw["table"],
        "columns": raw["columns"].split(",") if raw["columns"] else [],
        "sink": raw["sink"],
        "slot": raw["slot"],
        "status": raw["status"],
    }


def create_subscription(tenant: str, table: str, columns: list[str], sink: str) -> dict:
    """A new active subscription sub-{n} with its own replication slot cdc_sub_{n}; returns it."""
    n = r.incr("cdc:sub:seq")
    subscription_id = f"sub-{n}"
    r.hset(
        f"cdc:sub:{subscription_id}",
        mapping={"id": subscription_id, "tenant": tenant, "table": table, "columns": ",".join(columns), "sink": sink, "slot": f"cdc_sub_{n}", "status": "active"},
    )
    return find_subscription(subscription_id)


def find_subscription(subscription_id: str) -> dict | None:
    """The subscription, whoever owns it, or None."""
    return _subscription(r.hgetall(f"cdc:sub:{subscription_id}"))


def find_by_key(tenant: str, key: str) -> dict | None:
    """The subscription a create of the tenant with this Idempotency-Key made, if any."""
    subscription_id = r.get(f"cdc:idem:{tenant}:{key}")
    return None if subscription_id is None else find_subscription(subscription_id)


def record_key(tenant: str, key: str, subscription_id: str) -> None:
    """Remember which subscription the create (tenant, key) made, for its replays."""
    r.set(f"cdc:idem:{tenant}:{key}", subscription_id)


def set_status(subscription_id: str, status: str) -> None:
    r.hset(f"cdc:sub:{subscription_id}", "status", status)


def digest(row: str) -> str:
    """The SHA-256 of a row's JSON text, hex; "" when there is no row."""
    return hashlib.sha256(row.encode()).hexdigest() if row else ""
`,
  'cdc/cursor.py': `"""
The LSN cursor (provided; step 2 builds the same functions): cdc:cursor:{subscription}:{table} holds
the last LSN the sink applied for that table, without expiry. confirm moves it forward in one Lua
compare-and-set and never back; it reports whether it moved. load_cursor is None before the first
confirmation.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

ADVANCE_LUA = """
local current = redis.call('GET', KEYS[1])
if current and tonumber(current) >= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
"""
advance = r.register_script(ADVANCE_LUA)


def cursor_key(subscription_id: str, table: str) -> str:
    return f"cdc:cursor:{subscription_id}:{table}"


def confirm(subscription_id: str, table: str, lsn: int) -> bool:
    """Record that the sink applied the table's changes up to lsn; whether the cursor moved."""
    return advance(keys=[cursor_key(subscription_id, table)], args=[lsn]) == 1


def load_cursor(subscription_id: str, table: str) -> int | None:
    """The last confirmed LSN of the table, or None before the first confirmation."""
    value = r.get(cursor_key(subscription_id, table))
    return None if value is None else int(value)
`,
};

export const supportModulesTs: Record<string, string> = {
  'cdc/store.ts': `/**
 * The subscription store and the source catalog (provided). A subscription is a Redis hash
 * cdc:sub:{id} with id, tenant, table, columns (a comma list), sink, slot and status (active, or
 * slot_lost once its replication slot is gone); cdc:idem:{tenant}:{key} names the subscription a
 * create with that Idempotency-Key made. The catalog says which tables each tenant may stream, the
 * columns of every table of the source database, and which of them are sensitive.
 */
import {createHash} from 'crypto';
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Subscription {
  id: string;
  tenant: string;
  table: string;
  columns: string[];
  sink: string;
  slot: string;
  status: string;
}

const APPROVED_TABLES: Record<string, string[]> = {acme: ['orders', 'customers', 'invoices'], globex: ['orders', 'invoices']};
const SCHEMA: Record<string, string[]> = {
  orders: ['id', 'customer_id', 'status', 'total_cents'],
  customers: ['id', 'name', 'email', 'country'],
  invoices: ['id', 'order_id', 'amount_cents', 'tax_id'],
  auth_users: ['id', 'email', 'password_hash'],
  sessions: ['id', 'user_id', 'token'],
};
const SENSITIVE: Record<string, string[]> = {customers: ['email'], invoices: ['tax_id'], auth_users: ['email', 'password_hash'], sessions: ['token']};

/** The tables the tenant's data agreement lets it stream. */
export const approvedTables = (tenant: string): string[] => [...(APPROVED_TABLES[tenant] ?? [])];

/** The table's columns in the source database, or null when there is no such table. */
export const tableColumns = (table: string): string[] | null => (SCHEMA[table] === undefined ? null : [...SCHEMA[table]]);

/** The table's columns no subscription may stream. */
export const sensitiveColumns = (table: string): string[] => [...(SENSITIVE[table] ?? [])];

function subscriptionOf(raw: Record<string, string>): Subscription | null {
  if (Object.keys(raw).length === 0) return null;
  return {
    id: raw.id,
    tenant: raw.tenant,
    table: raw.table,
    columns: raw.columns ? raw.columns.split(',') : [],
    sink: raw.sink,
    slot: raw.slot,
    status: raw.status,
  };
}

/** A new active subscription sub-{n} with its own replication slot cdc_sub_{n}; returns it. */
export async function createSubscription(tenant: string, table: string, columns: string[], sink: string): Promise<Subscription> {
  const n = await redis.incr('cdc:sub:seq');
  const id = \`sub-\${n}\`;
  await redis.hset(\`cdc:sub:\${id}\`, {id, tenant, table, columns: columns.join(','), sink, slot: \`cdc_sub_\${n}\`, status: 'active'});
  return (await findSubscription(id)) as Subscription;
}

/** The subscription, whoever owns it, or null. */
export async function findSubscription(id: string): Promise<Subscription | null> {
  return subscriptionOf(await redis.hgetall(\`cdc:sub:\${id}\`));
}

/** The subscription a create of the tenant with this Idempotency-Key made, if any. */
export async function findByKey(tenant: string, key: string): Promise<Subscription | null> {
  const id = await redis.get(\`cdc:idem:\${tenant}:\${key}\`);
  return id === null ? null : findSubscription(id);
}

/** Remember which subscription the create (tenant, key) made, for its replays. */
export async function recordKey(tenant: string, key: string, id: string): Promise<void> {
  await redis.set(\`cdc:idem:\${tenant}:\${key}\`, id);
}

export async function setStatus(id: string, status: string): Promise<void> {
  await redis.hset(\`cdc:sub:\${id}\`, 'status', status);
}

/** The SHA-256 of a row's JSON text, hex; "" when there is no row. */
export const digest = (row: string): string => (row ? createHash('sha256').update(row).digest('hex') : '');
`,
  'cdc/cursor.ts': `/**
 * The LSN cursor (provided; step 2 builds the same functions): cdc:cursor:{subscription}:{table}
 * holds the last LSN the sink applied for that table, without expiry. confirm moves it forward in
 * one Lua compare-and-set and never back; it reports whether it moved. loadCursor is null before
 * the first confirmation.
 */
import Redis from 'ioredis';

export const ADVANCE_LUA = \`
local current = redis.call('GET', KEYS[1])
if current and tonumber(current) >= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
\`;

interface CursorRedis extends Redis {
  advanceCursor(key: string, lsn: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as CursorRedis;
redis.defineCommand('advanceCursor', {numberOfKeys: 1, lua: ADVANCE_LUA});

export const cursorKey = (subscriptionId: string, table: string): string => \`cdc:cursor:\${subscriptionId}:\${table}\`;

/** Record that the sink applied the table's changes up to lsn; whether the cursor moved. */
export async function confirm(subscriptionId: string, table: string, lsn: number): Promise<boolean> {
  return (await redis.advanceCursor(cursorKey(subscriptionId, table), lsn)) === 1;
}

/** The last confirmed LSN of the table, or null before the first confirmation. */
export async function loadCursor(subscriptionId: string, table: string): Promise<number | null> {
  const value = await redis.get(cursorKey(subscriptionId, table));
  return value === null ? null : Number(value);
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'cdc/store/store.go': `// Package store is the subscription store and the source catalog (provided). A subscription is a
// Redis hash cdc:sub:{id} with id, tenant, table, columns (a comma list), sink, slot and status
// (active, or slot_lost once its replication slot is gone); cdc:idem:{tenant}:{key} names the
// subscription a create with that Idempotency-Key made. The catalog says which tables each tenant
// may stream, the columns of every table of the source database, and which of them are sensitive.
package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Subscription is one tenant's stream of one table to one sink.
type Subscription struct {
	ID      string   \`json:"id"\`
	Tenant  string   \`json:"tenant"\`
	Table   string   \`json:"table"\`
	Columns []string \`json:"columns"\`
	Sink    string   \`json:"sink"\`
	Slot    string   \`json:"slot"\`
	Status  string   \`json:"status"\`
}

var approvedTables = map[string][]string{"acme": {"orders", "customers", "invoices"}, "globex": {"orders", "invoices"}}

var schema = map[string][]string{
	"orders":     {"id", "customer_id", "status", "total_cents"},
	"customers":  {"id", "name", "email", "country"},
	"invoices":   {"id", "order_id", "amount_cents", "tax_id"},
	"auth_users": {"id", "email", "password_hash"},
	"sessions":   {"id", "user_id", "token"},
}

var sensitive = map[string][]string{"customers": {"email"}, "invoices": {"tax_id"}, "auth_users": {"email", "password_hash"}, "sessions": {"token"}}

// ApprovedTables are the tables the tenant's data agreement lets it stream.
func ApprovedTables(tenant string) []string { return append([]string{}, approvedTables[tenant]...) }

// TableColumns are the table's columns in the source database; false when there is no such table.
func TableColumns(table string) ([]string, bool) {
	columns, ok := schema[table]
	return append([]string{}, columns...), ok
}

// SensitiveColumns are the table's columns no subscription may stream.
func SensitiveColumns(table string) []string { return append([]string{}, sensitive[table]...) }

// CreateSubscription makes a new active subscription sub-{n} with its own replication slot cdc_sub_{n}.
func CreateSubscription(ctx context.Context, tenant, table string, columns []string, sink string) (*Subscription, error) {
	n, err := rdb.Incr(ctx, "cdc:sub:seq").Result()
	if err != nil {
		return nil, err
	}
	id := fmt.Sprintf("sub-%d", n)
	err = rdb.HSet(ctx, "cdc:sub:"+id, map[string]any{
		"id": id, "tenant": tenant, "table": table, "columns": strings.Join(columns, ","), "sink": sink,
		"slot": fmt.Sprintf("cdc_sub_%d", n), "status": "active",
	}).Err()
	if err != nil {
		return nil, err
	}
	return FindSubscription(ctx, id), nil
}

// FindSubscription is the subscription, whoever owns it, or nil.
func FindSubscription(ctx context.Context, id string) *Subscription {
	raw := rdb.HGetAll(ctx, "cdc:sub:"+id).Val()
	if len(raw) == 0 {
		return nil
	}
	columns := []string{}
	if raw["columns"] != "" {
		columns = strings.Split(raw["columns"], ",")
	}
	return &Subscription{ID: raw["id"], Tenant: raw["tenant"], Table: raw["table"], Columns: columns, Sink: raw["sink"], Slot: raw["slot"], Status: raw["status"]}
}

// FindByKey is the subscription a create of the tenant with this Idempotency-Key made, or nil.
func FindByKey(ctx context.Context, tenant, key string) *Subscription {
	id, err := rdb.Get(ctx, "cdc:idem:"+tenant+":"+key).Result()
	if err != nil {
		return nil
	}
	return FindSubscription(ctx, id)
}

// RecordKey remembers which subscription the create (tenant, key) made, for its replays.
func RecordKey(ctx context.Context, tenant, key, id string) error {
	return rdb.Set(ctx, "cdc:idem:"+tenant+":"+key, id, 0).Err()
}

// SetStatus sets the subscription's status (active, slot_lost).
func SetStatus(ctx context.Context, id, status string) error {
	return rdb.HSet(ctx, "cdc:sub:"+id, "status", status).Err()
}

// Digest is the SHA-256 of a row's JSON text, hex; "" when there is no row.
func Digest(row string) string {
	if row == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(row))
	return hex.EncodeToString(sum[:])
}
`,
  'cdc/cursor/cursor.go': `// Package cursor is the LSN cursor (provided; step 2 builds the same functions):
// cdc:cursor:{subscription}:{table} holds the last LSN the sink applied for that table, without
// expiry. Confirm moves it forward in one Lua compare-and-set and never back; it reports whether it
// moved. LoadCursor reports false before the first confirmation.
package cursor

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Advance sets KEYS[1] to ARGV[1] only if that is past the LSN it holds.
var Advance = redis.NewScript(\`
local current = redis.call('GET', KEYS[1])
if current and tonumber(current) >= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
\`)

// CursorKey is where the table's confirmed LSN lives.
func CursorKey(subscriptionID, table string) string {
	return "cdc:cursor:" + subscriptionID + ":" + table
}

// Confirm records that the sink applied the table's changes up to lsn; whether the cursor moved.
func Confirm(ctx context.Context, subscriptionID, table string, lsn int64) (bool, error) {
	moved, err := Advance.Run(ctx, rdb, []string{CursorKey(subscriptionID, table)}, lsn).Int64()
	return moved == 1, err
}

// LoadCursor is the last confirmed LSN of the table; false before the first confirmation.
func LoadCursor(ctx context.Context, subscriptionID, table string) (int64, bool, error) {
	value, err := rdb.Get(ctx, CursorKey(subscriptionID, table)).Result()
	if err == redis.Nil {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	lsn, err := strconv.ParseInt(value, 10, 64)
	return lsn, err == nil, err
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'cdc/store.h': `// The subscription store and the source catalog (provided). A subscription is a Redis hash
// cdc:sub:{id} with id, tenant, table, columns (a comma list), sink, slot and status (active, or
// slot_lost once its replication slot is gone); cdc:idem:{tenant}:{key} names the subscription a
// create with that Idempotency-Key made. The catalog says which tables each tenant may stream, the
// columns of every table of the source database, and which of them are sensitive.
#pragma once

#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include <cstdio>
#include <map>
#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

struct Subscription {
  std::string id;
  std::string tenant;
  std::string table;
  std::vector<std::string> columns;
  std::string sink;
  std::string slot;
  std::string status;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline const std::map<std::string, std::vector<std::string>> kApproved = {{"acme", {"orders", "customers", "invoices"}},
                                                                         {"globex", {"orders", "invoices"}}};
inline const std::map<std::string, std::vector<std::string>> kSchema = {
    {"orders", {"id", "customer_id", "status", "total_cents"}},
    {"customers", {"id", "name", "email", "country"}},
    {"invoices", {"id", "order_id", "amount_cents", "tax_id"}},
    {"auth_users", {"id", "email", "password_hash"}},
    {"sessions", {"id", "user_id", "token"}}};
inline const std::map<std::string, std::vector<std::string>> kSensitive = {
    {"customers", {"email"}}, {"invoices", {"tax_id"}}, {"auth_users", {"email", "password_hash"}}, {"sessions", {"token"}}};

// The tables the tenant's data agreement lets it stream.
inline std::vector<std::string> approvedTables(const std::string& tenant) {
  const auto it = kApproved.find(tenant);
  return it == kApproved.end() ? std::vector<std::string>{} : it->second;
}

// The table's columns in the source database, or none when there is no such table.
inline std::optional<std::vector<std::string>> tableColumns(const std::string& table) {
  const auto it = kSchema.find(table);
  if (it == kSchema.end()) return std::nullopt;
  return it->second;
}

// The table's columns no subscription may stream.
inline std::vector<std::string> sensitiveColumns(const std::string& table) {
  const auto it = kSensitive.find(table);
  return it == kSensitive.end() ? std::vector<std::string>{} : it->second;
}

// The subscription as the API answers it.
inline nlohmann::json toJson(const Subscription& s) {
  return nlohmann::json{{"id", s.id},     {"tenant", s.tenant}, {"table", s.table},  {"columns", s.columns},
                        {"sink", s.sink}, {"slot", s.slot},     {"status", s.status}};
}

// The subscription, whoever owns it, or none.
inline std::optional<Subscription> findSubscription(const std::string& id) {
  std::unordered_map<std::string, std::string> raw = redis().hgetall("cdc:sub:" + id);
  if (raw.empty()) return std::nullopt;
  Subscription s{raw["id"], raw["tenant"], raw["table"], {}, raw["sink"], raw["slot"], raw["status"]};
  std::stringstream columns(raw["columns"]);
  for (std::string column; std::getline(columns, column, ',');) s.columns.push_back(column);
  return s;
}

// A new active subscription sub-{n} with its own replication slot cdc_sub_{n}; returns it.
inline Subscription createSubscription(const std::string& tenant, const std::string& table, const std::vector<std::string>& columns,
                                       const std::string& sink) {
  const std::string n = std::to_string(redis().incr("cdc:sub:seq"));
  std::string joined;
  for (const auto& column : columns) joined += (joined.empty() ? "" : ",") + column;
  redis().hset("cdc:sub:sub-" + n, {{"id", "sub-" + n}, {"tenant", tenant}, {"table", table}, {"columns", joined},
                                    {"sink", sink}, {"slot", "cdc_sub_" + n}, {"status", "active"}});
  return *findSubscription("sub-" + n);
}

// The subscription a create of the tenant with this Idempotency-Key made, if any.
inline std::optional<Subscription> findByKey(const std::string& tenant, const std::string& key) {
  const auto id = redis().get("cdc:idem:" + tenant + ":" + key);
  if (!id) return std::nullopt;
  return findSubscription(*id);
}

// Remember which subscription the create (tenant, key) made, for its replays.
inline void recordKey(const std::string& tenant, const std::string& key, const std::string& id) {
  redis().set("cdc:idem:" + tenant + ":" + key, id);
}

inline void setStatus(const std::string& id, const std::string& status) { redis().hset("cdc:sub:" + id, "status", status); }

// The SHA-256 of a row's JSON text, hex; "" when there is no row.
inline std::string digest(const std::string& row) {
  if (row.empty()) return "";
  unsigned char sum[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(row.data()), row.size(), sum);
  std::string hex;
  char byte[3];
  for (unsigned char c : sum) {
    std::snprintf(byte, sizeof byte, "%02x", c);
    hex += byte;
  }
  return hex;
}

}  // namespace store
`,
  'cdc/cursor.h': `// The LSN cursor (provided; step 2 builds the same functions): cdc:cursor:{subscription}:{table}
// holds the last LSN the sink applied for that table, without expiry. confirm moves it forward in
// one Lua compare-and-set and never back; it reports whether it moved. loadCursor is none before
// the first confirmation.
#pragma once

#include <sw/redis++/redis++.h>

#include <cstdint>
#include <optional>
#include <string>

namespace cursor {

inline const std::string kAdvanceLua = R"lua(
local current = redis.call('GET', KEYS[1])
if current and tonumber(current) >= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string cursorKey(const std::string& subscription_id, const std::string& table) {
  return "cdc:cursor:" + subscription_id + ":" + table;
}

// Record that the sink applied the table's changes up to lsn; whether the cursor moved.
inline bool confirm(const std::string& subscription_id, const std::string& table, int64_t lsn) {
  return redis().eval<long long>(kAdvanceLua, {cursorKey(subscription_id, table)}, {std::to_string(lsn)}) == 1;
}

// The last confirmed LSN of the table, or none before the first confirmation.
inline std::optional<int64_t> loadCursor(const std::string& subscription_id, const std::string& table) {
  const auto value = redis().get(cursorKey(subscription_id, table));
  if (!value) return std::nullopt;
  return std::stoll(*value);
}

}  // namespace cursor
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('cdc', 'Store')]: `package cdc

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The subscription store and the source catalog (provided). A subscription is a Redis hash
 * cdc:sub:{id} with id, tenant, table, columns (a comma list), sink, slot and status (active, or
 * slot_lost once its replication slot is gone); cdc:idem:{tenant}:{key} names the subscription a
 * create with that Idempotency-Key made. The catalog says which tables each tenant may stream, the
 * columns of every table of the source database, and which of them are sensitive.
 */
object Store {
  final case class Subscription(id: String, tenant: String, table: String, columns: Seq[String], sink: String, slot: String, status: String)

  val jedis = new JedisPooled("redis", 6379)

  private val Approved = Map("acme" -> Seq("orders", "customers", "invoices"), "globex" -> Seq("orders", "invoices"))
  private val Schema = Map(
    "orders" -> Seq("id", "customer_id", "status", "total_cents"),
    "customers" -> Seq("id", "name", "email", "country"),
    "invoices" -> Seq("id", "order_id", "amount_cents", "tax_id"),
    "auth_users" -> Seq("id", "email", "password_hash"),
    "sessions" -> Seq("id", "user_id", "token"))
  private val Sensitive = Map("customers" -> Seq("email"), "invoices" -> Seq("tax_id"), "auth_users" -> Seq("email", "password_hash"), "sessions" -> Seq("token"))

  /** The tables the tenant's data agreement lets it stream. */
  def approvedTables(tenant: String): Seq[String] = Approved.getOrElse(tenant, Seq.empty)

  /** The table's columns in the source database, or None when there is no such table. */
  def tableColumns(table: String): Option[Seq[String]] = Schema.get(table)

  /** The table's columns no subscription may stream. */
  def sensitiveColumns(table: String): Seq[String] = Sensitive.getOrElse(table, Seq.empty)

  /** The subscription as the API answers it. */
  def toJson(s: Subscription): JsObject = JsObject(
    "id" -> JsString(s.id), "tenant" -> JsString(s.tenant), "table" -> JsString(s.table),
    "columns" -> JsArray(s.columns.map(JsString(_)).toVector), "sink" -> JsString(s.sink),
    "slot" -> JsString(s.slot), "status" -> JsString(s.status))

  /** The subscription, whoever owns it, if it exists. */
  def findSubscription(id: String): Option[Subscription] = {
    val raw = jedis.hgetAll(s"cdc:sub:$id").asScala.toMap
    if (raw.isEmpty) None
    else {
      val columns = if (raw("columns").isEmpty) Seq.empty else raw("columns").split(",").toSeq
      Some(Subscription(raw("id"), raw("tenant"), raw("table"), columns, raw("sink"), raw("slot"), raw("status")))
    }
  }

  /** A new active subscription sub-{n} with its own replication slot cdc_sub_{n}; returns it. */
  def createSubscription(tenant: String, table: String, columns: Seq[String], sink: String): Subscription = {
    val n = jedis.incr("cdc:sub:seq")
    val id = s"sub-$n"
    jedis.hset(s"cdc:sub:$id", Map("id" -> id, "tenant" -> tenant, "table" -> table, "columns" -> columns.mkString(","),
      "sink" -> sink, "slot" -> s"cdc_sub_$n", "status" -> "active").asJava)
    findSubscription(id).get
  }

  /** The subscription a create of the tenant with this Idempotency-Key made, if any. */
  def findByKey(tenant: String, key: String): Option[Subscription] =
    Option(jedis.get(s"cdc:idem:$tenant:$key")).flatMap(findSubscription)

  /** Remember which subscription the create (tenant, key) made, for its replays. */
  def recordKey(tenant: String, key: String, id: String): Unit = jedis.set(s"cdc:idem:$tenant:$key", id)

  def setStatus(id: String, status: String): Unit = jedis.hset(s"cdc:sub:$id", "status", status)

  /** The SHA-256 of a row's JSON text, hex; "" when there is no row. */
  def digest(row: String): String =
    if (row.isEmpty) ""
    else MessageDigest.getInstance("SHA-256").digest(row.getBytes(StandardCharsets.UTF_8)).map(b => f"\${b & 0xff}%02x").mkString
}
`,
  [scalaPath('cdc', 'Cursor')]: `package cdc

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The LSN cursor (provided; step 2 builds the same functions): cdc:cursor:{subscription}:{table}
 * holds the last LSN the sink applied for that table, without expiry. confirm moves it forward in
 * one Lua compare-and-set and never back; it reports whether it moved. loadCursor is None before
 * the first confirmation.
 */
object Cursor {
  val jedis = new JedisPooled("redis", 6379)

  val AdvanceLua: String =
    """local current = redis.call('GET', KEYS[1])
      |if current and tonumber(current) >= tonumber(ARGV[1]) then return 0 end
      |redis.call('SET', KEYS[1], ARGV[1])
      |return 1
      |""".stripMargin

  def cursorKey(subscriptionId: String, table: String): String = s"cdc:cursor:$subscriptionId:$table"

  /** Record that the sink applied the table's changes up to lsn; whether the cursor moved. */
  def confirm(subscriptionId: String, table: String, lsn: Long): Boolean =
    jedis.eval(AdvanceLua, List(cursorKey(subscriptionId, table)).asJava, List(lsn.toString).asJava).asInstanceOf[java.lang.Long] == 1L

  /** The last confirmed LSN of the table, or None before the first confirmation. */
  def loadCursor(subscriptionId: String, table: String): Option[Long] = Option(jedis.get(cursorKey(subscriptionId, table))).map(_.toLong)
}
`,
};
