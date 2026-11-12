/**
 * Hand-written support modules the catalog-enrichment steps import but no step builds: the
 * `enrich` package. `enrich.taxonomy` is the brand and category taxonomy (the course's stand-in for
 * the knowledge graph): its version, the retrieval of candidate brands, the allowed units and the
 * attribute schema the model answers to. `enrich.store` is the catalog's state in Redis, shared by
 * every step: content hashes, review proposals and leases, labels, the catalog and search-index
 * rows, and the outbox. The five languages keep the same keys, so a harness reads one layout
 * whatever the stack.
 */
import {scalaPath} from '../scala-support';

const SCHEMA =
  '{"type":"object","properties":{"brand":{"type":["string","null"]},"size":{"type":["number","null"]},"unit":{"type":["string","null"]},"organic":{"type":"boolean"},"category":{"type":["string","null"]}},"required":["brand","size","unit","organic","category"],"additionalProperties":false}';

const BRANDS = [
  'Dove',
  'Dove Men+Care',
  'Oatly',
  'Silk',
  'Califia Farms',
  'Horizon Organic',
  'Chobani',
  'Fage',
  'Tide',
  'Persil',
  'Barilla',
  'De Cecco',
  "Kellogg's",
  'Nature Valley',
  'Clif',
  'KIND',
  "Lay's",
  'Doritos',
  'Heinz',
  "Hellmann's",
  'Colgate',
  'Crest',
  'Pantene',
  'Head & Shoulders',
  'Olay',
  'Nivea',
  'Coca-Cola',
  'Pepsi',
  'LaCroix',
  'Evian',
];

const CATEGORIES = [
  'body-wash',
  'soap',
  'plant-milk',
  'yogurt',
  'laundry',
  'pasta',
  'cereal',
  'snacks',
  'condiments',
  'oral-care',
  'hair-care',
  'skin-care',
  'soft-drinks',
  'water',
];

const UNITS = ['ml', 'l', 'g', 'kg', 'oz', 'fl oz', 'lb', 'ct'];

const quoted = (items: string[]): string => items.map(s => JSON.stringify(s)).join(', ');

const TAXONOMY_DOC = `The brand and category taxonomy (provided): the course's stand-in for the knowledge graph behind the
catalog. VERSION names the release every extraction is valid under. nearest_brands is the retrieval
step 2 runs before the model: brands ranked by how many lower-case alphanumeric tokens they share
with the text (the stand-in for an embedding search), ties in BRANDS order. ATTRIBUTE_SCHEMA is the
JSON schema the extractor answers to.`;

const STORE_DOC = `The catalog's state in Redis (provided), shared by every step:

  sku:{sku_id}                   hash: content_hash (step 1), attributes_version (the per-SKU counter)
  proposal:{sku_id}              hash: a model result waiting for a reviewer (step 2 writes it, step 4
                                 reads it): merchant, attributes (JSON), confidence, taxonomy_version, reason
  review:queue                   list of the SKU ids with a proposal
  review:lease:{sku_id}          the reviewer holding the SKU (step 3 takes it, step 4 checks it)
  label:{sku_id}:v{n}            hash: one reviewer decision (decision, attributes JSON,
                                 taxonomy_version, reviewer); label:{sku_id}:seq numbers them
  review:idem:{reviewer}:{key}   the answer to a review request, for its retries (24 h)
  catalog:{sku_id}, search:{sku_id}  hash: attributes (JSON), attributes_version, source,
                                 taxonomy_version: what the shop and the search index serve (step 5)
  outbox:enriched                list of {"event", "reason"} JSON rows a relay republishes

content_hash is the identity of a SKU version: the SHA-256 hex of merchant, title, description and
the sorted image refs, one per line.`;

const lines = (doc: string, prefix: string): string =>
  doc
    .split('\n')
    .map(l => (l === '' ? prefix.trimEnd() : prefix + l))
    .join('\n');

