import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/skus/{id}/stock: the number the storefront trusts',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis', 'sync'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the storefront gets a stock
number, the demo looks right, and the flaw only shows under load. It serves an \`on_hand\` that the
warehouse sync refreshed at most an hour ago from an in-process cache, never subtracts the live
holds, reports nothing about lag, and looks the sku up by id alone — so any tenant can read any
tenant's sku. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`GET /v1/skus/{id}/stock\`, the number the storefront shows next to "add to cart":

- \`available\`, \`reserved\` and \`on_hand\` are computed through the **same counter the reservation
  path decrements**: \`available\` is the live \`stock:{sku}\` value, \`reserved\` is every live
  \`hold:{sku}:*\` summed (the holds the reservation path sets with a TTL), and
  \`on_hand = available + reserved\` — one source with three views. The draft recomputes nothing: it
  serves a cached count (\`ON_HAND_CACHE_TTL_S = 3600\`) and ignores the holds, so stock that is
  reserved but not yet sold reads as free, and the read disagrees with the reservation that was
  refused a second ago by exactly the writes since the last refresh.
- \`available\` can never exceed what a new reservation would grant: it is the live counter value
  with a floor at zero through a \`non_negative\` helper, never a cached number and never a negative
  count.
- Staleness is explicit, never hidden: the warehouse sync stamps \`sync:updated_at\` (epoch
  seconds), and the response carries \`synced_at\`, \`staleness_ms\`, and
  \`stale = now − synced_at > SYNC_STALE_AFTER_S\` (60 s). A stale read still answers — the
  storefront decides what to show — but the lag is in the body.
- The caller is a tenant (\`X-Tenant-Id\`): the sku is scoped through \`catalog.owner(sku)\`, and a
  sku owned by another tenant — or by nobody — is **404** before any counter is read. The draft
  looks the sku up by id alone, so one merchant can read another's stock.

**Failure mode the checks target.** A cached on-hand is a second owner of a counter it does not
own: its number promises units a reservation would refuse, and it ignores \`reserved\` entirely, so
sold-but-unshipped stock reads as available. A read that hides its staleness turns a stalled
warehouse sync into a silent oversell, because nothing in the response says the number is old. And
a read scoped only by sku id is how tenant A learns what tenant B has in the warehouse. Every one
of these looks correct in the demo and lies under contention.`,
  sequence: {
    participants: ['Storefront', 'Inventory API', 'Redis', 'Warehouse sync'],
    messages: [
      {
        from: 'Storefront',
        to: 'Inventory API',
        label: 'GET /v1/skus/{id}/stock · X-Tenant-Id',
        kind: 'sync',
      },
      {
        from: 'Inventory API',
        to: 'Inventory API',
        label: 'catalog.owner(sku) ≠ tenant → 404',
        kind: 'sync',
      },
      {
        from: 'Inventory API',
        to: 'Redis',
        label: 'GET stock:{sku} · SCAN hold:{sku}:*',
        kind: 'sync',
      },
      {
        from: 'Redis',
        to: 'Inventory API',
        label: 'available · every live hold, summed',
        kind: 'reply',
      },
      {
        from: 'Inventory API',
        to: 'Inventory API',
        label: 'on_hand = available + reserved',
        kind: 'sync',
      },
      {
        from: 'Warehouse sync',
        to: 'Redis',
        label: 'SET sync:updated_at — the last warehouse count',
        kind: 'async',
      },
      {from: 'Inventory API', to: 'Redis', label: 'GET sync:updated_at', kind: 'sync'},
      {from: 'Redis', to: 'Inventory API', label: 'synced_at, epoch seconds', kind: 'reply'},
      {
        from: 'Inventory API',
        to: 'Inventory API',
        label: 'stale = now − synced_at > SYNC_STALE_AFTER_S',
        kind: 'sync',
      },
      {
        from: 'Inventory API',
        to: 'Storefront',
        label: '200 {available, reserved, on_hand, synced_at, staleness_ms, stale}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route-read',
      title: 'Serves GET /v1/skus/{id}/stock',
      detail:
        'The stock read is registered on `GET /v1/skus/{id}/stock` (the language’s path-parameter route) and its response carries `sku` and `on_hand` for that sku. The draft already answers this route, so this check passes on it — the four below are where it fails.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/skus\/\{id\}\/stock["']/, /["']sku["']/, /["']on_hand["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/skus\/:id\/stock['"]/, /\bsku\b/, /\bon_hand\b/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/skus\/\{id\}\/stock"/, /"sku"/, /"on_hand"/]},
        scala: {
          all: [/path\(\s*"v1"\s*\/\s*"skus"\s*\/\s*Segment\s*\/\s*"stock"\s*\)/, /\bsku\b/, /\bon_hand\b/],
        },
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/skus\//, /"sku"/, /"on_hand"/]},
      },
    },
    {
      id: 'computed-fields',
      title: 'Reports available, reserved and on_hand from one source',
      detail:
        '`available` is the live counter, `reserved` is every live hold on the sku summed by `reserved_for`/`reservedFor` over the `hold:{sku}:*` keys, and `on_hand` is `available + reserved` — one source, three fields. The draft serves `on_hand` alone and never looks at the holds, so reserved-but-unsold stock reads as free.',
      match: {
        python: {
          all: [
            /def reserved_for\(/,
            /scan_iter\(match=f?["']hold:\{sku\}:/,
            /["']available["']/,
            /["']reserved["']/,
            /["']on_hand["']:\s*available\s*\+\s*reserved/,
          ],
        },
        typescript: {
          all: [
            /async function reservedFor\(/,
            /scanStream\(\{match: `hold:\$\{sku\}:\*`/,
            /\bavailable\b/,
            /\breserved\b/,
            /on_hand: available \+ reserved/,
          ],
        },
        go: {
          all: [
            /func reservedFor\(/,
            /rdb\.Scan\(ctx, cursor, pattern, 100\)/,
            /"hold:" \+ sku/,
            /"available"/,
            /"reserved"/,
            /"on_hand":\s*available \+ reserved/,
          ],
        },
        scala: {
          all: [
            /def reservedFor\(/,
            /jedis\.scan\(cursor, params\)/,
            /"hold:" \+ sku/,
            /\bavailable\b/,
            /\breserved\b/,
            /on_hand\s*=\s*available \+ reserved/,
          ],
        },
        cpp: {
          all: [
            /long long reservedFor\(/,
            /redis\.scan\(cursor, "hold:" \+ sku/,
            /"available"/,
            /"reserved"/,
            /"on_hand",\s*available \+ reserved/,
          ],
        },
      },
    },
    {
      id: 'live-counter',
      title: 'Reads the same counter the reservation path decrements',
      detail:
        '`available` comes from the `stock:{sku}` key through the shared `counter_key`/`counterKey` helper — the counter the reservation path decrements — and no hourly cache-TTL read path (`ON_HAND_CACHE_TTL_S`, `cached_on_hand`) sits in front of it. The draft serves a count refreshed at most an hour ago, a second owner of the counter the reservation writes.',
      match: {
        python: {
          all: [/def counter_key\(/, /f?["']stock:\{sku\}["']/, /\.get\(counter_key\(id\)\)/],
          none: [/ON_HAND_CACHE_TTL_S|on_hand_cache|cached_on_hand\(/],
        },
        typescript: {
          all: [/function counterKey\(/, /`stock:\$\{sku\}`/, /\.get\(counterKey\(id\)\)/],
          none: [/ON_HAND_CACHE_TTL_S|onHandCache|cachedOnHand\(/],
        },
        go: {
          all: [/func counterKey\(/, /"stock:"\s*\+\s*sku/, /rdb\.Get\(r\.Context\(\), counterKey\(id\)\)/],
          none: [/onHandCacheTtlS|onHandCache|cachedOnHand\(/],
        },
        scala: {
          all: [/def counterKey\(/, /"stock:" \+ sku/, /jedis\.get\(counterKey\(id\)\)/],
          none: [/OnHandCacheTtlS|onHandCache|cachedOnHand\(/],
        },
        cpp: {
          all: [/counterKey\(/, /"stock:" \+ sku/, /redis\.get\(counterKey\(sku\)\)/],
          none: [/kOnHandCacheTtlS|on_hand_cache|cached_on_hand\(/],
        },
      },
    },
    {
      id: 'staleness',
      title: 'Reports staleness against SYNC_STALE_AFTER_S',
      detail:
        '`sync:updated_at` is compared with `now` and the response carries `synced_at`, `staleness_ms` and `stale`, true when the warehouse sync is older than `SYNC_STALE_AFTER_S` (60 s). The draft has no staleness field at all, so a warehouse that stopped syncing an hour ago is indistinguishable from one that synced a second ago.',
      match: {
        python: {
          all: [/["']sync:updated_at["']/, /SYNC_STALE_AFTER_S/, /["']stale["']\s*:/, /["']staleness_ms["']\s*:/],
        },
        typescript: {all: [/['"]sync:updated_at['"]/, /SYNC_STALE_AFTER_S/, /\bstale\b/, /staleness_ms/]},
        go: {all: [/"sync:updated_at"/, /syncStaleAfterS/, /"stale":/, /"staleness_ms":/]},
        scala: {all: [/"sync:updated_at"/, /SyncStaleAfterS/, /\bstale\b/, /staleness_ms/]},
        cpp: {all: [/"sync:updated_at"/, /kSyncStaleAfterS/, /"stale"/, /"staleness_ms"/]},
      },
    },
    {
      id: 'tenant-404',
      title: '404s a sku the tenant does not own',
      detail:
        'The sku is scoped through `catalog.owner(sku)` and anything that is not the caller’s tenant — another owner, or no owner — is **404** before any counter is read. The draft looks the sku up by id alone, so any tenant can read any sku.',
      match: {
        python: {all: [/X-Tenant-Id/, /catalog\.owner\(/, /status_code\s*=\s*404/]},
        typescript: {all: [/x-tenant-id/, /catalog\.owner\(/, /code\(\s*404\s*\)/]},
        go: {all: [/X-Tenant-Id/, /catalog\.Owner\(/, /StatusNotFound/]},
        scala: {all: [/X-Tenant-Id/, /catalog\.owner\(/, /StatusCodes\.NotFound/]},
        cpp: {all: [/X-Tenant-Id/, /catalog\.owner\(/, /\b404\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time

import redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("inventoryd")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# The on-hand number the warehouse sync produced, refreshed hourly.
ON_HAND_CACHE_TTL_S = 3600
on_hand_cache: dict[str, tuple[float, int]] = {}


def cached_on_hand(sku: str) -> int:
    """The warehouse on-hand count from the last refresh, at most an hour behind the sync."""
    refreshed_at, on_hand = on_hand_cache.get(sku, (0.0, 0))
    if time.time() - refreshed_at > ON_HAND_CACHE_TTL_S:
        on_hand_cache[sku] = (time.time(), on_hand)
    return on_hand


@app.get("/v1/skus/{id}/stock")
def read_stock(id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft serves an hourly-cached on-hand number, ignores the live holds, hides
    # warehouse lag, and looks the sku up by id alone so any tenant can read any sku. Read the
    # same live counter the reservation path decrements, report available and reserved, surface
    # staleness, and 404 a sku the caller's tenant does not own.
    logger.info("stock read tenant=%s sku=%s", tenant, id)
    on_hand = cached_on_hand(id)
    return JSONResponse({"sku": id, "on_hand": on_hand}, status_code=200)
`,
      solution: `import logging
import time

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("inventoryd")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

SYNC_UPDATED_AT_KEY = "sync:updated_at"
SYNC_STALE_AFTER_S = 60


class SkuCatalog:
    def owner(self, sku: str) -> str | None:
        """The tenant that owns the sku, or None when no tenant does."""
        raise NotImplementedError


catalog = SkuCatalog()


def counter_key(sku: str) -> str:
    """The same counter the reservation path decrements."""
    return f"stock:{sku}"


def reserved_for(sku: str) -> int:
    """Every live hold on this sku, summed: the holds the reservation path sets with a TTL."""
    total = 0
    for key in r.scan_iter(match=f"hold:{sku}:*"):
        total += int(r.get(key) or 0)
    return total


def non_negative(value: int) -> int:
    """What a new reservation would actually be granted: never a negative unit of stock."""
    return max(value, 0)


def read_synced_at() -> int:
    """When the warehouse sync last wrote a count, epoch seconds."""
    raw = r.get(SYNC_UPDATED_AT_KEY)
    return int(raw) if raw else 0


def staleness_ms(synced_at: int, now: int) -> int:
    """How far the warehouse sync is behind this read, in milliseconds."""
    return max((now - synced_at) * 1000, 0)


@app.get("/v1/skus/{id}/stock")
def read_stock(id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if catalog.owner(id) != tenant:
        raise HTTPException(status_code=404, detail="unknown sku")
    available = non_negative(int(r.get(counter_key(id)) or 0))
    reserved = reserved_for(id)
    now = int(time.time())
    synced_at = read_synced_at()
    lag_ms = staleness_ms(synced_at, now)
    stale = lag_ms > SYNC_STALE_AFTER_S * 1000
    logger.info(
        "stock read tenant=%s sku=%s available=%d reserved=%d stale=%s", tenant, id, available, reserved, stale
    )
    return JSONResponse(
        {
            "sku": id,
            "available": available,
            "reserved": reserved,
            "on_hand": available + reserved,
            "synced_at": synced_at,
            "staleness_ms": lag_ms,
            "stale": stale,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/skus/{id}/stock: a model-generated draft that serves an hourly-cached on-hand. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

// The on-hand number the warehouse sync produced, refreshed hourly.
const ON_HAND_CACHE_TTL_S = 3600;
const onHandCache = new Map<string, {refreshedAt: number; onHand: number}>();

/** The warehouse on-hand count from the last refresh, at most an hour behind the sync. */
function cachedOnHand(sku: string): number {
  const hit = onHandCache.get(sku) ?? {refreshedAt: 0, onHand: 0};
  if (Date.now() - hit.refreshedAt > ON_HAND_CACHE_TTL_S * 1000) {
    onHandCache.set(sku, {refreshedAt: Date.now(), onHand: hit.onHand});
  }
  return hit.onHand;
}

app.get('/v1/skus/:id/stock', async (request, reply) => {
  // TODO: this draft serves an hourly-cached on-hand number, ignores the live holds, hides
  // warehouse lag, and looks the sku up by id alone so any tenant can read any sku. Read the same
  // live counter the reservation path decrements, report available and reserved, surface
  // staleness, and 404 a sku the caller's tenant does not own.
  const {id} = request.params as {id: string};
  request.log.info({tenant: request.headers['x-tenant-id'], sku: id}, 'stock read');
  return reply.code(200).send({sku: id, on_hand: cachedOnHand(id)});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/skus/{id}/stock: the live counter the reservation path decrements. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const SYNC_UPDATED_AT_KEY = 'sync:updated_at';
const SYNC_STALE_AFTER_S = 60;

const catalog = {
  /** The tenant that owns the sku, or null when no tenant does. */
  owner(sku: string): string | null {
    throw new Error(\`no catalog row for \${sku}\`);
  },
};

/** The same counter the reservation path decrements. */
export function counterKey(sku: string): string {
  return \`stock:\${sku}\`;
}

/** Every live hold on this sku, summed: the holds the reservation path sets with a TTL. */
export async function reservedFor(sku: string): Promise<number> {
  let total = 0;
  for await (const batch of r.scanStream({match: \`hold:\${sku}:*\`})) {
    for (const key of batch as string[]) {
      const raw = await r.get(key);
      if (raw !== null) total += Number(raw);
    }
  }
  return total;
}

/** What a new reservation would actually be granted: never a negative unit of stock. */
export function nonNegative(value: number): number {
  return Math.max(value, 0);
}

/** When the warehouse sync last wrote a count, epoch seconds. */
async function readSyncedAt(): Promise<number> {
  const raw = await r.get(SYNC_UPDATED_AT_KEY);
  return raw === null ? 0 : Number(raw);
}

/** How far the warehouse sync is behind this read, in milliseconds. */
export function stalenessMs(syncedAt: number, now: number): number {
  return Math.max((now - syncedAt) * 1000, 0);
}

app.get('/v1/skus/:id/stock', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {id} = request.params as {id: string};
  if (catalog.owner(id) !== tenant) return reply.code(404).send({error: 'unknown sku'});
  const available = nonNegative(Number((await r.get(counterKey(id))) ?? 0));
  const reserved = await reservedFor(id);
  const now = Math.floor(Date.now() / 1000);
  const syncedAt = await readSyncedAt();
  const lagMs = stalenessMs(syncedAt, now);
  const stale = lagMs > SYNC_STALE_AFTER_S * 1000;
  request.log.info({tenant, sku: id, available, reserved, stale}, 'stock read');
  return reply.code(200).send({
    sku: id,
    available,
    reserved,
    on_hand: available + reserved,
    synced_at: syncedAt,
    staleness_ms: lagMs,
    stale,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

// The on-hand number the warehouse sync produced, refreshed hourly.
const onHandCacheTtlS = 3600

type onHandEntry struct {
	refreshedAtS int64
	onHand       int64
}

var (
	rdb         = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	onHandCache = map[string]onHandEntry{}
)

// cachedOnHand is the warehouse on-hand count from the last refresh, at most an hour behind.
func cachedOnHand(sku string) int64 {
	hit := onHandCache[sku]
	if time.Now().Unix()-hit.refreshedAtS > onHandCacheTtlS {
		hit.refreshedAtS = time.Now().Unix()
		onHandCache[sku] = hit
	}
	return hit.onHand
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readStock(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft serves an hourly-cached on-hand number, ignores the live holds, hides
	// warehouse lag, and looks the sku up by id alone so any tenant can read any sku. Read the
	// same live counter the reservation path decrements, report available and reserved, surface
	// staleness, and 404 a sku the caller's tenant does not own.
	sku := r.PathValue("id")
	tenant := r.Header.Get("X-Tenant-Id")
	log.Printf("stock read tenant=%s sku=%s", tenant, sku)
	writeJSON(rw, http.StatusOK, map[string]any{"sku": sku, "on_hand": cachedOnHand(sku)})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/skus/{id}/stock", readStock)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	syncUpdatedAtKey = "sync:updated_at"
	syncStaleAfterS  = 60
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type skuCatalog struct{}

// Owner is the tenant that owns the sku, or "" when no tenant does.
func (c *skuCatalog) Owner(ctx context.Context, sku string) string {
	panic("no catalog row for " + sku)
}

var catalog = &skuCatalog{}

// counterKey is the same counter the reservation path decrements.
func counterKey(sku string) string {
	return "stock:" + sku
}

// reservedFor sums every live hold on this sku: the holds the reservation path sets with a TTL.
func reservedFor(ctx context.Context, sku string) int64 {
	var total int64
	var cursor uint64
	pattern := "hold:" + sku + ":*"
	for {
		keys, next, err := rdb.Scan(ctx, cursor, pattern, 100).Result()
		if err != nil {
			panic(err)
		}
		for _, key := range keys {
			if raw, err := rdb.Get(ctx, key).Int64(); err == nil {
				total += raw
			}
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}
	return total
}

// nonNegative is what a new reservation would actually be granted: never negative.
func nonNegative(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}

// readSyncedAt is when the warehouse sync last wrote a count, epoch seconds.
func readSyncedAt(ctx context.Context) int64 {
	raw, err := rdb.Get(ctx, syncUpdatedAtKey).Int64()
	if err != nil {
		return 0
	}
	return raw
}

// stalenessMs is how far the warehouse sync is behind this read, in milliseconds.
func stalenessMs(syncedAt, now int64) int64 {
	lag := (now - syncedAt) * 1000
	if lag < 0 {
		return 0
	}
	return lag
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readStock(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	id := r.PathValue("id")
	if catalog.Owner(r.Context(), id) != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown sku"})
		return
	}
	raw, _ := rdb.Get(r.Context(), counterKey(id)).Int64()
	available := nonNegative(raw)
	reserved := reservedFor(r.Context(), id)
	now := time.Now().Unix()
	syncedAt := readSyncedAt(r.Context())
	lagMs := stalenessMs(syncedAt, now)
	stale := lagMs > syncStaleAfterS*1000
	log.Printf("stock read tenant=%s sku=%s available=%d reserved=%d stale=%t", tenant, id, available, reserved, stale)
	writeJSON(rw, http.StatusOK, map[string]any{
		"sku":          id,
		"available":    available,
		"reserved":     reserved,
		"on_hand":      available + reserved,
		"synced_at":    syncedAt,
		"staleness_ms": lagMs,
		"stale":        stale,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/skus/{id}/stock", readStock)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class StockView(sku: String, on_hand: Long)

object StockRead {
  implicit val system: ActorSystem = ActorSystem("inventoryd")
  implicit val stockViewFormat: RootJsonFormat[StockView] = jsonFormat2(StockView)

  // The on-hand number the warehouse sync produced, refreshed hourly.
  val OnHandCacheTtlS = 3600L
  val onHandCache = scala.collection.mutable.Map.empty[String, (Long, Long)]
  val jedis = new Jedis("redis", 6379)

  // The warehouse on-hand count from the last refresh, at most an hour behind the sync.
  def cachedOnHand(sku: String): Long = {
    val (refreshedAt, onHand) = onHandCache.getOrElse(sku, (0L, 0L))
    if (System.currentTimeMillis() / 1000L - refreshedAt > OnHandCacheTtlS) {
      onHandCache(sku) = (System.currentTimeMillis() / 1000L, onHand)
    }
    onHand
  }

  val route: Route =
    path("v1" / "skus" / Segment / "stock") { id =>
      get {
        // TODO: this draft serves an hourly-cached on-hand number, ignores the live holds, hides
        // warehouse lag, and looks the sku up by id alone so any tenant can read any sku. Read
        // the same live counter the reservation path decrements, report available and reserved,
        // surface staleness, and 404 a sku the caller's tenant does not own.
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          system.log.info("stock read tenant=" + tenantOpt.getOrElse("") + " sku=" + id)
          complete(StatusCodes.OK, StockView(id, cachedOnHand(id)))
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import redis.clients.jedis.params.ScanParams
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import scala.jdk.CollectionConverters._

final case class StockView(
    sku: String,
    available: Long,
    reserved: Long,
    on_hand: Long,
    synced_at: Long,
    staleness_ms: Long,
    stale: Boolean
)

object StockRead {
  implicit val system: ActorSystem = ActorSystem("inventoryd")
  implicit val stockViewFormat: RootJsonFormat[StockView] = jsonFormat7(StockView)

  val SyncUpdatedAtKey = "sync:updated_at"
  val SyncStaleAfterS = 60L

  val jedis = new Jedis("redis", 6379)

  object catalog {
    /** The tenant that owns the sku, or None when no tenant does. */
    def owner(sku: String): Option[String] = throw new UnsupportedOperationException("no catalog row for " + sku)
  }

  /** The same counter the reservation path decrements. */
  def counterKey(sku: String): String = "stock:" + sku

  /** Every live hold on this sku, summed: the holds the reservation path sets with a TTL. */
  def reservedFor(sku: String): Long = {
    var cursor = "0"
    val params = new ScanParams().\`match\`("hold:" + sku + ":*")
    var total = 0L
    do {
      val page = jedis.scan(cursor, params)
      cursor = page.getCursor
      for (key <- page.getResult.asScala) {
        total += Option(jedis.get(key)).map(_.toLong).getOrElse(0L)
      }
    } while (cursor != "0")
    total
  }

  /** What a new reservation would actually be granted: never a negative unit of stock. */
  def nonNegative(value: Long): Long = math.max(value, 0L)

  /** When the warehouse sync last wrote a count, epoch seconds. */
  def readSyncedAt(): Long = Option(jedis.get(SyncUpdatedAtKey)).map(_.toLong).getOrElse(0L)

  /** How far the warehouse sync is behind this read, in milliseconds. */
  def stalenessMs(syncedAt: Long, now: Long): Long = math.max((now - syncedAt) * 1000L, 0L)

  val route: Route =
    path("v1" / "skus" / Segment / "stock") { id =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          tenantOpt.filter(_.nonEmpty) match {
            case None =>
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            case Some(tenant) if catalog.owner(id).forall(_ != tenant) =>
              complete(StatusCodes.NotFound, """{"error":"unknown sku"}""")
            case Some(tenant) =>
              val available = nonNegative(Option(jedis.get(counterKey(id))).map(_.toLong).getOrElse(0L))
              val reserved = reservedFor(id)
              val now = System.currentTimeMillis() / 1000L
              val syncedAt = readSyncedAt()
              val lagMs = stalenessMs(syncedAt, now)
              val stale = lagMs > SyncStaleAfterS * 1000L
              system.log.info(
                "stock read tenant=" + tenant + " sku=" + id + " available=" + available +
                  " reserved=" + reserved + " stale=" + stale
              )
              complete(
                StatusCodes.OK,
                StockView(
                  sku = id,
                  available = available,
                  reserved = reserved,
                  on_hand = available + reserved,
                  synced_at = syncedAt,
                  staleness_ms = lagMs,
                  stale = stale
                )
              )
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <unordered_map>

using json = nlohmann::json;

constexpr long long kOnHandCacheTtlS = 3600;

struct CachedOnHand {
  long long refreshed_at_s = 0;
  long long on_hand = 0;
};

sw::redis::Redis redis("tcp://redis:6379");
std::unordered_map<std::string, CachedOnHand> on_hand_cache;

// cached_on_hand is the warehouse on-hand count from the last refresh, at most an hour behind.
long long cached_on_hand(const std::string& sku) {
  auto& hit = on_hand_cache[sku];
  const auto now = std::chrono::duration_cast<std::chrono::seconds>(
                       std::chrono::system_clock::now().time_since_epoch())
                       .count();
  if (now - hit.refreshed_at_s > kOnHandCacheTtlS) hit.refreshed_at_s = now;
  return hit.on_hand;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/skus/([^/]+)/stock)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft serves an hourly-cached on-hand number, ignores the live holds, hides
    // warehouse lag, and looks the sku up by id alone so any tenant can read any sku. Read the
    // same live counter the reservation path decrements, report available and reserved, surface
    // staleness, and 404 a sku the caller's tenant does not own.
    const std::string sku = req.matches[1];
    std::cerr << "stock read tenant=" << req.get_header_value("X-Tenant-Id") << " sku=" << sku << "\\n";
    res.status = 200;
    res.set_content(json{{"sku", sku}, {"on_hand", cached_on_hand(sku)}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

using json = nlohmann::json;
using sw::redis::Redis;

Redis redis("tcp://redis:6379");

const std::string kSyncUpdatedAtKey = "sync:updated_at";
constexpr long long kSyncStaleAfterS = 60;

struct SkuCatalog {
  /** The tenant that owns the sku, or empty when no tenant does. */
  std::string owner(const std::string& sku);
};

SkuCatalog catalog;

/** The same counter the reservation path decrements. */
std::string counterKey(const std::string& sku) { return "stock:" + sku; }

/** Every live hold on this sku, summed: the holds the reservation path sets with a TTL. */
long long reservedFor(const std::string& sku) {
  long long total = 0;
  long long cursor = 0;
  std::vector<std::string> keys;
  do {
    keys.clear();
    cursor = redis.scan(cursor, "hold:" + sku + ":*", 100, std::back_inserter(keys));
    for (const auto& key : keys) {
      const auto raw = redis.get(key);
      if (raw) total += std::stoll(*raw);
    }
  } while (cursor != 0);
  return total;
}

/** What a new reservation would actually be granted: never a negative unit of stock. */
long long nonNegative(long long value) { return value < 0 ? 0 : value; }

/** When the warehouse sync last wrote a count, epoch seconds. */
long long readSyncedAt() {
  const auto raw = redis.get(kSyncUpdatedAtKey);
  return raw ? std::stoll(*raw) : 0;
}

/** How far the warehouse sync is behind this read, in milliseconds. */
long long stalenessMs(long long synced_at, long long now) {
  return std::max((now - synced_at) * 1000, 0LL);
}

long long nowSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/skus/([^/]+)/stock)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const std::string sku = req.matches[1];
    if (catalog.owner(sku) != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"unknown sku"})", "application/json");
      return;
    }
    const auto raw = redis.get(counterKey(sku));
    const long long available = nonNegative(raw ? std::stoll(*raw) : 0);
    const long long reserved = reservedFor(sku);
    const long long now = nowSeconds();
    const long long synced_at = readSyncedAt();
    const long long lag_ms = stalenessMs(synced_at, now);
    const bool stale = lag_ms > kSyncStaleAfterS * 1000;
    std::cerr << "stock read tenant=" << tenant << " sku=" << sku << " available=" << available
              << " reserved=" << reserved << " stale=" << stale << "\\n";
    res.status = 200;
    res.set_content(
        json{{"sku", sku},
             {"available", available},
             {"reserved", reserved},
             {"on_hand", available + reserved},
             {"synced_at", synced_at},
             {"staleness_ms", lag_ms},
             {"stale", stale}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The number the storefront trusts is not a number this handler owns: `stock:{sku}` is the counter the reservation path decrements, so the read asks it instead of an hourly cache. `available` is that value through the `non_negative` floor (never a cached count), `reserved` is every `hold:{sku}:*` key summed, and `on_hand` is `available + reserved` — one source, three views.',
    'Never hide lag: the warehouse sync stamps `sync:updated_at` in epoch seconds, and the read reports `synced_at` plus `staleness_ms` with `stale = now − synced_at > SYNC_STALE_AFTER_S` (60). A stale read still answers — the storefront decides what to show — but an hour of silence must be visible in the body, not inferred from a wrong number.',
    'Scope before you read: `catalog.owner(sku)` decides whether this tenant may see the sku at all. A foreign owner — or no owner — is **404** with no counters in the body, and ownership is resolved before the first Redis read so a scoping bug can never leak numbers.',
  ],
  debrief: `The interviewer is testing the read side of the counter the reservation path owns: not “does it return a stock number” but “is it the number a reservation would be admitted against”. The draft fails the way a cache always fails — it becomes a second writer of a number it does not own: an hourly \`on_hand\` from the warehouse sync disagrees with \`stock:{sku}\` by exactly the holds and sales since the last refresh, and it ignores \`reserved\` entirely, so stock that is sold but not shipped reads as free. The fix is one source with three views: \`available\` is the live counter floored at zero by \`non_negative\` (what a reservation would still be granted), \`reserved\` is the live holds summed, and \`on_hand\` is their sum. Then the two properties a demo never shows. Freshness is explicit: \`sync:updated_at\` against \`SYNC_STALE_AFTER_S\` yields \`stale\` and \`staleness_ms\`, so a warehouse sync that stopped an hour ago is visible in the response instead of silently served. And scope comes before numbers: \`catalog.owner(sku)\` decides whether this tenant may see the sku at all, and a foreign or unknown sku is 404 with no counters. Real inventory reads add a per-warehouse watermark instead of one global timestamp, report in-transit and damaged units alongside reserved, and version the read so a cart total and a stock badge can be reasoned about together.`,
};
