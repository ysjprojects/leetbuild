import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis guardrail counters per sku window',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a single seller updating a price
looks capped, the route answers 200 with a number, and the demo passes. It hides the one failure a
pricing service is judged by — what ten updates arriving together do to the same budget. Review it
like the service owner, fix it, and prove the fix with the checks below.

Implement the guardrail reservation behind \`POST /v1/prices\`
(body \`{"sku": "…", "price_cents": 1299, "reason": "…"}\`):

- \`MAX_MOVE_BP = 2000\` (20.00% of the current price, per sku, per hour window), \`FLOOR_CENTS = 50\`,
  \`CEILING_CENTS = 500000\`, \`WINDOW_S = 3600\`. A move is
  \`abs(price_cents - current_cents) * 10000 // current_cents\` basis points.
- The headroom belongs to the **sku and the hour**: the key is \`guard:{sku}:{window}\` with
  \`window = now // WINDOW_S\` and the hash field is \`moved\`, and the script must \`EXPIRE\` the key on
  the write that created it while reporting the remaining \`TTL\`. A window-less key is a global cap on
  the sku; a key without a TTL ratchets that cap down for good.
- Read, check and consume the headroom **inside one Lua script** (\`RESERVE_LUA\`, run through
  \`EVAL\`): \`HGET\` the accumulator, compare, and \`HINCRBY\` only on success. A client-side \`GET\`
  followed by an \`INCRBY\` is two round trips, and two updates pass the same last basis points.
- The compared quantity is the **accumulated** movement, not this update against the price on disk:
  \`moved + this_move <= MAX_MOVE_BP\` decides, so ten 15% updates in one hour meet one 20% budget
  instead of ten separate ones.
- The reservation mints an \`update_id\` and returns it. \`store.publish(\` runs **after** the
  reservation succeeded and carries that id, and the \`price:{sku}\` cache is written with
  \`price_cents\`, \`source\`, \`updated_at\` and the same \`update_id\`, so any published price can be
  traced back to the update that consumed its headroom.
- An update that does not fit the window is rejected with **409** and
  \`{"headroom_bp": …, "bound_cents": …}\` — what the window still has and the furthest price it still
  allows — and the refusal happens **before** \`store.publish(\`. The bound is
  \`delta = current_cents * headroom_bp // 10000\` applied in the direction of the move
  (\`current_cents ± delta\`) and clamped by \`FLOOR_CENTS\` and \`CEILING_CENTS\`.

**Failure mode the checks target.** A per-update bound is not a window budget. The draft measures each
proposal against the price on disk, so every update is legal on its own and ten of them compound into
a move no single update was ever allowed to make; its counter is read and written in two round trips,
so concurrent updates spend headroom that is already gone; it is keyed without a window and never
expires, so one busy hour permanently caps the sku; and the publish carries no id, which is exactly
what makes a price movement explainable three weeks later.`,
  sequence: {
    participants: ['Pricing API', 'Redis', 'Price store'],
    messages: [
      {
        from: 'Pricing API',
        to: 'Redis',
        label: 'EVAL reserve · KEYS[guard:{sku}:{window}] ARGV[this_move, MAX_MOVE_BP, WINDOW_S]',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Pricing API', label: '{ok, moved, headroom, ttl}', kind: 'reply'},
      {
        from: 'Pricing API',
        to: 'Pricing API',
        label: '409 {headroom_bp, bound_cents} when it does not fit — store untouched',
        kind: 'sync',
      },
      {
        from: 'Pricing API',
        to: 'Price store',
        label: 'publish(sku, price_cents, reason, source, update_id) after the reservation',
        kind: 'sync',
      },
      {
        from: 'Price store',
        to: 'Pricing API',
        label: 'committed · price:{sku} then carries price_cents, source, updated_at, update_id',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'The decision has to live where the accumulator lives. `HGET` the `moved` field inside `RESERVE_LUA`, add this update’s basis points, compare against `MAX_MOVE_BP`, and `HINCRBY` only when it fits. The draft reads with `GET` and writes with `INCRBY` from the client: between those two calls another update sees headroom it can no longer spend.',
    'One sku, one hour, one accumulator: `guard:{sku}:{window}` with `window = now // WINDOW_S`. Inside the same script, `EXPIRE` the key when `TTL` says it was just created. A counter that never expires is not a window limit — it is a permanent ceiling that a single busy hour installs on the sku.',
    'A refusal is a product answer, not just a status code: `409` with `headroom_bp` tells the seller what is left and `bound_cents` tells it the furthest price this window still allows, so it can retry with a price that fits. The refusal must return before `store.publish(`, and every publish that does happen must carry the `update_id` the reservation minted.',
  ],
  checks: [
    {
      id: 'atomic-reserve',
      title: 'Headroom is read, checked and consumed in one Lua script',
      detail:
        'One `RESERVE_LUA` run through `EVAL` reads the accumulator with `HGET`, compares it, and increments it with `HINCRBY` server-side. The draft reads with a client-side `GET` and writes with `INCRBY`, so two concurrent updates both spend headroom that only one of them can have.',
      match: {
        python: {all: [/RESERVE_LUA/, /\.eval\(/, /HGET/, /HINCRBY/]},
        typescript: {all: [/RESERVE_LUA/, /\.eval\(/, /HGET/, /HINCRBY/]},
        go: {all: [/(reserveScript|NewScript)/, /\.Run\(/, /HGET/, /HINCRBY/]},
        scala: {all: [/ReserveLua/, /\.eval\(/, /HGET/, /HINCRBY/]},
        cpp: {all: [/kReserveLua/, /\.eval</, /HGET/, /HINCRBY/]},
      },
    },
    {
      id: 'window-expiry',
      title: 'The counter is per sku per hour and expires',
      detail:
        'The key is `guard:{sku}:{window}` with `window = now // WINDOW_S`, and the script calls `EXPIRE` on the write that created it while reporting `TTL`. Without the bucket the cap is global to the sku; without the expiry one busy hour caps it forever.',
      match: {
        python: {all: [/guard:\{sku\}:\{window\}/, /WINDOW_S/, /EXPIRE/, /TTL/]},
        typescript: {all: [/guard:\$\{sku\}:\$\{window\}/, /WINDOW_S/, /EXPIRE/, /TTL/]},
        go: {all: [/guard:%s:%d/, /windowSeconds/, /EXPIRE/, /TTL/]},
        scala: {all: [/guard:\$sku:\$window/, /WindowSeconds/, /EXPIRE/, /TTL/]},
        cpp: {all: [/"guard:"/, /kWindowSeconds/, /EXPIRE/, /TTL/]},
      },
    },
    {
      id: 'shared-headroom',
      title: 'The window accumulates moves instead of judging one update',
      detail:
        'The decision is `moved + this_move` against `MAX_MOVE_BP` on the accumulator, and the read (`HGET`) precedes the write (`HINCRBY`). The draft compares this single update against the price on disk, so updates that are each inside the per-update bound still pass together.',
      match: {
        python: {all: [/MAX_MOVE_BP/, /moved \+ this_move/], order: [/HGET/, /HINCRBY/]},
        typescript: {all: [/MAX_MOVE_BP/, /moved \+ this_move/], order: [/HGET/, /HINCRBY/]},
        go: {all: [/maxMoveBp/, /moved \+ this_move/], order: [/HGET/, /HINCRBY/]},
        scala: {all: [/MaxMoveBp/, /moved \+ this_move/], order: [/HGET/, /HINCRBY/]},
        cpp: {all: [/kMaxMoveBp/, /moved \+ this_move/], order: [/HGET/, /HINCRBY/]},
      },
    },
    {
      id: 'traceable-update',
      title: 'The publish carries the id the reservation minted',
      detail:
        'The reservation mints an `update_id` and returns it, `store.publish(` runs after `reserve(`, and the `price:{sku}` cache is written with the same `update_id`. The draft publishes with no id at all, so no published price can be traced back to the headroom it consumed.',
      match: {
        python: {all: [/uuid4\(\)/, /update_id/, /price:\{sku\}/], order: [/reserve\(/, /store\.publish\(/]},
        typescript: {
          all: [/randomUUID\(\)/, /update_id/, /price:\$\{sku\}/],
          order: [/reserve\(/, /store\.publish\(/],
        },
        go: {all: [/newUpdateID\(\)/, /update_id/, /price:%s/], order: [/reserve\(/, /store\.Publish\(/]},
        scala: {all: [/randomUUID\(\)/, /update_id/, /price:\$sku/], order: [/reserve\(/, /store\.publish\(/]},
        cpp: {all: [/new_update_id\(\)/, /update_id/, /"price:"/], order: [/reserve\(/, /store\.publish\(/]},
      },
    },
    {
      id: 'reject-headroom',
      title: 'A refusal answers 409 with the headroom and the bound',
      detail:
        'An update that does not fit the window is refused with `409` and a body naming `headroom_bp` and `bound_cents`, and the refusal comes before `store.publish(`, so a rejected price never becomes durable. The draft answers 422 with its own remaining basis points.',
      match: {
        python: {all: [/headroom_bp/, /bound_cents/, /status_code\s*=\s*409/], order: [/409/, /store\.publish\(/]},
        typescript: {all: [/headroom_bp/, /bound_cents/, /\.code\(409\)/], order: [/409/, /store\.publish\(/]},
        go: {all: [/headroom_bp/, /bound_cents/, /StatusConflict/], order: [/StatusConflict/, /store\.Publish\(/]},
        scala: {
          all: [/headroom_bp/, /bound_cents/, /StatusCodes\.Conflict/],
          order: [/StatusCodes\.Conflict/, /store\.publish\(/],
        },
        cpp: {all: [/headroom_bp/, /bound_cents/, /status\s*=\s*409/], order: [/409/, /store\.publish\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""POST /v1/prices: a model-generated draft that checks each proposal against the price on disk."""
import time

import redis
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_MOVE_BP = 2_000
FLOOR_CENTS = 50
CEILING_CENTS = 500_000


class PriceStore:
    """The price store (given): skus, published prices, audit and outbox rows."""

    def get_sku(self, sku: str) -> bool:
        raise NotImplementedError

    def last_approved(self, sku: str) -> int:
        raise NotImplementedError

    def publish(self, sku: str, price_cents: int, reason: str, source: str) -> None:
        raise NotImplementedError


store = PriceStore()


class PriceRequest(BaseModel):
    sku: str
    price_cents: int
    reason: str


def moved_bp(current_cents: int, price_cents: int) -> int:
    return abs(price_cents - current_cents) * 10_000 // max(current_cents, 1)


def price_key(sku: str) -> str:
    return f"price:{sku}"


@app.post("/v1/prices")
def post_price(body: PriceRequest) -> dict:
    # TODO: this draft reads the window counter with a client-side GET and writes it back with
    # INCRBY, and it never lets the counter decide: each update is compared against the price on
    # disk, so ten parallel updates each pass and compound. The key has no window bucket and no TTL,
    # so the limit ratchets down forever, and neither the publish nor the price:{sku} cache carries
    # the id of the update that consumed the headroom.
    if not store.get_sku(body.sku):
        raise HTTPException(status_code=404, detail="unknown sku")
    if not FLOOR_CENTS <= body.price_cents <= CEILING_CENTS:
        raise HTTPException(
            status_code=422,
            detail={
                "error": "price outside the absolute guardrails",
                "price_cents": body.price_cents,
                "floor_cents": FLOOR_CENTS,
                "ceiling_cents": CEILING_CENTS,
            },
        )
    current_cents = store.last_approved(body.sku)
    this_move = moved_bp(current_cents, body.price_cents)
    if this_move > MAX_MOVE_BP:
        raise HTTPException(
            status_code=422,
            detail={"error": "move exceeds the limit", "remaining_bp": MAX_MOVE_BP - this_move},
        )
    spent = int(r.get(f"guard:{body.sku}") or 0)
    r.incrby(f"guard:{body.sku}", this_move)
    source = "guardrail"
    store.publish(body.sku, body.price_cents, body.reason, source)
    r.hset(
        price_key(body.sku),
        mapping={
            "price_cents": body.price_cents,
            "source": source,
            "updated_at": int(time.time()),
        },
    )
    return {
        "sku": body.sku,
        "price_cents": body.price_cents,
        "remaining_bp": MAX_MOVE_BP - spent - this_move,
    }
`,
      solution: `"""POST /v1/prices: reserve the sku's hour-window headroom, then publish what fits."""
import time
import uuid

import redis
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_MOVE_BP = 2_000
FLOOR_CENTS = 50
CEILING_CENTS = 500_000
WINDOW_S = 3_600

# ARGV[1] = this update's move in bp   ARGV[2] = MAX_MOVE_BP   ARGV[3] = WINDOW_S
RESERVE_LUA = """
local moved = tonumber(redis.call('HGET', KEYS[1], 'moved')) or 0
local this_move = tonumber(ARGV[1])
if moved + this_move > tonumber(ARGV[2]) then
  return {0, moved, tonumber(ARGV[2]) - moved, redis.call('TTL', KEYS[1])}
end
redis.call('HINCRBY', KEYS[1], 'moved', this_move)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {1, moved + this_move, tonumber(ARGV[2]) - moved - this_move, redis.call('TTL', KEYS[1])}
"""


class PriceStore:
    """The price store (given): skus, published prices, audit and outbox rows."""

    def get_sku(self, sku: str) -> bool:
        raise NotImplementedError

    def last_approved(self, sku: str) -> int:
        raise NotImplementedError

    def publish(self, sku: str, price_cents: int, reason: str, source: str, update_id: str) -> None:
        raise NotImplementedError


store = PriceStore()


class PriceRequest(BaseModel):
    sku: str
    price_cents: int
    reason: str


def moved_bp(current_cents: int, price_cents: int) -> int:
    return abs(price_cents - current_cents) * 10_000 // max(current_cents, 1)


def price_key(sku: str) -> str:
    return f"price:{sku}"


def window_bound(current_cents: int, headroom_bp: int, direction: int) -> int:
    """The furthest price the remaining headroom allows, clamped by floor and ceiling."""
    delta = current_cents * headroom_bp // 10_000
    return min(max(current_cents + direction * delta, FLOOR_CENTS), CEILING_CENTS)


def guard_key(sku: str, window: int) -> str:
    return f"guard:{sku}:{window}"


def reserve(sku: str, this_move: int) -> tuple[bool, int, int, int, str]:
    """Consume this move's headroom in the sku's hour window.

    Returns (ok, moved, headroom_bp, ttl, update_id); the update_id is minted here so a publish can
    always be traced to the reservation that paid for it.
    """
    window = int(time.time()) // WINDOW_S
    update_id = uuid.uuid4().hex
    ok, moved, headroom_bp, ttl = r.eval(
        RESERVE_LUA, 1, guard_key(sku, window), this_move, MAX_MOVE_BP, WINDOW_S
    )
    return bool(ok), int(moved), int(headroom_bp), int(ttl), update_id


@app.post("/v1/prices")
def post_price(body: PriceRequest) -> dict:
    if not store.get_sku(body.sku):
        raise HTTPException(status_code=404, detail="unknown sku")
    if not FLOOR_CENTS <= body.price_cents <= CEILING_CENTS:
        raise HTTPException(
            status_code=422,
            detail={
                "error": "price outside the absolute guardrails",
                "price_cents": body.price_cents,
                "floor_cents": FLOOR_CENTS,
                "ceiling_cents": CEILING_CENTS,
            },
        )
    current_cents = store.last_approved(body.sku)
    direction = 1 if body.price_cents >= current_cents else -1
    this_move = moved_bp(current_cents, body.price_cents)
    ok, moved, headroom_bp, ttl, update_id = reserve(body.sku, this_move)
    if not ok:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "change exceeds the per-window limit",
                "current_price_cents": current_cents,
                "headroom_bp": headroom_bp,
                "bound_cents": window_bound(current_cents, headroom_bp, direction),
            },
        )
    source = "guardrail"
    store.publish(body.sku, body.price_cents, body.reason, source, update_id)
    r.hset(
        price_key(body.sku),
        mapping={
            "price_cents": body.price_cents,
            "source": source,
            "updated_at": int(time.time()),
            "update_id": update_id,
        },
    )
    return {
        "sku": body.sku,
        "price_cents": body.price_cents,
        "source": source,
        "update_id": update_id,
        "moved_bp": moved,
        "headroom_bp": headroom_bp,
        "window_ends_in": ttl,
    }
`,
    },
    typescript: {
      starter: `/** POST /v1/prices: a model-generated draft that checks each proposal against the price on disk. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const MAX_MOVE_BP = 2_000;
const FLOOR_CENTS = 50;
const CEILING_CENTS = 500_000;

interface PriceBody {
  sku: string;
  price_cents: number;
  reason: string;
}

/** The price store (given): skus, published prices, audit and outbox rows. */
interface PriceStore {
  get_sku(sku: string): Promise<boolean>;
  last_approved(sku: string): Promise<number>;
  publish(sku: string, price_cents: number, reason: string, source: string): Promise<void>;
}

const store = {} as PriceStore;

function movedBp(currentCents: number, priceCents: number): number {
  return Math.floor((Math.abs(priceCents - currentCents) * 10_000) / Math.max(currentCents, 1));
}

function priceKey(sku: string): string {
  return \`price:\${sku}\`;
}

app.post('/v1/prices', async (request, reply) => {
  // TODO: this draft reads the window counter with a client-side GET and writes it back with
  // INCRBY, and it never lets the counter decide: each update is compared against the price on
  // disk, so ten parallel updates each pass and compound. The key has no window bucket and no TTL,
  // so the limit ratchets down forever, and neither the publish nor the price:{sku} cache carries
  // the id of the update that consumed the headroom.
  const body = request.body as PriceBody;
  if (!(await store.get_sku(body.sku))) {
    return reply.code(404).send({error: 'unknown sku'});
  }
  if (body.price_cents < FLOOR_CENTS || body.price_cents > CEILING_CENTS) {
    return reply.code(422).send({
      error: 'price outside the absolute guardrails',
      price_cents: body.price_cents,
      floor_cents: FLOOR_CENTS,
      ceiling_cents: CEILING_CENTS,
    });
  }
  const currentCents = await store.last_approved(body.sku);
  const thisMove = movedBp(currentCents, body.price_cents);
  if (thisMove > MAX_MOVE_BP) {
    return reply.code(422).send({error: 'move exceeds the limit', remaining_bp: MAX_MOVE_BP - thisMove});
  }
  const spent = Number((await r.get(\`guard:\${body.sku}\`)) ?? 0);
  await r.incrby(\`guard:\${body.sku}\`, thisMove);
  const source = 'guardrail';
  await store.publish(body.sku, body.price_cents, body.reason, source);
  await r.hset(priceKey(body.sku), {
    price_cents: String(body.price_cents),
    source,
    updated_at: String(Math.floor(Date.now() / 1000)),
  });
  return reply.code(200).send({
    sku: body.sku,
    price_cents: body.price_cents,
    remaining_bp: MAX_MOVE_BP - spent - thisMove,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/prices: reserve the sku's hour-window headroom, then publish what fits. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const MAX_MOVE_BP = 2_000;
const FLOOR_CENTS = 50;
const CEILING_CENTS = 500_000;
const WINDOW_S = 3_600;

// ARGV[1] = this update's move in bp   ARGV[2] = MAX_MOVE_BP   ARGV[3] = WINDOW_S
const RESERVE_LUA = \`
local moved = tonumber(redis.call('HGET', KEYS[1], 'moved')) or 0
local this_move = tonumber(ARGV[1])
if moved + this_move > tonumber(ARGV[2]) then
  return {0, moved, tonumber(ARGV[2]) - moved, redis.call('TTL', KEYS[1])}
end
redis.call('HINCRBY', KEYS[1], 'moved', this_move)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {1, moved + this_move, tonumber(ARGV[2]) - moved - this_move, redis.call('TTL', KEYS[1])}
\`;

interface PriceBody {
  sku: string;
  price_cents: number;
  reason: string;
}

/** The price store (given): skus, published prices, audit and outbox rows. */
interface PriceStore {
  get_sku(sku: string): Promise<boolean>;
  last_approved(sku: string): Promise<number>;
  publish(sku: string, price_cents: number, reason: string, source: string, update_id: string): Promise<void>;
}

const store = {} as PriceStore;

function movedBp(currentCents: number, priceCents: number): number {
  return Math.floor((Math.abs(priceCents - currentCents) * 10_000) / Math.max(currentCents, 1));
}

function priceKey(sku: string): string {
  return \`price:\${sku}\`;
}

function windowBound(currentCents: number, headroomBp: number, direction: number): number {
  const delta = Math.floor((currentCents * headroomBp) / 10_000);
  return Math.min(Math.max(currentCents + direction * delta, FLOOR_CENTS), CEILING_CENTS);
}

function guardKey(sku: string, window: number): string {
  return \`guard:\${sku}:\${window}\`;
}

/** Consumes this move's headroom in the sku's hour window and mints the update id that paid for it. */
async function reserve(
  sku: string,
  thisMove: number,
): Promise<[boolean, number, number, number, string]> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const updateId = randomUUID();
  const reply = (await r.eval(
    RESERVE_LUA,
    1,
    guardKey(sku, window),
    String(thisMove),
    String(MAX_MOVE_BP),
    String(WINDOW_S),
  )) as [number, number, number, number];
  return [reply[0] === 1, reply[1], reply[2], reply[3], updateId];
}

app.post('/v1/prices', async (request, reply) => {
  const body = request.body as PriceBody;
  if (!(await store.get_sku(body.sku))) {
    return reply.code(404).send({error: 'unknown sku'});
  }
  if (body.price_cents < FLOOR_CENTS || body.price_cents > CEILING_CENTS) {
    return reply.code(422).send({
      error: 'price outside the absolute guardrails',
      price_cents: body.price_cents,
      floor_cents: FLOOR_CENTS,
      ceiling_cents: CEILING_CENTS,
    });
  }
  const currentCents = await store.last_approved(body.sku);
  const direction = body.price_cents >= currentCents ? 1 : -1;
  const thisMove = movedBp(currentCents, body.price_cents);
  const [ok, moved, headroomBp, ttl, updateId] = await reserve(body.sku, thisMove);
  if (!ok) {
    return reply.code(409).send({
      error: 'change exceeds the per-window limit',
      current_price_cents: currentCents,
      headroom_bp: headroomBp,
      bound_cents: windowBound(currentCents, headroomBp, direction),
    });
  }
  const source = 'guardrail';
  await store.publish(body.sku, body.price_cents, body.reason, source, updateId);
  await r.hset(priceKey(body.sku), {
    price_cents: String(body.price_cents),
    source,
    updated_at: String(Math.floor(Date.now() / 1000)),
    update_id: updateId,
  });
  return reply.code(200).send({
    sku: body.sku,
    price_cents: body.price_cents,
    source,
    update_id: updateId,
    moved_bp: moved,
    headroom_bp: headroomBp,
    window_ends_in: ttl,
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
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	maxMoveBp    = 2000
	floorCents   = 50
	ceilingCents = 500000
)

// PriceStore is the Postgres row store (given): skus, published prices, audit and outbox rows.
type PriceStore struct{}

func (s *PriceStore) GetSKU(ctx context.Context, sku string) (bool, error) { return false, nil }

func (s *PriceStore) LastApproved(ctx context.Context, sku string) (int64, error) { return 0, nil }

func (s *PriceStore) Publish(ctx context.Context, sku string, priceCents int64, reason, source string) error {
	return nil
}

var (
	rdb   = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	store = &PriceStore{}
)

type PriceRequest struct {
	SKU        string \`json:"sku"\`
	PriceCents int64  \`json:"price_cents"\`
	Reason     string \`json:"reason"\`
}

func priceKey(sku string) string { return fmt.Sprintf("price:%s", sku) }

func movedBp(currentCents, priceCents int64) int64 {
	diff := priceCents - currentCents
	if diff < 0 {
		diff = -diff
	}
	if currentCents < 1 {
		currentCents = 1
	}
	return diff * 10000 / currentCents
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func postPrice(rw http.ResponseWriter, r *http.Request) {
	var body PriceRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft reads the window counter with a client-side GET and writes it back with
	// INCRBY, and it never lets the counter decide: each update is compared against the price on
	// disk, so ten parallel updates each pass and compound. The key has no window bucket and no
	// TTL, so the limit ratchets down forever, and neither the publish nor the price:{sku} cache
	// carries the id of the update that consumed the headroom.
	known, _ := store.GetSKU(r.Context(), body.SKU)
	if !known {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown sku"})
		return
	}
	if body.PriceCents < floorCents || body.PriceCents > ceilingCents {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]any{
			"error":         "price outside the absolute guardrails",
			"price_cents":   body.PriceCents,
			"floor_cents":   floorCents,
			"ceiling_cents": ceilingCents,
		})
		return
	}
	currentCents, _ := store.LastApproved(r.Context(), body.SKU)
	thisMove := movedBp(currentCents, body.PriceCents)
	if thisMove > maxMoveBp {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]any{
			"error":        "move exceeds the limit",
			"remaining_bp": maxMoveBp - thisMove,
		})
		return
	}
	spent, _ := rdb.Get(r.Context(), "guard:"+body.SKU).Int64()
	rdb.IncrBy(r.Context(), "guard:"+body.SKU, thisMove)
	source := "guardrail"
	_ = store.Publish(r.Context(), body.SKU, body.PriceCents, body.Reason, source)
	rdb.HSet(r.Context(), priceKey(body.SKU), map[string]any{
		"price_cents": body.PriceCents,
		"source":      source,
		"updated_at":  time.Now().Unix(),
	})
	writeJSON(rw, http.StatusOK, map[string]any{
		"sku":          body.SKU,
		"price_cents":  body.PriceCents,
		"remaining_bp": maxMoveBp - spent - thisMove,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/prices", postPrice)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	maxMoveBp     = 2000
	floorCents    = 50
	ceilingCents  = 500000
	windowSeconds = 3600
)

// PriceStore is the Postgres row store (given): skus, published prices, audit and outbox rows.
type PriceStore struct{}

func (s *PriceStore) GetSKU(ctx context.Context, sku string) (bool, error) { return false, nil }

func (s *PriceStore) LastApproved(ctx context.Context, sku string) (int64, error) { return 0, nil }

func (s *PriceStore) Publish(ctx context.Context, sku string, priceCents int64, reason, source, updateID string) error {
	return nil
}

var (
	rdb   = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	store = &PriceStore{}
)

// ARGV[1] = this update's move in bp   ARGV[2] = maxMoveBp   ARGV[3] = windowSeconds
var reserveScript = redis.NewScript(\`
local moved = tonumber(redis.call('HGET', KEYS[1], 'moved')) or 0
local this_move = tonumber(ARGV[1])
if moved + this_move > tonumber(ARGV[2]) then
  return {0, moved, tonumber(ARGV[2]) - moved, redis.call('TTL', KEYS[1])}
end
redis.call('HINCRBY', KEYS[1], 'moved', this_move)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {1, moved + this_move, tonumber(ARGV[2]) - moved - this_move, redis.call('TTL', KEYS[1])}
\`)

type PriceRequest struct {
	SKU        string \`json:"sku"\`
	PriceCents int64  \`json:"price_cents"\`
	Reason     string \`json:"reason"\`
}

func priceKey(sku string) string { return fmt.Sprintf("price:%s", sku) }

// windowBound is the furthest price the remaining headroom allows, clamped by floor and ceiling.
func windowBound(currentCents, headroomBp, direction int64) int64 {
	delta := currentCents * headroomBp / 10000
	bound := currentCents + direction*delta
	if bound < floorCents {
		return floorCents
	}
	if bound > ceilingCents {
		return ceilingCents
	}
	return bound
}

func guardKey(sku string, window int64) string { return fmt.Sprintf("guard:%s:%d", sku, window) }

func newUpdateID() string {
	var buf [16]byte
	_, _ = rand.Read(buf[:])
	return hex.EncodeToString(buf[:])
}

func movedBp(currentCents, priceCents int64) int64 {
	diff := priceCents - currentCents
	if diff < 0 {
		diff = -diff
	}
	if currentCents < 1 {
		currentCents = 1
	}
	return diff * 10000 / currentCents
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

type reservation struct {
	ok         bool
	moved      int64
	headroomBp int64
	ttl        int64
	updateID   string
}

// reserve consumes this move's headroom in the sku's hour window and mints the id that paid for it.
func reserve(ctx context.Context, sku string, thisMove int64) (reservation, error) {
	window := time.Now().Unix() / windowSeconds
	updateID := newUpdateID()
	values, err := reserveScript.Run(
		ctx,
		rdb,
		[]string{guardKey(sku, window)},
		thisMove,
		maxMoveBp,
		windowSeconds,
	).Int64Slice()
	if err != nil {
		return reservation{}, err
	}
	return reservation{
		ok:         values[0] == 1,
		moved:      values[1],
		headroomBp: values[2],
		ttl:        values[3],
		updateID:   updateID,
	}, nil
}

func postPrice(rw http.ResponseWriter, r *http.Request) {
	var body PriceRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	known, _ := store.GetSKU(r.Context(), body.SKU)
	if !known {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown sku"})
		return
	}
	if body.PriceCents < floorCents || body.PriceCents > ceilingCents {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]any{
			"error":         "price outside the absolute guardrails",
			"price_cents":   body.PriceCents,
			"floor_cents":   floorCents,
			"ceiling_cents": ceilingCents,
		})
		return
	}
	currentCents, _ := store.LastApproved(r.Context(), body.SKU)
	direction := int64(1)
	if body.PriceCents < currentCents {
		direction = -1
	}
	thisMove := movedBp(currentCents, body.PriceCents)
	res, err := reserve(r.Context(), body.SKU, thisMove)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "guard unavailable"})
		return
	}
	if !res.ok {
		writeJSON(rw, http.StatusConflict, map[string]any{
			"error":               "change exceeds the per-window limit",
			"current_price_cents": currentCents,
			"headroom_bp":         res.headroomBp,
			"bound_cents":         windowBound(currentCents, res.headroomBp, direction),
		})
		return
	}
	source := "guardrail"
	if err := store.Publish(r.Context(), body.SKU, body.PriceCents, body.Reason, source, res.updateID); err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "publish failed"})
		return
	}
	rdb.HSet(r.Context(), priceKey(body.SKU), map[string]any{
		"price_cents": body.PriceCents,
		"source":      source,
		"updated_at":  time.Now().Unix(),
		"update_id":   res.updateID,
	})
	writeJSON(rw, http.StatusOK, map[string]any{
		"sku":            body.SKU,
		"price_cents":    body.PriceCents,
		"source":         source,
		"update_id":      res.updateID,
		"moved_bp":       res.moved,
		"headroom_bp":    res.headroomBp,
		"window_ends_in": res.ttl,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/prices", postPrice)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `/** POST /v1/prices: a model-generated draft that checks each proposal against the price on disk. */
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class PriceRequest(sku: String, price_cents: Long, reason: String)

/** The price store (given): skus, published prices, audit and outbox rows. */
trait PriceStore {
  def get_sku(sku: String): Boolean
  def last_approved(sku: String): Long
  def publish(sku: String, priceCents: Long, reason: String, source: String): Unit
}

object PricingApi {
  implicit val system: ActorSystem = ActorSystem("priced")
  implicit val priceFormat: RootJsonFormat[PriceRequest] = jsonFormat3(PriceRequest)

  val MaxMoveBp = 2000L
  val FloorCents = 50L
  val CeilingCents = 500000L

  val jedis = new Jedis("redis", 6379)
  val store: PriceStore = new PriceStore {
    def get_sku(sku: String): Boolean = false
    def last_approved(sku: String): Long = 0L
    def publish(sku: String, priceCents: Long, reason: String, source: String): Unit = ()
  }

  def priceKey(sku: String): String = s"price:$sku"

  def movedBp(currentCents: Long, priceCents: Long): Long =
    math.abs(priceCents - currentCents) * 10000 / math.max(currentCents, 1L)

  val route: Route =
    path("v1" / "prices") {
      post {
        entity(as[PriceRequest]) { body =>
          // TODO: this draft reads the window counter with a client-side GET and writes it back
          // with INCRBY, and it never lets the counter decide: each update is compared against the
          // price on disk, so ten parallel updates each pass and compound. The key has no window
          // bucket and no TTL, so the limit ratchets down forever, and neither the publish nor the
          // price:{sku} cache carries the id of the update that consumed the headroom.
          if (!store.get_sku(body.sku)) {
            complete(StatusCodes.NotFound, """{"error":"unknown sku"}""")
          } else if (body.price_cents < FloorCents || body.price_cents > CeilingCents) {
            complete(
              StatusCodes.UnprocessableEntity,
              s"""{"error":"price outside the absolute guardrails","price_cents":\${body.price_cents},"floor_cents":\${FloorCents},"ceiling_cents":\${CeilingCents}}"""
            )
          } else {
            val currentCents = store.last_approved(body.sku)
            val thisMove = movedBp(currentCents, body.price_cents)
            if (thisMove > MaxMoveBp) {
              complete(
                StatusCodes.UnprocessableEntity,
                s"""{"error":"move exceeds the limit","remaining_bp":\${MaxMoveBp - thisMove}}"""
              )
            } else {
              val spent = Option(jedis.get(s"guard:\${body.sku}")).map(_.toLong).getOrElse(0L)
              jedis.incrBy(s"guard:\${body.sku}", thisMove)
              val source = "guardrail"
              store.publish(body.sku, body.price_cents, body.reason, source)
              val cache = new java.util.HashMap[String, String]()
              cache.put("price_cents", body.price_cents.toString)
              cache.put("source", source)
              cache.put("updated_at", (System.currentTimeMillis() / 1000).toString)
              jedis.hset(priceKey(body.sku), cache)
              complete(
                StatusCodes.OK,
                s"""{"sku":"\${body.sku}","price_cents":\${body.price_cents},"remaining_bp":\${MaxMoveBp - spent - thisMove}}"""
              )
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
      solution: `/** POST /v1/prices: reserve the sku's hour-window headroom, then publish what fits. */
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class PriceRequest(sku: String, price_cents: Long, reason: String)

/** The price store (given): skus, published prices, audit and outbox rows. */
trait PriceStore {
  def get_sku(sku: String): Boolean
  def last_approved(sku: String): Long
  def publish(sku: String, priceCents: Long, reason: String, source: String, updateId: String): Unit
}

/** What the window allowed: how much of it this move consumed and what is left. */
final case class Reservation(ok: Boolean, moved: Long, headroom_bp: Long, ttl: Long, update_id: String)

object PricingApi {
  implicit val system: ActorSystem = ActorSystem("priced")
  implicit val priceFormat: RootJsonFormat[PriceRequest] = jsonFormat3(PriceRequest)

  val MaxMoveBp = 2000L
  val FloorCents = 50L
  val CeilingCents = 500000L
  val WindowSeconds = 3600L

  val jedis = new Jedis("redis", 6379)
  val store: PriceStore = new PriceStore {
    def get_sku(sku: String): Boolean = false
    def last_approved(sku: String): Long = 0L
    def publish(sku: String, priceCents: Long, reason: String, source: String, updateId: String): Unit = ()
  }

  // ARGV[1] = this update's move in bp   ARGV[2] = MaxMoveBp   ARGV[3] = WindowSeconds
  val ReserveLua =
    """
      |local moved = tonumber(redis.call('HGET', KEYS[1], 'moved')) or 0
      |local this_move = tonumber(ARGV[1])
      |if moved + this_move > tonumber(ARGV[2]) then
      |  return {0, moved, tonumber(ARGV[2]) - moved, redis.call('TTL', KEYS[1])}
      |end
      |redis.call('HINCRBY', KEYS[1], 'moved', this_move)
      |if redis.call('TTL', KEYS[1]) < 0 then
      |  redis.call('EXPIRE', KEYS[1], ARGV[3])
      |end
      |return {1, moved + this_move, tonumber(ARGV[2]) - moved - this_move, redis.call('TTL', KEYS[1])}
      |""".stripMargin

  def priceKey(sku: String): String = s"price:$sku"

  /** The furthest price the remaining headroom allows, clamped by floor and ceiling. */
  def windowBound(currentCents: Long, headroomBp: Long, direction: Long): Long = {
    val delta = currentCents * headroomBp / 10000
    math.min(math.max(currentCents + direction * delta, FloorCents), CeilingCents)
  }

  def guardKey(sku: String, window: Long): String = s"guard:$sku:$window"

  def movedBp(currentCents: Long, priceCents: Long): Long =
    math.abs(priceCents - currentCents) * 10000 / math.max(currentCents, 1L)

  /** Consumes this move's headroom in the sku's hour window and mints the id that paid for it. */
  def reserve(sku: String, thisMove: Long): Reservation = {
    val window = System.currentTimeMillis() / 1000 / WindowSeconds
    val updateId = UUID.randomUUID().toString
    val result = jedis
      .eval(
        ReserveLua,
        1,
        guardKey(sku, window),
        thisMove.toString,
        MaxMoveBp.toString,
        WindowSeconds.toString
      )
      .asInstanceOf[java.util.List[Long]]
    Reservation(result.get(0) == 1L, result.get(1), result.get(2), result.get(3), updateId)
  }

  val route: Route =
    path("v1" / "prices") {
      post {
        entity(as[PriceRequest]) { body =>
          if (!store.get_sku(body.sku)) {
            complete(StatusCodes.NotFound, """{"error":"unknown sku"}""")
          } else if (body.price_cents < FloorCents || body.price_cents > CeilingCents) {
            complete(
              StatusCodes.UnprocessableEntity,
              s"""{"error":"price outside the absolute guardrails","price_cents":\${body.price_cents},"floor_cents":\${FloorCents},"ceiling_cents":\${CeilingCents}}"""
            )
          } else {
            val currentCents = store.last_approved(body.sku)
            val direction = if (body.price_cents >= currentCents) 1L else -1L
            val thisMove = movedBp(currentCents, body.price_cents)
            val Reservation(ok, moved, headroomBp, ttl, updateId) = reserve(body.sku, thisMove)
            if (!ok) {
              val boundCents = windowBound(currentCents, headroomBp, direction)
              complete(
                StatusCodes.Conflict,
                s"""{"error":"change exceeds the per-window limit","current_price_cents":$currentCents,"headroom_bp":$headroomBp,"bound_cents":$boundCents}"""
              )
            } else {
              val source = "guardrail"
              store.publish(body.sku, body.price_cents, body.reason, source, updateId)
              val cache = new java.util.HashMap[String, String]()
              cache.put("price_cents", body.price_cents.toString)
              cache.put("source", source)
              cache.put("updated_at", (System.currentTimeMillis() / 1000).toString)
              cache.put("update_id", updateId)
              jedis.hset(priceKey(body.sku), cache)
              complete(
                StatusCodes.OK,
                s"""{"sku":"\${body.sku}","price_cents":\${body.price_cents},"source":"$source","update_id":"$updateId","moved_bp":$moved,"headroom_bp":$headroomBp,"window_ends_in":$ttl}"""
              )
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
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

using json = nlohmann::json;

constexpr long long kMaxMoveBp = 2000;
constexpr long long kFloorCents = 50;
constexpr long long kCeilingCents = 500000;

// The price store (given): skus, published prices, audit and outbox rows.
struct PriceStore {
  bool get_sku(const std::string& sku);
  long long last_approved(const std::string& sku);
  void publish(const std::string& sku, long long price_cents, const std::string& reason, const std::string& source);
};

PriceStore store;

std::string price_key(const std::string& sku) { return "price:" + sku; }

long long now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

long long moved_bp(long long current_cents, long long price_cents) {
  const long long diff = price_cents > current_cents ? price_cents - current_cents : current_cents - price_cents;
  const long long base = current_cents < 1 ? 1 : current_cents;
  return diff * 10000 / base;
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/prices", [&redis](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft reads the window counter with a client-side GET and writes it back with
    // INCRBY, and it never lets the counter decide: each update is compared against the price on
    // disk, so ten parallel updates each pass and compound. The key has no window bucket and no
    // TTL, so the limit ratchets down forever, and neither the publish nor the price:{sku} cache
    // carries the id of the update that consumed the headroom.
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto sku = body.value("sku", std::string());
    const auto price_cents = body.value("price_cents", 0LL);
    const auto reason = body.value("reason", std::string());
    if (!store.get_sku(sku)) {
      res.status = 404;
      res.set_content(R"({"error":"unknown sku"})", "application/json");
      return;
    }
    if (price_cents < kFloorCents || price_cents > kCeilingCents) {
      res.status = 422;
      res.set_content(
          json{{"error", "price outside the absolute guardrails"},
               {"price_cents", price_cents},
               {"floor_cents", kFloorCents},
               {"ceiling_cents", kCeilingCents}}
              .dump(),
          "application/json");
      return;
    }
    const auto current_cents = store.last_approved(sku);
    const auto this_move = moved_bp(current_cents, price_cents);
    if (this_move > kMaxMoveBp) {
      res.status = 422;
      res.set_content(
          json{{"error", "move exceeds the limit"}, {"remaining_bp", kMaxMoveBp - this_move}}.dump(),
          "application/json");
      return;
    }
    const auto raw_spent = redis.get("guard:" + sku);
    const long long spent = raw_spent ? std::stoll(*raw_spent) : 0;
    redis.incrby("guard:" + sku, this_move);
    const std::string source = "guardrail";
    store.publish(sku, price_cents, reason, source);
    redis.hset(
        price_key(sku),
        {{"price_cents", std::to_string(price_cents)},
         {"source", source},
         {"updated_at", std::to_string(now_seconds())}});
    res.status = 200;
    res.set_content(
        json{{"sku", sku}, {"price_cents", price_cents}, {"remaining_bp", kMaxMoveBp - spent - this_move}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <random>
#include <sstream>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kMaxMoveBp = 2000;
constexpr long long kFloorCents = 50;
constexpr long long kCeilingCents = 500000;
constexpr long long kWindowSeconds = 3600;

// ARGV[1] = this update's move in bp   ARGV[2] = kMaxMoveBp   ARGV[3] = kWindowSeconds
const char* kReserveLua = R"LUA(
local moved = tonumber(redis.call('HGET', KEYS[1], 'moved')) or 0
local this_move = tonumber(ARGV[1])
if moved + this_move > tonumber(ARGV[2]) then
  return {0, moved, tonumber(ARGV[2]) - moved, redis.call('TTL', KEYS[1])}
end
redis.call('HINCRBY', KEYS[1], 'moved', this_move)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {1, moved + this_move, tonumber(ARGV[2]) - moved - this_move, redis.call('TTL', KEYS[1])}
)LUA";

// The price store (given): skus, published prices, audit and outbox rows.
struct PriceStore {
  bool get_sku(const std::string& sku);
  long long last_approved(const std::string& sku);
  void publish(
      const std::string& sku,
      long long price_cents,
      const std::string& reason,
      const std::string& source,
      const std::string& update_id);
};

PriceStore store;

// What the window allowed: how much of it this move consumed and what is left.
struct Reservation {
  bool ok;
  long long moved;
  long long headroom_bp;
  long long ttl;
  std::string update_id;
};

std::string price_key(const std::string& sku) { return "price:" + sku; }

// The furthest price the remaining headroom allows, clamped by floor and ceiling.
long long window_bound(long long current_cents, long long headroom_bp, long long direction) {
  const long long delta = current_cents * headroom_bp / 10000;
  const long long bound = current_cents + direction * delta;
  return std::min(std::max(bound, kFloorCents), kCeilingCents);
}

std::string guard_key(const std::string& sku, long long window) {
  return "guard:" + sku + ":" + std::to_string(window);
}

std::string new_update_id() {
  static std::mt19937_64 generator(std::random_device{}());
  std::uniform_int_distribution<unsigned long long> dist;
  std::ostringstream out;
  out << std::hex << dist(generator) << dist(generator);
  return out.str();
}

long long now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

long long moved_bp(long long current_cents, long long price_cents) {
  const long long diff = price_cents > current_cents ? price_cents - current_cents : current_cents - price_cents;
  const long long base = current_cents < 1 ? 1 : current_cents;
  return diff * 10000 / base;
}

// Consumes this move's headroom in the sku's hour window and mints the id that paid for it.
Reservation reserve(sw::redis::Redis& redis, const std::string& sku, long long this_move) {
  const auto window = now_seconds() / kWindowSeconds;
  const auto update_id = new_update_id();
  const auto result = redis.eval<std::vector<long long>>(
      kReserveLua,
      {guard_key(sku, window)},
      {this_move, kMaxMoveBp, kWindowSeconds});
  return {result[0] == 1, result[1], result[2], result[3], update_id};
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/prices", [&redis](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto sku = body.value("sku", std::string());
    const auto price_cents = body.value("price_cents", 0LL);
    const auto reason = body.value("reason", std::string());
    if (!store.get_sku(sku)) {
      res.status = 404;
      res.set_content(R"({"error":"unknown sku"})", "application/json");
      return;
    }
    if (price_cents < kFloorCents || price_cents > kCeilingCents) {
      res.status = 422;
      res.set_content(
          json{{"error", "price outside the absolute guardrails"},
               {"price_cents", price_cents},
               {"floor_cents", kFloorCents},
               {"ceiling_cents", kCeilingCents}}
              .dump(),
          "application/json");
      return;
    }
    const auto current_cents = store.last_approved(sku);
    const auto direction = price_cents >= current_cents ? 1LL : -1LL;
    const auto this_move = moved_bp(current_cents, price_cents);
    const auto reservation = reserve(redis, sku, this_move);
    if (!reservation.ok) {
      const auto bound_cents = window_bound(current_cents, reservation.headroom_bp, direction);
      res.status = 409;
      res.set_content(
          json{{"error", "change exceeds the per-window limit"},
               {"current_price_cents", current_cents},
               {"headroom_bp", reservation.headroom_bp},
               {"bound_cents", bound_cents}}
              .dump(),
          "application/json");
      return;
    }
    const std::string source = "guardrail";
    store.publish(sku, price_cents, reason, source, reservation.update_id);
    redis.hset(
        price_key(sku),
        {{"price_cents", std::to_string(price_cents)},
         {"source", source},
         {"updated_at", std::to_string(now_seconds())},
         {"update_id", reservation.update_id}});
    res.status = 200;
    res.set_content(
        json{{"sku", sku},
             {"price_cents", price_cents},
             {"source", source},
             {"update_id", reservation.update_id},
             {"moved_bp", reservation.moved},
             {"headroom_bp", reservation.headroom_bp},
             {"window_ends_in", reservation.ttl}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question behind this step is where shared state lives and what a refusal owes the caller. A per-update bound is not a window budget: ten 15% updates are each legal and together they are a 400% move, so the check and the consumption have to be one atomic step against an accumulator that belongs to a sku's hour — keyed, expired and read inside the same script. The draft's two round trips pass every serial test and fail exactly when the service is busy, which is when the limit matters; its key without a TTL turns one busy hour into a permanent ceiling on that sku, which is why operations has to reason about the window and not about individual updates. Traceability is the part candidates forget: an \`update_id\` minted with the reservation, carried into \`store.publish\` and mirrored into the \`price:{sku}\` cache is what lets someone answer "why is this 4999?" three weeks later, and the 409 body is what lets the caller retry with a price that fits instead of guessing the bound. Real systems add per-sku recipes, refund headroom when the store rejects a publish, and gliding windows for the skus that move constantly.`,
};