export const supportModules: Record<string, string> = {
  'enrich/__init__.py': '',
  'enrich/taxonomy.py': `"""
${TAXONOMY_DOC}
"""
import re

VERSION = "tx-2026.11"

BRANDS = (
    ${quoted(BRANDS)},
)
CATEGORIES = (${quoted(CATEGORIES)})
ALLOWED_UNITS = (${quoted(UNITS)})
ATTRIBUTE_SCHEMA = '${SCHEMA}'


def _tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", text.lower()))


def nearest_brands(text: str, k: int) -> list[str]:
    """The k brands nearest to the text, nearest first."""
    words = _tokens(text)
    return sorted(BRANDS, key=lambda brand: -len(_tokens(brand) & words))[:k]


def has_category(category: str) -> bool:
    return category in CATEGORIES
`,
  'enrich/store.py': `"""
${STORE_DOC}
"""
import hashlib
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RELEASE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
"""
_release = r.register_script(RELEASE_LUA)


def content_hash(merchant: str, title: str, description: str, images: list[str]) -> str:
    canonical = "\\n".join([merchant, title, description, *sorted(images)])
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def last_hash(sku_id: str) -> str | None:
    """The content hash of the version last enqueued for this SKU, if any."""
    return r.hget(f"sku:{sku_id}", "content_hash")


def put_hash(sku_id: str, digest: str) -> None:
    r.hset(f"sku:{sku_id}", "content_hash", digest)


def next_version(sku_id: str) -> int:
    """The next attributes_version of this SKU: 1, 2, 3, …"""
    return r.hincrby(f"sku:{sku_id}", "attributes_version", 1)


def enqueue_review(result: dict, reason: str) -> None:
    """Park a model result (sku_id, merchant, attributes, confidence, taxonomy_version) for a reviewer."""
    r.hset(
        f"proposal:{result['sku_id']}",
        mapping={
            "merchant": result["merchant"],
            "attributes": json.dumps(result["attributes"]),
            "confidence": result["confidence"],
            "taxonomy_version": result["taxonomy_version"],
            "reason": reason,
        },
    )
    r.rpush("review:queue", result["sku_id"])


def pending(sku_id: str) -> dict | None:
    """The proposal waiting for review: sku_id, merchant, attributes, confidence, taxonomy_version, reason."""
    raw = r.hgetall(f"proposal:{sku_id}")
    if not raw:
        return None
    return {
        "sku_id": sku_id,
        "merchant": raw["merchant"],
        "attributes": json.loads(raw["attributes"]),
        "confidence": float(raw["confidence"]),
        "taxonomy_version": raw["taxonomy_version"],
        "reason": raw.get("reason", ""),
    }


def drop_proposal(sku_id: str) -> None:
    r.delete(f"proposal:{sku_id}")
    r.lrem("review:queue", 0, sku_id)


def lease_holder(sku_id: str) -> str | None:
    """The reviewer holding the SKU's review lease, if any."""
    return r.get(f"review:lease:{sku_id}")


def release_lease(sku_id: str, reviewer: str) -> bool:
    """Delete the lease only while this reviewer still holds it."""
    return _release(keys=[f"review:lease:{sku_id}"], args=[reviewer]) == 1


def put_label(sku_id: str, decision: str, attributes: dict, taxonomy_version: str, reviewer: str) -> int:
    """Store one reviewer decision as a labelled example; returns its version (1, 2, …)."""
    n = r.incr(f"label:{sku_id}:seq")
    r.hset(
        f"label:{sku_id}:v{n}",
        mapping={"decision": decision, "attributes": json.dumps(attributes), "taxonomy_version": taxonomy_version, "reviewer": reviewer},
    )
    return n


def read_label(sku_id: str, n: int) -> dict | None:
    raw = r.hgetall(f"label:{sku_id}:v{n}")
    if not raw:
        return None
    return {**raw, "attributes": json.loads(raw["attributes"])}


def review_result(reviewer: str, key: str) -> dict | None:
    """The answer recorded for this reviewer's Idempotency-Key, if any."""
    raw = r.get(f"review:idem:{reviewer}:{key}")
    return json.loads(raw) if raw else None


def record_review(reviewer: str, key: str, response: dict) -> None:
    r.set(f"review:idem:{reviewer}:{key}", json.dumps(response), ex=86400)


def _entry(raw: dict) -> dict | None:
    if not raw:
        return None
    return {
        "attributes": json.loads(raw["attributes"]),
        "attributes_version": int(raw["attributes_version"]),
        "source": raw["source"],
        "taxonomy_version": raw["taxonomy_version"],
    }


def _write(key: str, event: dict) -> None:
    r.hset(
        key,
        mapping={
            "attributes": json.dumps(event["attributes"]),
            "attributes_version": event["attributes_version"],
            "source": event["source"],
            "taxonomy_version": event["taxonomy_version"],
        },
    )


def catalog_current(sku_id: str) -> dict | None:
    """What the shop serves: attributes, attributes_version, source, taxonomy_version."""
    return _entry(r.hgetall(f"catalog:{sku_id}"))


def apply_catalog(event: dict) -> None:
    _write(f"catalog:{event['sku_id']}", event)


def search_entry(sku_id: str) -> dict | None:
    return _entry(r.hgetall(f"search:{sku_id}"))


def index_upsert(event: dict) -> None:
    _write(f"search:{event['sku_id']}", event)


def insert_outbox(event: dict, reason: str) -> None:
    """An sku.enriched event the broker refused: a relay produces it later."""
    r.rpush("outbox:enriched", json.dumps({"event": event, "reason": reason}))
`,
};

