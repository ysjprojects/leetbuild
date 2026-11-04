/**
 * Hand-written support module the product-search steps import but no step builds: `search.catalog`,
 * the tenant catalog index. Every product is a Redis hash catalog:{tenant}:product:{id} (id, title,
 * brand, category, price_cents, in_stock "true"/"false", cost_cents, price_version), listed in the
 * set catalog:{tenant}:ids; catalog:{tenant}:version is the tenant's index version, bumped by every
 * write. `run_query` is the query engine, `normalize_query` and `digest` the helpers steps 2 and 4
 * share. The five languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'search/__init__.py': '',
  'search/catalog.py': `"""
The tenant catalog index (provided). Every product is a Redis hash catalog:{tenant}:product:{id}
with id, title, brand, category, price_cents, in_stock ("true"/"false"), cost_cents (the wholesale
cost: internal, never shown to shoppers) and price_version (bumped by every write); the set
catalog:{tenant}:ids lists a tenant's products and catalog:{tenant}:version is the tenant's index
version, bumped by every write. A product is returned as a dict with typed values.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

PUBLIC_FIELDS = ("id", "title", "brand", "category", "price_cents", "in_stock", "price_version")


def product_key(tenant: str, product_id: str) -> str:
    return f"catalog:{tenant}:product:{product_id}"


def normalize_query(q: str) -> str:
    """Lowercase, trimmed, every run of whitespace one space: two spellings of one query become one."""
    return " ".join(q.lower().split())


def digest(text: str) -> str:
    """FNV-1a, 64 bits, as 16 hex digits: a short stable name for a longer text."""
    h = 0xCBF29CE484222325
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{h:016x}"


def put_product(tenant: str, product: dict) -> int:
    """Index or update a product (id, title, brand, category, price_cents, in_stock, cost_cents); returns the tenant's new index version."""
    key = product_key(tenant, product["id"])
    r.hset(
        key,
        mapping={
            "id": product["id"],
            "title": product["title"],
            "brand": product["brand"],
            "category": product["category"],
            "price_cents": int(product["price_cents"]),
            "in_stock": "true" if product["in_stock"] else "false",
            "cost_cents": int(product["cost_cents"]),
        },
    )
    r.hincrby(key, "price_version", 1)
    r.sadd(f"catalog:{tenant}:ids", product["id"])
    return r.incr(f"catalog:{tenant}:version")


def index_version(tenant: str) -> int:
    """The tenant's index version: 0 before the first write."""
    return int(r.get(f"catalog:{tenant}:version") or 0)


def _product(raw: dict) -> dict | None:
    if not raw:
        return None
    return {
        "id": raw["id"],
        "title": raw["title"],
        "brand": raw["brand"],
        "category": raw["category"],
        "price_cents": int(raw["price_cents"]),
        "in_stock": raw["in_stock"] == "true",
        "cost_cents": int(raw["cost_cents"]),
        "price_version": int(raw["price_version"]),
    }


def get_product(tenant: str, product_id: str) -> dict | None:
    """The tenant's product, every stored field, or None."""
    return _product(r.hgetall(product_key(tenant, product_id)))


def find_product(product_id: str) -> dict | None:
    """The merchandising console's lookup: the first product with this id in any tenant's catalog."""
    for key in sorted(r.keys(f"catalog:*:product:{product_id}")):
        return _product(r.hgetall(key))
    return None


def public_view(product: dict) -> dict:
    """The fields a shopper may see."""
    return {name: product[name] for name in PUBLIC_FIELDS}


def _matches(raw: dict, terms: list[str], filters: dict[str, str]) -> bool:
    text = f"{raw['title']} {raw['brand']} {raw['category']}".lower()
    if not all(term in text for term in terms):
        return False
    for field, value in filters.items():
        if field in ("min_price", "max_price"):
            try:
                bound = int(value)
            except ValueError:
                return False
            price = int(raw["price_cents"])
            if (field == "min_price" and price < bound) or (field == "max_price" and price > bound):
                return False
        elif raw.get(field) != value:  # any stored field is a filter: equality on its text
            return False
    return True


def run_query(tenant: str, q: str, filters: dict[str, str], page_size: int) -> list[dict]:
    """The query engine: the tenant's products matching every term of q and every filter, cheapest first, at most page_size."""
    terms = normalize_query(q).split()
    hits = []
    for product_id in r.smembers(f"catalog:{tenant}:ids"):
        raw = r.hgetall(product_key(tenant, product_id))
        if raw and _matches(raw, terms, filters):
            hits.append(_product(raw))
    hits.sort(key=lambda p: (p["price_cents"], p["id"]))
    return [public_view(p) for p in hits[:page_size]]
`,
};

export const supportModulesTs: Record<string, string> = {
  'search/catalog.ts': `/**
 * The tenant catalog index (provided). Every product is a Redis hash catalog:{tenant}:product:{id}
 * with id, title, brand, category, price_cents, in_stock ("true"/"false"), cost_cents (the
 * wholesale cost: internal, never shown to shoppers) and price_version (bumped by every write); the
 * set catalog:{tenant}:ids lists a tenant's products and catalog:{tenant}:version is the tenant's
 * index version, bumped by every write.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Product {
  id: string;
  title: string;
  brand: string;
  category: string;
  price_cents: number;
  in_stock: boolean;
  cost_cents: number;
  price_version: number;
}

export type ProductInput = Omit<Product, 'price_version'>;

/** The fields a shopper may see. */
export type Hit = Omit<Product, 'cost_cents'>;

