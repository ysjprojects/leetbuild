/**
 * Hand-written support modules the product-catalog steps import but no step builds: the `catalog`
 * package. `catalog.store` is the versions store (every product is a sequence of version rows in
 * Redis hashes, the course's stand-in for the catalog database): drafts, published versions, the
 * recorded publish actions. `catalog.snapshot` is the published pointer of step 2 as later steps use
 * it: `publish_snapshot` (the compare-and-set swap) and `read_published`. The five languages keep
 * the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'catalog/__init__.py': '',
  'catalog/store.py': `"""
The versions store (provided): every product is a sequence of version rows, each a Redis hash
product:{id}:v{n} with product_id, version, status (draft, published or archived), title,
price_cents and tax_class (an unset field is ""). product:{id} holds the product's draft,
published and latest version numbers; product:{id}:publish:{key} the recorded result of a
publish action. A row is returned as a dict: an unset field is None, price_cents is an int.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

FIELDS = ("title", "price_cents", "tax_class")


def row_key(product_id: str, version: int) -> str:
    return f"product:{product_id}:v{version}"


def _row(raw: dict) -> dict | None:
    if not raw:
        return None
    row = {"product_id": raw["product_id"], "version": int(raw["version"]), "status": raw["status"]}
    for name in FIELDS:
        value = raw.get(name, "")
        row[name] = None if value == "" else (int(value) if name == "price_cents" else value)
    return row


def _pointer(product_id: str, which: str) -> int | None:
    value = r.hget(f"product:{product_id}", which)
    return int(value) if value else None


def _write_fields(product_id: str, version: int, fields: dict) -> None:
    mapping = {name: ("" if fields[name] is None else str(fields[name])) for name in FIELDS if name in fields}
    if mapping:
        r.hset(row_key(product_id, version), mapping=mapping)


def version(product_id: str, n: int) -> dict | None:
    """Version n of the product, or None."""
    return _row(r.hgetall(row_key(product_id, n)))


def create(title: str) -> dict:
    """A new product whose version 1 is its draft; returns the row."""
    product_id = f"p-{r.incr('product:seq')}"
    r.hset(
        row_key(product_id, 1),
        mapping={"product_id": product_id, "version": 1, "status": "draft", "title": title, "price_cents": "", "tax_class": ""},
    )
    r.hset(f"product:{product_id}", mapping={"draft": 1, "published": "", "latest": 1})
    return version(product_id, 1)


def draft_of(product_id: str) -> dict | None:
    """The product's draft row, or None when its latest version is live."""
    n = _pointer(product_id, "draft")
    return version(product_id, n) if n else None


def published_of(product_id: str) -> dict | None:
    """The product's published row, or None when nothing was published yet."""
    n = _pointer(product_id, "published")
    return version(product_id, n) if n else None


def latest(product_id: str) -> dict | None:
    """The product's newest row, whatever its status."""
    n = _pointer(product_id, "latest")
    return version(product_id, n) if n else None


def upsert(product_id: str, fields: dict) -> dict:
    """The pre-versioning writer the bulk importer still uses: writes fields into the product's latest row in place, whatever its status."""
    row = latest(product_id)
    if row is None:
        raise KeyError(product_id)
    _write_fields(product_id, row["version"], fields)
    return version(product_id, row["version"])


def write_draft(product_id: str, fields: dict) -> dict:
    """Writes fields into the draft row; when the product has none (its latest version is live), opens the next version as a draft copied from the published row first."""
    draft = draft_of(product_id)
    if draft is None:
        base = latest(product_id)
        if base is None:
            raise KeyError(product_id)
        n = base["version"] + 1
        r.hset(row_key(product_id, n), mapping={**r.hgetall(row_key(product_id, base["version"])), "version": n, "status": "draft"})
        r.hset(f"product:{product_id}", mapping={"draft": n, "latest": n})
        draft = version(product_id, n)
    _write_fields(product_id, draft["version"], fields)
    return version(product_id, draft["version"])


def promote(product_id: str, n: int) -> dict:
    """Marks version n published (the previously published row becomes archived) and clears the draft pointer; returns the row."""
    previous = _pointer(product_id, "published")
    if previous and previous != n:
        r.hset(row_key(product_id, previous), "status", "archived")
    r.hset(row_key(product_id, n), "status", "published")
    r.hset(f"product:{product_id}", mapping={"published": n, "draft": ""})
    return version(product_id, n)


def publish_result(product_id: str, key: str) -> dict | None:
    """The result recorded for the publish action (product_id, key), if any."""
    raw = r.get(f"product:{product_id}:publish:{key}")
    return json.loads(raw) if raw else None


def record_publish(product_id: str, key: str, result: dict) -> None:
    """Record what the publish action (product_id, key) answered, for its replays."""
    r.set(f"product:{product_id}:publish:{key}", json.dumps(result))
`,
  'catalog/snapshot.py': `"""
The published pointer (provided; step 2 builds the same two functions): catalog:{id}:v{n} is the
whole published snapshot of a version as one JSON document, catalog:{id}:published the version the
storefront serves. publish_snapshot writes the snapshot, then moves the pointer in one Lua script
only if it still holds the version the caller expected (None: nothing published yet); it reports
whether the pointer moved. read_published resolves the pointer once and loads exactly that snapshot.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SWAP_LUA = """
local current = redis.call('GET', KEYS[1]) or ''
if current ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
"""
swap = r.register_script(SWAP_LUA)


def snapshot_key(product_id: str, version: int) -> str:
    return f"catalog:{product_id}:v{version}"


def pointer_key(product_id: str) -> str:
    return f"catalog:{product_id}:published"


def publish_snapshot(product_id: str, version: int, snapshot: dict, expected: int | None) -> bool:
    """Write the whole snapshot under its own key, then swap the pointer if it still holds expected."""
    r.set(snapshot_key(product_id, version), json.dumps(snapshot))
    return swap(keys=[pointer_key(product_id)], args=[version, "" if expected is None else expected]) == 1


def read_published(product_id: str) -> dict | None:
    """The published snapshot: one pointer read, then exactly that version."""
    version = r.get(pointer_key(product_id))
    if version is None:
        return None
    raw = r.get(snapshot_key(product_id, int(version)))
    return json.loads(raw) if raw else None
`,
};

export const supportModulesTs: Record<string, string> = {
  'catalog/store.ts': `/**
 * The versions store (provided): every product is a sequence of version rows, each a Redis hash
 * product:{id}:v{n} with product_id, version, status (draft, published or archived), title,
 * price_cents and tax_class (an unset field is ""). product:{id} holds the product's draft,
 * published and latest version numbers; product:{id}:publish:{key} the recorded result of a
 * publish action. A Row has an unset field as null and price_cents as a number.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const FIELDS = ['title', 'price_cents', 'tax_class'] as const;

export interface Fields {
  title?: string | null;
  price_cents?: number | null;
  tax_class?: string | null;
}

export interface Row {
  product_id: string;
  version: number;
  status: string;
  title: string | null;
  price_cents: number | null;
  tax_class: string | null;
}

export const rowKey = (productId: string, version: number): string => \`product:\${productId}:v\${version}\`;

function row(raw: Record<string, string>): Row | null {
  if (Object.keys(raw).length === 0) return null;
  const text = (name: string): string | null => (raw[name] === undefined || raw[name] === '' ? null : raw[name]);
  const price = text('price_cents');
  return {
    product_id: raw.product_id,
    version: Number(raw.version),
    status: raw.status,
    title: text('title'),
    price_cents: price === null ? null : Number(price),
    tax_class: text('tax_class'),
  };
}

async function pointer(productId: string, which: string): Promise<number | null> {
  const value = await redis.hget(\`product:\${productId}\`, which);
  return value ? Number(value) : null;
}

async function writeFields(productId: string, version: number, fields: Fields): Promise<void> {
  const mapping: Record<string, string> = {};
  for (const name of FIELDS) {
    if (fields[name] !== undefined) mapping[name] = fields[name] === null ? '' : String(fields[name]);
  }
  if (Object.keys(mapping).length > 0) await redis.hset(rowKey(productId, version), mapping);
}

/** Version n of the product, or null. */
export async function version(productId: string, n: number): Promise<Row | null> {
  return row(await redis.hgetall(rowKey(productId, n)));
}