export const supportModulesTs: Record<string, string> = {
  'enrich/taxonomy.ts': `/**
${lines(TAXONOMY_DOC, ' * ')}
 */
export const VERSION = 'tx-2026.11';

export const BRANDS: readonly string[] = [
  ${BRANDS.map(b => JSON.stringify(b)).join(',\n  ')},
];
export const CATEGORIES: readonly string[] = [${quoted(CATEGORIES).replace(/"/g, "'")}];
export const ALLOWED_UNITS: readonly string[] = [${quoted(UNITS).replace(/"/g, "'")}];
export const ATTRIBUTE_SCHEMA = '${SCHEMA}';

const tokens = (text: string): Set<string> => new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/** The k brands nearest to the text, nearest first. */
export function nearestBrands(text: string, k: number): string[] {
  const words = tokens(text);
  const score = (brand: string): number => [...tokens(brand)].filter(t => words.has(t)).length;
  return [...BRANDS].sort((a, b) => score(b) - score(a)).slice(0, k);
}

export const hasCategory = (category: string): boolean => CATEGORIES.includes(category);
`,
  'enrich/store.ts': `/**
${lines(STORE_DOC, ' * ')}
 */
import {createHash} from 'node:crypto';

import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export type Attributes = Record<string, unknown>;

/** A SKU version on sku.extract (step 1 → step 2). */
export interface Job {
  sku_id: string;
  merchant: string;
  content_hash: string;
  title: string;
  description: string;
  images: string[];
}

/** What an extraction answers (step 2), as step 3 caches it. */
export interface Result {
  sku_id: string;
  merchant: string;
  attributes: Attributes;
  confidence: number;
  taxonomy_version: string;
  source: 'model';
  status: 'accepted' | 'review';
}

/** One sku.enriched record (steps 4 and 5). */
export interface EnrichedEvent {
  sku_id: string;
  merchant: string;
  attributes: Attributes;
  attributes_version: number;
  taxonomy_version: string;
  source: 'model' | 'human';
}

export interface Proposal {
  sku_id: string;
  merchant: string;
  attributes: Attributes;
  confidence: number;
  taxonomy_version: string;
  reason: string;
}

/** A catalog or search-index row. */
export interface Entry {
  attributes: Attributes;
  attributes_version: number;
  source: string;
  taxonomy_version: string;
}

const RELEASE_LUA = \`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
\`;

export function contentHash(merchant: string, title: string, description: string, images: string[]): string {
  const canonical = [merchant, title, description, ...[...images].sort()].join('\\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** The content hash of the version last enqueued for this SKU, or null. */
export const lastHash = (skuId: string): Promise<string | null> => redis.hget(\`sku:\${skuId}\`, 'content_hash');

export async function putHash(skuId: string, digest: string): Promise<void> {
  await redis.hset(\`sku:\${skuId}\`, 'content_hash', digest);
}

/** The next attributes_version of this SKU: 1, 2, 3, … */
export const nextVersion = (skuId: string): Promise<number> => redis.hincrby(\`sku:\${skuId}\`, 'attributes_version', 1);

/** Park a model result for a reviewer. */
export async function enqueueReview(result: Result, reason: string): Promise<void> {
  await redis.hset(\`proposal:\${result.sku_id}\`, {
    merchant: result.merchant,
    attributes: JSON.stringify(result.attributes),
    confidence: String(result.confidence),
    taxonomy_version: result.taxonomy_version,
    reason,
  });
  await redis.rpush('review:queue', result.sku_id);
}

/** The proposal waiting for review, or null. */
export async function pending(skuId: string): Promise<Proposal | null> {
  const raw = await redis.hgetall(\`proposal:\${skuId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {
    sku_id: skuId,
    merchant: raw.merchant,
    attributes: JSON.parse(raw.attributes) as Attributes,
    confidence: Number(raw.confidence),
    taxonomy_version: raw.taxonomy_version,
    reason: raw.reason ?? '',
  };
}

export async function dropProposal(skuId: string): Promise<void> {
  await redis.del(\`proposal:\${skuId}\`);
  await redis.lrem('review:queue', 0, skuId);
}

/** The reviewer holding the SKU's review lease, or null. */
export const leaseHolder = (skuId: string): Promise<string | null> => redis.get(\`review:lease:\${skuId}\`);

/** Delete the lease only while this reviewer still holds it. */
export async function releaseLease(skuId: string, reviewer: string): Promise<boolean> {
  return (await redis.eval(RELEASE_LUA, 1, \`review:lease:\${skuId}\`, reviewer)) === 1;
}

/** Store one reviewer decision as a labelled example; returns its version (1, 2, …). */
export async function putLabel(skuId: string, decision: string, attributes: Attributes, taxonomyVersion: string, reviewer: string): Promise<number> {
  const n = await redis.incr(\`label:\${skuId}:seq\`);
  await redis.hset(\`label:\${skuId}:v\${n}\`, {decision, attributes: JSON.stringify(attributes), taxonomy_version: taxonomyVersion, reviewer});
  return n;
}

export async function readLabel(skuId: string, n: number): Promise<Record<string, unknown> | null> {
  const raw = await redis.hgetall(\`label:\${skuId}:v\${n}\`);
  if (Object.keys(raw).length === 0) return null;
  return {...raw, attributes: JSON.parse(raw.attributes)};
}

/** The answer recorded for this reviewer's Idempotency-Key, or null. */
export async function reviewResult(reviewer: string, key: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(\`review:idem:\${reviewer}:\${key}\`);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

export async function recordReview(reviewer: string, key: string, response: Record<string, unknown>): Promise<void> {
  await redis.set(\`review:idem:\${reviewer}:\${key}\`, JSON.stringify(response), 'EX', 86400);
}

function entry(raw: Record<string, string>): Entry | null {
  if (Object.keys(raw).length === 0) return null;
  return {
    attributes: JSON.parse(raw.attributes) as Attributes,
    attributes_version: Number(raw.attributes_version),
    source: raw.source,
    taxonomy_version: raw.taxonomy_version,
  };
}

async function write(key: string, event: EnrichedEvent): Promise<void> {
  await redis.hset(key, {
    attributes: JSON.stringify(event.attributes),
    attributes_version: String(event.attributes_version),
    source: event.source,
    taxonomy_version: event.taxonomy_version,
  });
}

/** What the shop serves, or null. */
export const catalogCurrent = async (skuId: string): Promise<Entry | null> => entry(await redis.hgetall(\`catalog:\${skuId}\`));
export const applyCatalog = (event: EnrichedEvent): Promise<void> => write(\`catalog:\${event.sku_id}\`, event);
export const searchEntry = async (skuId: string): Promise<Entry | null> => entry(await redis.hgetall(\`search:\${skuId}\`));
export const indexUpsert = (event: EnrichedEvent): Promise<void> => write(\`search:\${event.sku_id}\`, event);

/** An sku.enriched event the broker refused: a relay produces it later. */
export async function insertOutbox(event: EnrichedEvent, reason: string): Promise<void> {
  await redis.rpush('outbox:enriched', JSON.stringify({event, reason}));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'enrich/taxonomy/taxonomy.go': `// Package taxonomy is the brand and category taxonomy (provided): the course's stand-in for the
// knowledge graph behind the catalog. Version names the release every extraction is valid under.
// NearestBrands is the retrieval step 2 runs before the model: brands ranked by how many lower-case
// alphanumeric tokens they share with the text (the stand-in for an embedding search), ties in
// Brands order. AttributeSchema is the JSON schema the extractor answers to.
package taxonomy

import (
	"regexp"
	"sort"
	"strings"
)

const Version = "tx-2026.11"

var Brands = []string{
	${BRANDS.map(b => JSON.stringify(b)).join(',\n\t')},
}

var Categories = []string{${quoted(CATEGORIES)}}

var AllowedUnits = []string{${quoted(UNITS)}}

const AttributeSchema = \`${SCHEMA}\`

var word = regexp.MustCompile(\`[a-z0-9]+\`)

func tokens(text string) map[string]bool {
	out := map[string]bool{}
	for _, t := range word.FindAllString(strings.ToLower(text), -1) {
		out[t] = true
	}
	return out
}

// NearestBrands is the k brands nearest to the text, nearest first.
func NearestBrands(text string, k int) []string {
	words := tokens(text)
	score := func(brand string) int {
		n := 0
		for t := range tokens(brand) {
			if words[t] {
				n++
			}
		}
		return n
	}
	ranked := append([]string{}, Brands...)
	sort.SliceStable(ranked, func(i, j int) bool { return score(ranked[i]) > score(ranked[j]) })
	if k < len(ranked) {
		ranked = ranked[:k]
	}
	return ranked
}

func HasCategory(category string) bool {
	for _, c := range Categories {
		if c == category {
			return true
		}
	}
	return false
}
`,
  'enrich/store/store.go': `${lines(STORE_DOC.replace('The catalog', 'Package store is the catalog'), '// ')}
package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Job is a SKU version on sku.extract (step 1 → step 2).
type Job struct {
	SkuID       string   \`json:"sku_id"\`
	Merchant    string   \`json:"merchant"\`
	ContentHash string   \`json:"content_hash"\`
	Title       string   \`json:"title"\`
	Description string   \`json:"description"\`
	Images      []string \`json:"images"\`
}

// Result is what an extraction answers (step 2), as step 3 caches it.
type Result struct {
	SkuID           string         \`json:"sku_id"\`
	Merchant        string         \`json:"merchant"\`
	Attributes      map[string]any \`json:"attributes"\`
	Confidence      float64        \`json:"confidence"\`
	TaxonomyVersion string         \`json:"taxonomy_version"\`
	Source          string         \`json:"source"\`
	Status          string         \`json:"status"\`
}

// Event is one sku.enriched record (steps 4 and 5).
type Event struct {
	SkuID             string         \`json:"sku_id"\`
	Merchant          string         \`json:"merchant"\`
	Attributes        map[string]any \`json:"attributes"\`
	AttributesVersion int64          \`json:"attributes_version"\`
	TaxonomyVersion   string         \`json:"taxonomy_version"\`
	Source            string         \`json:"source"\`
}

// Proposal is a model result waiting for a reviewer.
type Proposal struct {
	SkuID           string
	Merchant        string
	Attributes      map[string]any
	Confidence      float64
	TaxonomyVersion string
	Reason          string
}

// Entry is a catalog or search-index row.
type Entry struct {
	Attributes        map[string]any
	AttributesVersion int64
	Source            string
	TaxonomyVersion   string
}

var release = redis.NewScript(\`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
\`)

func ContentHash(merchant, title, description string, images []string) string {
	sorted := append([]string{}, images...)
	sort.Strings(sorted)
	canonical := strings.Join(append([]string{merchant, title, description}, sorted...), "\\n")
	sum := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(sum[:])
}

// LastHash is the content hash of the version last enqueued for this SKU; ok is false when there is none.
func LastHash(ctx context.Context, skuID string) (string, bool) {
	v, err := rdb.HGet(ctx, "sku:"+skuID, "content_hash").Result()
	return v, err == nil
}

func PutHash(ctx context.Context, skuID, digest string) error {
	return rdb.HSet(ctx, "sku:"+skuID, "content_hash", digest).Err()
}

// NextVersion is the next attributes_version of this SKU: 1, 2, 3, …
func NextVersion(ctx context.Context, skuID string) (int64, error) {
	return rdb.HIncrBy(ctx, "sku:"+skuID, "attributes_version", 1).Result()
}

// EnqueueReview parks a model result for a reviewer.
func EnqueueReview(ctx context.Context, result Result, reason string) error {
	attributes, _ := json.Marshal(result.Attributes)
	if err := rdb.HSet(ctx, "proposal:"+result.SkuID, "merchant", result.Merchant, "attributes", string(attributes),
		"confidence", strconv.FormatFloat(result.Confidence, 'f', -1, 64), "taxonomy_version", result.TaxonomyVersion, "reason", reason).Err(); err != nil {
		return err
	}
	return rdb.RPush(ctx, "review:queue", result.SkuID).Err()
}

// Pending is the proposal waiting for review, or nil.
func Pending(ctx context.Context, skuID string) *Proposal {
	raw := rdb.HGetAll(ctx, "proposal:"+skuID).Val()
	if len(raw) == 0 {
		return nil
	}
	p := &Proposal{SkuID: skuID, Merchant: raw["merchant"], TaxonomyVersion: raw["taxonomy_version"], Reason: raw["reason"]}
	json.Unmarshal([]byte(raw["attributes"]), &p.Attributes)
	p.Confidence, _ = strconv.ParseFloat(raw["confidence"], 64)
	return p
}

func DropProposal(ctx context.Context, skuID string) error {
	if err := rdb.Del(ctx, "proposal:"+skuID).Err(); err != nil {
		return err
	}
	return rdb.LRem(ctx, "review:queue", 0, skuID).Err()
}

// LeaseHolder is the reviewer holding the SKU's review lease; ok is false when nobody does.
func LeaseHolder(ctx context.Context, skuID string) (string, bool) {
	v, err := rdb.Get(ctx, "review:lease:"+skuID).Result()
	return v, err == nil
}

// ReleaseLease deletes the lease only while this reviewer still holds it.
func ReleaseLease(ctx context.Context, skuID, reviewer string) (bool, error) {
	n, err := release.Run(ctx, rdb, []string{"review:lease:" + skuID}, reviewer).Int64()
	return n == 1, err
}

// PutLabel stores one reviewer decision as a labelled example; it returns its version (1, 2, …).
func PutLabel(ctx context.Context, skuID, decision string, attributes map[string]any, taxonomyVersion, reviewer string) (int64, error) {
	n, err := rdb.Incr(ctx, "label:"+skuID+":seq").Result()
	if err != nil {
		return 0, err
	}
	encoded, _ := json.Marshal(attributes)
	err = rdb.HSet(ctx, fmt.Sprintf("label:%s:v%d", skuID, n), "decision", decision, "attributes", string(encoded),
		"taxonomy_version", taxonomyVersion, "reviewer", reviewer).Err()
	return n, err
}

// ReadLabel is label n of the SKU (decision, attributes, taxonomy_version, reviewer), or nil.
func ReadLabel(ctx context.Context, skuID string, n int64) map[string]any {
	raw := rdb.HGetAll(ctx, fmt.Sprintf("label:%s:v%d", skuID, n)).Val()
	if len(raw) == 0 {
		return nil
	}
	out := map[string]any{"decision": raw["decision"], "taxonomy_version": raw["taxonomy_version"], "reviewer": raw["reviewer"]}
	var attributes map[string]any
	json.Unmarshal([]byte(raw["attributes"]), &attributes)
	out["attributes"] = attributes
	return out
}

// ReviewResult is the answer recorded for this reviewer's Idempotency-Key, or nil.
func ReviewResult(ctx context.Context, reviewer, key string) map[string]any {
	raw, err := rdb.Get(ctx, "review:idem:"+reviewer+":"+key).Result()
	if err != nil {
		return nil
	}
	var out map[string]any
	json.Unmarshal([]byte(raw), &out)
	return out
}

func RecordReview(ctx context.Context, reviewer, key string, response map[string]any) error {
	encoded, _ := json.Marshal(response)
	return rdb.Set(ctx, "review:idem:"+reviewer+":"+key, string(encoded), 24*time.Hour).Err()
}

func entry(raw map[string]string) *Entry {
	if len(raw) == 0 {
		return nil
	}
	e := &Entry{Source: raw["source"], TaxonomyVersion: raw["taxonomy_version"]}
	json.Unmarshal([]byte(raw["attributes"]), &e.Attributes)
	e.AttributesVersion, _ = strconv.ParseInt(raw["attributes_version"], 10, 64)
	return e
}

func write(ctx context.Context, key string, event Event) error {
	attributes, _ := json.Marshal(event.Attributes)
	return rdb.HSet(ctx, key, "attributes", string(attributes), "attributes_version", event.AttributesVersion,
		"source", event.Source, "taxonomy_version", event.TaxonomyVersion).Err()
}

// CatalogCurrent is what the shop serves, or nil.
func CatalogCurrent(ctx context.Context, skuID string) *Entry {
	return entry(rdb.HGetAll(ctx, "catalog:"+skuID).Val())
}

func ApplyCatalog(ctx context.Context, event Event) error { return write(ctx, "catalog:"+event.SkuID, event) }

// SearchEntry is what the search index serves, or nil.
func SearchEntry(ctx context.Context, skuID string) *Entry {
	return entry(rdb.HGetAll(ctx, "search:"+skuID).Val())
}

func IndexUpsert(ctx context.Context, event Event) error { return write(ctx, "search:"+event.SkuID, event) }

// InsertOutbox keeps an sku.enriched event the broker refused: a relay produces it later.
func InsertOutbox(ctx context.Context, event Event, reason string) error {
	row, _ := json.Marshal(map[string]any{"event": event, "reason": reason})
	return rdb.RPush(ctx, "outbox:enriched", string(row)).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'enrich/taxonomy.h': `${lines(
    TAXONOMY_DOC.replace('VERSION', 'kVersion')
      .replace('nearest_brands', 'nearest_brands')
      .replace('BRANDS order', 'kBrands order')
      .replace('ATTRIBUTE_SCHEMA', 'kAttributeSchema'),
    '// ',
  )}
#pragma once

#include <algorithm>
#include <cctype>
#include <set>
#include <string>
#include <vector>

namespace taxonomy {

inline const std::string kVersion = "tx-2026.11";

inline const std::vector<std::string> kBrands = {
    ${BRANDS.map(b => JSON.stringify(b)).join(',\n    ')},
};

inline const std::vector<std::string> kCategories = {${quoted(CATEGORIES)}};

inline const std::vector<std::string> kAllowedUnits = {${quoted(UNITS)}};

inline const std::string kAttributeSchema = R"(${SCHEMA})";

inline std::set<std::string> tokens(const std::string& text) {
  std::set<std::string> out;
  std::string current;
  for (const char c : text + " ") {
    const unsigned char u = static_cast<unsigned char>(c);
    if (std::isalnum(u) && u < 128) {
      current += static_cast<char>(std::tolower(u));
    } else if (!current.empty()) {
      out.insert(current);
      current.clear();
    }
  }
  return out;
}

// The k brands nearest to the text, nearest first.
inline std::vector<std::string> nearest_brands(const std::string& text, size_t k) {
  const std::set<std::string> words = tokens(text);
  const auto score = [&words](const std::string& brand) {
    int n = 0;
    for (const std::string& t : tokens(brand)) n += words.count(t) ? 1 : 0;
    return n;
  };
  std::vector<std::string> ranked = kBrands;
  std::stable_sort(ranked.begin(), ranked.end(), [&](const std::string& a, const std::string& b) { return score(a) > score(b); });
  if (k < ranked.size()) ranked.resize(k);
  return ranked;
}

inline bool has_category(const std::string& category) {
  return std::find(kCategories.begin(), kCategories.end(), category) != kCategories.end();
}

}  // namespace taxonomy
`,
  'enrich/store.h': `${lines(STORE_DOC, '// ')}
//
// Jobs, results, events, proposals and catalog rows are JSON objects with the fields the Python
// and TypeScript modules give them (an event: sku_id, merchant, attributes, attributes_version,
// taxonomy_version, source).
#pragma once

#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

using json = nlohmann::json;

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline const std::string kReleaseLua = R"(
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
)";

