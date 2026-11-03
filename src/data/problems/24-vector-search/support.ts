/**
 * Hand-written support modules the vector-search steps import but no step builds: the `search`
 * package. `search.corpus` is the index as Redis keeps it (the active version and its dimension,
 * documents, one namespace per tenant and version) with the exact nearest-neighbour ranking every
 * step searches through; `search.fingerprint` is the digest a query vector is known by outside the
 * request (step 2's cache key, step 4's event). The five languages keep the same keys, so a harness
 * seeds and reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'search/__init__.py': '',
  'search/corpus.py': `"""
The corpus (provided): the search index as Redis keeps it. index:active is a hash with the active
index version and its dimension (dims). doc:{id} is a hash with the document's id, tenant, the index
version it was embedded for and its vector (comma-separated floats). index:{version}:{tenant} is the
set of the tenant's document ids in one index version: the tenant's namespace. nearest() ranks one
namespace by dot product, best first, ties by id; a query of another width is scored over the
shorter of the two, because the corpus does not check widths.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def _parse(raw: str) -> list[float]:
    return [float(x) for x in raw.split(",") if x]


def active_index() -> dict:
    """The active index: {"version": "idx-42", "dims": 4}."""
    raw = r.hgetall("index:active")
    return {"version": raw.get("version", ""), "dims": int(raw.get("dims", 0))}


def activate(version: str, dims: int) -> None:
    """Make version the active index (the reindexer's switch)."""
    r.hset("index:active", mapping={"version": version, "dims": dims})


def put_document(tenant: str, version: str, doc_id: str, vector: list[float]) -> None:
    """Store a document embedded for version and add it to the tenant's namespace (the ingest writer)."""
    r.hset(f"doc:{doc_id}", mapping={"id": doc_id, "tenant": tenant, "version": version, "vector": ",".join(repr(float(x)) for x in vector)})
    r.sadd(f"index:{version}:{tenant}", doc_id)


def document_by_id(doc_id: str) -> dict | None:
    """Any tenant's document by id, {"id", "tenant", "version", "vector"}: the reindexer's lookup, which works across tenants."""
    raw = r.hgetall(f"doc:{doc_id}")
    if not raw:
        return None
    return {"id": raw["id"], "tenant": raw["tenant"], "version": raw["version"], "vector": _parse(raw["vector"])}


def document(tenant: str, doc_id: str) -> dict | None:
    """The tenant's document, or None when there is none or it belongs to another tenant."""
    doc = document_by_id(doc_id)
    return doc if doc is not None and doc["tenant"] == tenant else None


def nearest(tenant: str, version: str, query: list[float], k: int) -> list[dict]:
    """The k documents of the tenant's namespace in version closest to query: [{"id", "score"}], best first."""
    hits = []
    for doc_id in r.smembers(f"index:{version}:{tenant}"):
        vector = _parse(r.hget(f"doc:{doc_id}", "vector") or "")
        hits.append({"id": doc_id, "score": sum(a * b for a, b in zip(query, vector))})
    hits.sort(key=lambda h: (-h["score"], h["id"]))
    return hits[:k]
`,
  'search/fingerprint.py': `"""
query_digest (provided): the digest a query vector is known by outside the request (step 2's cache
key, step 4's event): SHA-256 over the vector's IEEE-754 doubles, big-endian, in hex. Equal vectors
give equal digests in every runtime.
"""
import hashlib
import struct


def query_digest(query: list[float]) -> str:
    return hashlib.sha256(struct.pack(f">{len(query)}d", *query)).hexdigest()
`,
};

export const supportModulesTs: Record<string, string> = {
  'search/corpus.ts': `/**
 * The corpus (provided): the search index as Redis keeps it. index:active is a hash with the active
 * index version and its dimension (dims). doc:{id} is a hash with the document's id, tenant, the
 * index version it was embedded for and its vector (comma-separated floats). index:{version}:{tenant}
 * is the set of the tenant's document ids in one index version: the tenant's namespace. nearest()
 * ranks one namespace by dot product, best first, ties by id; a query of another width is scored over
 * the shorter of the two, because the corpus does not check widths.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Index {
  version: string;
  dims: number;
}

export interface Document {
  id: string;
  tenant: string;
  version: string;
  vector: number[];
}

export interface Hit {
  id: string;
  score: number;
}

/** The active index: {version: 'idx-42', dims: 4}. */
export async function activeIndex(): Promise<Index> {
  const raw = await redis.hgetall('index:active');
  return {version: raw.version ?? '', dims: Number(raw.dims ?? 0)};
}

