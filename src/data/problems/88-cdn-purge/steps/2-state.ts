import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis per-path dedupe and a purge budget',
  concept: 'redis',
  file: 'state',
  focus: ['purge', 'redis', 'tenant'],
  task: `## Task

**Review premise.** The starter dedupes with \`EXISTS\` and marks paths afterwards, keeps the
budget counter under a key that never expires, and answers a bare \`429\`. It works in a demo
where requests arrive one at a time. Review it like the engineer who owns the Redis keyspace, fix
it, and prove the fix with the checks below.

Every purge goes through \`reserve(tenant, domain, paths)\`, which runs **one** Lua script
(\`RESERVE_LUA\`) with \`EVAL\`:

- **Per-path dedupe.** For each path, the key \`purge:seen:{tenant}:{domain}:{path}\` is set with
  \`SET … NX EX DEDUPE_TTL_S\`, where \`DEDUPE_TTL_S\` is **600** (a ten-minute window). A path whose
  key already exists is a duplicate: it is reported back and is **not** purged again.
- **Per-domain budget.** \`purge:budget:{domain}:{window}\` counts the paths charged in this
  window, where \`window = now // WINDOW_S\` and \`WINDOW_S\` is **300**. The counter is incremented
  by the number of **new** paths inside the same script, and gets \`EXPIRE WINDOW_S\` on first write
  so it is born with the window and dies with it. \`BUDGET_MAX\` is **1000** paths per window.
- **One script, one atomic step.** A read-then-write pair from the application (\`EXISTS\`/number,
  then \`SET\`, then a client-side \`INCRBY\`) has a window between the halves: two purges from the
  same double-submitted deploy both see the path as new and both charge the budget. The write has
  to be inside the script, next to the check.
- **The reply is positional**: allowed, remaining, TTL, how many paths are new, the new paths, then
  the duplicates.

The handler reserves **before** it calls the provider:

- Budget exhausted → **429** with \`Retry-After\` (the remaining TTL of the window key, at least 1)
  and \`X-Purge-Budget-Remaining: 0\`, and the provider is never called.
- Otherwise the provider receives only the **new** paths, so a duplicate purge submits an empty
  batch instead of hammering the CDN again.

:::widget token-bucket {"rate": 3, "burst": 1000}

**Failure mode the checks target.** The draft checks dedupe with a client-side \`EXISTS\`, then
writes later — a double-submitted deploy purges twice and burns budget for work it did not need.
Its budget key is \`purge:budget:{domain}\` with no window bucket and no TTL, so the counter only
ever grows: after 1000 paths in the domain's lifetime, every purge is rejected forever, and no
operator sees why. And the bare \`429\` leaves the client to retry immediately, which is how a
budget rejects a deploy into a retry storm.`,
  sequence: {
    participants: ['Purge API', 'Redis', 'CDN provider'],
    messages: [
      {from: 'Purge API', to: 'Purge API', label: 'window = now // 300 · keys for each path', kind: 'sync'},
      {from: 'Purge API', to: 'Redis', label: 'EVAL reserve (budget, purge:seen:* · paths)', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'EXISTS each path · charge budget · SET NX EX 600', kind: 'sync'},
      {from: 'Redis', to: 'Purge API', label: '[allowed, remaining, ttl, new…, duplicates…]', kind: 'reply'},
      {from: 'Purge API', to: 'Purge API', label: 'allowed = 0 → 429 Retry-After', kind: 'sync'},
      {from: 'Purge API', to: 'CDN provider', label: 'SubmitPurge(purge_id, domain, new paths)', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'atomic-reserve',
      title: 'Dedupe and budget live in one server-side script',
      detail:
        'One `RESERVE_LUA` runs through `EVAL` and marks each path with `SET … NX EX` inside the script. The draft asks Redis `EXISTS` first and writes later, so two concurrent purges both see the path as new.',
      match: {
        python: {all: [/RESERVE_LUA/, /'NX'/, /\.eval\(/], none: [/\.exists\(/]},
        typescript: {all: [/RESERVE_LUA/, /'NX'/, /\.eval\(/], none: [/\.exists\(/]},
        go: {all: [/reserveLua/, /'NX'/, /\.Eval\(/], none: [/\.Exists\(/]},
        scala: {all: [/reserveLua/, /'NX'/, /\.eval\(/], none: [/\.exists\(/]},
        cpp: {all: [/kReserveLua/, /'NX'/, /eval</], none: [/exists\(/]},
      },
    },
    {
      id: 'window-bucket',
      title: 'The budget key is bucketed by window and expires with it',
      detail:
        'The budget key carries the window (`purge:budget:{domain}:{window}` via `budget_key`) and the script sets `EXPIRE WINDOW_S` on first write, so the counter resets per window. The draft uses one un-bucketed, immortal key, so the domain’s budget only ever shrinks.',
      match: {
        python: {all: [/purge:budget/, /WINDOW_S/, /EXPIRE/, /budget_key\(/]},
        typescript: {all: [/purge:budget/, /WINDOW_S/, /EXPIRE/, /budgetKey\(/]},
        go: {all: [/purge:budget/, /windowS/, /EXPIRE/, /budgetKey\(/]},
        scala: {all: [/purge:budget/, /WindowS/, /EXPIRE/, /budgetKey\(/]},
        cpp: {all: [/purge:budget/, /kWindowS/, /EXPIRE/, /budgetKey\(/]},
      },
    },
    {
      id: 'dedupe-window',
      title: 'Dedupe holds for ten minutes and only new paths are purged',
      detail:
        '`DEDUPE_TTL_S` = 600 gives each path a ten-minute window, and the reservation returns only `new_paths` to the provider while reporting the `duplicates`. The draft writes dedupe keys with no TTL at all, so a path purged once can never be purged again.',
      match: {
        python: {all: [/DEDUPE_TTL_S/, /new_paths/, /duplicates/]},
        typescript: {all: [/DEDUPE_TTL_S/, /newPaths/, /duplicates/]},
        go: {all: [/dedupeTtlS/, /NewPaths/, /duplicates/]},
        scala: {all: [/DedupeTtlS/, /newPaths/, /duplicates/]},
        cpp: {all: [/kDedupeTtlS/, /new_paths/, /duplicates/]},
      },
    },
    {
      id: 'budget-429',
      title: 'An exhausted budget answers 429 with Retry-After before the provider',
      detail:
        '`BUDGET_MAX` paths per window; when the reservation is refused the handler answers **429** with `Retry-After` (the window’s remaining TTL) and `X-Purge-Budget-Remaining`, and never calls the provider. The draft sends a bare 429 and charges after the fact.',
      match: {
        python: {all: [/BUDGET_MAX/, /\b429\b/, /Retry-After/, /X-Purge-Budget-Remaining/]},
        typescript: {all: [/BUDGET_MAX/, /\b429\b/, /Retry-After/, /X-Purge-Budget-Remaining/]},
        go: {all: [/budgetMax/, /StatusTooManyRequests/, /Retry-After/, /X-Purge-Budget-Remaining/]},
        scala: {
          all: [/BudgetMax/, /StatusCodes\.TooManyRequests/, /Retry-After/, /X-Purge-Budget-Remaining/],
        },
        cpp: {all: [/kBudgetMax/, /\b429\b/, /Retry-After/, /X-Purge-Budget-Remaining/]},
      },
    },
    {
      id: 'reserve-before-submit',
      title: 'The reservation settles before the provider is called',
      detail:
        'The reserve runs first, the provider sees only the paths the reservation accepted, and the budget is never adjusted from the application. The draft charges the counter from the client after deciding, which is a second place for the budget and the truth to disagree.',
      match: {
        python: {
          all: [/providers\.SubmitPurge\(/],
          order: [/\breserve\(/, /providers\.SubmitPurge\(/],
          none: [/\.incrby\(/],
        },
        typescript: {
          all: [/providers\.SubmitPurge\(/],
          order: [/\breserve\(/, /providers\.SubmitPurge\(/],
          none: [/\.incrby\(/],
        },
        go: {
          all: [/provider\.SubmitPurge\(/],
          order: [/\breserve\(/, /provider\.SubmitPurge\(/],
          none: [/\.IncrBy\(/],
        },
        scala: {
          all: [/\.submitPurge\(/],
          order: [/\breserve\(/, /\.submitPurge\(/],
          none: [/\.incrBy\(/],
        },
        cpp: {
          all: [/provider\.SubmitPurge\(/],
          order: [/\breserve\(/, /provider\.SubmitPurge\(/],
          none: [/incrby\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

BUDGET_MAX = 1000


class PurgeRequest(BaseModel):
    domain: str
    paths: list[str]


class PurgeProvider:
    def SubmitPurge(self, purge_id: str, domain: str, paths: list[str]) -> None:
        """Hand the batch to the CDN provider."""
        raise NotImplementedError


providers = PurgeProvider()


def budget_key(domain: str) -> str:
    return f"purge:budget:{domain}"


def dedupe_key(tenant: str, domain: str, path: str) -> str:
    return f"purge:seen:{tenant}:{domain}:{path}"


def reserve(tenant: str, domain: str, paths: list[str]) -> dict:
    # TODO: this draft checks dedupe with a client-side EXISTS and writes afterwards, so a
    # double-submitted deploy purges twice; the budget key has no window bucket and no TTL, so the
    # counter never resets; and the 429 carries no Retry-After. Review all three: one atomic EVAL
    # that checks and writes together, a bucketed budget key that expires with its window, and a
    # 429 that tells the client when to come back.
    seen = [path for path in paths if r.exists(dedupe_key(tenant, domain, path))]
    fresh = [path for path in paths if path not in seen]
    for path in fresh:
        r.set(dedupe_key(tenant, domain, path), "1")
    used = int(r.get(budget_key(domain)) or 0)
    if used + len(fresh) > BUDGET_MAX:
        return {"allowed": False, "remaining": 0, "ttl": 0, "new_paths": [], "duplicates": seen}
    r.incrby(budget_key(domain), len(fresh))
    return {
        "allowed": True,
        "remaining": BUDGET_MAX - used - len(fresh),
        "ttl": 0,
        "new_paths": fresh,
        "duplicates": seen,
    }


@app.post("/v1/purges")
def create_purge(body: PurgeRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    result = reserve(tenant, body.domain, body.paths)
    if not result["allowed"]:
        raise HTTPException(status_code=429, detail="domain purge budget exhausted")
    providers.SubmitPurge(f"purge-{body.domain}", body.domain, result["new_paths"])
    return {"domain": body.domain, "submitted": result["new_paths"], "remaining": result["remaining"]}
`,
      solution: `import time

import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

DEDUPE_TTL_S = 600
WINDOW_S = 300
BUDGET_MAX = 1000

RESERVE_LUA = """
-- KEYS[1] is the domain's window budget; KEYS[2..] are the per-path dedupe keys.
-- ARGV[1] dedupe ttl, ARGV[2] budget per window, ARGV[3] window ttl, ARGV[4..] the paths.
local dedupe_ttl = tonumber(ARGV[1])
local budget_max = tonumber(ARGV[2])
local window_ttl = tonumber(ARGV[3])
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local new_paths = {}
local duplicates = {}
for i = 2, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 0 then
    new_paths[#new_paths + 1] = ARGV[i + 2]
  else
    duplicates[#duplicates + 1] = ARGV[i + 2]
  end
end
local allowed = 1
local remaining = budget_max - used - #new_paths
if used + #new_paths > budget_max then
  allowed = 0
  remaining = math.max(budget_max - used, 0)
else
  for i = 1, #new_paths do
    redis.call('SET', KEYS[i + 1], '1', 'NX', 'EX', dedupe_ttl)
  end
  redis.call('INCRBY', KEYS[1], #new_paths)
  if redis.call('TTL', KEYS[1]) < 0 then
    redis.call('EXPIRE', KEYS[1], window_ttl)
  end
end
-- Positional reply: allowed, remaining, ttl, how many paths are new, the new paths, then the
-- duplicates.
local reply = {allowed, remaining, redis.call('TTL', KEYS[1]), #new_paths}
for i = 1, #new_paths do reply[#reply + 1] = new_paths[i] end
for i = 1, #duplicates do reply[#reply + 1] = duplicates[i] end
return reply
"""


class PurgeRequest(BaseModel):
    domain: str
    paths: list[str]


class PurgeProvider:
    def SubmitPurge(self, purge_id: str, domain: str, paths: list[str]) -> None:
        """Hand the batch to the CDN provider."""
        raise NotImplementedError


providers = PurgeProvider()


def budget_key(domain: str, window: int) -> str:
    return f"purge:budget:{domain}:{window}"


def dedupe_key(tenant: str, domain: str, path: str) -> str:
    return f"purge:seen:{tenant}:{domain}:{path}"


def reserve(tenant: str, domain: str, paths: list[str]) -> dict:
    """Dedupe the paths and charge the domain's window budget in one atomic script."""
    window = int(time.time()) // WINDOW_S
    keys = [budget_key(domain, window)] + [dedupe_key(tenant, domain, path) for path in paths]
    reply = r.eval(RESERVE_LUA, len(keys), *keys, DEDUPE_TTL_S, BUDGET_MAX, WINDOW_S, *paths)
    allowed, remaining, ttl, new_count = (int(value) for value in reply[:4])
    new_paths = list(reply[4 : 4 + new_count])
    return {
        "allowed": allowed == 1,
        "remaining": remaining,
        "ttl": ttl,
        "new_paths": new_paths,
        "duplicates": list(reply[4 + new_count :]),
    }


@app.post("/v1/purges")
def create_purge(body: PurgeRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    result = reserve(tenant, body.domain, body.paths)
    if not result["allowed"]:
        retry_after = max(result["ttl"], 1)
        raise HTTPException(
            status_code=429,
            detail="domain purge budget exhausted",
            headers={"Retry-After": str(retry_after), "X-Purge-Budget-Remaining": "0"},
        )
    if result["new_paths"]:
        providers.SubmitPurge(f"purge-{body.domain}", body.domain, result["new_paths"])
    return {
        "domain": body.domain,
        "submitted": result["new_paths"],
        "duplicates": result["duplicates"],
        "remaining": result["remaining"],
    }
`,
    },
    typescript: {
      starter: `/** Purge intake: a model-generated draft that reads before it writes and never expires its budget. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const BUDGET_MAX = 1000;

interface PurgeBody {
  domain: string;
  paths: string[];
}

const providers = {
  async SubmitPurge(purgeId: string, domain: string, paths: string[]): Promise<void> {
    throw new Error(\`not implemented: \${domain} \${paths.length} paths for \${purgeId}\`);
  },
};

function budgetKey(domain: string): string {
  return \`purge:budget:\${domain}\`;
}

function dedupeKey(tenant: string, domain: string, path: string): string {
  return \`purge:seen:\${tenant}:\${domain}:\${path}\`;
}

app.post('/v1/purges', async (request, reply) => {
  // TODO: this draft checks dedupe with a client-side EXISTS and writes afterwards, so a
  // double-submitted deploy purges twice; the budget key has no window bucket and no TTL, so the
  // counter never resets; and the 429 carries no Retry-After. Review all three: one atomic EVAL
  // that checks and writes together, a bucketed budget key that expires with its window, and a
  // 429 that tells the client when to come back.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as PurgeBody;
  const seen: string[] = [];
  const fresh: string[] = [];
  for (const path of body.paths) {
    if (await r.exists(dedupeKey(tenant, body.domain, path))) seen.push(path);
    else fresh.push(path);
  }
  for (const path of fresh) await r.set(dedupeKey(tenant, body.domain, path), '1');
  const used = Number((await r.get(budgetKey(body.domain))) ?? 0);
  if (used + fresh.length > BUDGET_MAX) return reply.code(429).send({error: 'domain purge budget exhausted'});
  await r.incrby(budgetKey(body.domain), fresh.length);
  await providers.SubmitPurge(\`purge-\${body.domain}\`, body.domain, fresh);
  return reply.code(202).send({domain: body.domain, submitted: fresh, remaining: BUDGET_MAX - used - fresh.length});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Purge intake: per-path dedupe and a per-domain window budget in one atomic script. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const DEDUPE_TTL_S = 600;
const WINDOW_S = 300;
const BUDGET_MAX = 1000;

const RESERVE_LUA = \`
-- KEYS[1] is the domain's window budget; KEYS[2..] are the per-path dedupe keys.
-- ARGV[1] dedupe ttl, ARGV[2] budget per window, ARGV[3] window ttl, ARGV[4..] the paths.
local dedupe_ttl = tonumber(ARGV[1])
local budget_max = tonumber(ARGV[2])
local window_ttl = tonumber(ARGV[3])
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local new_paths = {}
local duplicates = {}
for i = 2, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 0 then
    new_paths[#new_paths + 1] = ARGV[i + 2]
  else
    duplicates[#duplicates + 1] = ARGV[i + 2]
  end
end
local allowed = 1
local remaining = budget_max - used - #new_paths
if used + #new_paths > budget_max then
  allowed = 0
  remaining = math.max(budget_max - used, 0)
else
  for i = 1, #new_paths do
    redis.call('SET', KEYS[i + 1], '1', 'NX', 'EX', dedupe_ttl)
  end
  redis.call('INCRBY', KEYS[1], #new_paths)
  if redis.call('TTL', KEYS[1]) < 0 then
    redis.call('EXPIRE', KEYS[1], window_ttl)
  end
end
-- Positional reply: allowed, remaining, ttl, how many paths are new, the new paths, then the
-- duplicates.
local reply = {allowed, remaining, redis.call('TTL', KEYS[1]), #new_paths}
for i = 1, #new_paths do reply[#reply + 1] = new_paths[i] end
for i = 1, #duplicates do reply[#reply + 1] = duplicates[i] end
return reply
\`;

interface PurgeBody {
  domain: string;
  paths: string[];
}

interface Reservation {
  allowed: boolean;
  remaining: number;
  ttl: number;
  newPaths: string[];
  duplicates: string[];
}

const providers = {
  async SubmitPurge(purgeId: string, domain: string, paths: string[]): Promise<void> {
    throw new Error(\`not implemented: \${domain} \${paths.length} paths for \${purgeId}\`);
  },
};

function budgetKey(domain: string, window: number): string {
  return \`purge:budget:\${domain}:\${window}\`;
}

function dedupeKey(tenant: string, domain: string, path: string): string {
  return \`purge:seen:\${tenant}:\${domain}:\${path}\`;
}

async function reserve(tenant: string, domain: string, paths: string[]): Promise<Reservation> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const keys = [budgetKey(domain, window)];
  for (const path of paths) keys.push(dedupeKey(tenant, domain, path));
  const reply = (await r.eval(
    RESERVE_LUA,
    keys.length,
    ...keys,
    String(DEDUPE_TTL_S),
    String(BUDGET_MAX),
    String(WINDOW_S),
    ...paths,
  )) as string[];
  const newCount = Number(reply[3]);
  return {
    allowed: Number(reply[0]) === 1,
    remaining: Number(reply[1]),
    ttl: Number(reply[2]),
    newPaths: reply.slice(4, 4 + newCount),
    duplicates: reply.slice(4 + newCount),
  };
}

app.post('/v1/purges', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as PurgeBody;
  const reservation = await reserve(tenant, body.domain, body.paths);
  if (!reservation.allowed)
    return reply
      .code(429)
      .header('Retry-After', String(Math.max(reservation.ttl, 1)))
      .header('X-Purge-Budget-Remaining', '0')
      .send({error: 'domain purge budget exhausted'});
  if (reservation.newPaths.length > 0)
    await providers.SubmitPurge(\`purge-\${body.domain}\`, body.domain, reservation.newPaths);
  return reply.code(202).send({
    domain: body.domain,
    submitted: reservation.newPaths,
    duplicates: reservation.duplicates,
    remaining: reservation.remaining,
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

	"github.com/redis/go-redis/v9"
)

const budgetMax = 1000

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type PurgeRequest struct {
	Domain string   \`json:"domain"\`
	Paths  []string \`json:"paths"\`
}

type PurgeProvider struct{}

func (p *PurgeProvider) SubmitPurge(ctx context.Context, purgeID, domain string, paths []string) error {
	return nil
}

var provider = &PurgeProvider{}

func budgetKey(domain string) string { return "purge:budget:" + domain }

func dedupeKey(tenant, domain, path string) string {
	return "purge:seen:" + tenant + ":" + domain + ":" + path
}

type Reservation struct {
	Allowed    bool
	Remaining  int
	TTL        int
	NewPaths   []string
	Duplicates []string
}

func reserve(ctx context.Context, tenant, domain string, paths []string) (*Reservation, error) {
	// TODO: this draft checks dedupe with a client-side EXISTS and writes afterwards, so a
	// double-submitted deploy purges twice; the budget key has no window bucket and no TTL, so the
	// counter never resets; and the 429 carries no Retry-After. Review all three: one atomic EVAL
	// that checks and writes together, a bucketed budget key that expires with its window, and a
	// 429 that tells the client when to come back.
	reservation := &Reservation{}
	for _, path := range paths {
		exists, err := rdb.Exists(ctx, dedupeKey(tenant, domain, path)).Result()
		if err != nil {
			return nil, err
		}
		if exists > 0 {
			reservation.Duplicates = append(reservation.Duplicates, path)
		} else {
			reservation.NewPaths = append(reservation.NewPaths, path)
		}
	}
	for _, path := range reservation.NewPaths {
		if err := rdb.Set(ctx, dedupeKey(tenant, domain, path), "1", 0).Err(); err != nil {
			return nil, err
		}
	}
	used, err := rdb.Get(ctx, budgetKey(domain)).Int()
	if err != nil {
		used = 0
	}
	if used+len(reservation.NewPaths) > budgetMax {
		reservation.Allowed = false
		reservation.NewPaths = nil
		return reservation, nil
	}
	rdb.IncrBy(ctx, budgetKey(domain), int64(len(reservation.NewPaths)))
	reservation.Allowed = true
	reservation.Remaining = budgetMax - used - len(reservation.NewPaths)
	return reservation, nil
}

func createPurge(rw http.ResponseWriter, r *http.Request) {
	var body PurgeRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	reservation, err := reserve(r.Context(), r.Header.Get("X-Tenant-Id"), body.Domain, body.Paths)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if !reservation.Allowed {
		writeJSON(rw, http.StatusTooManyRequests, map[string]string{"error": "domain purge budget exhausted"})
		return
	}
	_ = provider.SubmitPurge(r.Context(), "purge-"+body.Domain, body.Domain, reservation.NewPaths)
	writeJSON(rw, http.StatusAccepted, map[string]any{
		"domain":    body.Domain,
		"submitted": reservation.NewPaths,
		"remaining": reservation.Remaining,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/purges", createPurge)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	dedupeTtlS = 600
	windowS    = 300
	budgetMax  = 1000
)

// reserveLua dedupes the paths and charges the domain's window budget in one atomic step.
const reserveLua = \`
-- KEYS[1] is the domain's window budget; KEYS[2..] are the per-path dedupe keys.
-- ARGV[1] dedupe ttl, ARGV[2] budget per window, ARGV[3] window ttl, ARGV[4..] the paths.
local dedupe_ttl = tonumber(ARGV[1])
local budget_max = tonumber(ARGV[2])
local window_ttl = tonumber(ARGV[3])
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local new_paths = {}
local duplicates = {}
for i = 2, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 0 then
    new_paths[#new_paths + 1] = ARGV[i + 2]
  else
    duplicates[#duplicates + 1] = ARGV[i + 2]
  end
end
local allowed = 1
local remaining = budget_max - used - #new_paths
if used + #new_paths > budget_max then
  allowed = 0
  remaining = math.max(budget_max - used, 0)
else
  for i = 1, #new_paths do
    redis.call('SET', KEYS[i + 1], '1', 'NX', 'EX', dedupe_ttl)
  end
  redis.call('INCRBY', KEYS[1], #new_paths)
  if redis.call('TTL', KEYS[1]) < 0 then
    redis.call('EXPIRE', KEYS[1], window_ttl)
  end
end
-- Positional reply: allowed, remaining, ttl, how many paths are new, the new paths, then the
-- duplicates.
local reply = {allowed, remaining, redis.call('TTL', KEYS[1]), #new_paths}
for i = 1, #new_paths do reply[#reply + 1] = new_paths[i] end
for i = 1, #duplicates do reply[#reply + 1] = duplicates[i] end
return reply
\`

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type PurgeRequest struct {
	Domain string   \`json:"domain"\`
	Paths  []string \`json:"paths"\`
}

type PurgeProvider struct{}

func (p *PurgeProvider) SubmitPurge(ctx context.Context, purgeID, domain string, paths []string) error {
	return nil
}

var provider = &PurgeProvider{}

func budgetKey(domain string, window int64) string {
	return "purge:budget:" + domain + ":" + strconv.FormatInt(window, 10)
}

func dedupeKey(tenant, domain, path string) string {
	return "purge:seen:" + tenant + ":" + domain + ":" + path
}

type Reservation struct {
	Allowed    bool
	Remaining  int
	TTL        int
	NewPaths   []string
	Duplicates []string
}

func replyInt(value any) int {
	switch typed := value.(type) {
	case int64:
		return int(typed)
	case string:
		parsed, err := strconv.Atoi(typed)
		if err == nil {
			return parsed
		}
	}
	return 0
}

func replyStrings(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	values := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			values = append(values, text)
		}
	}
	return values
}

func reserve(ctx context.Context, tenant, domain string, paths []string) (*Reservation, error) {
	window := time.Now().Unix() / windowS
	keys := make([]string, 0, len(paths)+1)
	keys = append(keys, budgetKey(domain, window))
	for _, path := range paths {
		keys = append(keys, dedupeKey(tenant, domain, path))
	}
	args := make([]any, 0, len(paths)+3)
	args = append(args, dedupeTtlS, budgetMax, windowS)
	for _, path := range paths {
		args = append(args, path)
	}
	raw, err := rdb.Eval(ctx, reserveLua, keys, args...).Result()
	if err != nil {
		return nil, err
	}
	reply, ok := raw.([]any)
	if !ok || len(reply) < 4 {
		return nil, nil
	}
	newCount := replyInt(reply[3])
	reservation := &Reservation{
		Allowed:    replyInt(reply[0]) == 1,
		Remaining:  replyInt(reply[1]),
		TTL:        replyInt(reply[2]),
		NewPaths:   replyStrings(reply[3:]),
		Duplicates: []string{},
	}
	if newCount <= len(reservation.NewPaths) {
		reservation.NewPaths = reservation.NewPaths[:newCount]
		reservation.Duplicates = replyStrings(reply[3:])[newCount:]
	}
	return reservation, nil
}

func createPurge(rw http.ResponseWriter, r *http.Request) {
	var body PurgeRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	reservation, err := reserve(r.Context(), r.Header.Get("X-Tenant-Id"), body.Domain, body.Paths)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if !reservation.Allowed {
		rw.Header().Set("Retry-After", strconv.Itoa(max(reservation.TTL, 1)))
		rw.Header().Set("X-Purge-Budget-Remaining", "0")
		writeJSON(rw, http.StatusTooManyRequests, map[string]string{"error": "domain purge budget exhausted"})
		return
	}
	if len(reservation.NewPaths) > 0 {
		_ = provider.SubmitPurge(r.Context(), "purge-"+body.Domain, body.Domain, reservation.NewPaths)
	}
	writeJSON(rw, http.StatusAccepted, map[string]any{
		"domain":     body.Domain,
		"submitted":  reservation.NewPaths,
		"duplicates": reservation.Duplicates,
		"remaining":  reservation.Remaining,
	})
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/purges", createPurge)
	http.ListenAndServe(":8443", mux)
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

final case class Reservation(
    allowed: Boolean,
    remaining: Int,
    ttl: Int,
    newPaths: List[String],
    duplicates: List[String])

object PurgeState {
  val BudgetMax = 1000

  val jedis = new Jedis("redis", 6379)

  def budgetKey(domain: String): String = s"purge:budget:$domain"

  def dedupeKey(tenant: String, domain: String, path: String): String =
    s"purge:seen:$tenant:$domain:$path"

  // TODO: this draft checks dedupe with a client-side EXISTS and writes afterwards, so a
  // double-submitted deploy purges twice; the budget key has no window bucket and no TTL, so the
  // counter never resets; and the 429 carries no Retry-After. Review all three: one atomic EVAL
  // that checks and writes together, a bucketed budget key that expires with its window, and a
  // 429 that tells the client when to come back.
  def reserve(tenant: String, domain: String, paths: List[String]): Reservation = {
    val duplicates = paths.filter(path => jedis.exists(dedupeKey(tenant, domain, path)))
    val fresh = paths.filterNot(duplicates.contains)
    fresh.foreach(path => jedis.set(dedupeKey(tenant, domain, path), "1"))
    val used = Option(jedis.get(budgetKey(domain))).map(_.toInt).getOrElse(0)
    if (used + fresh.length > BudgetMax) {
      Reservation(allowed = false, remaining = 0, ttl = 0, newPaths = Nil, duplicates = duplicates)
    } else {
      jedis.incrBy(budgetKey(domain), fresh.length.toLong)
      Reservation(allowed = true, remaining = BudgetMax - used - fresh.length, ttl = 0, fresh, duplicates)
    }
  }
}

object PurgeProvider {
  def submitPurge(purgeId: String, domain: String, paths: List[String]): Unit = ???
}

object PurgeApi {
  def createPurge(tenant: String, domain: String, paths: List[String]): Either[String, Reservation] = {
    val reservation = PurgeState.reserve(tenant, domain, paths)
    if (!reservation.allowed) Left("domain purge budget exhausted")
    else {
      PurgeProvider.submitPurge(s"purge-$domain", domain, reservation.newPaths)
      Right(reservation)
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.StatusCodes
import redis.clients.jedis.Jedis

import scala.jdk.CollectionConverters._

final case class Reservation(
    allowed: Boolean,
    remaining: Int,
    ttl: Int,
    newPaths: List[String],
    duplicates: List[String])

object PurgeState {
  val DedupeTtlS = 600
  val WindowS = 300
  val BudgetMax = 1000

  val reserveLua = """
-- KEYS[1] is the domain's window budget; KEYS[2..] are the per-path dedupe keys.
-- ARGV[1] dedupe ttl, ARGV[2] budget per window, ARGV[3] window ttl, ARGV[4..] the paths.
local dedupe_ttl = tonumber(ARGV[1])
local budget_max = tonumber(ARGV[2])
local window_ttl = tonumber(ARGV[3])
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local new_paths = {}
local duplicates = {}
for i = 2, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 0 then
    new_paths[#new_paths + 1] = ARGV[i + 2]
  else
    duplicates[#duplicates + 1] = ARGV[i + 2]
  end
end
local allowed = 1
local remaining = budget_max - used - #new_paths
if used + #new_paths > budget_max then
  allowed = 0
  remaining = math.max(budget_max - used, 0)
else
  for i = 1, #new_paths do
    redis.call('SET', KEYS[i + 1], '1', 'NX', 'EX', dedupe_ttl)
  end
  redis.call('INCRBY', KEYS[1], #new_paths)
  if redis.call('TTL', KEYS[1]) < 0 then
    redis.call('EXPIRE', KEYS[1], window_ttl)
  end
end
-- Positional reply: allowed, remaining, ttl, how many paths are new, the new paths, then the
-- duplicates.
local reply = {allowed, remaining, redis.call('TTL', KEYS[1]), #new_paths}
for i = 1, #new_paths do reply[#reply + 1] = new_paths[i] end
for i = 1, #duplicates do reply[#reply + 1] = duplicates[i] end
return reply
"""

  val jedis = new Jedis("redis", 6379)

  def budgetKey(domain: String, window: Long): String = s"purge:budget:$domain:$window"

  def dedupeKey(tenant: String, domain: String, path: String): String =
    s"purge:seen:$tenant:$domain:$path"

  // reserve dedupes the paths and charges the domain's window budget in one atomic script.
  def reserve(tenant: String, domain: String, paths: List[String]): Reservation = {
    val window = System.currentTimeMillis() / 1000L / WindowS
    val keys = (budgetKey(domain, window) :: paths.map(dedupeKey(tenant, domain, _))).asJava
    val args = (List(DedupeTtlS.toString, BudgetMax.toString, WindowS.toString) ++ paths).asJava
    val reply = jedis.eval(reserveLua, keys, args).asInstanceOf[java.util.List[AnyRef]]
    val newCount = reply.get(3).toString.toInt
    val tail = reply.subList(4, reply.size).asScala.toList.map(_.toString)
    Reservation(
      allowed = reply.get(0).toString.toInt == 1,
      remaining = reply.get(1).toString.toInt,
      ttl = reply.get(2).toString.toInt,
      newPaths = tail.take(newCount),
      duplicates = tail.drop(newCount),
    )
  }
}

object PurgeApi {
  def createPurge(tenant: String, domain: String, paths: List[String]): (Int, Map[String, String], Reservation) = {
    val reservation = PurgeState.reserve(tenant, domain, paths)
    if (!reservation.allowed) {
      val retryAfter = math.max(reservation.ttl, 1)
      (StatusCodes.TooManyRequests.intValue, Map("Retry-After" -> retryAfter.toString, "X-Purge-Budget-Remaining" -> "0"), reservation)
    } else {
      if (reservation.newPaths.nonEmpty) PurgeProvider.submitPurge(s"purge-$domain", domain, reservation.newPaths)
      (202, Map.empty, reservation)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kBudgetMax = 1000;

struct PurgeProvider {
  void SubmitPurge(const std::string& purgeId, const std::string& domain, const std::vector<std::string>& paths);
};

PurgeProvider provider;
std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

std::string budgetKey(const std::string& domain) { return "purge:budget:" + domain; }

std::string dedupeKey(const std::string& tenant, const std::string& domain, const std::string& path) {
  return "purge:seen:" + tenant + ":" + domain + ":" + path;
}

struct Reservation {
  bool allowed = false;
  long long remaining = 0;
  long long ttl = 0;
  std::vector<std::string> new_paths;
  std::vector<std::string> duplicates;
};

// TODO: this draft checks dedupe with a client-side EXISTS and writes afterwards, so a
// double-submitted deploy purges twice; the budget key has no window bucket and no TTL, so the
// counter never resets; and the 429 carries no Retry-After. Review all three: one atomic EVAL that
// checks and writes together, a bucketed budget key that expires with its window, and a 429 that
// tells the client when to come back.
Reservation reserve(const std::string& tenant, const std::string& domain, const std::vector<std::string>& paths) {
  Reservation reservation;
  for (const auto& path : paths) {
    if (redis->exists(dedupeKey(tenant, domain, path)) > 0) {
      reservation.duplicates.push_back(path);
    } else {
      reservation.new_paths.push_back(path);
    }
  }
  for (const auto& path : reservation.new_paths) redis->set(dedupeKey(tenant, domain, path), "1");
  const auto used = std::stoll(redis->get(budgetKey(domain)).value_or("0"));
  if (used + static_cast<long long>(reservation.new_paths.size()) > kBudgetMax) return reservation;
  redis->incrby(budgetKey(domain), static_cast<long long>(reservation.new_paths.size()));
  reservation.allowed = true;
  reservation.remaining = kBudgetMax - used - static_cast<long long>(reservation.new_paths.size());
  return reservation;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/purges", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto body = json::parse(req.body, nullptr, false);
    const auto reservation = reserve(tenant, body.value("domain", std::string()), body.value("paths", std::vector<std::string>()));
    if (!reservation.allowed) {
      res.status = 429;
      res.set_content(R"({"error":"domain purge budget exhausted"})", "application/json");
      return;
    }
    provider.SubmitPurge("purge-" + body.value("domain", std::string()), body.value("domain", std::string()), reservation.new_paths);
    res.status = 202;
    res.set_content(json{{"domain", body.value("domain", std::string())}, {"submitted", reservation.new_paths}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <ctime>
#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kDedupeTtlS = 600;
constexpr int kWindowS = 300;
constexpr long long kBudgetMax = 1000;

// kReserveLua dedupes the paths and charges the domain's window budget in one atomic step.
const std::string kReserveLua = R"lua(
-- KEYS[1] is the domain's window budget; KEYS[2..] are the per-path dedupe keys.
-- ARGV[1] dedupe ttl, ARGV[2] budget per window, ARGV[3] window ttl, ARGV[4..] the paths.
local dedupe_ttl = tonumber(ARGV[1])
local budget_max = tonumber(ARGV[2])
local window_ttl = tonumber(ARGV[3])
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local new_paths = {}
local duplicates = {}
for i = 2, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 0 then
    new_paths[#new_paths + 1] = ARGV[i + 2]
  else
    duplicates[#duplicates + 1] = ARGV[i + 2]
  end
end
local allowed = 1
local remaining = budget_max - used - #new_paths
if used + #new_paths > budget_max then
  allowed = 0
  remaining = math.max(budget_max - used, 0)
else
  for i = 1, #new_paths do
    redis.call('SET', KEYS[i + 1], '1', 'NX', 'EX', dedupe_ttl)
  end
  redis.call('INCRBY', KEYS[1], #new_paths)
  if redis.call('TTL', KEYS[1]) < 0 then
    redis.call('EXPIRE', KEYS[1], window_ttl)
  end
end
-- Positional reply: allowed, remaining, ttl, how many paths are new, the new paths, then the
-- duplicates.
local reply = {allowed, remaining, redis.call('TTL', KEYS[1]), #new_paths}
for i = 1, #new_paths do reply[#reply + 1] = new_paths[i] end
for i = 1, #duplicates do reply[#reply + 1] = duplicates[i] end
return reply
)lua";

struct PurgeProvider {
  void SubmitPurge(const std::string& purgeId, const std::string& domain, const std::vector<std::string>& paths);
};

PurgeProvider provider;
std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

struct Reservation {
  bool allowed = false;
  long long remaining = 0;
  long long ttl = 0;
  std::vector<std::string> new_paths;
  std::vector<std::string> duplicates;
};

std::string budgetKey(const std::string& domain, long long window) {
  return "purge:budget:" + domain + ":" + std::to_string(window);
}

std::string dedupeKey(const std::string& tenant, const std::string& domain, const std::string& path) {
  return "purge:seen:" + tenant + ":" + domain + ":" + path;
}

Reservation reserve(const std::string& tenant, const std::string& domain, const std::vector<std::string>& paths) {
  const long long window = static_cast<long long>(std::time(nullptr)) / kWindowS;
  std::vector<std::string> keys{budgetKey(domain, window)};
  for (const auto& path : paths) keys.push_back(dedupeKey(tenant, domain, path));
  std::vector<std::string> args{std::to_string(kDedupeTtlS), std::to_string(kBudgetMax), std::to_string(kWindowS)};
  args.insert(args.end(), paths.begin(), paths.end());
  const auto reply = redis->eval<std::vector<std::string>>(kReserveLua, keys.begin(), keys.end(), args.begin(), args.end());
  Reservation reservation;
  reservation.allowed = std::stoll(reply[0]) == 1;
  reservation.remaining = std::stoll(reply[1]);
  reservation.ttl = std::stoll(reply[2]);
  const auto newCount = std::stoll(reply[3]);
  reservation.new_paths.assign(reply.begin() + 4, reply.begin() + 4 + newCount);
  reservation.duplicates.assign(reply.begin() + 4 + newCount, reply.end());
  return reservation;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/purges", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto body = json::parse(req.body, nullptr, false);
    const auto domain = body.value("domain", std::string());
    const auto reservation = reserve(tenant, domain, body.value("paths", std::vector<std::string>()));
    if (!reservation.allowed) {
      res.status = 429;
      res.set_header("Retry-After", std::to_string(std::max<long long>(reservation.ttl, 1)));
      res.set_header("X-Purge-Budget-Remaining", "0");
      res.set_content(R"({"error":"domain purge budget exhausted"})", "application/json");
      return;
    }
    if (!reservation.new_paths.empty()) provider.SubmitPurge("purge-" + domain, domain, reservation.new_paths);
    res.status = 202;
    res.set_content(
        json{{"domain", domain}, {"submitted", reservation.new_paths}, {"duplicates", reservation.duplicates},
             {"remaining", reservation.remaining}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'One script, one atomic step: pass the budget key first and one dedupe key per path, then the TTL, the budget and the window TTL as arguments, and read the per-path paths from `ARGV[4..]`. Redis runs the whole script without interleaving another command, which is what makes "check then write" safe here.',
    'Bucket the budget by the clock, not by the deploy: `window = now // WINDOW_S` in the key, plus `EXPIRE WINDOW_S` when the script creates the key, so the counter dies with its window instead of living until someone deletes it.',
    'Reserve before the provider call and hand it only the new paths. When the reservation is refused, answer 429 with `Retry-After` from the window key’s TTL and `X-Purge-Budget-Remaining`, and leave the dedupe keys untouched so the paths stay purgeable once the window rolls over.',
  ],
  debrief: `The interviewer is asking about atomicity under concurrency and about key lifetimes. A read-then-write dedupe passes every serial test and fails exactly when it matters: a deploy pipeline that submits the same purge twice, or two replicas receiving the same request. One Lua script turns check-and-write into a single step, and it also lets the budget be charged by the same decision that deduped the paths. The window bucket is the second half: a counter keyed by domain alone is immortal, so the domain slowly spends a budget that never refills, and the resulting 429s look like a bug in the CDN rather than a missing TTL. The 429 itself is a contract — \`Retry-After\` tells a well-behaved client when the window reopens, and \`X-Purge-Budget-Remaining\` lets a deploy pipeline see how close it is. Real platforms add a per-tenant budget on top of the per-domain one, a soft limit that lets wildcards through with a warning, and a metric on every dedupe hit so a stuck pipeline is visible.`,
};