inline std::string content_hash(const std::string& merchant, const std::string& title, const std::string& description,
                                std::vector<std::string> images) {
  std::sort(images.begin(), images.end());
  std::string canonical = merchant + "\\n" + title + "\\n" + description;
  for (const std::string& image : images) canonical += "\\n" + image;
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(canonical.data()), canonical.size(), digest);
  std::string hex;
  char byte[3];
  for (unsigned char c : digest) {
    std::snprintf(byte, sizeof byte, "%02x", c);
    hex += byte;
  }
  return hex;
}

// The content hash of the version last enqueued for this SKU, if any.
inline std::optional<std::string> last_hash(const std::string& sku_id) {
  const auto v = redis().hget("sku:" + sku_id, "content_hash");
  return v ? std::optional<std::string>(*v) : std::nullopt;
}

inline void put_hash(const std::string& sku_id, const std::string& digest) { redis().hset("sku:" + sku_id, "content_hash", digest); }

// The next attributes_version of this SKU: 1, 2, 3, ...
inline long long next_version(const std::string& sku_id) { return redis().hincrby("sku:" + sku_id, "attributes_version", 1); }

// Park a model result (sku_id, merchant, attributes, confidence, taxonomy_version) for a reviewer.
inline void enqueue_review(const json& result, const std::string& reason) {
  const std::string sku_id = result.at("sku_id").get<std::string>();
  redis().hset("proposal:" + sku_id, {std::make_pair(std::string("merchant"), result.at("merchant").get<std::string>()),
                                      std::make_pair(std::string("attributes"), result.at("attributes").dump()),
                                      std::make_pair(std::string("confidence"), json(result.at("confidence").get<double>()).dump()),
                                      std::make_pair(std::string("taxonomy_version"), result.at("taxonomy_version").get<std::string>()),
                                      std::make_pair(std::string("reason"), reason)});
  redis().rpush("review:queue", sku_id);
}