/** Make version the active index (the reindexer's switch). */
export async function activate(version: string, dims: number): Promise<void> {
  await redis.hset('index:active', {version, dims: String(dims)});
}

/** Store a document embedded for version and add it to the tenant's namespace (the ingest writer). */
export async function putDocument(tenant: string, version: string, docId: string, vector: number[]): Promise<void> {
  await redis.hset(\`doc:\${docId}\`, {id: docId, tenant, version, vector: vector.map(String).join(',')});
  await redis.sadd(\`index:\${version}:\${tenant}\`, docId);
}

/** Any tenant's document by id: the reindexer's lookup, which works across tenants. */
export async function documentById(docId: string): Promise<Document | null> {
  const raw = await redis.hgetall(\`doc:\${docId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {id: raw.id, tenant: raw.tenant, version: raw.version, vector: (raw.vector ?? '').split(',').filter(Boolean).map(Number)};
}

/** The tenant's document, or null when there is none or it belongs to another tenant. */
export async function document(tenant: string, docId: string): Promise<Document | null> {
  const doc = await documentById(docId);
  return doc !== null && doc.tenant === tenant ? doc : null;
}

/** The k documents of the tenant's namespace in version closest to query, best first. */
export async function nearest(tenant: string, version: string, query: number[], k: number): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (const id of await redis.smembers(\`index:\${version}:\${tenant}\`)) {
    const raw = (await redis.hget(\`doc:\${id}\`, 'vector')) ?? '';
    const vector = raw.split(',').filter(Boolean).map(Number);
    let score = 0;
    for (let i = 0; i < Math.min(query.length, vector.length); i++) score += query[i] * vector[i];
    hits.push({id, score});
  }
  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hits.slice(0, k);
}
`,
  'search/fingerprint.ts': `/**
 * queryDigest (provided): the digest a query vector is known by outside the request (step 2's cache
 * key, step 4's event): SHA-256 over the vector's IEEE-754 doubles, big-endian, in hex. Equal vectors
 * give equal digests in every runtime.
 */
import {createHash} from 'node:crypto';

export function queryDigest(query: number[]): string {
  const bytes = Buffer.alloc(8 * query.length);
  query.forEach((x, i) => bytes.writeDoubleBE(x, 8 * i));
  return createHash('sha256').update(bytes).digest('hex');
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'search/corpus/corpus.go': `// Package corpus is the search index as Redis keeps it (provided). index:active is a hash with the
// active index version and its dimension (dims). doc:{id} is a hash with the document's id, tenant,
// the index version it was embedded for and its vector (comma-separated floats).
// index:{version}:{tenant} is the set of the tenant's document ids in one index version: the
// tenant's namespace. Nearest ranks one namespace by dot product, best first, ties by id; a query of
// another width is scored over the shorter of the two, because the corpus does not check widths.
package corpus

import (
	"context"
	"sort"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Index is the active index version and its dimension.
type Index struct {
	Version string
	Dims    int
}

// Doc is one document: its id, tenant, the index version it was embedded for and its vector.
type Doc struct {
	ID      string
	Tenant  string
	Version string
	Vector  []float64
}

// Hit is one ranked document.
type Hit struct {
	ID    string  \`json:"id"\`
	Score float64 \`json:"score"\`
}

func parse(raw string) []float64 {
	out := []float64{}
	for _, part := range strings.Split(raw, ",") {
		if f, err := strconv.ParseFloat(part, 64); err == nil {
			out = append(out, f)
		}
	}
	return out
}

// ActiveIndex is the active index: {Version: "idx-42", Dims: 4}.
func ActiveIndex(ctx context.Context) Index {
	raw := rdb.HGetAll(ctx, "index:active").Val()
	dims, _ := strconv.Atoi(raw["dims"])
	return Index{Version: raw["version"], Dims: dims}
}

// Activate makes version the active index (the reindexer's switch).
func Activate(ctx context.Context, version string, dims int) {
	rdb.HSet(ctx, "index:active", "version", version, "dims", strconv.Itoa(dims))
}

// PutDocument stores a document embedded for version and adds it to the tenant's namespace (the ingest writer).
func PutDocument(ctx context.Context, tenant, version, docID string, vector []float64) {
	parts := make([]string, len(vector))
	for i, x := range vector {
		parts[i] = strconv.FormatFloat(x, 'g', -1, 64)
	}
	rdb.HSet(ctx, "doc:"+docID, "id", docID, "tenant", tenant, "version", version, "vector", strings.Join(parts, ","))
	rdb.SAdd(ctx, "index:"+version+":"+tenant, docID)
}

// DocumentByID is any tenant's document by id, or nil: the reindexer's lookup, which works across tenants.
func DocumentByID(ctx context.Context, docID string) *Doc {
	raw := rdb.HGetAll(ctx, "doc:"+docID).Val()
	if len(raw) == 0 {
		return nil
	}
	return &Doc{ID: raw["id"], Tenant: raw["tenant"], Version: raw["version"], Vector: parse(raw["vector"])}
}

// Document is the tenant's document, or nil when there is none or it belongs to another tenant.
func Document(ctx context.Context, tenant, docID string) *Doc {
	if doc := DocumentByID(ctx, docID); doc != nil && doc.Tenant == tenant {
		return doc
	}
	return nil
}

// Nearest is the k documents of the tenant's namespace in version closest to query, best first.
func Nearest(ctx context.Context, tenant, version string, query []float64, k int) []Hit {
	hits := []Hit{}
	for _, id := range rdb.SMembers(ctx, "index:"+version+":"+tenant).Val() {
		vector := parse(rdb.HGet(ctx, "doc:"+id, "vector").Val())
		score := 0.0
		for i := 0; i < len(query) && i < len(vector); i++ {
			score += query[i] * vector[i]
		}
		hits = append(hits, Hit{ID: id, Score: score})
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		return hits[i].ID < hits[j].ID
	})
	if k < len(hits) {
		hits = hits[:k]
	}
	return hits
}
`,
  'search/fingerprint/fingerprint.go': `// Package fingerprint is the digest a query vector is known by outside the request (provided; step
// 2's cache key, step 4's event): SHA-256 over the vector's IEEE-754 doubles, big-endian, in hex.
// Equal vectors give equal digests in every runtime.
package fingerprint

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"math"
)

// QueryDigest is the hex SHA-256 of the query's doubles, big-endian.
func QueryDigest(query []float64) string {
	buf := make([]byte, 8*len(query))
	for i, x := range query {
		binary.BigEndian.PutUint64(buf[8*i:], math.Float64bits(x))
	}
	sum := sha256.Sum256(buf)
	return hex.EncodeToString(sum[:])
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'search/corpus.h': `// The corpus (provided): the search index as Redis keeps it. index:active is a hash with the active
// index version and its dimension (dims). doc:{id} is a hash with the document's id, tenant, the
// index version it was embedded for and its vector (comma-separated floats). index:{version}:{tenant}
// is the set of the tenant's document ids in one index version: the tenant's namespace. nearest()
// ranks one namespace by dot product, best first, ties by id; a query of another width is scored over
// the shorter of the two, because the corpus does not check widths.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <iterator>
#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

namespace corpus {

struct Index {
  std::string version;
  long dims = 0;
};

struct Document {
  std::string id;
  std::string tenant;
  std::string version;
  std::vector<double> vector;
};

struct Hit {
  std::string id;
  double score = 0;
};

// A hit as JSON: {"id", "score"} (so json(hits) is the response array).
inline void to_json(nlohmann::json& j, const Hit& h) { j = nlohmann::json{{"id", h.id}, {"score", h.score}}; }

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::vector<double> parse(const std::string& raw) {
  std::vector<double> out;
  std::stringstream in(raw);
  std::string part;
  while (std::getline(in, part, ',')) {
    if (!part.empty()) out.push_back(std::stod(part));
  }
  return out;
}

// The active index: {"idx-42", 4}.
inline Index activeIndex() {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall("index:active", std::inserter(raw, raw.end()));
  Index index;
  index.version = raw.count("version") ? raw["version"] : "";
  index.dims = raw.count("dims") ? std::stol(raw["dims"]) : 0;
  return index;
}

// Make version the active index (the reindexer's switch).
inline void activate(const std::string& version, long dims) {
  redis().hset("index:active", {std::make_pair(std::string("version"), version), std::make_pair(std::string("dims"), std::to_string(dims))});
}

// Store a document embedded for version and add it to the tenant's namespace (the ingest writer).
inline void putDocument(const std::string& tenant, const std::string& version, const std::string& doc_id, const std::vector<double>& vector) {
  std::string joined;
  for (size_t i = 0; i < vector.size(); ++i) joined += (i ? "," : "") + nlohmann::json(vector[i]).dump();
  redis().hset("doc:" + doc_id, {std::make_pair(std::string("id"), doc_id), std::make_pair(std::string("tenant"), tenant),
                                 std::make_pair(std::string("version"), version), std::make_pair(std::string("vector"), joined)});
  redis().sadd("index:" + version + ":" + tenant, doc_id);
}

// Any tenant's document by id: the reindexer's lookup, which works across tenants.
inline std::optional<Document> documentById(const std::string& doc_id) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall("doc:" + doc_id, std::inserter(raw, raw.end()));
  if (raw.empty()) return std::nullopt;
  return Document{raw["id"], raw["tenant"], raw["version"], parse(raw["vector"])};
}

// The tenant's document, or none when there is none or it belongs to another tenant.
inline std::optional<Document> document(const std::string& tenant, const std::string& doc_id) {
  auto doc = documentById(doc_id);
  if (doc && doc->tenant == tenant) return doc;
  return std::nullopt;
}

// The k documents of the tenant's namespace in version closest to query, best first.
inline std::vector<Hit> nearest(const std::string& tenant, const std::string& version, const std::vector<double>& query, long k) {
  std::vector<std::string> ids;
  redis().smembers("index:" + version + ":" + tenant, std::back_inserter(ids));
  std::vector<Hit> hits;
  for (const std::string& id : ids) {
    const auto raw = redis().hget("doc:" + id, "vector");
    const std::vector<double> vector = parse(raw ? *raw : "");
    double score = 0;
    for (size_t i = 0; i < query.size() && i < vector.size(); ++i) score += query[i] * vector[i];
    hits.push_back(Hit{id, score});
  }
  std::sort(hits.begin(), hits.end(), [](const Hit& a, const Hit& b) { return a.score != b.score ? a.score > b.score : a.id < b.id; });
  if (k >= 0 && static_cast<size_t>(k) < hits.size()) hits.resize(k);
  return hits;
}

}  // namespace corpus
`,
  'search/fingerprint.h': `// queryDigest (provided): the digest a query vector is known by outside the request (step 2's cache
// key, step 4's event): SHA-256 over the vector's IEEE-754 doubles, big-endian, in hex. Equal vectors
// give equal digests in every runtime.
#pragma once

#include <openssl/sha.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace fingerprint {

inline std::string queryDigest(const std::vector<double>& query) {
  std::vector<unsigned char> bytes(8 * query.size());
  for (size_t i = 0; i < query.size(); ++i) {
    uint64_t bits;
    std::memcpy(&bits, &query[i], sizeof bits);
    for (int b = 0; b < 8; ++b) bytes[8 * i + b] = static_cast<unsigned char>(bits >> (56 - 8 * b));
  }
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(bytes.data(), bytes.size(), digest);
  static const char* kHex = "0123456789abcdef";
  std::string out;
  for (unsigned char c : digest) {
    out += kHex[c >> 4];
    out += kHex[c & 15];
  }
  return out;
}

}  // namespace fingerprint
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('search', 'Corpus')]: `package search

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The corpus (provided): the search index as Redis keeps it. index:active is a hash with the active
 * index version and its dimension (dims). doc:{id} is a hash with the document's id, tenant, the
 * index version it was embedded for and its vector (comma-separated floats). index:{version}:{tenant}
 * is the set of the tenant's document ids in one index version: the tenant's namespace. nearest()
 * ranks one namespace by dot product, best first, ties by id; a query of another width is scored over
 * the shorter of the two, because the corpus does not check widths.
 */
object Corpus {
  final case class Index(version: String, dims: Int)
  final case class Document(id: String, tenant: String, version: String, vector: Vector[Double])
  final case class Hit(id: String, score: Double)

  val jedis = new JedisPooled("redis", 6379)

  private def parse(raw: String): Vector[Double] = raw.split(",").filter(_.nonEmpty).map(_.toDouble).toVector

  /** The active index: Index("idx-42", 4). */
  def activeIndex(): Index = {
    val raw = jedis.hgetAll("index:active").asScala
    Index(raw.getOrElse("version", ""), raw.get("dims").map(_.toInt).getOrElse(0))
  }

  /** Make version the active index (the reindexer's switch). */
  def activate(version: String, dims: Int): Unit =
    jedis.hset("index:active", Map("version" -> version, "dims" -> dims.toString).asJava)

  /** Store a document embedded for version and add it to the tenant's namespace (the ingest writer). */
  def putDocument(tenant: String, version: String, docId: String, vector: Seq[Double]): Unit = {
    jedis.hset(s"doc:$docId", Map("id" -> docId, "tenant" -> tenant, "version" -> version, "vector" -> vector.mkString(",")).asJava)
    jedis.sadd(s"index:$version:$tenant", docId)
  }

  /** Any tenant's document by id: the reindexer's lookup, which works across tenants. */
  def documentById(docId: String): Option[Document] = {
    val raw = jedis.hgetAll(s"doc:$docId").asScala
    if (raw.isEmpty) None else Some(Document(raw("id"), raw("tenant"), raw("version"), parse(raw("vector"))))
  }

  /** The tenant's document, or None when there is none or it belongs to another tenant. */
  def document(tenant: String, docId: String): Option[Document] = documentById(docId).filter(_.tenant == tenant)

  /** The k documents of the tenant's namespace in version closest to query, best first. */
  def nearest(tenant: String, version: String, query: Seq[Double], k: Int): Vector[Hit] =
    jedis
      .smembers(s"index:$version:$tenant")
      .asScala
      .toVector
      .map { id =>
        val vector = parse(Option(jedis.hget(s"doc:$id", "vector")).getOrElse(""))
        Hit(id, query.zip(vector).map { case (a, b) => a * b }.sum)
      }
      .sortBy(h => (-h.score, h.id))
      .take(k)
}
`,
  [scalaPath('search', 'Fingerprint')]: `package search

import java.nio.ByteBuffer
import java.security.MessageDigest

/**
 * queryDigest (provided): the digest a query vector is known by outside the request (step 2's cache
 * key, step 4's event): SHA-256 over the vector's IEEE-754 doubles, big-endian, in hex. Equal vectors
 * give equal digests in every runtime.
 */
object Fingerprint {
  def queryDigest(query: Seq[Double]): String = {
    val bytes = ByteBuffer.allocate(8 * query.length) // big-endian
    query.foreach(x => bytes.putDouble(x))
    MessageDigest.getInstance("SHA-256").digest(bytes.array).map(b => f"$b%02x").mkString
  }
}
`,
};
