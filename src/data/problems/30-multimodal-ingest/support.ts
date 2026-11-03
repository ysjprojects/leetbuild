/**
 * Hand-written support modules the multimodal-ingest steps import but no step builds: the `ingest`
 * package. `ingest.assets` is the asset store (Redis hashes, the course's stand-in for the assets
 * database) with the backfill set and the outbox; `ingest.vectors` is the index writer step 4
 * calls before it publishes; `ingest.objects` is the object store's side of a signed read URL
 * (the MAC under the key it shares with the API, and the check it runs on every URL). The five
 * languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'ingest/__init__.py': '',
  'ingest/assets.py': `"""
The asset store (provided): every asset is a Redis hash asset:{asset_id} with asset_id, tenant,
checksum, mime, byte_size, caption, caption_source, degraded ("1" or "0"), state (pending or
indexed) and embedding_ids (comma-separated); asset:by-hash:{tenant}:{checksum} holds the asset a
tenant registered for a content hash. ingest:backfill is the set of assets indexed without a
caption, outbox the list of events the broker did not take (JSON rows: topic, key, payload).
An asset is a dict: caption and caption_source None when unset, degraded a bool, byte_size an int,
embedding_ids a list. A captioned result is a dict: caption (None: none), caption_source (user,
vision or none) and degraded.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def asset_key(asset_id: str) -> str:
    return f"asset:{asset_id}"


def _asset(raw: dict) -> dict | None:
    if not raw:
        return None
    return {
        "asset_id": raw["asset_id"],
        "tenant": raw["tenant"],
        "checksum": raw["checksum"],
        "mime": raw["mime"],
        "byte_size": int(raw["byte_size"]),
        "caption": raw.get("caption") or None,
        "caption_source": raw.get("caption_source") or None,
        "degraded": raw.get("degraded") == "1",
        "state": raw["state"],
        "embedding_ids": [e for e in raw.get("embedding_ids", "").split(",") if e],
    }


def get(asset_id: str) -> dict | None:
    """The asset, or None."""
    return _asset(r.hgetall(asset_key(asset_id)))


def find(tenant: str, checksum: str) -> dict | None:
    """The asset the tenant registered for this content hash, or None."""
    asset_id = r.get(f"asset:by-hash:{tenant}:{checksum}")
    return get(asset_id) if asset_id else None


def create(tenant: str, checksum: str, mime: str, byte_size: int, caption: str | None) -> dict:
    """A new pending asset with the next id (a-1, a-2, …), findable under (tenant, checksum)."""
    asset_id = f"a-{r.incr('asset:seq')}"
    r.hset(asset_key(asset_id), mapping={
        "asset_id": asset_id, "tenant": tenant, "checksum": checksum, "mime": mime, "byte_size": byte_size,
        "caption": caption or "", "caption_source": "", "degraded": "0", "state": "pending", "embedding_ids": "",
    })
    r.set(f"asset:by-hash:{tenant}:{checksum}", asset_id)
    return get(asset_id)


def record_index(asset_id: str, captioned: dict, embedding_ids: list[str]) -> dict:
    """Mark the asset indexed with its caption and embedding ids; returns the asset."""
    r.hset(asset_key(asset_id), mapping={
        "state": "indexed",
        "caption": captioned["caption"] or "",
        "caption_source": captioned["caption_source"],
        "degraded": "1" if captioned["degraded"] else "0",
        "embedding_ids": ",".join(embedding_ids),
    })
    return get(asset_id)


def queue_backfill(asset_id: str) -> None:
    """Remember the asset for the caption backfill."""
    r.sadd("ingest:backfill", asset_id)


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """An event the broker did not take, for the relay to publish later."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
  'ingest/vectors.py': `"""
The index writer (provided): upsert embeds an asset, an image vector always and a caption vector
when it has a caption, writes index:{asset_id} (tenant, vectors, caption), records the result on
the asset (state indexed) and returns the embedding ids ({asset_id}:image, {asset_id}:caption).
"""
import redis

from ingest import assets

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def upsert(asset: dict, captioned: dict) -> list[str]:
    """Index the asset with its captioned result; returns the embedding ids."""
    vectors = ["image"] + (["caption"] if captioned["caption"] else [])
    embedding_ids = [f"{asset['asset_id']}:{v}" for v in vectors]
    r.hset(f"index:{asset['asset_id']}", mapping={
        "tenant": asset["tenant"], "vectors": ",".join(vectors), "caption": captioned["caption"] or "",
    })
    assets.record_index(asset["asset_id"], captioned, embedding_ids)
    return embedding_ids
`,
  'ingest/objects.py': `"""
The object store (provided): the bytes of an image live under object:{checksum}. A read URL is
{BASE_URL}/{checksum}?tenant={tenant}&expires={unix seconds}&sig={sig}; the store serves it
(verify) only to the tenant it names, only until expires, and only when sig is
mac(f"{checksum}|{tenant}|{expires}"). mac is HMAC-SHA256 (hex) under the key the store shares
with the API.
"""
import hashlib
import hmac
import time

import redis

BASE_URL = "https://objects.ingest.internal"
SIGNING_KEY = b"ingest-objects-v1"

r = redis.Redis(host="redis", port=6379)


def mac(message: str) -> str:
    """The store's MAC of message."""
    return hmac.new(SIGNING_KEY, message.encode(), hashlib.sha256).hexdigest()


def read(checksum: str) -> bytes | None:
    """The image's bytes, or None."""
    return r.get(f"object:{checksum}")


def verify(url: str, tenant: str) -> bool:
    """Whether the store serves url to tenant now."""
    prefix = BASE_URL + "/"
    if not url.startswith(prefix) or "?" not in url:
        return False
    checksum, query = url[len(prefix):].split("?", 1)
    params = dict(part.split("=", 1) for part in query.split("&") if "=" in part)
    named, expires, sig = params.get("tenant", ""), params.get("expires", ""), params.get("sig", "")
    if named != tenant or not expires.isdigit() or time.time() > int(expires):
        return False
    return hmac.compare_digest(sig, mac(f"{checksum}|{named}|{expires}"))
`,
};

export const supportModulesTs: Record<string, string> = {
  'ingest/assets.ts': `/**
 * The asset store (provided): every asset is a Redis hash asset:{asset_id} with asset_id, tenant,
 * checksum, mime, byte_size, caption, caption_source, degraded ("1" or "0"), state (pending or
 * indexed) and embedding_ids (comma-separated); asset:by-hash:{tenant}:{checksum} holds the asset
 * a tenant registered for a content hash. ingest:backfill is the set of assets indexed without a
 * caption, outbox the list of events the broker did not take (JSON rows: topic, key, payload).
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Asset {
  asset_id: string;
  tenant: string;
  checksum: string;
  mime: string;
  byte_size: number;
  caption: string | null;
  caption_source: string | null;
  degraded: boolean;
  state: string;
  embedding_ids: string[];
}

/** What step 3 makes of an asset: its caption (null: none), where it came from (user, vision or none), and whether it is degraded. */
export interface Captioned {
  caption: string | null;
  caption_source: string;
  degraded: boolean;
}

