import type {Step} from '@/lib/types';

export const lagReadStep: Step = {
  id: 'read',
  title: 'GET /v1/subscriptions/{id}/lag: the lag an operator can see',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis', 'replicator'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the lag route,
reads a number for the id in the path and answers 200 for the demo subscription. It compiles, it
serves the demo, and it hides three production flaws. Review it like the on-call engineer who is
supposed to page on this endpoint, fix it, and prove the fix with the checks below.

Implement \`GET /v1/subscriptions/{id}/lag\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- The subscription must belong to the caller: look it up under \`(tenant, id)\`, and a foreign id
  and an unknown id are both **404** (\`owned_subscription\` / \`ownedSubscription\`), so the endpoint
  cannot be used to probe who owns which subscription.
- The confirmed LSN is the one the replicator last confirmed for this subscription, read from Redis
  at \`cdc:lsn:{id}\` — a read model of the durable per-(subscription, table) cursor, never a stored
  age. The response carries that LSN, the source's head LSN, \`lag_changes\` = head LSN —
  confirmed LSN, and \`lag_seconds\` derived from it with \`LSN_PER_SECOND\`.
- A lag beyond the retention window (\`RETENTION_WINDOW_CHANGES\`) raises a \`"critical"\` state.
- A slot that is gone is \`SLOT_DROPPED\` and surfaces as \`"critical"\` with the LSN gap
  (\`lsn_gap\`) named — the distance between what the sink confirmed and what the database still
  retains — instead of a generic error.

**Failure mode the checks target.** The draft reports lag in seconds only, read from
\`cdc:lag:{id}\` — a cached value with a 300 s TTL — so the number an operator pages on is minutes
old and unrelated to the log; it hides a cold cache and a dropped slot behind the same
\`{"error": "lag unavailable"}\` **502**; and it never checks ownership, so any tenant can read any
subscription's position by guessing an id. Lag is arithmetic on two LSNs, a dropped slot is a
page with an amount of data attached, and a subscription that is not the caller's does not exist.`,
  sequence: {
    participants: ['Operator', 'CDC API', 'subscription store', 'Redis', 'Replicator'],
    messages: [
      {from: 'Operator', to: 'CDC API', label: 'GET /v1/subscriptions/{id}/lag · X-Tenant-Id', kind: 'sync'},
      {from: 'CDC API', to: 'subscription store', label: 'get(tenant, id)', kind: 'sync'},
      {from: 'subscription store', to: 'CDC API', label: 'subscription / none → 404', kind: 'reply'},
      {from: 'CDC API', to: 'Redis', label: 'get cdc:lsn:{id} · confirmed LSN', kind: 'sync'},
      {from: 'Redis', to: 'CDC API', label: 'confirmed LSN', kind: 'reply'},
      {from: 'CDC API', to: 'Replicator', label: 'slot status · head LSN · active', kind: 'sync'},
      {from: 'Replicator', to: 'CDC API', label: 'head LSN · active / SLOT_DROPPED', kind: 'reply'},
      {
        from: 'CDC API',
        to: 'Operator',
        label: '200 {confirmed_lsn, head_lsn, lag_changes, lag_seconds, state}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/subscriptions/{id}/lag',
      detail: 'Register the lag route on `GET /v1/subscriptions/{id}/lag`, with the id in the path.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/subscriptions\/\{id\}\/lag["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/subscriptions\/:id\/lag['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/subscriptions\/\{id\}\/lag"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"subscriptions"\s*\/\s*Segment\s*\/\s*"lag"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(/, /\/v1\/subscriptions\//]},
      },
    },
    {
      id: 'lsn-arithmetic',
      title: 'Derives lag from the confirmed and head LSNs',
      detail:
        'The response carries the confirmed LSN and the source head LSN, and the lag is computed as `lag_changes = head_lsn - confirmed_lsn` with `lag_seconds` divided out of it by `LSN_PER_SECOND`. The draft reports a cached age in seconds and never reads either LSN.',
      match: {
        python: {all: [/head_lsn/, /confirmed_lsn/, /lag_changes/, /lag_seconds/]},
        typescript: {
          all: [/headLsn|head_lsn/, /confirmedLsn|confirmed_lsn/, /lagChanges|lag_changes/, /lagSeconds|lag_seconds/],
        },
        go: {all: [/HeadLSN/, /ConfirmedLSN/, /LagChanges/, /LagSeconds/]},
        scala: {all: [/headLsn/, /confirmedLsn/, /lagChanges/, /lagSeconds/]},
        cpp: {all: [/head_lsn/, /confirmed_lsn/, /lag_changes/, /lag_seconds/]},
      },
    },
    {
      id: 'foreign-404',
      title: 'Scopes the read to the caller and answers 404 otherwise',
      detail:
        'The subscription is looked up under `(tenant, id)` by `owned_subscription` / `ownedSubscription`, and a subscription that is not the caller’s — or does not exist — is **404**, so ids cannot be probed. The draft reads whatever id it is given.',
      match: {
        python: {all: [/def owned_subscription\(/, /status_code\s*=\s*404/]},
        typescript: {all: [/function ownedSubscription\(/, /code\(\s*404\s*\)/]},
        go: {all: [/func ownedSubscription\(/, /http\.StatusNotFound/]},
        scala: {all: [/def ownedSubscription\(/, /StatusCodes\.NotFound/]},
        cpp: {all: [/ownedSubscription\(/, /\b404\b/]},
      },
    },
    {
      id: 'retention-critical',
      title: 'Flags a lag past the retention window',
      detail:
        'A lag larger than the retention window (`RETENTION_WINDOW_CHANGES`) is reported as a `"critical"` state, because the slot is about to run out of log to retain. The draft has no notion of a window and no state field.',
      match: {
        python: {all: [/RETENTION_WINDOW_CHANGES/, /"critical"/]},
        typescript: {all: [/RETENTION_WINDOW_CHANGES/, /'critical'/]},
        go: {all: [/retentionWindowChanges/, /"critical"/]},
        scala: {all: [/RetentionWindowChanges/, /"critical"/]},
        cpp: {all: [/kRetentionWindowChanges/, /"critical"/]},
      },
    },
    {
      id: 'slot-drop-named',
      title: 'Names a dropped slot and its LSN gap',
      detail:
        'A slot that is no longer active is reported as `SLOT_DROPPED` with a `"critical"` state and the `lsn_gap` (restart LSN minus confirmed LSN) named, so the operator learns how much change the database is about to discard. The draft folds it into the same generic error as a cold cache.',
      match: {
        python: {all: [/SLOT_DROPPED/, /lsn_gap/]},
        typescript: {all: [/SLOT_DROPPED/, /lsn_gap/]},
        go: {all: [/SlotDropped/, /LSNGap|lsn_gap/]},
        scala: {all: [/SlotDropped/, /lsnGap/]},
        cpp: {all: [/kSlotDropped/, /lsn_gap/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import redis.asyncio as redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("cdc")

rds = redis.Redis(host="redis", port=6379, decode_responses=True)


async def slot_active(subscription_id: str) -> bool:
    """Whether the replication slot is still active — the draft asks the replicator once."""
    raise NotImplementedError


@app.get("/v1/subscriptions/{id}/lag")
async def subscription_lag(
    id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")
) -> JSONResponse:
    # TODO: this draft answers from the cached \`cdc:lag:{id}\` value (300 s TTL) instead of deriving
    # the lag from the confirmed and head LSNs, hides a cold cache and a dropped slot behind the same
    # generic 502, and never checks that the subscription belongs to the caller.
    cached = await rds.get(f"cdc:lag:{id}")
    if cached is None or not await slot_active(id):
        return JSONResponse({"error": "lag unavailable"}, status_code=502)
    logger.info("lag read tenant=%s id=%s", tenant or "anonymous", id)
    return JSONResponse({"id": id, "lag_seconds": int(cached)}, status_code=200)
`,
      solution: `import logging

import redis.asyncio as redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("cdc")

LSN_PER_SECOND = 262144
RETENTION_WINDOW_CHANGES = 50000
SLOT_DROPPED = "SLOT_DROPPED"

rds = redis.Redis(host="redis", port=6379, decode_responses=True)


class SubscriptionStore:
    def get(self, tenant: str, subscription_id: str) -> dict | None:
        """The subscription with this id when it belongs to the tenant, else None."""
        raise NotImplementedError


class SlotReader:
    def status(self, subscription: dict) -> dict:
        """The slot's head LSN and liveness; restart_lsn when the slot has been dropped."""
        raise NotImplementedError


store = SubscriptionStore()
slots = SlotReader()


def owned_subscription(tenant: str, subscription_id: str) -> dict:
    """The subscription when it belongs to the calling tenant — a foreign id is not observable."""
    subscription = store.get(tenant, subscription_id)
    if subscription is None:
        raise HTTPException(status_code=404, detail="subscription not found")
    return subscription


@app.get("/v1/subscriptions/{id}/lag")
async def subscription_lag(
    id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    subscription = owned_subscription(tenant, id)

    raw = await rds.get(f"cdc:lsn:{id}")
    confirmed_lsn = int(raw) if raw is not None else 0
    slot = slots.status(subscription)
    head_lsn = int(slot["head_lsn"])
    lag_changes = max(head_lsn - confirmed_lsn, 0)
    lag_seconds = lag_changes // LSN_PER_SECOND

    if not slot["active"]:
        lsn_gap = int(slot["restart_lsn"]) - confirmed_lsn
        logger.warning("slot dropped subscription=%s tenant=%s lsn_gap=%s", id, tenant, lsn_gap)
        return JSONResponse(
            {
                "id": id,
                "state": "critical",
                "error": SLOT_DROPPED,
                "lsn_gap": lsn_gap,
                "confirmed_lsn": confirmed_lsn,
                "head_lsn": head_lsn,
                "lag_changes": lag_changes,
                "lag_seconds": lag_seconds,
                "active": False,
            },
            status_code=200,
        )

    state = "critical" if lag_changes > RETENTION_WINDOW_CHANGES else "ok"
    return JSONResponse(
        {
            "id": id,
            "state": state,
            "confirmed_lsn": confirmed_lsn,
            "head_lsn": head_lsn,
            "lag_changes": lag_changes,
            "lag_seconds": lag_seconds,
            "active": True,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/subscriptions/:id/lag: a model-generated draft that reads a cached lag. */
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

async function slotActive(id: string): Promise<boolean> {
  /** Whether the replication slot is still active — asked once by the draft. */
  throw new Error('not implemented');
}

app.get('/v1/subscriptions/:id/lag', async (request, reply) => {
  // TODO: this draft answers from the cached cdc:lag:{id} value (300 s TTL) instead of deriving the
  // lag from the confirmed and head LSNs, hides a cold cache and a dropped slot behind the same
  // generic 502, and never checks that the subscription belongs to the caller.
  const {id} = request.params as {id: string};
  const tenant = request.headers['x-tenant-id'];
  const cached = await redis.get(\`cdc:lag:\${id}\`);
  if (cached === null || !(await slotActive(id)))
    return reply.code(502).send({error: 'lag unavailable'});
  request.log.info({tenant: tenant ?? 'anonymous', id}, 'lag read');
  return reply.code(200).send({id, lag_seconds: Number(cached)});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/subscriptions/:id/lag: the lag an operator can page on, derived from LSN arithmetic. */
import Fastify from 'fastify';
import Redis from 'ioredis';

import {store, type Subscription} from './store';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

const LSN_PER_SECOND = 262144;
const RETENTION_WINDOW_CHANGES = 50000;
const SLOT_DROPPED = 'SLOT_DROPPED';

interface SlotStatus {
  head_lsn: number;
  active: boolean;
  restart_lsn: number;
}

async function readSlotStatus(subscription: Subscription): Promise<SlotStatus> {
  /** The slot's head LSN and liveness, read from the replicator. */
  throw new Error('not implemented');
}

async function ownedSubscription(tenant: string, id: string): Promise<Subscription | null> {
  /** The subscription when it belongs to the calling tenant — a foreign id is not observable. */
  return store.get(tenant, id);
}

app.get('/v1/subscriptions/:id/lag', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {id} = request.params as {id: string};

  const subscription = await ownedSubscription(tenant, id);
  if (subscription === null) return reply.code(404).send({error: 'subscription not found'});

  const raw = await redis.get(\`cdc:lsn:\${id}\`);
  const confirmedLsn = raw === null ? 0 : Number(raw);
  const slot = await readSlotStatus(subscription);
  const headLsn = slot.head_lsn;
  const lagChanges = Math.max(headLsn - confirmedLsn, 0);
  const lagSeconds = Math.floor(lagChanges / LSN_PER_SECOND);

  if (!slot.active) {
    const lsnGap = slot.restart_lsn - confirmedLsn;
    request.log.warn({tenant, id, lsn_gap: lsnGap}, 'slot dropped');
    return reply.code(200).send({
      id,
      state: 'critical',
      error: SLOT_DROPPED,
      lsn_gap: lsnGap,
      confirmed_lsn: confirmedLsn,
      head_lsn: headLsn,
      lag_changes: lagChanges,
      lag_seconds: lagSeconds,
      active: false,
    });
  }

  const state = lagChanges > RETENTION_WINDOW_CHANGES ? 'critical' : 'ok';
  return reply.code(200).send({
    id,
    state,
    confirmed_lsn: confirmedLsn,
    head_lsn: headLsn,
    lag_changes: lagChanges,
    lag_seconds: lagSeconds,
    active: true,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Subscription struct {
	ID     string \`json:"id"\`
	Tenant string \`json:"tenant"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func slotActive(ctx context.Context, id string) bool {
	return true
}

func subscriptionLag(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft answers from the cached cdc:lag:{id} value (300 s TTL) instead of deriving the
	// lag from the confirmed and head LSNs, hides a cold cache and a dropped slot behind the same
	// generic 502, and never checks that the subscription belongs to the caller.
	id := r.PathValue("id")
	tenant := r.Header.Get("X-Tenant-Id")
	cached, err := rdb.Get(r.Context(), "cdc:lag:"+id).Result()
	if err != nil || !slotActive(r.Context(), id) {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "lag unavailable"})
		return
	}
	seconds, _ := strconv.Atoi(cached)
	log.Printf("lag read tenant=%s id=%s seconds=%d", tenant, id, seconds)
	writeJSON(rw, http.StatusOK, map[string]any{"id": id, "lag_seconds": seconds})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/subscriptions/{id}/lag", subscriptionLag)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const lsnPerSecond = 262144
const retentionWindowChanges = 50000

const SlotDropped = "SLOT_DROPPED"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Subscription struct {
	ID     string \`json:"id"\`
	Tenant string \`json:"tenant"\`
}

type SlotStatus struct {
	HeadLSN    uint64
	Active     bool
	RestartLSN uint64
}

type LagResponse struct {
	ID           string \`json:"id"\`
	State        string \`json:"state"\`
	ConfirmedLSN uint64 \`json:"confirmed_lsn"\`
	HeadLSN      uint64 \`json:"head_lsn"\`
	LagChanges   uint64 \`json:"lag_changes"\`
	LagSeconds   uint64 \`json:"lag_seconds"\`
	Active       bool   \`json:"active"\`
	Error        string \`json:"error,omitempty"\`
	LSNGap       uint64 \`json:"lsn_gap,omitempty"\`
}

type SubscriptionStore struct{}

func (s *SubscriptionStore) Get(ctx context.Context, tenant, id string) (*Subscription, error) {
	return nil, nil
}

var store = &SubscriptionStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readSlotStatus(subscription *Subscription) (*SlotStatus, error) {
	/** The slot's head LSN and liveness, read from the replicator. */
	return nil, nil
}

func ownedSubscription(tenant, id string) (*Subscription, error) {
	/** The subscription when it belongs to the calling tenant — a foreign id is not observable. */
	return store.Get(context.Background(), tenant, id)
}

func subscriptionLag(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	id := r.PathValue("id")

	subscription, err := ownedSubscription(tenant, id)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if subscription == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "subscription not found"})
		return
	}

	raw, err := rdb.Get(r.Context(), "cdc:lsn:"+id).Result()
	if err != nil && err != redis.Nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	var confirmedLSN uint64
	if raw != "" {
		confirmedLSN, _ = strconv.ParseUint(raw, 10, 64)
	}

	slot, err := readSlotStatus(subscription)
	if err != nil || slot == nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	headLSN := slot.HeadLSN
	var lagChanges uint64
	if headLSN > confirmedLSN {
		lagChanges = headLSN - confirmedLSN
	}
	lagSeconds := lagChanges / lsnPerSecond

	if !slot.Active {
		lsnGap := slot.RestartLSN - confirmedLSN
		log.Printf("slot dropped subscription=%s tenant=%s lsn_gap=%d", id, tenant, lsnGap)
		writeJSON(rw, http.StatusOK, LagResponse{
			ID:           id,
			State:        "critical",
			ConfirmedLSN: confirmedLSN,
			HeadLSN:      headLSN,
			LagChanges:   lagChanges,
			LagSeconds:   lagSeconds,
			Active:       false,
			Error:        SlotDropped,
			LSNGap:       lsnGap,
		})
		return
	}

	state := "ok"
	if lagChanges > retentionWindowChanges {
		state = "critical"
	}
	writeJSON(rw, http.StatusOK, LagResponse{
		ID:           id,
		State:        state,
		ConfirmedLSN: confirmedLSN,
		HeadLSN:      headLSN,
		LagChanges:   lagChanges,
		LagSeconds:   lagSeconds,
		Active:       true,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/subscriptions/{id}/lag", subscriptionLag)
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
import redis.clients.jedis.JedisPooled
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CachedLag(id: String, lagSeconds: Long)

object CdcApi {
  implicit val system: ActorSystem = ActorSystem("cdc-streamer")
  implicit val cachedLagFormat: RootJsonFormat[CachedLag] = jsonFormat2(CachedLag)

  val jedis = new JedisPooled("redis", 6379)

  def slotActive(id: String): Boolean = true

  val route: Route =
    path("v1" / "subscriptions" / Segment / "lag") { id =>
      get {
        val tenant = "anonymous"
        // TODO: this draft answers from the cached cdc:lag:{id} value (300 s TTL) instead of
        // deriving the lag from the confirmed and head LSNs, hides a cold cache and a dropped slot
        // behind the same generic 502, and never checks that the subscription belongs to the caller.
        val cached = jedis.get(s"cdc:lag:$id")
        if (cached == null || !slotActive(id)) {
          complete(StatusCodes.BadGateway, """{"error":"lag unavailable"}""")
        } else {
          system.log.info(s"lag read tenant=$tenant id=$id")
          complete(StatusCodes.OK, CachedLag(id, cached.toLong))
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
import redis.clients.jedis.JedisPooled
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class LagResponse(
    id: String,
    state: String,
    confirmedLsn: Long,
    headLsn: Long,
    lagChanges: Long,
    lagSeconds: Long,
    active: Boolean,
    error: String,
    lsnGap: Long,
)

final case class SlotStatus(headLsn: Long, active: Boolean, restartLsn: Long)

/** One subscription of one tenant: what the ops read is scoped to. */
final case class Subscription(id: String, tenant: String)

object CdcApi {
  implicit val system: ActorSystem = ActorSystem("cdc-streamer")
  implicit val lagFormat: RootJsonFormat[LagResponse] = jsonFormat9(LagResponse)

  val LsnPerSecond: Long = 262144L
  val RetentionWindowChanges: Long = 50000L
  val SlotDropped: String = "SLOT_DROPPED"

  val jedis = new JedisPooled("redis", 6379)
  val store = SubscriptionStore.open()

  def readSlotStatus(subscription: Subscription): SlotStatus = {
    /** The slot's head LSN and liveness, read from the replicator. */
    SlotStatus(0L, true, 0L)
  }

  def ownedSubscription(tenant: String, id: String): Option[Subscription] = {
    /** The subscription when it belongs to the calling tenant — a foreign id is not observable. */
    store.get(tenant, id)
  }

  val route: Route =
    path("v1" / "subscriptions" / Segment / "lag") { id =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            val tenant = tenantOpt.get
            ownedSubscription(tenant, id) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"subscription not found"}""")
              case Some(subscription) =>
                val confirmedLsn: Long = Option(jedis.get(s"cdc:lsn:$id")).map(_.toLong).getOrElse(0L)
                val slot = readSlotStatus(subscription)
                val headLsn = slot.headLsn
                val lagChanges = math.max(headLsn - confirmedLsn, 0L)
                val lagSeconds = lagChanges / LsnPerSecond
                if (!slot.active) {
                  val lsnGap = slot.restartLsn - confirmedLsn
                  system.log.warning(s"slot dropped subscription=$id tenant=$tenant lsnGap=$lsnGap")
                  complete(
                    StatusCodes.OK,
                    LagResponse(id, "critical", confirmedLsn, headLsn, lagChanges, lagSeconds, false, SlotDropped, lsnGap),
                  )
                } else {
                  val state = if (lagChanges > RetentionWindowChanges) "critical" else "ok"
                  complete(
                    StatusCodes.OK,
                    LagResponse(id, state, confirmedLsn, headLsn, lagChanges, lagSeconds, true, "", 0L),
                  )
                }
            }
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

#include <iostream>
#include <string>

#include <sw/redis++/redis++.h>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

bool slotActive(const std::string& id) { return true; }

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/subscriptions/([^/]+)/lag)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft answers from the cached cdc:lag:{id} value (300 s TTL) instead of deriving
    // the lag from the confirmed and head LSNs, hides a cold cache and a dropped slot behind the
    // same generic 502, and never checks that the subscription belongs to the caller.
    const auto id = req.matches[1];
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto cached = redis.get("cdc:lag:" + id);
    if (!cached || !slotActive(id)) {
      res.status = 502;
      res.set_content(R"({"error":"lag unavailable"})", "application/json");
      return;
    }
    std::cerr << "lag read tenant=" << tenant << " id=" << id << "\\n";
    res.status = 200;
    res.set_content(json{{"id", id}, {"lag_seconds", std::stoll(*cached)}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
  return 0;
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <string>

#include <sw/redis++/redis++.h>

using json = nlohmann::json;

constexpr long long kLsnPerSecond = 262144;
constexpr long long kRetentionWindowChanges = 50000;
const std::string kSlotDropped = "SLOT_DROPPED";

sw::redis::Redis redis("tcp://redis:6379");

struct Subscription {
  std::string id;
  std::string tenant;
};

struct SlotStatus {
  long long head_lsn;
  bool active;
  long long restart_lsn;
};

// Provided: the subscription with this id when it belongs to the tenant, nothing otherwise.
std::optional<Subscription> storeGet(const std::string& tenant, const std::string& id);

// Provided: the slot's head LSN and liveness, nothing when the replicator cannot be reached.
std::optional<SlotStatus> readSlotStatus(const Subscription& subscription);

std::optional<Subscription> ownedSubscription(const std::string& tenant, const std::string& id) {
  /** The subscription when it belongs to the calling tenant — a foreign id is not observable. */
  return storeGet(tenant, id);
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/subscriptions/([^/]+)/lag)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto id = req.matches[1];

    const auto subscription = ownedSubscription(tenant, id);
    if (!subscription) {
      res.status = 404;
      res.set_content(R"({"error":"subscription not found"})", "application/json");
      return;
    }

    long long confirmed_lsn = 0;
    const auto raw = redis.get("cdc:lsn:" + id);
    if (raw) confirmed_lsn = std::stoll(*raw);

    const auto slot = readSlotStatus(*subscription);
    if (!slot) {
      res.status = 502;
      res.set_content(R"({"error":"TRY_AGAIN"})", "application/json");
      return;
    }
    const long long head_lsn = slot->head_lsn;
    const long long lag_changes = head_lsn > confirmed_lsn ? head_lsn - confirmed_lsn : 0;
    const long long lag_seconds = lag_changes / kLsnPerSecond;

    if (!slot->active) {
      const long long lsn_gap = slot->restart_lsn - confirmed_lsn;
      std::cerr << "slot dropped subscription=" << id << " tenant=" << tenant << " lsn_gap=" << lsn_gap
                << "\\n";
      res.status = 200;
      res.set_content(json{{"id", id},
                           {"state", "critical"},
                           {"error", kSlotDropped},
                           {"lsn_gap", lsn_gap},
                           {"confirmed_lsn", confirmed_lsn},
                           {"head_lsn", head_lsn},
                           {"lag_changes", lag_changes},
                           {"lag_seconds", lag_seconds},
                           {"active", false}}
                          .dump(),
                      "application/json");
      return;
    }

    const std::string state = lag_changes > kRetentionWindowChanges ? "critical" : "ok";
    res.status = 200;
    res.set_content(json{{"id", id},
                         {"state", state},
                         {"confirmed_lsn", confirmed_lsn},
                         {"head_lsn", head_lsn},
                         {"lag_changes", lag_changes},
                         {"lag_seconds", lag_seconds},
                         {"active", true}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
  return 0;
}
`,
    },
  },
  hints: [
    'Ownership first: look the subscription up under `(tenant, id)` and answer **404** for a miss — the same answer for a foreign id and for an id that never existed, so the endpoint cannot be used to enumerate which subscriptions a tenant has. Then read `cdc:lsn:{id}`, the confirmed position the replicator wrote, which has no TTL for a reason.',
    'Lag is arithmetic on two LSNs, not a stored number: `lag_changes = head_lsn - confirmed_lsn` from the confirmed cursor and the head LSN the slot reader returns, and `lag_seconds = lag_changes // LSN_PER_SECOND`. A cached age under `cdc:lag:{id}` is minutes stale and tells an operator nothing about the log.',
    'Two page-worthy answers still return the numbers, with 200: `lag_changes > RETENTION_WINDOW_CHANGES` is a `"critical"` state, and a slot that is gone is `"critical"` too — `SLOT_DROPPED` with the `lsn_gap` (restart LSN minus confirmed LSN) named, the amount of change the database is about to discard, instead of one generic 502 for both.',
  ],
  debrief: `The interviewer is testing whether you can review generated code for the difference between a number that is stored and a number that is derived. The draft returns a lag in seconds from \`cdc:lag:{id}\`, a 300 s cache; it looks right on the dashboard and is meaningless on the day it matters, because the value an operator pages on has to come from the two LSNs the system actually holds — the confirmed cursor and the source head — with the seconds divided out of the difference. The second defect is the failure mode of every "unavailable" endpoint: one 502 for a cold cache and for a subscription whose slot has been dropped. A slot that is gone is not an outage of this endpoint, it is the database about to discard the log the stream still needs, and it deserves a name — \`SLOT_DROPPED\` — a state, and the \`lsn_gap\` that says how much change is at risk. The third is the quiet one: the draft reads any id it is given, so the endpoint is an oracle for other tenants' subscription ids and positions; scoping the lookup to the caller and answering 404 for a foreign id is the fix. Real streamers add the sink's applied LSN per table, an alert that fires on the state rather than on the seconds, and a retention forecast — time until the slot's \`restart_lsn\` reaches the confirmed LSN — so the page arrives before the data is gone.`,
};