export const PUBLIC_FIELDS = ['id', 'title', 'brand', 'category', 'price_cents', 'in_stock', 'price_version'] as const;

export const productKey = (tenant: string, productId: string): string => \`catalog:\${tenant}:product:\${productId}\`;

/** Lowercase, trimmed, every run of whitespace one space: two spellings of one query become one. */
export const normalizeQuery = (q: string): string =>
  q
    .toLowerCase()
    .split(/\\s+/)
    .filter(term => term !== '')
    .join(' ');

/** FNV-1a, 64 bits, as 16 hex digits: a short stable name for a longer text. */
export function digest(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** Index or update a product; resolves the tenant's new index version. */
export async function putProduct(tenant: string, product: ProductInput): Promise<number> {
  const key = productKey(tenant, product.id);
  await redis.hset(key, {
    id: product.id,
    title: product.title,
    brand: product.brand,
    category: product.category,
    price_cents: String(product.price_cents),
    in_stock: product.in_stock ? 'true' : 'false',
    cost_cents: String(product.cost_cents),
  });
  await redis.hincrby(key, 'price_version', 1);
  await redis.sadd(\`catalog:\${tenant}:ids\`, product.id);
  return redis.incr(\`catalog:\${tenant}:version\`);
}

/** The tenant's index version: 0 before the first write. */
export async function indexVersion(tenant: string): Promise<number> {
  return Number((await redis.get(\`catalog:\${tenant}:version\`)) ?? 0);
}

function product(raw: Record<string, string>): Product | null {
  if (Object.keys(raw).length === 0) return null;
  return {
    id: raw.id,
    title: raw.title,
    brand: raw.brand,
    category: raw.category,
    price_cents: Number(raw.price_cents),
    in_stock: raw.in_stock === 'true',
    cost_cents: Number(raw.cost_cents),
    price_version: Number(raw.price_version),
  };
}

/** The tenant's product, every stored field, or null. */
export async function getProduct(tenant: string, productId: string): Promise<Product | null> {
  return product(await redis.hgetall(productKey(tenant, productId)));
}

/** The merchandising console's lookup: the first product with this id in any tenant's catalog. */
export async function findProduct(productId: string): Promise<Product | null> {
  const keys = (await redis.keys(\`catalog:*:product:\${productId}\`)).sort();
  return keys.length === 0 ? null : product(await redis.hgetall(keys[0]));
}

/** The fields a shopper may see. */
export function publicView(p: Product): Hit {
  return {id: p.id, title: p.title, brand: p.brand, category: p.category, price_cents: p.price_cents, in_stock: p.in_stock, price_version: p.price_version};
}

function matches(raw: Record<string, string>, terms: string[], filters: Record<string, string>): boolean {
  const text = \`\${raw.title} \${raw.brand} \${raw.category}\`.toLowerCase();
  if (!terms.every(term => text.includes(term))) return false;
  for (const [field, value] of Object.entries(filters)) {
    if (field === 'min_price' || field === 'max_price') {
      if (!/^-?\\d+$/.test(value)) return false;
      const price = Number(raw.price_cents);
      if ((field === 'min_price' && price < Number(value)) || (field === 'max_price' && price > Number(value))) return false;
    } else if (raw[field] !== value) {
      return false; // any stored field is a filter: equality on its text
    }
  }
  return true;
}

/** The query engine: the tenant's products matching every term of q and every filter, cheapest first, at most pageSize. */
export async function runQuery(tenant: string, q: string, filters: Record<string, string>, pageSize: number): Promise<Hit[]> {
  const terms = normalizeQuery(q).split(' ').filter(term => term !== '');
  const hits: Product[] = [];
  for (const productId of await redis.smembers(\`catalog:\${tenant}:ids\`)) {
    const raw = await redis.hgetall(productKey(tenant, productId));
    if (Object.keys(raw).length > 0 && matches(raw, terms, filters)) hits.push(product(raw) as Product);
  }
  hits.sort((a, b) => a.price_cents - b.price_cents || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hits.slice(0, pageSize).map(publicView);
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'search/catalog/catalog.go': `// Package catalog is the tenant catalog index (provided). Every product is a Redis hash
// catalog:{tenant}:product:{id} with id, title, brand, category, price_cents, in_stock
// ("true"/"false"), cost_cents (the wholesale cost: internal, never shown to shoppers) and
// price_version (bumped by every write); the set catalog:{tenant}:ids lists a tenant's products and
// catalog:{tenant}:version is the tenant's index version, bumped by every write.
package catalog

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Product is every stored field of a product.
type Product struct {
	ID           string \`json:"id"\`
	Title        string \`json:"title"\`
	Brand        string \`json:"brand"\`
	Category     string \`json:"category"\`
	PriceCents   int64  \`json:"price_cents"\`
	InStock      bool   \`json:"in_stock"\`
	CostCents    int64  \`json:"cost_cents"\`
	PriceVersion int64  \`json:"price_version"\`
}

// Hit is the fields a shopper may see.
type Hit struct {
	ID           string \`json:"id"\`
	Title        string \`json:"title"\`
	Brand        string \`json:"brand"\`
	Category     string \`json:"category"\`
	PriceCents   int64  \`json:"price_cents"\`
	InStock      bool   \`json:"in_stock"\`
	PriceVersion int64  \`json:"price_version"\`
}

// ProductKey is the hash of one product of a tenant.
func ProductKey(tenant, productID string) string {
	return "catalog:" + tenant + ":product:" + productID
}

// NormalizeQuery lowercases and trims q and makes every run of whitespace one space: two spellings of one query become one.
func NormalizeQuery(q string) string {
	return strings.Join(strings.Fields(strings.ToLower(q)), " ")
}

// Digest is FNV-1a, 64 bits, as 16 hex digits: a short stable name for a longer text.
func Digest(text string) string {
	h := uint64(0xcbf29ce484222325)
	for _, b := range []byte(text) {
		h ^= uint64(b)
		h *= 0x100000001b3
	}
	return fmt.Sprintf("%016x", h)
}

// PutProduct indexes or updates a product (its PriceVersion is ignored) and returns the tenant's new index version.
func PutProduct(ctx context.Context, tenant string, p Product) int64 {
	key := ProductKey(tenant, p.ID)
	rdb.HSet(ctx, key, map[string]any{
		"id": p.ID, "title": p.Title, "brand": p.Brand, "category": p.Category,
		"price_cents": strconv.FormatInt(p.PriceCents, 10), "in_stock": strconv.FormatBool(p.InStock), "cost_cents": strconv.FormatInt(p.CostCents, 10),
	})
	rdb.HIncrBy(ctx, key, "price_version", 1)
	rdb.SAdd(ctx, "catalog:"+tenant+":ids", p.ID)
	return rdb.Incr(ctx, "catalog:"+tenant+":version").Val()
}

// IndexVersion is the tenant's index version: 0 before the first write.
func IndexVersion(ctx context.Context, tenant string) int64 {
	n, _ := strconv.ParseInt(rdb.Get(ctx, "catalog:"+tenant+":version").Val(), 10, 64)
	return n
}

func product(raw map[string]string) *Product {
	if len(raw) == 0 {
		return nil
	}
	price, _ := strconv.ParseInt(raw["price_cents"], 10, 64)
	cost, _ := strconv.ParseInt(raw["cost_cents"], 10, 64)
	version, _ := strconv.ParseInt(raw["price_version"], 10, 64)
	return &Product{ID: raw["id"], Title: raw["title"], Brand: raw["brand"], Category: raw["category"], PriceCents: price, InStock: raw["in_stock"] == "true", CostCents: cost, PriceVersion: version}
}

// GetProduct is the tenant's product, every stored field, or nil.
func GetProduct(ctx context.Context, tenant, productID string) *Product {
	return product(rdb.HGetAll(ctx, ProductKey(tenant, productID)).Val())
}

// FindProduct is the merchandising console's lookup: the first product with this id in any tenant's catalog.
func FindProduct(ctx context.Context, productID string) *Product {
	keys := rdb.Keys(ctx, "catalog:*:product:"+productID).Val()
	if len(keys) == 0 {
		return nil
	}
	sort.Strings(keys)
	return product(rdb.HGetAll(ctx, keys[0]).Val())
}

// PublicView is the fields a shopper may see.
func PublicView(p Product) Hit {
	return Hit{ID: p.ID, Title: p.Title, Brand: p.Brand, Category: p.Category, PriceCents: p.PriceCents, InStock: p.InStock, PriceVersion: p.PriceVersion}
}

func matches(raw map[string]string, terms []string, filters map[string]string) bool {
	text := strings.ToLower(raw["title"] + " " + raw["brand"] + " " + raw["category"])
	for _, term := range terms {
		if !strings.Contains(text, term) {
			return false
		}
	}
	for field, value := range filters {
		if field == "min_price" || field == "max_price" {
			bound, err := strconv.ParseInt(value, 10, 64)
			if err != nil {
				return false
			}
			price, _ := strconv.ParseInt(raw["price_cents"], 10, 64)
			if (field == "min_price" && price < bound) || (field == "max_price" && price > bound) {
				return false
			}
		} else if stored, ok := raw[field]; !ok || stored != value {
			return false // any stored field is a filter: equality on its text
		}
	}
	return true
}

// RunQuery is the query engine: the tenant's products matching every term of q and every filter, cheapest first, at most pageSize.
func RunQuery(ctx context.Context, tenant, q string, filters map[string]string, pageSize int) []Hit {
	terms := strings.Fields(NormalizeQuery(q))
	var found []Product
	for _, productID := range rdb.SMembers(ctx, "catalog:"+tenant+":ids").Val() {
		raw := rdb.HGetAll(ctx, ProductKey(tenant, productID)).Val()
		if len(raw) > 0 && matches(raw, terms, filters) {
			found = append(found, *product(raw))
		}
	}
	sort.Slice(found, func(i, j int) bool {
		if found[i].PriceCents != found[j].PriceCents {
			return found[i].PriceCents < found[j].PriceCents
		}
		return found[i].ID < found[j].ID
	})
	hits := []Hit{}
	for i := 0; i < len(found) && i < pageSize; i++ {
		hits = append(hits, PublicView(found[i]))
	}
	return hits
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'search/catalog.h': `// The tenant catalog index (provided). Every product is a Redis hash catalog:{tenant}:product:{id}
// with id, title, brand, category, price_cents, in_stock ("true"/"false"), cost_cents (the
// wholesale cost: internal, never shown to shoppers) and price_version (bumped by every write); the
// set catalog:{tenant}:ids lists a tenant's products and catalog:{tenant}:version is the tenant's
// index version, bumped by every write. A product a shopper sees is a JSON object (publicView).
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <iterator>
#include <map>
#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

namespace catalog {

struct Product {
  std::string id;
  std::string title;
  std::string brand;
  std::string category;
  long price_cents = 0;
  bool in_stock = false;
  long cost_cents = 0;
  long price_version = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string productKey(const std::string& tenant, const std::string& product_id) {
  return "catalog:" + tenant + ":product:" + product_id;
}

// Lowercase, trimmed, every run of whitespace one space: two spellings of one query become one.
inline std::string normalizeQuery(const std::string& q) {
  std::istringstream in(q);
  std::string term, out;
  while (in >> term) {
    std::transform(term.begin(), term.end(), term.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    out += (out.empty() ? "" : " ") + term;
  }
  return out;
}

// FNV-1a, 64 bits, as 16 hex digits: a short stable name for a longer text.
inline std::string digest(const std::string& text) {
  uint64_t h = 0xcbf29ce484222325ULL;
  for (unsigned char byte : text) {
    h ^= byte;
    h *= 0x100000001b3ULL;
  }
  char out[17];
  std::snprintf(out, sizeof out, "%016llx", static_cast<unsigned long long>(h));
  return out;
}

// Index or update a product (its price_version is ignored); returns the tenant's new index version.
inline long putProduct(const std::string& tenant, const Product& p) {
  const std::string key = productKey(tenant, p.id);
  const std::map<std::string, std::string> fields = {
      {"id", p.id},
      {"title", p.title},
      {"brand", p.brand},
      {"category", p.category},
      {"price_cents", std::to_string(p.price_cents)},
      {"in_stock", p.in_stock ? "true" : "false"},
      {"cost_cents", std::to_string(p.cost_cents)}};
  redis().hset(key, fields.begin(), fields.end());
  redis().hincrby(key, "price_version", 1);
  redis().sadd("catalog:" + tenant + ":ids", p.id);
  return redis().incr("catalog:" + tenant + ":version");
}

// The tenant's index version: 0 before the first write.
inline long indexVersion(const std::string& tenant) {
  const auto value = redis().get("catalog:" + tenant + ":version");
  return value ? std::stol(*value) : 0;
}

inline std::optional<Product> productOf(const std::unordered_map<std::string, std::string>& raw) {
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  Product p;
  p.id = text("id");
  p.title = text("title");
  p.brand = text("brand");
  p.category = text("category");
  p.price_cents = std::stol(text("price_cents"));
  p.in_stock = text("in_stock") == "true";
  p.cost_cents = std::stol(text("cost_cents"));
  p.price_version = std::stol(text("price_version"));
  return p;
}

// The tenant's product, every stored field, or none.
inline std::optional<Product> getProduct(const std::string& tenant, const std::string& product_id) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall(productKey(tenant, product_id), std::inserter(raw, raw.end()));
  return productOf(raw);
}

// The merchandising console's lookup: the first product with this id in any tenant's catalog.
inline std::optional<Product> findProduct(const std::string& product_id) {
  std::vector<std::string> keys;
  redis().keys("catalog:*:product:" + product_id, std::back_inserter(keys));
  if (keys.empty()) return std::nullopt;
  std::sort(keys.begin(), keys.end());
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall(keys.front(), std::inserter(raw, raw.end()));
  return productOf(raw);
}

// The fields a shopper may see.
inline nlohmann::json publicView(const Product& p) {
  return {{"id", p.id},     {"title", p.title},       {"brand", p.brand},
          {"category", p.category}, {"price_cents", p.price_cents}, {"in_stock", p.in_stock},
          {"price_version", p.price_version}};
}

// Every stored field of a product, the wholesale cost included.
inline nlohmann::json toJson(const Product& p) {
  nlohmann::json out = publicView(p);
  out["cost_cents"] = p.cost_cents;
  return out;
}

inline bool matches(const std::unordered_map<std::string, std::string>& raw, const std::vector<std::string>& terms,
                    const std::map<std::string, std::string>& filters) {
  const auto text = [&raw](const std::string& name) { return raw.count(name) ? raw.at(name) : std::string(); };
  const std::string haystack = normalizeQuery(text("title") + " " + text("brand") + " " + text("category"));
  for (const std::string& term : terms) {
    if (haystack.find(term) == std::string::npos) return false;
  }
  for (const auto& [field, value] : filters) {
    if (field == "min_price" || field == "max_price") {
      long bound = 0;
      try {
        size_t used = 0;
        bound = std::stol(value, &used);
        if (used != value.size()) return false;
      } catch (const std::exception&) {
        return false;
      }
      const long price = std::stol(text("price_cents"));
      if ((field == "min_price" && price < bound) || (field == "max_price" && price > bound)) return false;
    } else if (!raw.count(field) || raw.at(field) != value) {
      return false;  // any stored field is a filter: equality on its text
    }
  }
  return true;
}

// The query engine: the tenant's products matching every term of q and every filter, cheapest
// first, at most page_size, as a JSON array of public views.
inline nlohmann::json runQuery(const std::string& tenant, const std::string& q, const std::map<std::string, std::string>& filters,
                               int page_size) {
  std::vector<std::string> terms;
  std::istringstream in(normalizeQuery(q));
  for (std::string term; in >> term;) terms.push_back(term);
  std::vector<std::string> ids;
  redis().smembers("catalog:" + tenant + ":ids", std::back_inserter(ids));
  std::vector<Product> found;
  for (const std::string& product_id : ids) {
    std::unordered_map<std::string, std::string> raw;
    redis().hgetall(productKey(tenant, product_id), std::inserter(raw, raw.end()));
    if (!raw.empty() && matches(raw, terms, filters)) found.push_back(*productOf(raw));
  }
  std::sort(found.begin(), found.end(), [](const Product& a, const Product& b) {
    return a.price_cents != b.price_cents ? a.price_cents < b.price_cents : a.id < b.id;
  });
  nlohmann::json hits = nlohmann::json::array();
  for (size_t i = 0; i < found.size() && static_cast<int>(i) < page_size; ++i) hits.push_back(publicView(found[i]));
  return hits;
}

}  // namespace catalog
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('search', 'Catalog')]: `package search

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The tenant catalog index (provided). Every product is a Redis hash catalog:{tenant}:product:{id}
 * with id, title, brand, category, price_cents, in_stock ("true"/"false"), cost_cents (the
 * wholesale cost: internal, never shown to shoppers) and price_version (bumped by every write); the
 * set catalog:{tenant}:ids lists a tenant's products and catalog:{tenant}:version is the tenant's
 * index version, bumped by every write.
 */
object Catalog {
  final case class Product(id: String, title: String, brand: String, category: String, priceCents: Long, inStock: Boolean, costCents: Long, priceVersion: Long)

  val jedis = new JedisPooled("redis", 6379)

  def productKey(tenant: String, productId: String): String = s"catalog:$tenant:product:$productId"

  /** Lowercase, trimmed, every run of whitespace one space: two spellings of one query become one. */
  def normalizeQuery(q: String): String = q.toLowerCase.split("\\\\s+").filter(_.nonEmpty).mkString(" ")

  /** FNV-1a, 64 bits, as 16 hex digits: a short stable name for a longer text. */
  def digest(text: String): String = {
    var h = 0xcbf29ce484222325L
    text.getBytes("UTF-8").foreach { byte =>
      h ^= (byte & 0xff).toLong
      h *= 0x100000001b3L
    }
    f"$h%016x"
  }

  /** Index or update a product (its priceVersion is ignored); returns the tenant's new index version. */
  def putProduct(tenant: String, p: Product): Long = {
    val key = productKey(tenant, p.id)
    jedis.hset(key, Map("id" -> p.id, "title" -> p.title, "brand" -> p.brand, "category" -> p.category, "price_cents" -> p.priceCents.toString, "in_stock" -> p.inStock.toString, "cost_cents" -> p.costCents.toString).asJava)
    jedis.hincrBy(key, "price_version", 1)
    jedis.sadd(s"catalog:$tenant:ids", p.id)
    jedis.incr(s"catalog:$tenant:version")
  }

  /** The tenant's index version: 0 before the first write. */
  def indexVersion(tenant: String): Long = Option(jedis.get(s"catalog:$tenant:version")).map(_.toLong).getOrElse(0L)

  private def product(raw: Map[String, String]): Option[Product] =
    if (raw.isEmpty) None
    else Some(Product(raw("id"), raw("title"), raw("brand"), raw("category"), raw("price_cents").toLong, raw("in_stock") == "true", raw("cost_cents").toLong, raw("price_version").toLong))

  /** The tenant's product, every stored field, if it exists. */
  def getProduct(tenant: String, productId: String): Option[Product] = product(jedis.hgetAll(productKey(tenant, productId)).asScala.toMap)

  /** The merchandising console's lookup: the first product with this id in any tenant's catalog. */
  def findProduct(productId: String): Option[Product] =
    jedis.keys(s"catalog:*:product:$productId").asScala.toSeq.sorted.headOption.flatMap(key => product(jedis.hgetAll(key).asScala.toMap))

  /** The fields a shopper may see. */
  def publicView(p: Product): JsObject = JsObject(
    "id" -> JsString(p.id), "title" -> JsString(p.title), "brand" -> JsString(p.brand), "category" -> JsString(p.category),
    "price_cents" -> JsNumber(p.priceCents), "in_stock" -> JsBoolean(p.inStock), "price_version" -> JsNumber(p.priceVersion))

  /** Every stored field of a product, the wholesale cost included. */
  def toJson(p: Product): JsObject = JsObject(publicView(p).fields + ("cost_cents" -> JsNumber(p.costCents)))

  private def matches(raw: Map[String, String], terms: Seq[String], filters: Map[String, String]): Boolean = {
    val text = s"\${raw("title")} \${raw("brand")} \${raw("category")}".toLowerCase
    terms.forall(text.contains(_)) && filters.forall {
      case (field @ ("min_price" | "max_price"), value) =>
        value.toLongOption.exists { bound =>
          val price = raw("price_cents").toLong
          if (field == "min_price") price >= bound else price <= bound
        }
      case (field, value) => raw.get(field).contains(value) // any stored field is a filter: equality on its text
    }
  }

  /** The query engine: the tenant's products matching every term of q and every filter, cheapest first, at most pageSize. */
  def runQuery(tenant: String, q: String, filters: Map[String, String], pageSize: Int): Seq[JsObject] = {
    val terms = normalizeQuery(q).split(" ").filter(_.nonEmpty).toSeq
    jedis.smembers(s"catalog:$tenant:ids").asScala.toSeq
      .map(id => jedis.hgetAll(productKey(tenant, id)).asScala.toMap)
      .filter(raw => raw.nonEmpty && matches(raw, terms, filters))
      .flatMap(product)
      .sortBy(p => (p.priceCents, p.id))
      .take(pageSize)
      .map(publicView)
  }
}
`,
};
