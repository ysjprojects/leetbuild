import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/skus/{sku}/stock: the number the storefront trusts',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'api', 'redis', 'sync'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/skus/{sku}/stock\`, the number the storefront shows
next to "add to cart": it answers 404 for a sku the catalogue does not know, reads \`stock:{sku}\`
through a five-minute in-process cache, and answers
\`{sku, available, reserved: 0, on_hand, synced_at, stale: false}\`. It serves the demo and hides four
flaws.

**Failure mode the checks target.** A storefront that shows units a reservation took a minute ago,
units sitting in carts that are counted nowhere, a tenant reading another tenant's stock, and a
warehouse sync that stalled without anyone being told.

- \`available\` and \`reserved\` come from one Lua snapshot of \`stock:{sku}\` and \`holds:{sku}\`: a hold
  whose \`hold:{id}\` key is gone counts as available again, a live one as reserved;
  \`on_hand = available + reserved\`. Nothing caches the counter.
- \`catalog.owner(sku)\` must be the caller's tenant, else **404**.
- \`stale\` is true when \`synced_at\` is missing or older than \`SYNC_STALE_AFTER_S = 60\` seconds.`,
  sequence: {
    participants: ['Storefront', 'Inventory API', 'Redis'],
    messages: [
      {from: 'Storefront', to: 'Inventory API', label: 'GET /v1/skus/{sku}/stock · X-Tenant-Id', kind: 'sync'},
      {from: 'Inventory API', to: 'Redis', label: 'catalog.owner(sku) ≠ tenant → 404', kind: 'sync'},
      {from: 'Inventory API', to: 'Redis', label: 'EVAL levels · stock:{sku} holds:{sku}', kind: 'sync'},
      {from: 'Redis', to: 'Inventory API', label: '{available, reserved} from one snapshot', kind: 'reply'},
      {from: 'Inventory API', to: 'Inventory API', label: 'synced_at older than 60 s → stale', kind: 'sync'},
      {
        from: 'Inventory API',
        to: 'Storefront',
        label: '200 {available, reserved, on_hand, synced_at, stale}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'live-counter',
      title: 'Reads the counter the reservation path decrements',
      detail:
        'A read after a reservation of 4 shows 4 fewer available units. The starter answers from a five-minute cache of the counter.',
      match: {
        python: {all: [/stock_key\(/], none: [/ON_HAND_CACHE_TTL_S/]},
        typescript: {all: [/stockKey\(/], none: [/ON_HAND_CACHE_TTL_S/]},
        go: {all: [/stock\.Key\(/], none: [/onHandCacheTTL/]},
        scala: {all: [/Stock\.key\(/], none: [/OnHandCacheTtlS/]},
        cpp: {all: [/stock::Key\(/], none: [/kOnHandCacheTtlS/]},
      },
    },
    {
      id: 'reserved-holds',
      title: 'Counts live holds as reserved and expired ones as available',
      detail:
        'With one live hold of 2 and one expired hold of 3 on a sku of 10, the read answers available 8, reserved 2, on_hand 10. The starter reports nothing reserved.',
      match: {
        python: {all: [/holds_key\(/, /EXISTS|\.exists\(/]},
        typescript: {all: [/holdsKey\(/, /EXISTS|\.exists\(/]},
        go: {all: [/stock\.HoldsKey\(/, /EXISTS|\.Exists\(/]},
        scala: {all: [/Stock\.holdsKey\(/, /EXISTS|\.exists\(/]},
        cpp: {all: [/stock::HoldsKey\(/, /EXISTS|\.exists\(/]},
      },
    },
    {
      id: 'tenant-404',
      title: "Answers 404 for a sku the caller's tenant does not sell",
      detail:
        "Tenant t1 reading t2's sku gets **404**, as for an unknown sku; t2 reading it gets 200. The starter only checks that the sku exists.",
      match: {
        python: {all: [/catalog\.owner\(sku\)\s*!=\s*tenant|tenant\s*!=\s*catalog\.owner\(/]},
        typescript: {all: [/owner\(sku\)\)?\s*!==\s*tenant|tenant\s*!==\s*\(?await owner\(/]},
        go: {all: [/owner\s*!=\s*tenant|Owner\([^\n]*\)\s*!=\s*tenant/]},
        scala: {all: [/owner\(sku\)\.contains\(|owner\(sku\)\s*!=\s*Some\(/]},
        cpp: {all: [/Owner\(sku\)\s*!=\s*tenant/]},
      },
    },
    {
      id: 'stale',
      title: 'Reports stale when the warehouse sync is over 60 s old',
      detail:
        'A sync written now reads `stale: false`; two minutes later the same read says `stale: true`, with `synced_at` in the body. The starter always answers `stale: false`.',
      match: {
        python: {all: [/SYNC_STALE_AFTER_S/, /catalog\.synced_at\(/]},
        typescript: {all: [/SYNC_STALE_AFTER_S/, /syncedAt\(/]},
        go: {all: [/syncStaleAfter/, /catalog\.SyncedAt\(/]},
        scala: {all: [/SyncStaleAfterS/, /Catalog\.syncedAt\(/]},
        cpp: {all: [/kSyncStaleAfterS/, /catalog::SyncedAt\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis
from fastapi import FastAPI, HTTPException, Request

from inventory import catalog  # catalog.owner, synced_at
from inventory.stock import holds_key, stock_key

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

ON_HAND_CACHE_TTL_S = 300
_cache: dict[str, tuple[float, int]] = {}


@app.get("/v1/skus/{sku}/stock")
def read_stock(sku: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    if catalog.owner(sku) is None:
        raise HTTPException(status_code=404, detail="unknown sku")
    cached = _cache.get(sku)
    if cached is None or time.time() - cached[0] > ON_HAND_CACHE_TTL_S:
        cached = (time.time(), int(r.get(stock_key(sku)) or 0))
        _cache[sku] = cached
    available = cached[1]
    return {
        "sku": sku,
        "available": available,
        "reserved": 0,
        "on_hand": available,
        "synced_at": catalog.synced_at(sku),
        "stale": False,
    }
`,
      solution: `import time

import redis
from fastapi import FastAPI, HTTPException, Request

from inventory import catalog  # catalog.owner, synced_at
from inventory.stock import holds_key, stock_key

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

SYNC_STALE_AFTER_S = 60

# One snapshot of the counter and the hold map: a hold whose key expired is available again (the
# next reserve credits it), a live one is reserved. KEYS: stock:{sku}, holds:{sku}.
LEVELS_LUA = """
local available = tonumber(redis.call('GET', KEYS[1]) or '0')
local reserved = 0
local entries = redis.call('HGETALL', KEYS[2])
for i = 1, #entries, 2 do
  if redis.call('EXISTS', 'hold:' .. entries[i]) == 1 then
    reserved = reserved + tonumber(entries[i + 1])
  else
    available = available + tonumber(entries[i + 1])
  end
end
return {available, reserved}
"""
levels = r.register_script(LEVELS_LUA)


@app.get("/v1/skus/{sku}/stock")
def read_stock(sku: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if catalog.owner(sku) != tenant:
        raise HTTPException(status_code=404, detail="unknown sku")
    available, reserved = levels(keys=[stock_key(sku), holds_key(sku)])
    synced_at = catalog.synced_at(sku)
    # A counter the warehouse has not confirmed for a while can promise units the shelf does not have.
    stale = synced_at is None or time.time() - synced_at > SYNC_STALE_AFTER_S
    return {
        "sku": sku,
        "available": available,
        "reserved": reserved,
        "on_hand": available + reserved,
        "synced_at": synced_at,
        "stale": stale,
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {owner, syncedAt} from 'inventory/catalog';
import {holdsKey, stockKey} from 'inventory/stock';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const ON_HAND_CACHE_TTL_S = 300;
const cache = new Map<string, {at: number; units: number}>();

app.get('/v1/skus/:sku/stock', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {sku} = request.params as {sku: string};
  if ((await owner(sku)) === null) return reply.code(404).send({error: 'unknown sku'});
  const now = Date.now() / 1000;
  let cached = cache.get(sku);
  if (cached === undefined || now - cached.at > ON_HAND_CACHE_TTL_S) {
    cached = {at: now, units: Number((await redis.get(stockKey(sku))) ?? 0)};
    cache.set(sku, cached);
  }
  return {sku, available: cached.units, reserved: 0, on_hand: cached.units, synced_at: await syncedAt(sku), stale: false};
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {owner, syncedAt} from 'inventory/catalog';
import {holdsKey, stockKey} from 'inventory/stock';

export const app = Fastify();

export const SYNC_STALE_AFTER_S = 60;

// One snapshot of the counter and the hold map: a hold whose key expired is available again (the
// next reserve credits it), a live one is reserved. KEYS: stock:{sku}, holds:{sku}.
const LEVELS_LUA = \`
local available = tonumber(redis.call('GET', KEYS[1]) or '0')
local reserved = 0
local entries = redis.call('HGETALL', KEYS[2])
for i = 1, #entries, 2 do
  if redis.call('EXISTS', 'hold:' .. entries[i]) == 1 then
    reserved = reserved + tonumber(entries[i + 1])
  else
    available = available + tonumber(entries[i + 1])
  end
end
return {available, reserved}
\`;

interface LevelsRedis extends Redis {
  stockLevels(stock: string, holds: string): Promise<[number, number]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as LevelsRedis;
redis.defineCommand('stockLevels', {numberOfKeys: 2, lua: LEVELS_LUA});

app.get('/v1/skus/:sku/stock', async (request, reply) => {
  const {sku} = request.params as {sku: string};
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  if ((await owner(sku)) !== tenant) return reply.code(404).send({error: 'unknown sku'});
  const [available, reserved] = (await redis.stockLevels(stockKey(sku), holdsKey(sku))).map(Number);
  const synced = await syncedAt(sku);
  // A counter the warehouse has not confirmed for a while can promise units the shelf does not have.
  const stale = synced === null || Date.now() / 1000 - synced > SYNC_STALE_AFTER_S;
  return {sku, available, reserved, on_hand: available + reserved, synced_at: synced, stale};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"inventory/catalog" // catalog.Owner, SyncedAt
	"inventory/stock"   // stock.Key, HoldsKey
)

const onHandCacheTTL = 300 * time.Second

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type cachedUnits struct {
	at    time.Time
	units int64
}

var onHandCache = map[string]cachedUnits{}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readStock(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	sku := r.PathValue("sku")
	if catalog.Owner(r.Context(), sku) == "" {
		http.Error(rw, "unknown sku", http.StatusNotFound)
		return
	}
	cached, ok := onHandCache[sku]
	if !ok || time.Since(cached.at) > onHandCacheTTL {
		units, _ := rdb.Get(r.Context(), stock.Key(sku)).Int64()
		cached = cachedUnits{at: time.Now(), units: units}
		onHandCache[sku] = cached
	}
	var syncedAt any
	if at, synced := catalog.SyncedAt(r.Context(), sku); synced {
		syncedAt = at
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"sku": sku, "available": cached.units, "reserved": 0, "on_hand": cached.units, "synced_at": syncedAt, "stale": false,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/skus/{sku}/stock", readStock)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"inventory/catalog" // catalog.Owner, SyncedAt
	"inventory/stock"   // stock.Key, HoldsKey
)

const syncStaleAfter = 60 // seconds

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// One snapshot of the counter and the hold map: a hold whose key expired is available again (the
// next reserve credits it), a live one is reserved. KEYS: stock:{sku}, holds:{sku}.
var levelsScript = redis.NewScript(\`
local available = tonumber(redis.call('GET', KEYS[1]) or '0')
local reserved = 0
local entries = redis.call('HGETALL', KEYS[2])
for i = 1, #entries, 2 do
  if redis.call('EXISTS', 'hold:' .. entries[i]) == 1 then
    reserved = reserved + tonumber(entries[i + 1])
  else
    available = available + tonumber(entries[i + 1])
  end
end
return {available, reserved}
\`)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readStock(rw http.ResponseWriter, r *http.Request) {
	sku := r.PathValue("sku")
	tenant := r.Header.Get("X-Tenant-Id")
	if owner := catalog.Owner(r.Context(), sku); owner == "" || owner != tenant {
		http.Error(rw, "unknown sku", http.StatusNotFound)
		return
	}
	levels, err := levelsScript.Run(r.Context(), rdb, []string{stock.Key(sku), stock.HoldsKey(sku)}).Int64Slice()
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	available, reserved := levels[0], levels[1]
	// A counter the warehouse has not confirmed for a while can promise units the shelf does not have.
	var syncedAt any
	stale := true
	if at, synced := catalog.SyncedAt(r.Context(), sku); synced {
		syncedAt = at
		stale = time.Now().Unix()-at > syncStaleAfter
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"sku": sku, "available": available, "reserved": reserved, "on_hand": available + reserved, "synced_at": syncedAt, "stale": stale,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/skus/{sku}/stock", readStock)
}
`,
    },
    scala: {
      starter: `import scala.collection.mutable

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import inventory.{Catalog, Stock} // Catalog.owner, syncedAt; Stock.key, holdsKey

object Read {
  val jedis = new JedisPooled("redis", 6379)

  val OnHandCacheTtlS = 300L
  private val cache = mutable.Map.empty[String, (Long, Long)]

  private def nowSeconds(): Long = System.currentTimeMillis() / 1000

  val route: Route = path("v1" / "skus" / Segment / "stock") { sku =>
    get {
      // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
      if (Catalog.owner(sku).isEmpty) complete(StatusCodes.NotFound -> "unknown sku")
      else {
        val (_, units) = cache.get(sku).filter { case (at, _) => nowSeconds() - at <= OnHandCacheTtlS }.getOrElse {
          val fresh = (nowSeconds(), Option(jedis.get(Stock.key(sku))).map(_.toLong).getOrElse(0L))
          cache(sku) = fresh
          fresh
        }
        val body = JsObject(
          "sku" -> JsString(sku),
          "available" -> JsNumber(units),
          "reserved" -> JsNumber(0),
          "on_hand" -> JsNumber(units),
          "synced_at" -> Catalog.syncedAt(sku).map(JsNumber(_)).getOrElse(JsNull),
          "stale" -> JsBoolean(false)
        )
        complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
      }
    }
  }
}
`,
      solution: `import scala.jdk.CollectionConverters._

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import inventory.{Catalog, Stock} // Catalog.owner, syncedAt; Stock.key, holdsKey

object Read {
  val jedis = new JedisPooled("redis", 6379)

  val SyncStaleAfterS = 60L

  // One snapshot of the counter and the hold map: a hold whose key expired is available again (the
  // next reserve credits it), a live one is reserved. KEYS: stock:{sku}, holds:{sku}.
  val LevelsLua: String =
    """
      |local available = tonumber(redis.call('GET', KEYS[1]) or '0')
      |local reserved = 0
      |local entries = redis.call('HGETALL', KEYS[2])
      |for i = 1, #entries, 2 do
      |  if redis.call('EXISTS', 'hold:' .. entries[i]) == 1 then
      |    reserved = reserved + tonumber(entries[i + 1])
      |  else
      |    available = available + tonumber(entries[i + 1])
      |  end
      |end
      |return {available, reserved}
      |""".stripMargin

  val route: Route = path("v1" / "skus" / Segment / "stock") { sku =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        if (!Catalog.owner(sku).contains(tenant.getOrElse(""))) complete(StatusCodes.NotFound -> "unknown sku")
        else {
          val levels = jedis
            .eval(LevelsLua, List(Stock.key(sku), Stock.holdsKey(sku)).asJava, List.empty[String].asJava)
            .asInstanceOf[java.util.List[AnyRef]]
            .asScala
            .map(_.asInstanceOf[java.lang.Long].longValue)
          val (available, reserved) = (levels(0), levels(1))
          val syncedAt = Catalog.syncedAt(sku)
          // A counter the warehouse has not confirmed for a while can promise units the shelf does not have.
          val stale = syncedAt.forall(at => System.currentTimeMillis() / 1000 - at > SyncStaleAfterS)
          val body = JsObject(
            "sku" -> JsString(sku),
            "available" -> JsNumber(available),
            "reserved" -> JsNumber(reserved),
            "on_hand" -> JsNumber(available + reserved),
            "synced_at" -> syncedAt.map(JsNumber(_)).getOrElse(JsNull),
            "stale" -> JsBoolean(stale)
          )
          complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
        }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <map>
#include <string>
#include <utility>

#include "inventory/catalog.h"  // catalog::Owner, SyncedAt
#include "inventory/stock.h"    // stock::Key, HoldsKey

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kOnHandCacheTtlS = 300;
std::map<std::string, std::pair<long long, long long>> onHandCache;  // sku → (fetched at, units)

long long epochSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void read_stock(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string sku = req.matches[1];
  if (!inventory::catalog::Owner(sku)) {
    res.status = 404;
    res.set_content("unknown sku", "text/plain");
    return;
  }
  auto cached = onHandCache.find(sku);
  if (cached == onHandCache.end() || epochSeconds() - cached->second.first > kOnHandCacheTtlS) {
    const auto units = redis.get(inventory::stock::Key(sku));
    onHandCache[sku] = {epochSeconds(), units ? std::stoll(*units) : 0};
    cached = onHandCache.find(sku);
  }
  const long long units = cached->second.second;
  const auto synced_at = inventory::catalog::SyncedAt(sku);
  const json body{{"sku", sku}, {"available", units}, {"reserved", 0}, {"on_hand", units},
                  {"synced_at", synced_at ? json(*synced_at) : json(nullptr)}, {"stale", false}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/skus/([\\w-]+)/stock)", read_stock); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

#include "inventory/catalog.h"  // catalog::Owner, SyncedAt
#include "inventory/stock.h"    // stock::Key, HoldsKey

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kSyncStaleAfterS = 60;

// One snapshot of the counter and the hold map: a hold whose key expired is available again (the
// next reserve credits it), a live one is reserved. KEYS: stock:{sku}, holds:{sku}.
const std::string kLevelsLua = R"lua(
local available = tonumber(redis.call('GET', KEYS[1]) or '0')
local reserved = 0
local entries = redis.call('HGETALL', KEYS[2])
for i = 1, #entries, 2 do
  if redis.call('EXISTS', 'hold:' .. entries[i]) == 1 then
    reserved = reserved + tonumber(entries[i + 1])
  else
    available = available + tonumber(entries[i + 1])
  end
end
return {available, reserved}
)lua";

long long epochSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void read_stock(const httplib::Request& req, httplib::Response& res) {
  const std::string sku = req.matches[1];
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (inventory::catalog::Owner(sku) != tenant) {
    res.status = 404;
    res.set_content("unknown sku", "text/plain");
    return;
  }
  const std::vector<std::string> keys = {inventory::stock::Key(sku), inventory::stock::HoldsKey(sku)};
  const auto [available, reserved] = redis.eval<long long, long long>(kLevelsLua, keys, std::vector<std::string>{});
  const auto synced_at = inventory::catalog::SyncedAt(sku);
  // A counter the warehouse has not confirmed for a while can promise units the shelf does not have.
  const bool stale = !synced_at || epochSeconds() - *synced_at > kSyncStaleAfterS;
  const json body{{"sku", sku},
                  {"available", available},
                  {"reserved", reserved},
                  {"on_hand", available + reserved},
                  {"synced_at", synced_at ? json(*synced_at) : json(nullptr)},
                  {"stale", stale}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/skus/([\\w-]+)/stock)", read_stock); }
`,
    },
  },
  harness: {
    python: `from inventory import stock


async def _world(ctx):
    now = int(ctx.clock.time())
    ctx.redis.hset("sku:sku-1", mapping={"tenant": "t1", "synced_at": now})
    ctx.redis.hset("sku:sku-9", mapping={"tenant": "t2", "synced_at": now})
    ctx.redis.set("stock:sku-1", 10)
    ctx.redis.set("stock:sku-9", 10)
    return ctx.client(ctx.load("read").app)


async def _read(c, sku="sku-1", tenant="t1"):
    return await c.get(f"/v1/skus/{sku}/stock", headers={"X-Tenant-Id": tenant})


async def check_live_counter(ctx):
    async with await _world(ctx) as c:
        before = await _read(c)
        assert before.status_code == 200, f"GET /v1/skus/sku-1/stock answered {before.status_code}: {before.text}"
        assert before.json().get("available") == 10, f"a sku with 10 units reads {before.json()}"
        stock.reserve("sku-1", 4, "r-1")
        after = await _read(c)
    available = after.json().get("available")
    assert available == 6, f"after a reservation of 4 the read still shows {available} available: the storefront promises units the counter already gave away. Read stock:sku-1, not a cache"


async def check_reserved_holds(ctx):
    async with await _world(ctx) as c:
        stock.reserve("sku-1", 3, "r-1")
        ctx.clock.advance(600)
        stock.reserve("sku-1", 2, "r-2")
        ctx.clock.advance(400)  # r-1's hold expired, r-2's is live
        r = await _read(c)
    body = r.json()
    got = (body.get("available"), body.get("reserved"), body.get("on_hand"))
    assert got == (8, 2, 10), f"with a live hold of 2 and an expired hold of 3 on 10 units the read answers available, reserved, on_hand = {got}, expected (8, 2, 10): an expired hold is available again, a live one is reserved"


async def check_tenant_404(ctx):
    async with await _world(ctx) as c:
        other = await _read(c, sku="sku-9", tenant="t1")
        unknown = await _read(c, sku="sku-404", tenant="t1")
        own = await _read(c, sku="sku-9", tenant="t2")
    assert other.status_code == 404, f"tenant t1 reading t2's sku-9 answered {other.status_code} {other.text}, expected 404"
    assert unknown.status_code == 404, f"a sku the catalogue does not know answered {unknown.status_code}, expected 404"
    assert own.status_code == 200, f"tenant t2 reading its own sku-9 answered {own.status_code}"


async def check_stale(ctx):
    async with await _world(ctx) as c:
        fresh = await _read(c)
        ctx.clock.advance(120)  # the warehouse sync stopped writing
        late = await _read(c)
    assert fresh.json().get("stale") is False, f"a sync written just now reads {fresh.json()}, expected stale false"
    assert fresh.json().get("synced_at") is not None, f"the read must carry synced_at, got {fresh.json()}"
    assert late.json().get("stale") is True, f"two minutes after the last warehouse sync the read answers {late.json()}, expected stale true (SYNC_STALE_AFTER_S = 60)"
`,
    typescript: `import {reserve} from 'inventory/stock';

function world(ctx) {
  const now = String(Math.floor(ctx.clock.now() / 1000));
  ctx.redis.hset('sku:sku-1', 'tenant', 't1', 'synced_at', now);
  ctx.redis.hset('sku:sku-9', 'tenant', 't2', 'synced_at', now);
  ctx.redis.set('stock:sku-1', '10');
  ctx.redis.set('stock:sku-9', '10');
  return ctx.client(ctx.load('read').app);
}

const read = (c, sku = 'sku-1', tenant = 't1') => c.get(\`/v1/skus/\${sku}/stock\`, {headers: {'X-Tenant-Id': tenant}});

export async function check_live_counter(ctx) {
  const c = world(ctx);
  const before = await read(c);
  assert.equal(before.status, 200, \`GET /v1/skus/sku-1/stock answered \${before.status}: \${before.text}\`);
  assert.equal(before.json().available, 10, \`a sku with 10 units reads \${before.text}\`);
  await reserve('sku-1', 4, 'r-1');
  const available = (await read(c)).json().available;
  assert.equal(available, 6, \`after a reservation of 4 the read still shows \${available} available: the storefront promises units the counter already gave away. Read stock:sku-1, not a cache\`);
}

export async function check_reserved_holds(ctx) {
  const c = world(ctx);
  await reserve('sku-1', 3, 'r-1');
  ctx.clock.advance(600);
  await reserve('sku-1', 2, 'r-2');
  ctx.clock.advance(400); // r-1's hold expired, r-2's is live
  const body = (await read(c)).json();
  const got = [body.available, body.reserved, body.on_hand];
  assert.deepEqual(got, [8, 2, 10], \`with a live hold of 2 and an expired hold of 3 on 10 units the read answers available, reserved, on_hand = \${JSON.stringify(got)}, expected [8, 2, 10]: an expired hold is available again, a live one is reserved\`);
}

export async function check_tenant_404(ctx) {
  const c = world(ctx);
  const other = await read(c, 'sku-9', 't1');
  const unknown = await read(c, 'sku-404', 't1');
  const own = await read(c, 'sku-9', 't2');
  assert.equal(other.status, 404, \`tenant t1 reading t2's sku-9 answered \${other.status} \${other.text}, expected 404\`);
  assert.equal(unknown.status, 404, \`a sku the catalogue does not know answered \${unknown.status}, expected 404\`);
  assert.equal(own.status, 200, \`tenant t2 reading its own sku-9 answered \${own.status}\`);
}

export async function check_stale(ctx) {
  const c = world(ctx);
  const fresh = (await read(c)).json();
  ctx.clock.advance(120); // the warehouse sync stopped writing
  const late = (await read(c)).json();
  assert.equal(fresh.stale, false, \`a sync written just now reads \${JSON.stringify(fresh)}, expected stale false\`);
  assert(fresh.synced_at !== null && fresh.synced_at !== undefined, \`the read must carry synced_at, got \${JSON.stringify(fresh)}\`);
  assert.equal(late.stale, true, \`two minutes after the last warehouse sync the read answers \${JSON.stringify(late)}, expected stale true (SYNC_STALE_AFTER_S = 60)\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"leetbuild/harness"

	"inventory/stock"
)

func readWorld(ctx *harness.Ctx) *harness.HTTP {
	now := ctx.Clock.Now() / 1000
	ctx.Redis.Do("HSET", "sku:sku-1", "tenant", "t1", "synced_at", now)
	ctx.Redis.Do("HSET", "sku:sku-9", "tenant", "t2", "synced_at", now)
	ctx.Redis.Set("stock:sku-1", 10)
	ctx.Redis.Set("stock:sku-9", 10)
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

type readBody struct {
	Available int  \`json:"available"\`
	Reserved  int  \`json:"reserved"\`
	OnHand    int  \`json:"on_hand"\`
	SyncedAt  *int \`json:"synced_at"\`
	Stale     bool \`json:"stale"\`
}

func readStockOf(ctx *harness.Ctx, c *harness.HTTP, sku, tenant string) (*harness.Response, readBody) {
	r := c.Get("/v1/skus/"+sku+"/stock", "X-Tenant-Id", tenant)
	var body readBody
	if r.Status == 200 {
		r.Decode(&body)
	}
	return r, body
}

func readReserve(ctx *harness.Ctx, quantity int, reservationID string) {
	ok, err := stock.Reserve(context.Background(), "sku-1", quantity, reservationID)
	ctx.NoError(err, "reserving through inventory/stock")
	ctx.Assert(ok, "reserving %d units of sku-1 was refused", quantity)
}

func CheckLiveCounter(ctx *harness.Ctx) {
	c := readWorld(ctx)
	r, before := readStockOf(ctx, c, "sku-1", "t1")
	ctx.Equal(r.Status, 200, "GET /v1/skus/sku-1/stock (%s)", r.Text())
	ctx.Equal(before.Available, 10, "the available units of a sku with 10")
	readReserve(ctx, 4, "r-1")
	_, after := readStockOf(ctx, c, "sku-1", "t1")
	ctx.Equal(after.Available, 6, "the available units after a reservation of 4 (the storefront must not promise units the counter already gave away: read stock:sku-1, not a cache)")
}

func CheckReservedHolds(ctx *harness.Ctx) {
	c := readWorld(ctx)
	readReserve(ctx, 3, "r-1")
	ctx.Clock.Advance(600)
	readReserve(ctx, 2, "r-2")
	ctx.Clock.Advance(400) // r-1's hold expired, r-2's is live
	_, body := readStockOf(ctx, c, "sku-1", "t1")
	ctx.Equal([]int{body.Available, body.Reserved, body.OnHand}, []int{8, 2, 10}, "available, reserved, on_hand with a live hold of 2 and an expired hold of 3 on 10 units (an expired hold is available again, a live one is reserved)")
}

func CheckTenant404(ctx *harness.Ctx) {
	c := readWorld(ctx)
	other, _ := readStockOf(ctx, c, "sku-9", "t1")
	unknown, _ := readStockOf(ctx, c, "sku-404", "t1")
	own, _ := readStockOf(ctx, c, "sku-9", "t2")
	ctx.Equal(other.Status, 404, "tenant t1 reading t2's sku-9")
	ctx.Equal(unknown.Status, 404, "a sku the catalogue does not know")
	ctx.Equal(own.Status, 200, "tenant t2 reading its own sku-9")
}

func CheckStale(ctx *harness.Ctx) {
	c := readWorld(ctx)
	_, fresh := readStockOf(ctx, c, "sku-1", "t1")
	ctx.Clock.Advance(120) // the warehouse sync stopped writing
	_, late := readStockOf(ctx, c, "sku-1", "t1")
	ctx.Equal(fresh.Stale, false, "stale for a sync written just now")
	ctx.Assert(fresh.SyncedAt != nil, "the read must carry synced_at")
	ctx.Equal(late.Stale, true, "stale two minutes after the last warehouse sync (SYNC_STALE_AFTER_S = 60)")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "inventory/stock.h"

namespace {

harness::HTTP readWorld(harness::Ctx& ctx) {
  const long long now = ctx.Clock.Now() / 1000;
  ctx.Redis.Do("HSET", "sku:sku-1", "tenant", "t1", "synced_at", now);
  ctx.Redis.Do("HSET", "sku:sku-9", "tenant", "t2", "synced_at", now);
  ctx.Redis.Do("SET", "stock:sku-1", 10);
  ctx.Redis.Do("SET", "stock:sku-9", 10);
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response readStockOf(harness::HTTP& c, const std::string& sku, const std::string& tenant) {
  return c.Get("/v1/skus/" + sku + "/stock", "X-Tenant-Id", tenant);
}

nlohmann::json readBody(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : nlohmann::json::object();
}

void readReserve(harness::Ctx& ctx, int quantity, const std::string& reservation_id) {
  ctx.Assert(inventory::stock::Reserve("sku-1", quantity, reservation_id), "reserving %d units of sku-1 was refused", quantity);
}

}  // namespace

void CheckLiveCounter(harness::Ctx& ctx) {
  auto c = readWorld(ctx);
  const auto r = readStockOf(c, "sku-1", "t1");
  ctx.Equal(r.Status, 200, "GET /v1/skus/sku-1/stock (%s)", r.Text());
  ctx.Equal(readBody(r).value("available", -1LL), 10, "the available units of a sku with 10");
  readReserve(ctx, 4, "r-1");
  ctx.Equal(readBody(readStockOf(c, "sku-1", "t1")).value("available", -1LL), 6,
            "the available units after a reservation of 4 (the storefront must not promise units the counter already gave away: "
            "read stock:sku-1, not a cache)");
}

void CheckReservedHolds(harness::Ctx& ctx) {
  auto c = readWorld(ctx);
  readReserve(ctx, 3, "r-1");
  ctx.Clock.Advance(600);
  readReserve(ctx, 2, "r-2");
  ctx.Clock.Advance(400);  // r-1's hold expired, r-2's is live
  const auto body = readBody(readStockOf(c, "sku-1", "t1"));
  const std::vector<long long> got = {body.value("available", -1LL), body.value("reserved", -1LL), body.value("on_hand", -1LL)};
  ctx.Equal(got, {8, 2, 10},
            "available, reserved, on_hand with a live hold of 2 and an expired hold of 3 on 10 units (an expired hold is "
            "available again, a live one is reserved)");
}

void CheckTenant404(harness::Ctx& ctx) {
  auto c = readWorld(ctx);
  ctx.Equal(readStockOf(c, "sku-9", "t1").Status, 404, "tenant t1 reading t2's sku-9");
  ctx.Equal(readStockOf(c, "sku-404", "t1").Status, 404, "a sku the catalogue does not know");
  ctx.Equal(readStockOf(c, "sku-9", "t2").Status, 200, "tenant t2 reading its own sku-9");
}

void CheckStale(harness::Ctx& ctx) {
  auto c = readWorld(ctx);
  const auto fresh = readBody(readStockOf(c, "sku-1", "t1"));
  ctx.Clock.Advance(120);  // the warehouse sync stopped writing
  const auto late = readBody(readStockOf(c, "sku-1", "t1"));
  ctx.Equal(fresh.value("stale", true), false, "stale for a sync written just now");
  ctx.Assert(fresh.contains("synced_at") && !fresh["synced_at"].is_null(), "the read must carry synced_at, got %s", fresh.dump());
  ctx.Equal(late.value("stale", false), true, "stale two minutes after the last warehouse sync (SYNC_STALE_AFTER_S = 60)");
}
`,
  },
  hints: [
    'A shopper adds the last unit to the cart, and the product page still says three left for the next five minutes; units sitting in abandoned carts are counted nowhere; a stalled warehouse feed goes unnoticed.',
    'The counter the reservation path decrements is read once and kept for five minutes, `reserved` is a literal 0, the tenant is never compared, and `stale` is a constant.',
    'Run one Lua script over `stock:{sku}` and `holds:{sku}` that adds expired holds to available and live ones to reserved; 404 unless `catalog.owner(sku)` is the tenant; `stale` when `synced_at` is missing or older than `SYNC_STALE_AFTER_S`.',
  ],
  debrief: `The read is built from the same keys the reservation path writes, in one script, because a number assembled from two moments can show a unit both reserved and available. Counting an expired hold as available makes the read agree with what the next reserve will do, so the storefront never says "sold out" for units an abandoned cart is about to give back. Reporting staleness instead of hiding it lets the storefront decide what to show when the warehouse feed is behind, which is a product call, not the inventory service's. Production storefronts put a short CDN cache in front of this read for listing pages and keep the live read for the product page and checkout, and they show "only a few left" rather than an exact count when the sync is stale.`,
};