export const assetKey = (assetId: string): string => \`asset:\${assetId}\`;

function asset(raw: Record<string, string>): Asset | null {
  if (Object.keys(raw).length === 0) return null;
  return {
    asset_id: raw.asset_id,
    tenant: raw.tenant,
    checksum: raw.checksum,
    mime: raw.mime,
    byte_size: Number(raw.byte_size),
    caption: raw.caption || null,
    caption_source: raw.caption_source || null,
    degraded: raw.degraded === '1',
    state: raw.state,
    embedding_ids: (raw.embedding_ids ?? '').split(',').filter(e => e !== ''),
  };
}

/** The asset, or null. */
export async function get(assetId: string): Promise<Asset | null> {
  return asset(await redis.hgetall(assetKey(assetId)));
}

/** The asset the tenant registered for this content hash, or null. */
export async function find(tenant: string, checksum: string): Promise<Asset | null> {
  const assetId = await redis.get(\`asset:by-hash:\${tenant}:\${checksum}\`);
  return assetId ? get(assetId) : null;
}

/** A new pending asset with the next id (a-1, a-2, …), findable under (tenant, checksum). */
export async function create(tenant: string, checksum: string, mime: string, byteSize: number, caption: string | null): Promise<Asset> {
  const assetId = \`a-\${await redis.incr('asset:seq')}\`;
  await redis.hset(assetKey(assetId), {
    asset_id: assetId, tenant, checksum, mime, byte_size: String(byteSize),
    caption: caption ?? '', caption_source: '', degraded: '0', state: 'pending', embedding_ids: '',
  });
  await redis.set(\`asset:by-hash:\${tenant}:\${checksum}\`, assetId);
  return (await get(assetId)) as Asset;
}

/** Mark the asset indexed with its caption and embedding ids; returns the asset. */
export async function recordIndex(assetId: string, captioned: Captioned, embeddingIds: string[]): Promise<Asset> {
  await redis.hset(assetKey(assetId), {
    state: 'indexed',
    caption: captioned.caption ?? '',
    caption_source: captioned.caption_source,
    degraded: captioned.degraded ? '1' : '0',
    embedding_ids: embeddingIds.join(','),
  });
  return (await get(assetId)) as Asset;
}

/** Remember the asset for the caption backfill. */
export async function queueBackfill(assetId: string): Promise<void> {
  await redis.sadd('ingest:backfill', assetId);
}

/** An event the broker did not take, for the relay to publish later. */
export async function insertOutbox(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
  'ingest/vectors.ts': `/**
 * The index writer (provided): upsert embeds an asset, an image vector always and a caption vector
 * when it has a caption, writes index:{asset_id} (tenant, vectors, caption), records the result on
 * the asset (state indexed) and returns the embedding ids ({asset_id}:image, {asset_id}:caption).
 */