// The proposal waiting for review: sku_id, merchant, attributes, confidence, taxonomy_version, reason.
inline std::optional<json> pending(const std::string& sku_id) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall("proposal:" + sku_id, std::inserter(raw, raw.begin()));
  if (raw.empty()) return std::nullopt;
  return json{{"sku_id", sku_id}, {"merchant", raw["merchant"]}, {"attributes", json::parse(raw["attributes"])},
              {"confidence", std::stod(raw["confidence"])}, {"taxonomy_version", raw["taxonomy_version"]}, {"reason", raw["reason"]}};
}

inline void drop_proposal(const std::string& sku_id) {
  redis().del("proposal:" + sku_id);
  redis().lrem("review:queue", 0, sku_id);
}

// The reviewer holding the SKU's review lease, if any.
inline std::optional<std::string> lease_holder(const std::string& sku_id) {
  const auto v = redis().get("review:lease:" + sku_id);
  return v ? std::optional<std::string>(*v) : std::nullopt;
}

// Delete the lease only while this reviewer still holds it.
inline bool release_lease(const std::string& sku_id, const std::string& reviewer) {
  return redis().eval<long long>(kReleaseLua, {"review:lease:" + sku_id}, {reviewer}) == 1;
}

// Store one reviewer decision as a labelled example; returns its version (1, 2, ...).
inline long long put_label(const std::string& sku_id, const std::string& decision, const json& attributes,
                           const std::string& taxonomy_version, const std::string& reviewer) {
  const long long n = redis().incr("label:" + sku_id + ":seq");
  redis().hset("label:" + sku_id + ":v" + std::to_string(n),
               {std::make_pair(std::string("decision"), decision), std::make_pair(std::string("attributes"), attributes.dump()),
                std::make_pair(std::string("taxonomy_version"), taxonomy_version), std::make_pair(std::string("reviewer"), reviewer)});
  return n;
}