/** A new product whose version 1 is its draft; returns the row. */
export async function create(title: string): Promise<Row> {
  const productId = \`p-\${await redis.incr('product:seq')}\`;
  await redis.hset(rowKey(productId, 1), {product_id: productId, version: '1', status: 'draft', title, price_cents: '', tax_class: ''});
  await redis.hset(\`product:\${productId}\`, {draft: '1', published: '', latest: '1'});
  return (await version(productId, 1)) as Row;
}

/** The product's draft row, or null when its latest version is live. */
export async function draftOf(productId: string): Promise<Row | null> {
  const n = await pointer(productId, 'draft');
  return n === null ? null : version(productId, n);
}

/** The product's published row, or null when nothing was published yet. */
export async function publishedOf(productId: string): Promise<Row | null> {
  const n = await pointer(productId, 'published');
  return n === null ? null : version(productId, n);
}

/** The product's newest row, whatever its status. */
export async function latest(productId: string): Promise<Row | null> {
  const n = await pointer(productId, 'latest');
  return n === null ? null : version(productId, n);
}

/** The pre-versioning writer the bulk importer still uses: writes fields into the product's latest row in place, whatever its status. */
export async function upsert(productId: string, fields: Fields): Promise<Row> {
  const current = await latest(productId);
  if (current === null) throw new Error(\`no product \${productId}\`);
  await writeFields(productId, current.version, fields);
  return (await version(productId, current.version)) as Row;
}

/** Writes fields into the draft row; when the product has none (its latest version is live), opens the next version as a draft copied from the published row first. */
export async function writeDraft(productId: string, fields: Fields): Promise<Row> {
  let draft = await draftOf(productId);
  if (draft === null) {
    const base = await latest(productId);
    if (base === null) throw new Error(\`no product \${productId}\`);
    const n = base.version + 1;
    const copy = await redis.hgetall(rowKey(productId, base.version));
    await redis.hset(rowKey(productId, n), {...copy, version: String(n), status: 'draft'});
    await redis.hset(\`product:\${productId}\`, {draft: String(n), latest: String(n)});
    draft = (await version(productId, n)) as Row;
  }
  await writeFields(productId, draft.version, fields);
  return (await version(productId, draft.version)) as Row;
}

/** Marks version n published (the previously published row becomes archived) and clears the draft pointer; returns the row. */
export async function promote(productId: string, n: number): Promise<Row> {
  const previous = await pointer(productId, 'published');
  if (previous !== null && previous !== n) await redis.hset(rowKey(productId, previous), 'status', 'archived');
  await redis.hset(rowKey(productId, n), 'status', 'published');
  await redis.hset(\`product:\${productId}\`, {published: String(n), draft: ''});
  return (await version(productId, n)) as Row;
}

/** The result recorded for the publish action (productId, key), if any. */
export async function publishResult(productId: string, key: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(\`product:\${productId}:publish:\${key}\`);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

/** Record what the publish action (productId, key) answered, for its replays. */
export async function recordPublish(productId: string, key: string, result: Record<string, unknown>): Promise<void> {
  await redis.set(\`product:\${productId}:publish:\${key}\`, JSON.stringify(result));
}
`,
  'catalog/snapshot.ts': `/**
 * The published pointer (provided; step 2 builds the same two functions): catalog:{id}:v{n} is the
 * whole published snapshot of a version as one JSON document, catalog:{id}:published the version
 * the storefront serves. publishSnapshot writes the snapshot, then moves the pointer in one Lua
 * script only if it still holds the version the caller expected (null: nothing published yet); it
 * reports whether the pointer moved. readPublished resolves the pointer once and loads exactly that
 * snapshot.
 */
import Redis from 'ioredis';

export const SWAP_LUA = \`
local current = redis.call('GET', KEYS[1]) or ''
if current ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
\`;

interface SwapRedis extends Redis {
  swapPointer(key: string, version: number, expected: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as SwapRedis;
redis.defineCommand('swapPointer', {numberOfKeys: 1, lua: SWAP_LUA});

export const snapshotKey = (productId: string, version: number): string => \`catalog:\${productId}:v\${version}\`;
export const pointerKey = (productId: string): string => \`catalog:\${productId}:published\`;

/** Write the whole snapshot under its own key, then swap the pointer if it still holds expected. */
export async function publishSnapshot(
  productId: string,
  version: number,
  snapshot: Record<string, unknown>,
  expected: number | null,
): Promise<boolean> {
  await redis.set(snapshotKey(productId, version), JSON.stringify(snapshot));
  return (await redis.swapPointer(pointerKey(productId), version, expected === null ? '' : String(expected))) === 1;
}

/** The published snapshot: one pointer read, then exactly that version. */
export async function readPublished(productId: string): Promise<Record<string, unknown> | null> {
  const version = await redis.get(pointerKey(productId));
  if (version === null) return null;
  const raw = await redis.get(snapshotKey(productId, Number(version)));
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'catalog/store/store.go': `// Package store is the versions store (provided): every product is a sequence of version rows,
// each a Redis hash product:{id}:v{n} with product_id, version, status (draft, published or
// archived), title, price_cents and tax_class (an unset field is ""). product:{id} holds the
// product's draft, published and latest version numbers; product:{id}:publish:{key} the recorded
// result of a publish action. A Row has an unset PriceCents as 0 and an unset text field as "".
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Fields are the editable fields of a version: title, price_cents, tax_class (a JSON body decodes into one).
type Fields = map[string]any

// Row is one version of a product.
type Row struct {
	ProductID  string \`json:"product_id"\`
	Version    int    \`json:"version"\`
	Status     string \`json:"status"\`
	Title      string \`json:"title"\`
	PriceCents int64  \`json:"price_cents"\`
	TaxClass   string \`json:"tax_class"\`
}

// RowKey is the hash of version n of a product.
func RowKey(productID string, version int) string {
	return fmt.Sprintf("product:%s:v%d", productID, version)
}

func row(raw map[string]string) *Row {
	if len(raw) == 0 {
		return nil
	}
	version, _ := strconv.Atoi(raw["version"])
	price, _ := strconv.ParseInt(raw["price_cents"], 10, 64)
	return &Row{ProductID: raw["product_id"], Version: version, Status: raw["status"], Title: raw["title"], PriceCents: price, TaxClass: raw["tax_class"]}
}

func pointer(ctx context.Context, productID, which string) int {
	n, _ := strconv.Atoi(rdb.HGet(ctx, "product:"+productID, which).Val())
	return n
}

func writeFields(ctx context.Context, productID string, version int, fields Fields) {
	mapping := map[string]any{}
	for _, name := range []string{"title", "price_cents", "tax_class"} {
		if value, ok := fields[name]; ok {
			if value == nil {
				mapping[name] = ""
			} else if f, isFloat := value.(float64); isFloat {
				mapping[name] = strconv.FormatInt(int64(f), 10)
			} else {
				mapping[name] = fmt.Sprint(value)
			}
		}
	}
	if len(mapping) > 0 {
		rdb.HSet(ctx, RowKey(productID, version), mapping)
	}
}

// Version is version n of the product, or nil.
func Version(ctx context.Context, productID string, n int) *Row {
	return row(rdb.HGetAll(ctx, RowKey(productID, n)).Val())
}

// Create makes a new product whose version 1 is its draft and returns the row.
func Create(ctx context.Context, title string) *Row {
	productID := fmt.Sprintf("p-%d", rdb.Incr(ctx, "product:seq").Val())
	rdb.HSet(ctx, RowKey(productID, 1), map[string]any{"product_id": productID, "version": "1", "status": "draft", "title": title, "price_cents": "", "tax_class": ""})
	rdb.HSet(ctx, "product:"+productID, map[string]any{"draft": "1", "published": "", "latest": "1"})
	return Version(ctx, productID, 1)
}

// DraftOf is the product's draft row, or nil when its latest version is live.
func DraftOf(ctx context.Context, productID string) *Row {
	if n := pointer(ctx, productID, "draft"); n > 0 {
		return Version(ctx, productID, n)
	}
	return nil
}

// PublishedOf is the product's published row, or nil when nothing was published yet.
func PublishedOf(ctx context.Context, productID string) *Row {
	if n := pointer(ctx, productID, "published"); n > 0 {
		return Version(ctx, productID, n)
	}
	return nil
}

// Latest is the product's newest row, whatever its status.
func Latest(ctx context.Context, productID string) *Row {
	if n := pointer(ctx, productID, "latest"); n > 0 {
		return Version(ctx, productID, n)
	}
	return nil
}

// Upsert is the pre-versioning writer the bulk importer still uses: it writes fields into the
// product's latest row in place, whatever its status.
func Upsert(ctx context.Context, productID string, fields Fields) (*Row, error) {
	current := Latest(ctx, productID)
	if current == nil {
		return nil, fmt.Errorf("no product %s", productID)
	}
	writeFields(ctx, productID, current.Version, fields)
	return Version(ctx, productID, current.Version), nil
}

// WriteDraft writes fields into the draft row; when the product has none (its latest version is
// live), it opens the next version as a draft copied from the published row first.
func WriteDraft(ctx context.Context, productID string, fields Fields) (*Row, error) {
	draft := DraftOf(ctx, productID)
	if draft == nil {
		base := Latest(ctx, productID)
		if base == nil {
			return nil, fmt.Errorf("no product %s", productID)
		}
		n := base.Version + 1
		copy := map[string]any{}
		for k, v := range rdb.HGetAll(ctx, RowKey(productID, base.Version)).Val() {
			copy[k] = v
		}
		copy["version"] = strconv.Itoa(n)
		copy["status"] = "draft"
		rdb.HSet(ctx, RowKey(productID, n), copy)
		rdb.HSet(ctx, "product:"+productID, map[string]any{"draft": strconv.Itoa(n), "latest": strconv.Itoa(n)})
		draft = Version(ctx, productID, n)
	}
	writeFields(ctx, productID, draft.Version, fields)
	return Version(ctx, productID, draft.Version), nil
}

// Promote marks version n published (the previously published row becomes archived) and clears
// the draft pointer; it returns the row.
func Promote(ctx context.Context, productID string, n int) *Row {
	if previous := pointer(ctx, productID, "published"); previous > 0 && previous != n {
		rdb.HSet(ctx, RowKey(productID, previous), "status", "archived")
	}
	rdb.HSet(ctx, RowKey(productID, n), "status", "published")
	rdb.HSet(ctx, "product:"+productID, map[string]any{"published": strconv.Itoa(n), "draft": ""})
	return Version(ctx, productID, n)
}

// PublishResult is the result recorded for the publish action (productID, key), if any.
func PublishResult(ctx context.Context, productID, key string) map[string]any {
	raw, err := rdb.Get(ctx, "product:"+productID+":publish:"+key).Result()
	if err != nil {
		return nil
	}
	var result map[string]any
	json.Unmarshal([]byte(raw), &result)
	return result
}

// RecordPublish records what the publish action (productID, key) answered, for its replays.
func RecordPublish(ctx context.Context, productID, key string, result map[string]any) {
	raw, _ := json.Marshal(result)
	rdb.Set(ctx, "product:"+productID+":publish:"+key, raw, 0)
}
`,
  'catalog/snapshot/snapshot.go': `// Package snapshot is the published pointer (provided; step 2 builds the same two functions):
// catalog:{id}:v{n} is the whole published snapshot of a version as one JSON document,
// catalog:{id}:published the version the storefront serves. PublishSnapshot writes the snapshot,
// then moves the pointer in one Lua script only if it still holds the version the caller expected
// (0: nothing published yet); it reports whether the pointer moved. ReadPublished resolves the
// pointer once and loads exactly that snapshot.
package snapshot

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Swap moves the pointer to ARGV[1] only if it still holds ARGV[2] ("" when nothing is published).
var Swap = redis.NewScript(\`
local current = redis.call('GET', KEYS[1]) or ''
if current ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
\`)

// SnapshotKey is where version n of a product is stored whole.
func SnapshotKey(productID string, version int) string {
	return fmt.Sprintf("catalog:%s:v%d", productID, version)
}

// PointerKey holds the version the storefront serves.
func PointerKey(productID string) string {
	return "catalog:" + productID + ":published"
}

// PublishSnapshot writes the whole snapshot under its own key, then swaps the pointer if it still holds expected.
func PublishSnapshot(ctx context.Context, productID string, version int, snapshot map[string]any, expected int) (bool, error) {
	raw, _ := json.Marshal(snapshot)
	if err := rdb.Set(ctx, SnapshotKey(productID, version), raw, 0).Err(); err != nil {
		return false, err
	}
	was := ""
	if expected > 0 {
		was = strconv.Itoa(expected)
	}
	moved, err := Swap.Run(ctx, rdb, []string{PointerKey(productID)}, version, was).Int64()
	return moved == 1, err
}

// ReadPublished is the published snapshot: one pointer read, then exactly that version.
func ReadPublished(ctx context.Context, productID string) (map[string]any, error) {
	version, err := rdb.Get(ctx, PointerKey(productID)).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	n, _ := strconv.Atoi(version)
	raw, err := rdb.Get(ctx, SnapshotKey(productID, n)).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var snapshot map[string]any
	return snapshot, json.Unmarshal([]byte(raw), &snapshot)
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'catalog/store.h': `// The versions store (provided): every product is a sequence of version rows, each a Redis hash
// product:{id}:v{n} with product_id, version, status (draft, published or archived), title,
// price_cents and tax_class (an unset field is ""). product:{id} holds the product's draft,
// published and latest version numbers; product:{id}:publish:{key} the recorded result of a
// publish action. A Row has an unset price_cents as 0 and an unset text field as "". Fields are a
// JSON object (title, price_cents, tax_class), as a request body parses.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>

namespace store {

struct Row {
  std::string product_id;
  long version = 0;
  std::string status;
  std::string title;
  long price_cents = 0;
  std::string tax_class;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string rowKey(const std::string& product_id, long version) {
  return "product:" + product_id + ":v" + std::to_string(version);
}

inline std::optional<Row> version(const std::string& product_id, long n) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(rowKey(product_id, n));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  Row row;
  row.product_id = text("product_id");
  row.version = std::stol(text("version"));
  row.status = text("status");
  row.title = text("title");
  row.price_cents = text("price_cents").empty() ? 0 : std::stol(text("price_cents"));
  row.tax_class = text("tax_class");
  return row;
}

inline long pointer(const std::string& product_id, const std::string& which) {
  const auto value = redis().hget("product:" + product_id, which);
  return value && !value->empty() ? std::stol(*value) : 0;
}

inline void writeFields(const std::string& product_id, long version, const nlohmann::json& fields) {
  std::map<std::string, std::string> mapping;
  for (const char* name : {"title", "price_cents", "tax_class"}) {
    if (!fields.contains(name)) continue;
    const nlohmann::json& value = fields[name];
    mapping[name] = value.is_null() ? "" : value.is_string() ? value.get<std::string>() : value.dump();
  }
  if (!mapping.empty()) redis().hset(rowKey(product_id, version), mapping.begin(), mapping.end());
}

// A new product whose version 1 is its draft; returns the row.
inline Row create(const std::string& title) {
  const std::string product_id = "p-" + std::to_string(redis().incr("product:seq"));
  redis().hset(rowKey(product_id, 1), {{"product_id", product_id}, {"version", "1"}, {"status", "draft"}, {"title", title}, {"price_cents", ""}, {"tax_class", ""}});
  redis().hset("product:" + product_id, {{"draft", "1"}, {"published", ""}, {"latest", "1"}});
  return *version(product_id, 1);
}

// The product's draft row, or none when its latest version is live.
inline std::optional<Row> draftOf(const std::string& product_id) {
  const long n = pointer(product_id, "draft");
  return n ? version(product_id, n) : std::nullopt;
}

// The product's published row, or none when nothing was published yet.
inline std::optional<Row> publishedOf(const std::string& product_id) {
  const long n = pointer(product_id, "published");
  return n ? version(product_id, n) : std::nullopt;
}

// The product's newest row, whatever its status.
inline std::optional<Row> latest(const std::string& product_id) {
  const long n = pointer(product_id, "latest");
  return n ? version(product_id, n) : std::nullopt;
}

// The pre-versioning writer the bulk importer still uses: writes fields into the product's latest
// row in place, whatever its status.
inline Row upsert(const std::string& product_id, const nlohmann::json& fields) {
  const auto current = latest(product_id);
  if (!current) throw std::out_of_range("no product " + product_id);
  writeFields(product_id, current->version, fields);
  return *version(product_id, current->version);
}

// Writes fields into the draft row; when the product has none (its latest version is live), opens
// the next version as a draft copied from the published row first.
inline Row writeDraft(const std::string& product_id, const nlohmann::json& fields) {
  auto draft = draftOf(product_id);
  if (!draft) {
    const auto base = latest(product_id);
    if (!base) throw std::out_of_range("no product " + product_id);
    const long n = base->version + 1;
    std::unordered_map<std::string, std::string> copy = redis().hgetall(rowKey(product_id, base->version));
    copy["version"] = std::to_string(n);
    copy["status"] = "draft";
    redis().hset(rowKey(product_id, n), copy.begin(), copy.end());
    redis().hset("product:" + product_id, {{"draft", std::to_string(n)}, {"latest", std::to_string(n)}});
    draft = version(product_id, n);
  }
  writeFields(product_id, draft->version, fields);
  return *version(product_id, draft->version);
}

// Marks version n published (the previously published row becomes archived) and clears the draft
// pointer; returns the row.
inline Row promote(const std::string& product_id, long n) {
  const long previous = pointer(product_id, "published");
  if (previous && previous != n) redis().hset(rowKey(product_id, previous), "status", "archived");
  redis().hset(rowKey(product_id, n), "status", "published");
  redis().hset("product:" + product_id, {{"published", std::to_string(n)}, {"draft", ""}});
  return *version(product_id, n);
}

// The result recorded for the publish action (product_id, key), if any.
inline std::optional<nlohmann::json> publishResult(const std::string& product_id, const std::string& key) {
  const auto raw = redis().get("product:" + product_id + ":publish:" + key);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// Record what the publish action (product_id, key) answered, for its replays.
inline void recordPublish(const std::string& product_id, const std::string& key, const nlohmann::json& result) {
  redis().set("product:" + product_id + ":publish:" + key, result.dump());
}

}  // namespace store
`,
  'catalog/snapshot.h': `// The published pointer (provided; step 2 builds the same two functions): catalog:{id}:v{n} is
// the whole published snapshot of a version as one JSON document, catalog:{id}:published the
// version the storefront serves. publishSnapshot writes the snapshot, then moves the pointer in one
// Lua script only if it still holds the version the caller expected (0: nothing published yet); it
// reports whether the pointer moved. readPublished resolves the pointer once and loads exactly that
// snapshot.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

namespace snapshot {

inline const std::string kSwapLua = R"lua(
local current = redis.call('GET', KEYS[1]) or ''
if current ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string snapshotKey(const std::string& product_id, long version) {
  return "catalog:" + product_id + ":v" + std::to_string(version);
}

inline std::string pointerKey(const std::string& product_id) { return "catalog:" + product_id + ":published"; }

// Write the whole snapshot under its own key, then swap the pointer if it still holds expected.
inline bool publishSnapshot(const std::string& product_id, long version, const nlohmann::json& snapshot, long expected) {
  redis().set(snapshotKey(product_id, version), snapshot.dump());
  const std::string was = expected > 0 ? std::to_string(expected) : "";
  return redis().eval<long long>(kSwapLua, {pointerKey(product_id)}, {std::to_string(version), was}) == 1;
}

// The published snapshot: one pointer read, then exactly that version.
inline std::optional<nlohmann::json> readPublished(const std::string& product_id) {
  const auto version = redis().get(pointerKey(product_id));
  if (!version) return std::nullopt;
  const auto raw = redis().get(snapshotKey(product_id, std::stol(*version)));
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

}  // namespace snapshot
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('catalog', 'Store')]: `package catalog

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

/**
 * The versions store (provided): every product is a sequence of version rows, each a Redis hash
 * product:{id}:v{n} with product_id, version, status (draft, published or archived), title,
 * price_cents and tax_class (an unset field is ""). product:{id} holds the product's draft,
 * published and latest version numbers; product:{id}:publish:{key} the recorded result of a
 * publish action. A Row has its unset fields as None. Fields are field name → text (a price as
 * its digits).
 */
object Store {
  final case class Row(productId: String, version: Long, status: String, title: Option[String], priceCents: Option[Long], taxClass: Option[String])

  val Fields: Seq[String] = Seq("title", "price_cents", "tax_class")

  val jedis = new JedisPooled("redis", 6379)

  def rowKey(productId: String, version: Long): String = s"product:$productId:v$version"

  private def row(raw: Map[String, String]): Option[Row] =
    if (raw.isEmpty) None
    else {
      def text(name: String): Option[String] = raw.get(name).filter(_.nonEmpty)
      Some(Row(raw("product_id"), raw("version").toLong, raw("status"), text("title"), text("price_cents").map(_.toLong), text("tax_class")))
    }

  private def pointer(productId: String, which: String): Option[Long] =
    Option(jedis.hget(s"product:$productId", which)).filter(_.nonEmpty).map(_.toLong)

  private def writeFields(productId: String, version: Long, fields: Map[String, String]): Unit = {
    val mapping = fields.filter { case (name, _) => Fields.contains(name) }
    if (mapping.nonEmpty) jedis.hset(rowKey(productId, version), mapping.asJava)
  }

  /** Version n of the product, if it exists. */
  def version(productId: String, n: Long): Option[Row] = row(jedis.hgetAll(rowKey(productId, n)).asScala.toMap)

  /** A new product whose version 1 is its draft; returns the row. */
  def create(title: String): Row = {
    val productId = s"p-\${jedis.incr("product:seq")}"
    jedis.hset(rowKey(productId, 1), Map("product_id" -> productId, "version" -> "1", "status" -> "draft", "title" -> title, "price_cents" -> "", "tax_class" -> "").asJava)
    jedis.hset(s"product:$productId", Map("draft" -> "1", "published" -> "", "latest" -> "1").asJava)
    version(productId, 1).get
  }

  /** The product's draft row, or None when its latest version is live. */
  def draftOf(productId: String): Option[Row] = pointer(productId, "draft").flatMap(version(productId, _))

  /** The product's published row, or None when nothing was published yet. */
  def publishedOf(productId: String): Option[Row] = pointer(productId, "published").flatMap(version(productId, _))

  /** The product's newest row, whatever its status. */
  def latest(productId: String): Option[Row] = pointer(productId, "latest").flatMap(version(productId, _))

  /** The pre-versioning writer the bulk importer still uses: writes fields into the product's latest row in place, whatever its status. */
  def upsert(productId: String, fields: Map[String, String]): Row = {
    val current = latest(productId).getOrElse(throw new NoSuchElementException(s"no product $productId"))
    writeFields(productId, current.version, fields)
    version(productId, current.version).get
  }

  /** Writes fields into the draft row; when the product has none (its latest version is live), opens the next version as a draft copied from the published row first. */
  def writeDraft(productId: String, fields: Map[String, String]): Row = {
    val draft = draftOf(productId).getOrElse {
      val base = latest(productId).getOrElse(throw new NoSuchElementException(s"no product $productId"))
      val n = base.version + 1
      val copy = jedis.hgetAll(rowKey(productId, base.version)).asScala.toMap ++ Map("version" -> n.toString, "status" -> "draft")
      jedis.hset(rowKey(productId, n), copy.asJava)
      jedis.hset(s"product:$productId", Map("draft" -> n.toString, "latest" -> n.toString).asJava)
      version(productId, n).get
    }
    writeFields(productId, draft.version, fields)
    version(productId, draft.version).get
  }

  /** Marks version n published (the previously published row becomes archived) and clears the draft pointer; returns the row. */
  def promote(productId: String, n: Long): Row = {
    pointer(productId, "published").filter(_ != n).foreach(previous => jedis.hset(rowKey(productId, previous), "status", "archived"))
    jedis.hset(rowKey(productId, n), "status", "published")
    jedis.hset(s"product:$productId", Map("published" -> n.toString, "draft" -> "").asJava)
    version(productId, n).get
  }

  /** The result recorded for the publish action (productId, key), if any. */
  def publishResult(productId: String, key: String): Option[JsObject] =
    Option(jedis.get(s"product:$productId:publish:$key")).map(_.parseJson.asJsObject)

  /** Record what the publish action (productId, key) answered, for its replays. */
  def recordPublish(productId: String, key: String, result: JsObject): Unit =
    jedis.set(s"product:$productId:publish:$key", result.compactPrint)
}
`,
  [scalaPath('catalog', 'Snapshot')]: `package catalog

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The published pointer (provided; step 2 builds the same two functions): catalog:{id}:v{n} is the
 * whole published snapshot of a version as one JSON document, catalog:{id}:published the version
 * the storefront serves. publishSnapshot writes the snapshot, then moves the pointer in one Lua
 * script only if it still holds the version the caller expected (None: nothing published yet); it
 * reports whether the pointer moved. readPublished resolves the pointer once and loads exactly that
 * snapshot.
 */
object Snapshot {
  val jedis = new JedisPooled("redis", 6379)

  val SwapLua: String =
    """local current = redis.call('GET', KEYS[1]) or ''
      |if current ~= ARGV[2] then return 0 end
      |redis.call('SET', KEYS[1], ARGV[1])
      |return 1
      |""".stripMargin

  def snapshotKey(productId: String, version: Long): String = s"catalog:$productId:v$version"
  def pointerKey(productId: String): String = s"catalog:$productId:published"

  /** Write the whole snapshot under its own key, then swap the pointer if it still holds expected. */
  def publishSnapshot(productId: String, version: Long, snapshot: JsObject, expected: Option[Long]): Boolean = {
    jedis.set(snapshotKey(productId, version), snapshot.compactPrint)
    val args = List(version.toString, expected.map(_.toString).getOrElse("")).asJava
    jedis.eval(SwapLua, List(pointerKey(productId)).asJava, args).asInstanceOf[java.lang.Long] == 1L
  }

  /** The published snapshot: one pointer read, then exactly that version. */
  def readPublished(productId: String): Option[JsObject] =
    Option(jedis.get(pointerKey(productId))).flatMap(version => Option(jedis.get(snapshotKey(productId, version.toLong)))).map(_.parseJson.asJsObject)
}
`,
};