import Redis from 'ioredis';

import {type Asset, type Captioned, recordIndex} from './assets';

const redis = new Redis({host: 'redis', port: 6379});

/** Index the asset with its captioned result; returns the embedding ids. */
export async function upsert(asset: Asset, captioned: Captioned): Promise<string[]> {
  const vectors = captioned.caption ? ['image', 'caption'] : ['image'];
  const embeddingIds = vectors.map(v => \`\${asset.asset_id}:\${v}\`);
  await redis.hset(\`index:\${asset.asset_id}\`, {tenant: asset.tenant, vectors: vectors.join(','), caption: captioned.caption ?? ''});
  await recordIndex(asset.asset_id, captioned, embeddingIds);
  return embeddingIds;
}
`,
  'ingest/objects.ts': `/**
 * The object store (provided): the bytes of an image live under object:{checksum}. A read URL is
 * {BASE_URL}/{checksum}?tenant={tenant}&expires={unix seconds}&sig={sig}; the store serves it
 * (verify) only to the tenant it names, only until expires, and only when sig is
 * mac(\`\${checksum}|\${tenant}|\${expires}\`). mac is HMAC-SHA256 (hex) under the key the store
 * shares with the API.
 */
import {createHmac} from 'node:crypto';

import Redis from 'ioredis';

export const BASE_URL = 'https://objects.ingest.internal';
const SIGNING_KEY = 'ingest-objects-v1';

const redis = new Redis({host: 'redis', port: 6379});

/** The store's MAC of message. */
export const mac = (message: string): string => createHmac('sha256', SIGNING_KEY).update(message).digest('hex');

/** The image's bytes, or null. */
export async function read(checksum: string): Promise<Buffer | null> {
  return redis.getBuffer(\`object:\${checksum}\`);
}

/** Whether the store serves url to tenant now. */
export function verify(url: string, tenant: string): boolean {
  const prefix = \`\${BASE_URL}/\`;
  if (!url.startsWith(prefix) || !url.includes('?')) return false;
  const rest = url.slice(prefix.length);
  const checksum = rest.slice(0, rest.indexOf('?'));
  const params = new Map<string, string>();
  for (const part of rest.slice(rest.indexOf('?') + 1).split('&')) {
    const eq = part.indexOf('=');
    if (eq > 0) params.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const named = params.get('tenant') ?? '';
  const expires = params.get('expires') ?? '';
  if (named !== tenant || !/^\\d+$/.test(expires) || Date.now() / 1000 > Number(expires)) return false;
  return params.get('sig') === mac(\`\${checksum}|\${named}|\${expires}\`);
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'ingest/assets/assets.go': `// Package assets is the asset store (provided): every asset is a Redis hash asset:{asset_id} with
// asset_id, tenant, checksum, mime, byte_size, caption, caption_source, degraded ("1" or "0"),
// state (pending or indexed) and embedding_ids (comma-separated); asset:by-hash:{tenant}:{checksum}
// holds the asset a tenant registered for a content hash. ingest:backfill is the set of assets
// indexed without a caption, outbox the list of events the broker did not take (JSON rows: topic,
// key, payload). An unset caption or caption source is "".
package assets

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Asset is one registered asset.
type Asset struct {
	AssetID       string   \`json:"asset_id"\`
	Tenant        string   \`json:"tenant"\`
	Checksum      string   \`json:"checksum"\`
	Mime          string   \`json:"mime"\`
	ByteSize      int64    \`json:"byte_size"\`
	Caption       string   \`json:"caption"\`
	CaptionSource string   \`json:"caption_source"\`
	Degraded      bool     \`json:"degraded"\`
	State         string   \`json:"state"\`
	EmbeddingIDs  []string \`json:"embedding_ids"\`
}

// Captioned is what step 3 makes of an asset: its caption ("": none), where it came from (user,
// vision or none), and whether it is degraded.
type Captioned struct {
	Caption  string \`json:"caption"\`
	Source   string \`json:"caption_source"\`
	Degraded bool   \`json:"degraded"\`
}

// AssetKey is the hash of an asset.
func AssetKey(assetID string) string { return "asset:" + assetID }

func asset(raw map[string]string) *Asset {
	if len(raw) == 0 {
		return nil
	}
	size, _ := strconv.ParseInt(raw["byte_size"], 10, 64)
	ids := []string{}
	for _, e := range strings.Split(raw["embedding_ids"], ",") {
		if e != "" {
			ids = append(ids, e)
		}
	}
	return &Asset{
		AssetID: raw["asset_id"], Tenant: raw["tenant"], Checksum: raw["checksum"], Mime: raw["mime"], ByteSize: size,
		Caption: raw["caption"], CaptionSource: raw["caption_source"], Degraded: raw["degraded"] == "1", State: raw["state"], EmbeddingIDs: ids,
	}
}

// Get is the asset, or nil.
func Get(ctx context.Context, assetID string) *Asset {
	return asset(rdb.HGetAll(ctx, AssetKey(assetID)).Val())
}

// Find is the asset the tenant registered for this content hash, or nil.
func Find(ctx context.Context, tenant, checksum string) *Asset {
	assetID, err := rdb.Get(ctx, "asset:by-hash:"+tenant+":"+checksum).Result()
	if err != nil {
		return nil
	}
	return Get(ctx, assetID)
}

// Create makes a new pending asset with the next id (a-1, a-2, …), findable under (tenant, checksum).
func Create(ctx context.Context, tenant, checksum, mime string, byteSize int64, caption string) (*Asset, error) {
	assetID := fmt.Sprintf("a-%d", rdb.Incr(ctx, "asset:seq").Val())
	err := rdb.HSet(ctx, AssetKey(assetID), map[string]any{
		"asset_id": assetID, "tenant": tenant, "checksum": checksum, "mime": mime, "byte_size": strconv.FormatInt(byteSize, 10),
		"caption": caption, "caption_source": "", "degraded": "0", "state": "pending", "embedding_ids": "",
	}).Err()
	if err != nil {
		return nil, err
	}
	if err := rdb.Set(ctx, "asset:by-hash:"+tenant+":"+checksum, assetID, 0).Err(); err != nil {
		return nil, err
	}
	return Get(ctx, assetID), nil
}

// RecordIndex marks the asset indexed with its caption and embedding ids.
func RecordIndex(ctx context.Context, assetID string, c Captioned, embeddingIDs []string) error {
	degraded := "0"
	if c.Degraded {
		degraded = "1"
	}
	return rdb.HSet(ctx, AssetKey(assetID), map[string]any{
		"state": "indexed", "caption": c.Caption, "caption_source": c.Source, "degraded": degraded, "embedding_ids": strings.Join(embeddingIDs, ","),
	}).Err()
}

// QueueBackfill remembers the asset for the caption backfill.
func QueueBackfill(ctx context.Context, assetID string) error {
	return rdb.SAdd(ctx, "ingest:backfill", assetID).Err()
}

// InsertOutbox keeps an event the broker did not take, for the relay to publish later.
func InsertOutbox(ctx context.Context, topic, key string, payload map[string]any) error {
	row, _ := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	return rdb.RPush(ctx, "outbox", row).Err()
}
`,
  'ingest/vectors/vectors.go': `// Package vectors is the index writer (provided): Upsert embeds an asset, an image vector always
// and a caption vector when it has a caption, writes index:{asset_id} (tenant, vectors, caption),
// records the result on the asset (state indexed) and returns the embedding ids
// ({asset_id}:image, {asset_id}:caption).
package vectors

import (
	"context"
	"strings"

	"github.com/redis/go-redis/v9"

	"ingest/assets"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Upsert indexes the asset with its captioned result and returns the embedding ids.
func Upsert(ctx context.Context, a assets.Asset, c assets.Captioned) ([]string, error) {
	vectors := []string{"image"}
	if c.Caption != "" {
		vectors = append(vectors, "caption")
	}
	ids := make([]string, 0, len(vectors))
	for _, v := range vectors {
		ids = append(ids, a.AssetID+":"+v)
	}
	err := rdb.HSet(ctx, "index:"+a.AssetID, map[string]any{"tenant": a.Tenant, "vectors": strings.Join(vectors, ","), "caption": c.Caption}).Err()
	if err != nil {
		return nil, err
	}
	return ids, assets.RecordIndex(ctx, a.AssetID, c, ids)
}
`,
  'ingest/objects/objects.go': `// Package objects is the object store (provided): the bytes of an image live under
// object:{checksum}. A read URL is {BaseURL}/{checksum}?tenant={tenant}&expires={unix seconds}&sig={sig};
// the store serves it (Verify) only to the tenant it names, only until expires, and only when sig
// is Mac(checksum + "|" + tenant + "|" + expires). Mac is HMAC-SHA256 (hex) under the key the store
// shares with the API.
package objects

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// BaseURL is where the store serves objects.
const BaseURL = "https://objects.ingest.internal"

var signingKey = []byte("ingest-objects-v1")

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Mac is the store's MAC of message.
func Mac(message string) string {
	h := hmac.New(sha256.New, signingKey)
	h.Write([]byte(message))
	return hex.EncodeToString(h.Sum(nil))
}

// Read is the image's bytes, or nil.
func Read(ctx context.Context, checksum string) []byte {
	data, err := rdb.Get(ctx, "object:"+checksum).Bytes()
	if err != nil {
		return nil
	}
	return data
}

// Verify reports whether the store serves url to tenant now.
func Verify(url, tenant string) bool {
	rest, ok := strings.CutPrefix(url, BaseURL+"/")
	if !ok {
		return false
	}
	checksum, query, ok := strings.Cut(rest, "?")
	if !ok {
		return false
	}
	params := map[string]string{}
	for _, part := range strings.Split(query, "&") {
		if k, v, found := strings.Cut(part, "="); found {
			params[k] = v
		}
	}
	named, expires := params["tenant"], params["expires"]
	at, err := strconv.ParseInt(expires, 10, 64)
	if named != tenant || err != nil || time.Now().Unix() > at {
		return false
	}
	return hmac.Equal([]byte(params["sig"]), []byte(Mac(checksum+"|"+named+"|"+expires)))
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'ingest/assets.h': `// The asset store (provided): every asset is a Redis hash asset:{asset_id} with asset_id, tenant,
// checksum, mime, byte_size, caption, caption_source, degraded ("1" or "0"), state (pending or
// indexed) and embedding_ids (comma-separated); asset:by-hash:{tenant}:{checksum} holds the asset a
// tenant registered for a content hash. ingest:backfill is the set of assets indexed without a
// caption, outbox the list of events the broker did not take (JSON rows: topic, key, payload). An
// unset caption or caption source is "".
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace assets {

struct Asset {
  std::string asset_id;
  std::string tenant;
  std::string checksum;
  std::string mime;
  long long byte_size = 0;
  std::string caption;
  std::string caption_source;
  bool degraded = false;
  std::string state;
  std::vector<std::string> embedding_ids;
};

// What step 3 makes of an asset: its caption ("": none), where it came from (user, vision or
// none), and whether it is degraded.
struct Captioned {
  std::string caption;
  std::string source;
  bool degraded = false;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string assetKey(const std::string& asset_id) { return "asset:" + asset_id; }

// The asset as a JSON object (caption and caption_source null when unset).
inline nlohmann::json toJson(const Asset& a) {
  return nlohmann::json{{"asset_id", a.asset_id},
                        {"tenant", a.tenant},
                        {"checksum", a.checksum},
                        {"mime", a.mime},
                        {"byte_size", a.byte_size},
                        {"caption", a.caption.empty() ? nlohmann::json(nullptr) : nlohmann::json(a.caption)},
                        {"caption_source", a.caption_source.empty() ? nlohmann::json(nullptr) : nlohmann::json(a.caption_source)},
                        {"degraded", a.degraded},
                        {"state", a.state},
                        {"embedding_ids", a.embedding_ids}};
}

// The asset, or none.
inline std::optional<Asset> get(const std::string& asset_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(assetKey(asset_id));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  Asset a;
  a.asset_id = text("asset_id");
  a.tenant = text("tenant");
  a.checksum = text("checksum");
  a.mime = text("mime");
  a.byte_size = text("byte_size").empty() ? 0 : std::stoll(text("byte_size"));
  a.caption = text("caption");
  a.caption_source = text("caption_source");
  a.degraded = text("degraded") == "1";
  a.state = text("state");
  const std::string ids = text("embedding_ids");
  size_t start = 0;
  while (start < ids.size()) {
    size_t comma = ids.find(',', start);
    if (comma == std::string::npos) comma = ids.size();
    if (comma > start) a.embedding_ids.push_back(ids.substr(start, comma - start));
    start = comma + 1;
  }
  return a;
}

// The asset the tenant registered for this content hash, or none.
inline std::optional<Asset> find(const std::string& tenant, const std::string& checksum) {
  const auto asset_id = redis().get("asset:by-hash:" + tenant + ":" + checksum);
  if (!asset_id) return std::nullopt;
  return get(*asset_id);
}

// A new pending asset with the next id (a-1, a-2, …), findable under (tenant, checksum).
inline Asset create(const std::string& tenant, const std::string& checksum, const std::string& mime, long long byte_size,
                    const std::string& caption) {
  const std::string asset_id = "a-" + std::to_string(redis().incr("asset:seq"));
  const std::map<std::string, std::string> fields = {
      {"asset_id", asset_id}, {"tenant", tenant},           {"checksum", checksum}, {"mime", mime},
      {"byte_size", std::to_string(byte_size)}, {"caption", caption}, {"caption_source", ""},
      {"degraded", "0"},      {"state", "pending"},         {"embedding_ids", ""}};
  redis().hset(assetKey(asset_id), fields.begin(), fields.end());
  redis().set("asset:by-hash:" + tenant + ":" + checksum, asset_id);
  return *get(asset_id);
}

// Mark the asset indexed with its caption and embedding ids.
inline void recordIndex(const std::string& asset_id, const Captioned& c, const std::vector<std::string>& embedding_ids) {
  std::string ids;
  for (const std::string& id : embedding_ids) ids += (ids.empty() ? "" : ",") + id;
  const std::map<std::string, std::string> fields = {{"state", "indexed"},
                                                     {"caption", c.caption},
                                                     {"caption_source", c.source},
                                                     {"degraded", c.degraded ? "1" : "0"},
                                                     {"embedding_ids", ids}};
  redis().hset(assetKey(asset_id), fields.begin(), fields.end());
}

// Remember the asset for the caption backfill.
inline void queueBackfill(const std::string& asset_id) { redis().sadd("ingest:backfill", asset_id); }

// An event the broker did not take, for the relay to publish later.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace assets
`,
  'ingest/vectors.h': `// The index writer (provided): upsert embeds an asset, an image vector always and a caption vector
// when it has a caption, writes index:{asset_id} (tenant, vectors, caption), records the result on
// the asset (state indexed) and returns the embedding ids ({asset_id}:image, {asset_id}:caption).
#pragma once

#include <sw/redis++/redis++.h>

#include <map>
#include <string>
#include <vector>

#include "ingest/assets.h"

namespace vectors {

// Index the asset with its captioned result; returns the embedding ids.
inline std::vector<std::string> upsert(const assets::Asset& a, const assets::Captioned& c) {
  std::vector<std::string> kinds = {"image"};
  if (!c.caption.empty()) kinds.push_back("caption");
  std::vector<std::string> ids;
  std::string joined;
  for (const std::string& kind : kinds) {
    ids.push_back(a.asset_id + ":" + kind);
    joined += (joined.empty() ? "" : ",") + kind;
  }
  const std::map<std::string, std::string> fields = {{"tenant", a.tenant}, {"vectors", joined}, {"caption", c.caption}};
  assets::redis().hset("index:" + a.asset_id, fields.begin(), fields.end());
  assets::recordIndex(a.asset_id, c, ids);
  return ids;
}

}  // namespace vectors
`,
  'ingest/objects.h': `// The object store (provided): the bytes of an image live under object:{checksum}. A read URL is
// {kBaseUrl}/{checksum}?tenant={tenant}&expires={unix seconds}&sig={sig}; the store serves it
// (verify) only to the tenant it names, only until expires, and only when sig is
// mac(checksum + "|" + tenant + "|" + expires). mac is HMAC-SHA256 (hex) under the key the store
// shares with the API.
#pragma once

#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <map>
#include <optional>
#include <string>

namespace objects {

inline const std::string kBaseUrl = "https://objects.ingest.internal";
inline const std::string kSigningKey = "ingest-objects-v1";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The store's MAC of message.
inline std::string mac(const std::string& message) {
  unsigned char digest[EVP_MAX_MD_SIZE];
  unsigned int length = 0;
  HMAC(EVP_sha256(), kSigningKey.data(), static_cast<int>(kSigningKey.size()), reinterpret_cast<const unsigned char*>(message.data()),
       message.size(), digest, &length);
  static const char* hex = "0123456789abcdef";
  std::string out;
  for (unsigned int i = 0; i < length; i++) {
    out += hex[digest[i] >> 4];
    out += hex[digest[i] & 15];
  }
  return out;
}

// The image's bytes, or none.
inline std::optional<std::string> read(const std::string& checksum) { return redis().get("object:" + checksum); }

// Whether the store serves url to tenant now.
inline bool verify(const std::string& url, const std::string& tenant) {
  const std::string prefix = kBaseUrl + "/";
  if (url.rfind(prefix, 0) != 0) return false;
  const size_t q = url.find('?');
  if (q == std::string::npos) return false;
  const std::string checksum = url.substr(prefix.size(), q - prefix.size());
  std::map<std::string, std::string> params;
  size_t start = q + 1;
  while (start <= url.size()) {
    size_t amp = url.find('&', start);
    if (amp == std::string::npos) amp = url.size();
    const std::string part = url.substr(start, amp - start);
    const size_t eq = part.find('=');
    if (eq != std::string::npos && eq > 0) params[part.substr(0, eq)] = part.substr(eq + 1);
    start = amp + 1;
  }
  const std::string named = params["tenant"];
  const std::string expires = params["expires"];
  if (named != tenant || expires.empty() || expires.find_first_not_of("0123456789") != std::string::npos) return false;
  const long long now =
      std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  if (now > std::stoll(expires)) return false;
  return params["sig"] == mac(checksum + "|" + named + "|" + expires);
}

}  // namespace objects
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('ingest', 'Assets')]: `package ingest

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The asset store (provided): every asset is a Redis hash asset:{asset_id} with asset_id, tenant,
 * checksum, mime, byte_size, caption, caption_source, degraded ("1" or "0"), state (pending or
 * indexed) and embedding_ids (comma-separated); asset:by-hash:{tenant}:{checksum} holds the asset
 * a tenant registered for a content hash. ingest:backfill is the set of assets indexed without a
 * caption, outbox the list of events the broker did not take (JSON rows: topic, key, payload).
 */
object Assets {
  final case class Asset(
      assetId: String,
      tenant: String,
      checksum: String,
      mime: String,
      byteSize: Long,
      caption: Option[String],
      captionSource: Option[String],
      degraded: Boolean,
      state: String,
      embeddingIds: Seq[String])

  /** What step 3 makes of an asset: its caption (None: none), where it came from (user, vision or none), and whether it is degraded. */
  final case class Captioned(caption: Option[String], source: String, degraded: Boolean)

  val jedis = new JedisPooled("redis", 6379)

  def assetKey(assetId: String): String = s"asset:$assetId"

  /** The asset as a JSON object (caption and caption_source null when unset). */
  def toJson(a: Asset): JsObject = JsObject(
    "asset_id" -> JsString(a.assetId),
    "tenant" -> JsString(a.tenant),
    "checksum" -> JsString(a.checksum),
    "mime" -> JsString(a.mime),
    "byte_size" -> JsNumber(a.byteSize),
    "caption" -> a.caption.map(JsString(_)).getOrElse(JsNull),
    "caption_source" -> a.captionSource.map(JsString(_)).getOrElse(JsNull),
    "degraded" -> JsBoolean(a.degraded),
    "state" -> JsString(a.state),
    "embedding_ids" -> JsArray(a.embeddingIds.map(JsString(_)).toVector))

  /** The asset, if it exists. */
  def get(assetId: String): Option[Asset] = {
    val raw = jedis.hgetAll(assetKey(assetId)).asScala.toMap
    if (raw.isEmpty) None
    else {
      def text(name: String): Option[String] = raw.get(name).filter(_.nonEmpty)
      Some(Asset(raw("asset_id"), raw("tenant"), raw("checksum"), raw("mime"), raw("byte_size").toLong, text("caption"),
        text("caption_source"), raw.get("degraded").contains("1"), raw("state"), text("embedding_ids").map(_.split(",").toSeq).getOrElse(Seq.empty)))
    }
  }

  /** The asset the tenant registered for this content hash, if any. */
  def find(tenant: String, checksum: String): Option[Asset] =
    Option(jedis.get(s"asset:by-hash:$tenant:$checksum")).flatMap(get)

  /** A new pending asset with the next id (a-1, a-2, …), findable under (tenant, checksum). */
  def create(tenant: String, checksum: String, mime: String, byteSize: Long, caption: Option[String]): Asset = {
    val assetId = s"a-\${jedis.incr("asset:seq")}"
    jedis.hset(assetKey(assetId), Map(
      "asset_id" -> assetId, "tenant" -> tenant, "checksum" -> checksum, "mime" -> mime, "byte_size" -> byteSize.toString,
      "caption" -> caption.getOrElse(""), "caption_source" -> "", "degraded" -> "0", "state" -> "pending", "embedding_ids" -> "").asJava)
    jedis.set(s"asset:by-hash:$tenant:$checksum", assetId)
    get(assetId).get
  }

  /** Mark the asset indexed with its caption and embedding ids. */
  def recordIndex(assetId: String, captioned: Captioned, embeddingIds: Seq[String]): Unit =
    jedis.hset(assetKey(assetId), Map(
      "state" -> "indexed", "caption" -> captioned.caption.getOrElse(""), "caption_source" -> captioned.source,
      "degraded" -> (if (captioned.degraded) "1" else "0"), "embedding_ids" -> embeddingIds.mkString(",")).asJava)

  /** Remember the asset for the caption backfill. */
  def queueBackfill(assetId: String): Unit = jedis.sadd("ingest:backfill", assetId)

  /** An event the broker did not take, for the relay to publish later. */
  def insertOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
  [scalaPath('ingest', 'Vectors')]: `package ingest

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The index writer (provided): upsert embeds an asset, an image vector always and a caption vector
 * when it has a caption, writes index:{asset_id} (tenant, vectors, caption), records the result on
 * the asset (state indexed) and returns the embedding ids ({asset_id}:image, {asset_id}:caption).
 */
object Vectors {
  val jedis = new JedisPooled("redis", 6379)

  /** Index the asset with its captioned result; returns the embedding ids. */
  def upsert(asset: Assets.Asset, captioned: Assets.Captioned): Seq[String] = {
    val vectors = if (captioned.caption.isDefined) Seq("image", "caption") else Seq("image")
    val ids = vectors.map(v => s"\${asset.assetId}:$v")
    jedis.hset(s"index:\${asset.assetId}", Map("tenant" -> asset.tenant, "vectors" -> vectors.mkString(","), "caption" -> captioned.caption.getOrElse("")).asJava)
    Assets.recordIndex(asset.assetId, captioned, ids)
    ids
  }
}
`,
  [scalaPath('ingest', 'Objects')]: `package ingest

import java.nio.charset.StandardCharsets.UTF_8
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

import redis.clients.jedis.JedisPooled

/**
 * The object store (provided): the bytes of an image live under object:{checksum}. A read URL is
 * {BaseUrl}/{checksum}?tenant={tenant}&expires={unix seconds}&sig={sig}; the store serves it
 * (verify) only to the tenant it names, only until expires, and only when sig is
 * mac(s"$checksum|$tenant|$expires"). mac is HMAC-SHA256 (hex) under the key the store shares with
 * the API.
 */
object Objects {
  val BaseUrl = "https://objects.ingest.internal"
  private val SigningKey = "ingest-objects-v1"

  val jedis = new JedisPooled("redis", 6379)

  /** The store's MAC of message. */
  def mac(message: String): String = {
    val hmac = Mac.getInstance("HmacSHA256")
    hmac.init(new SecretKeySpec(SigningKey.getBytes(UTF_8), "HmacSHA256"))
    hmac.doFinal(message.getBytes(UTF_8)).map(b => f"\${b & 0xff}%02x").mkString
  }

  /** The image's bytes, if stored. */
  def read(checksum: String): Option[Array[Byte]] = Option(jedis.get(s"object:$checksum".getBytes(UTF_8)))

  /** Whether the store serves url to tenant now. */
  def verify(url: String, tenant: String): Boolean = {
    val prefix = BaseUrl + "/"
    if (!url.startsWith(prefix) || !url.contains("?")) false
    else {
      val (checksum, query) = url.drop(prefix.length).span(_ != '?')
      val params = query.drop(1).split("&").toSeq.flatMap { part =>
        part.split("=", 2) match {
          case Array(k, v) if k.nonEmpty => Some(k -> v)
          case _ => None
        }
      }.toMap
      val named = params.getOrElse("tenant", "")
      val expires = params.getOrElse("expires", "")
      named == tenant && expires.nonEmpty && expires.forall(_.isDigit) &&
        System.currentTimeMillis() / 1000 <= expires.toLong && params.get("sig").contains(mac(s"$checksum|$named|$expires"))
    }
  }
}
`,
};