inline std::optional<json> read_label(const std::string& sku_id, long long n) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall("label:" + sku_id + ":v" + std::to_string(n), std::inserter(raw, raw.begin()));
  if (raw.empty()) return std::nullopt;
  return json{{"decision", raw["decision"]}, {"attributes", json::parse(raw["attributes"])},
              {"taxonomy_version", raw["taxonomy_version"]}, {"reviewer", raw["reviewer"]}};
}

// The answer recorded for this reviewer's Idempotency-Key, if any.
inline std::optional<json> review_result(const std::string& reviewer, const std::string& key) {
  const auto raw = redis().get("review:idem:" + reviewer + ":" + key);
  return raw ? std::optional<json>(json::parse(*raw)) : std::nullopt;
}

inline void record_review(const std::string& reviewer, const std::string& key, const json& response) {
  redis().set("review:idem:" + reviewer + ":" + key, response.dump(), std::chrono::hours(24));
}

inline std::optional<json> entry(const std::string& key) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall(key, std::inserter(raw, raw.begin()));
  if (raw.empty()) return std::nullopt;
  return json{{"attributes", json::parse(raw["attributes"])}, {"attributes_version", std::stoll(raw["attributes_version"])},
              {"source", raw["source"]}, {"taxonomy_version", raw["taxonomy_version"]}};
}

inline void write(const std::string& key, const json& event) {
  redis().hset(key, {std::make_pair(std::string("attributes"), event.at("attributes").dump()),
                     std::make_pair(std::string("attributes_version"), std::to_string(event.at("attributes_version").get<long long>())),
                     std::make_pair(std::string("source"), event.at("source").get<std::string>()),
                     std::make_pair(std::string("taxonomy_version"), event.at("taxonomy_version").get<std::string>())});
}

// What the shop serves: attributes, attributes_version, source, taxonomy_version.
inline std::optional<json> catalog_current(const std::string& sku_id) { return entry("catalog:" + sku_id); }
inline void apply_catalog(const json& event) { write("catalog:" + event.at("sku_id").get<std::string>(), event); }
inline std::optional<json> search_entry(const std::string& sku_id) { return entry("search:" + sku_id); }
inline void index_upsert(const json& event) { write("search:" + event.at("sku_id").get<std::string>(), event); }

// An sku.enriched event the broker refused: a relay produces it later.
inline void insert_outbox(const json& event, const std::string& reason) {
  redis().rpush("outbox:enriched", json{{"event", event}, {"reason", reason}}.dump());
}

}  // namespace store
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('enrich', 'Taxonomy')]: `package enrich

/**
${lines(
  TAXONOMY_DOC.replace('VERSION', 'Version')
    .replace('nearest_brands', 'nearestBrands')
    .replace('BRANDS order', 'Brands order')
    .replace('ATTRIBUTE_SCHEMA', 'AttributeSchema'),
  ' * ',
)}
 */
object Taxonomy {
  val Version = "tx-2026.11"

  val Brands: Seq[String] = Seq(
    ${BRANDS.map(b => JSON.stringify(b)).join(',\n    ')},
  )
  val Categories: Set[String] = Set(${quoted(CATEGORIES)})
  val AllowedUnits: Set[String] = Set(${quoted(UNITS)})
  val AttributeSchema: String = """${SCHEMA}"""

  private def tokens(text: String): Set[String] = "[a-z0-9]+".r.findAllIn(text.toLowerCase).toSet

  /** The k brands nearest to the text, nearest first. */
  def nearestBrands(text: String, k: Int): Seq[String] = {
    val words = tokens(text)
    Brands.sortBy(brand => -(tokens(brand) & words).size).take(k)
  }

  def hasCategory(category: String): Boolean = Categories.contains(category)
}
`,
  [scalaPath('enrich', 'Store')]: `package enrich

import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

/**
${lines(STORE_DOC, ' * ')}
 *
 * Jobs, results, events and rows are ujson objects with the fields the Python module gives them.
 */
object Store {
  val jedis = new JedisPooled("redis", 6379)

  private val ReleaseLua =
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0"

  def contentHash(merchant: String, title: String, description: String, images: Seq[String]): String = {
    val canonical = (Seq(merchant, title, description) ++ images.sorted).mkString("\\n")
    MessageDigest.getInstance("SHA-256").digest(canonical.getBytes(UTF_8)).map("%02x".format(_)).mkString
  }

  /** The content hash of the version last enqueued for this SKU, if any. */
  def lastHash(skuId: String): Option[String] = Option(jedis.hget(s"sku:$skuId", "content_hash"))

  def putHash(skuId: String, digest: String): Unit = jedis.hset(s"sku:$skuId", "content_hash", digest)

  /** The next attributes_version of this SKU: 1, 2, 3, … */
  def nextVersion(skuId: String): Long = jedis.hincrBy(s"sku:$skuId", "attributes_version", 1L)

  /** Park a model result (sku_id, merchant, attributes, confidence, taxonomy_version) for a reviewer. */
  def enqueueReview(result: ujson.Obj, reason: String): Unit = {
    val skuId = result("sku_id").str
    jedis.hset(
      s"proposal:$skuId",
      Map(
        "merchant" -> result("merchant").str,
        "attributes" -> ujson.write(result("attributes")),
        "confidence" -> result("confidence").num.toString,
        "taxonomy_version" -> result("taxonomy_version").str,
        "reason" -> reason,
      ).asJava,
    )
    jedis.rpush("review:queue", skuId)
  }

  /** The proposal waiting for review: sku_id, merchant, attributes, confidence, taxonomy_version, reason. */
  def pending(skuId: String): Option[ujson.Obj] = {
    val raw = jedis.hgetAll(s"proposal:$skuId").asScala
    if (raw.isEmpty) None
    else
      Some(
        ujson.Obj(
          "sku_id" -> skuId,
          "merchant" -> raw("merchant"),
          "attributes" -> ujson.read(raw("attributes")),
          "confidence" -> raw("confidence").toDouble,
          "taxonomy_version" -> raw("taxonomy_version"),
          "reason" -> (raw.getOrElse("reason", ""): String),
        )
      )
  }

  def dropProposal(skuId: String): Unit = {
    jedis.del(s"proposal:$skuId")
    jedis.lrem("review:queue", 0L, skuId)
  }

  /** The reviewer holding the SKU's review lease, if any. */
  def leaseHolder(skuId: String): Option[String] = Option(jedis.get(s"review:lease:$skuId"))

  /** Delete the lease only while this reviewer still holds it. */
  def releaseLease(skuId: String, reviewer: String): Boolean =
    jedis.eval(ReleaseLua, List(s"review:lease:$skuId").asJava, List(reviewer).asJava) == 1L

  /** Store one reviewer decision as a labelled example; returns its version (1, 2, …). */
  def putLabel(skuId: String, decision: String, attributes: ujson.Value, taxonomyVersion: String, reviewer: String): Long = {
    val n = jedis.incr(s"label:$skuId:seq")
    jedis.hset(
      s"label:$skuId:v$n",
      Map("decision" -> decision, "attributes" -> ujson.write(attributes), "taxonomy_version" -> taxonomyVersion, "reviewer" -> reviewer).asJava,
    )
    n
  }

  def readLabel(skuId: String, n: Long): Option[ujson.Obj] = {
    val raw = jedis.hgetAll(s"label:$skuId:v$n").asScala
    if (raw.isEmpty) None
    else
      Some(ujson.Obj("decision" -> raw("decision"), "attributes" -> ujson.read(raw("attributes")), "taxonomy_version" -> raw("taxonomy_version"), "reviewer" -> raw("reviewer")))
  }

  /** The answer recorded for this reviewer's Idempotency-Key, if any. */
  def reviewResult(reviewer: String, key: String): Option[ujson.Value] = Option(jedis.get(s"review:idem:$reviewer:$key")).map(ujson.read(_))

  def recordReview(reviewer: String, key: String, response: ujson.Value): Unit =
    jedis.set(s"review:idem:$reviewer:$key", ujson.write(response), SetParams.setParams().ex(86400L))

  private def entry(key: String): Option[ujson.Obj] = {
    val raw = jedis.hgetAll(key).asScala
    if (raw.isEmpty) None
    else
      Some(ujson.Obj("attributes" -> ujson.read(raw("attributes")), "attributes_version" -> raw("attributes_version").toLong.toDouble, "source" -> raw("source"), "taxonomy_version" -> raw("taxonomy_version")))
  }

  private def write(key: String, event: ujson.Value): Unit =
    jedis.hset(
      key,
      Map(
        "attributes" -> ujson.write(event("attributes")),
        "attributes_version" -> event("attributes_version").num.toLong.toString,
        "source" -> event("source").str,
        "taxonomy_version" -> event("taxonomy_version").str,
      ).asJava,
    )

  /** What the shop serves: attributes, attributes_version, source, taxonomy_version. */
  def catalogCurrent(skuId: String): Option[ujson.Obj] = entry(s"catalog:$skuId")
  def applyCatalog(event: ujson.Value): Unit = write(s"catalog:\${event("sku_id").str}", event)
  def searchEntry(skuId: String): Option[ujson.Obj] = entry(s"search:$skuId")
  def indexUpsert(event: ujson.Value): Unit = write(s"search:\${event("sku_id").str}", event)

  /** An sku.enriched event the broker refused: a relay produces it later. */
  def insertOutbox(event: ujson.Value, reason: String): Unit =
    jedis.rpush("outbox:enriched", ujson.write(ujson.Obj("event" -> event, "reason" -> reason)))
}
`,
};
