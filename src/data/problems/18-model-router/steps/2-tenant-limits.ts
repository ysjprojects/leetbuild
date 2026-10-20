import type {Step} from '@/lib/types';

export const tenantLimitsStep: Step = {
  id: 'tenant-limits',
  title: 'Per-tenant limits: one atomic reservation',
  concept: 'redis',
  file: 'limits',
  focus: ['router', 'redis', 'provider'],
  task: `## Task

The starter is a plausible model-generated draft: a tenant with budget left gets its request
through, so the demo passes. The limiter hides a race, a leak and a wrong order of operations.
Find them, fix them, and prove the fix.

Implement the per-tenant rate limit used by every routed request:

- Each tenant gets **60 requests** and **100 000 tokens** per **60-second window**. The key is
  \`limits:{tenant}:{window}\` where \`window\` is the UTC minute bucket
  (\`floor(unix_seconds / 60)\`) — a tenant-less key leaks budget across tenants, a window-less key
  never resets.
- One **atomic Lua \`EVAL\`** must read both counters, reject when either reservation does not fit,
  and increment both when it does. A read followed by a separate decrement lets two concurrent
  requests both observe budget that only one of them can spend.
- The key must expire with its window: set \`EXPIRE\` inside the same script on the first write, so
  the counters reset instead of living forever.
- When either budget is exhausted, answer **429** with \`Retry-After\` (seconds, the key's TTL) and
  \`X-RateLimit-Remaining\` (tokens left), and **do not call the provider**.
- Reserve **before** the provider call. The draft bills after the answer, so a rejected request has
  already been paid for.

**Failure mode the checks target.** Two concurrent requests both pass the same check and overspend;
the key without a TTL never resets, so a tenant that had one busy minute is locked out forever; and
charging after the call means the provider is paid even when the tenant was over budget.`,
  sequence: {
    participants: ['Model Router', 'Redis', 'Provider'],
    messages: [
      {from: 'Model Router', to: 'Redis', label: 'EVAL reserve · KEYS[limits:acme:29162240]', kind: 'sync'},
      {from: 'Redis', to: 'Model Router', label: '{1, 59, 99744, 47}', kind: 'reply'},
      {from: 'Model Router', to: 'Provider', label: 'Complete(...) only after the reservation', kind: 'sync'},
      {from: 'Provider', to: 'Model Router', label: 'CompleteReply{content, usage}', kind: 'reply'},
      {
        from: 'Model Router',
        to: 'Model Router',
        label: '429 {Retry-After, X-RateLimit-Remaining} when rejected, provider untouched',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'The script must do all of it on the server: `HGET` both counters, compare against the limits, `HINCRBY` both on success. `GET` followed by `DECRBY` from the client leaves a window between the two commands where another request passes the same check.',
    'A window key must die with its window. Inside the same script, check `TTL` and call `EXPIRE` when the key was just created — afterwards the counter resets every minute instead of accumulating forever.',
    'The 429 is not just a status: `Retry-After` tells the client how long the window has left and `X-RateLimit-Remaining` lets it slow down before the next refusal. Return from the handler before the provider stub is touched.',
  ],
  checks: [
    {
      id: 'atomic',
      title: 'Reserves with one atomic Lua script',
      detail:
        'Both counters are read, checked and incremented inside one `EVAL`/`NewScript` call. A client-side `GET` followed by `DECRBY` races: two requests can both observe budget that only one of them can spend.',
      match: {
        python: {all: [/RESERVE_LUA/, /\.eval\(/, /HINCRBY/, /HGET/]},
        typescript: {all: [/RESERVE_LUA/, /\.eval\(/, /HINCRBY/, /HGET/]},
        go: {all: [/(reserveScript|NewScript)/, /\.Run\(/, /HINCRBY/, /HGET/]},
        scala: {all: [/ReserveLua/, /\.eval\(/, /HINCRBY/, /HGET/]},
        cpp: {all: [/kReserveLua/, /\.eval</, /HINCRBY/, /HGET/]},
      },
    },
    {
      id: 'ttl',
      title: 'Window key expires on first write',
      detail:
        'The script sets the key’s expiry (`EXPIRE`) when it creates it and reports the remaining `TTL`. Without it the per-minute budget never resets and the tenant stays locked out.',
      match: {
        python: {all: [/EXPIRE/, /TTL/]},
        typescript: {all: [/EXPIRE/, /TTL/]},
        go: {all: [/EXPIRE/, /TTL/]},
        scala: {all: [/EXPIRE/, /TTL/]},
        cpp: {all: [/EXPIRE/, /TTL/]},
      },
    },
    {
      id: 'reject-headers',
      title: 'Answers 429 with Retry-After and remaining tokens',
      detail:
        'An exhausted tenant gets `429 Too Many Requests`, a `Retry-After` in seconds and `X-RateLimit-Remaining`, built from the script’s return value — not a hardcoded constant.',
      match: {
        python: {all: [/Retry-After/, /X-RateLimit-Remaining/, /status_code\s*=\s*429/]},
        typescript: {all: [/Retry-After/, /X-RateLimit-Remaining/, /\.code\(\s*429\s*\)/]},
        go: {all: [/Retry-After/, /X-RateLimit-Remaining/, /StatusTooManyRequests|\b429\b/]},
        scala: {all: [/Retry-After/, /X-RateLimit-Remaining/, /TooManyRequests|\b429\b/]},
        cpp: {all: [/Retry-After/, /X-RateLimit-Remaining/, /status\s*=\s*429/]},
      },
    },
    {
      id: 'tenant-window-key',
      title: 'Keys by tenant and window',
      detail:
        'The key is `limits:{tenant}:{window}` built from the authenticated tenant and the 60-second window bucket; a shared key or a tenant-less key lets one tenant spend another tenant’s budget, and a window-less key never resets.',
      match: {
        python: {all: [/limits:\{tenant\}:\{window\}/, /WINDOW_S/]},
        typescript: {all: [/limits:\$\{tenant\}:\$\{window\}/, /WINDOW_S/]},
        go: {all: [/limits:%s:%s/, /windowSeconds/]},
        scala: {all: [/limits:\$tenant:\$window/, /WindowSeconds/]},
        cpp: {all: [/"limits:"/, /kWindowSeconds/]},
      },
    },
    {
      id: 'reserve-first',
      title: 'Reserves before the provider call',
      detail:
        'The reservation runs before the provider call; a rejected request never touches the provider. The draft calls the model first and charges afterwards, so over-budget requests are still paid for.',
      match: {
        python: {order: [/reserve\(/, /providers\.Complete\(/]},
        typescript: {order: [/reserve\(/, /provider\.Complete\(/]},
        go: {order: [/reserve\(/, /providers\.Complete\(/]},
        scala: {order: [/reserve\(/, /\.complete\(/]},
        cpp: {order: [/reserve\(/, /\.Complete\(|->Complete\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc
import redis

import providers_pb2
import providers_pb2_grpc
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

LIMIT_REQUESTS = 60
LIMIT_TOKENS = 100_000

channel = grpc.insecure_channel("providers:9000")
providers = providers_pb2_grpc.ProviderStub(channel)


class RouteRequest(BaseModel):
    prompt: str
    max_tokens: int = 256


def charge(tenant: str, tokens: int) -> tuple[bool, int, int]:
    # TODO: replace the client-side GET-then-DECRBY with one atomic EVAL, give the window key a
    # TTL on first write, and reserve before calling the provider instead of charging after it.
    key = f"limits:{tenant}"
    left_req = int(r.get(f"{key}:req") or LIMIT_REQUESTS)
    left_tok = int(r.get(f"{key}:tok") or LIMIT_TOKENS)
    if left_req < 1 or tokens > left_tok:
        return False, left_req, left_tok
    r.decrby(f"{key}:req", 1)
    r.decrby(f"{key}:tok", tokens)
    return True, left_req - 1, left_tok - tokens


@app.post("/v1/route")
def route(body: RouteRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    wanted = len(body.prompt) // 4 + body.max_tokens
    request = providers_pb2.CompleteRequest(prompt=body.prompt, max_tokens=body.max_tokens)
    reply = providers.Complete(request, timeout=8.0)
    ok, left_req, left_tok = charge(tenant, wanted)
    if not ok:
        raise HTTPException(
            status_code=429,
            detail="tenant limit exceeded",
            headers={"Retry-After": "60", "X-RateLimit-Remaining": str(left_tok)},
        )
    return {"content": reply.content, "remaining_tokens": left_tok}
`,
      solution: `import time

import grpc
import redis

import providers_pb2
import providers_pb2_grpc
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 60
LIMIT_REQUESTS = 60
LIMIT_TOKENS = 100_000

RESERVE_LUA = """
local req = tonumber(redis.call('HGET', KEYS[1], 'req')) or 0
local tok = tonumber(redis.call('HGET', KEYS[1], 'tok')) or 0
local want_req = tonumber(ARGV[1])
local want_tok = tonumber(ARGV[2])
if req + want_req > tonumber(ARGV[3]) or tok + want_tok > tonumber(ARGV[4]) then
  return {0, tonumber(ARGV[3]) - req, tonumber(ARGV[4]) - tok, redis.call('TTL', KEYS[1])}
end
redis.call('HINCRBY', KEYS[1], 'req', want_req)
redis.call('HINCRBY', KEYS[1], 'tok', want_tok)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[5])
end
return {1, tonumber(ARGV[3]) - req - want_req, tonumber(ARGV[4]) - tok - want_tok, redis.call('TTL', KEYS[1])}
"""

channel = grpc.insecure_channel("providers:9000")
providers = providers_pb2_grpc.ProviderStub(channel)


class RouteRequest(BaseModel):
    prompt: str
    max_tokens: int = 256


def limits_key(tenant: str, window: int) -> str:
    return f"limits:{tenant}:{window}"


def reserve(tenant: str, tokens: int) -> tuple[bool, int, int, int]:
    window = int(time.time()) // WINDOW_S
    ok, left_req, left_tok, ttl = r.eval(
        RESERVE_LUA, 1, limits_key(tenant, window), 1, tokens, LIMIT_REQUESTS, LIMIT_TOKENS, WINDOW_S
    )
    return bool(ok), int(left_req), int(left_tok), int(ttl)


@app.post("/v1/route")
def route(body: RouteRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    wanted = len(body.prompt) // 4 + body.max_tokens
    ok, left_req, left_tok, ttl = reserve(tenant, wanted)
    if not ok:
        raise HTTPException(
            status_code=429,
            detail="tenant limit exceeded",
            headers={"Retry-After": str(max(ttl, 1)), "X-RateLimit-Remaining": str(left_tok)},
        )
    request = providers_pb2.CompleteRequest(prompt=body.prompt, max_tokens=body.max_tokens)
    reply = providers.Complete(request, timeout=8.0)
    return {"content": reply.content, "remaining_tokens": left_tok}
`,
    },
    typescript: {
      starter: `/** POST /v1/route: a model-generated draft that charges after the call and never expires keys. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {provider} from './providers';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const LIMIT_REQUESTS = 60;
const LIMIT_TOKENS = 100_000;

interface RouteBody {
  prompt: string;
  max_tokens?: number;
}

async function charge(tenant: string, tokens: number): Promise<[boolean, number, number]> {
  // TODO: replace the client-side GET-then-DECRBY with one atomic EVAL, give the window key a
  // TTL on first write, and reserve before calling the provider instead of charging after it.
  const key = \`limits:\${tenant}\`;
  const leftReq = Number((await r.get(\`\${key}:req\`)) ?? LIMIT_REQUESTS);
  const leftTokens = Number((await r.get(\`\${key}:tok\`)) ?? LIMIT_TOKENS);
  if (leftReq < 1 || tokens > leftTokens) return [false, leftReq, leftTokens];
  await r.decrby(\`\${key}:req\`, 1);
  await r.decrby(\`\${key}:tok\`, tokens);
  return [true, leftReq - 1, leftTokens - tokens];
}

app.post('/v1/route', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as RouteBody;
  const wanted = Math.floor(body.prompt.length / 4) + (body.max_tokens ?? 256);
  const completion = await provider.Complete({prompt: body.prompt, max_tokens: body.max_tokens ?? 256});
  const [ok, , leftTokens] = await charge(tenant, wanted);
  if (!ok) {
    return reply
      .code(429)
      .header('Retry-After', '60')
      .header('X-RateLimit-Remaining', String(leftTokens))
      .send({error: 'tenant limit exceeded'});
  }
  return reply.code(200).send({content: completion.content, remaining_tokens: leftTokens});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/route: reserve the tenant's window budget atomically, then call the model. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {provider} from './providers';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const WINDOW_S = 60;
const LIMIT_REQUESTS = 60;
const LIMIT_TOKENS = 100_000;

const RESERVE_LUA = \`
local req = tonumber(redis.call('HGET', KEYS[1], 'req')) or 0
local tok = tonumber(redis.call('HGET', KEYS[1], 'tok')) or 0
local want_req = tonumber(ARGV[1])
local want_tok = tonumber(ARGV[2])
if req + want_req > tonumber(ARGV[3]) or tok + want_tok > tonumber(ARGV[4]) then
  return {0, tonumber(ARGV[3]) - req, tonumber(ARGV[4]) - tok, redis.call('TTL', KEYS[1])}
end
redis.call('HINCRBY', KEYS[1], 'req', want_req)
redis.call('HINCRBY', KEYS[1], 'tok', want_tok)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[5])
end
return {1, tonumber(ARGV[3]) - req - want_req, tonumber(ARGV[4]) - tok - want_tok, redis.call('TTL', KEYS[1])}
\`;

interface RouteBody {
  prompt: string;
  max_tokens?: number;
}

function limitsKey(tenant: string, window: number): string {
  return \`limits:\${tenant}:\${window}\`;
}

async function reserve(tenant: string, tokens: number): Promise<[boolean, number, number, number]> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const reply = (await r.eval(
    RESERVE_LUA,
    1,
    limitsKey(tenant, window),
    '1',
    String(tokens),
    String(LIMIT_REQUESTS),
    String(LIMIT_TOKENS),
    String(WINDOW_S),
  )) as [number, number, number, number];
  return [reply[0] === 1, reply[1], reply[2], reply[3]];
}

app.post('/v1/route', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as RouteBody;
  const wanted = Math.floor(body.prompt.length / 4) + (body.max_tokens ?? 256);
  const [ok, , leftTokens, ttl] = await reserve(tenant, wanted);
  if (!ok) {
    return reply
      .code(429)
      .header('Retry-After', String(Math.max(ttl, 1)))
      .header('X-RateLimit-Remaining', String(leftTokens))
      .send({error: 'tenant limit exceeded'});
  }
  const completion = await provider.Complete(
    {prompt: body.prompt, max_tokens: body.max_tokens ?? 256},
    {deadline: Date.now() + 8_000},
  );
  return reply.code(200).send({content: completion.content, remaining_tokens: leftTokens});
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
	"net/http"

	"github.com/redis/go-redis/v9"
	pb "router/providerspb"
)

const (
	limitRequests = 60
	limitTokens   = 100000
)

var (
	rdb       *redis.Client
	providers pb.ProviderClient
)

func charge(ctx context.Context, tenant string, tokens int) (bool, int, int) {
	// TODO: replace the client-side GET-then-DECRBY with one atomic EVAL, give the window key a
	// TTL on first write, and reserve before calling the provider instead of charging after it.
	key := fmt.Sprintf("limits:%s", tenant)
	leftReq, _ := rdb.Get(ctx, key+":req").Int()
	if leftReq == 0 {
		leftReq = limitRequests
	}
	leftTokens, _ := rdb.Get(ctx, key+":tok").Int()
	if leftTokens == 0 {
		leftTokens = limitTokens
	}
	if leftReq < 1 || tokens > leftTokens {
		return false, leftReq, leftTokens
	}
	rdb.DecrBy(ctx, key+":req", 1)
	rdb.DecrBy(ctx, key+":tok", int64(tokens))
	return true, leftReq - 1, leftTokens - tokens
}

func route(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	body := struct {
		Prompt    string \`json:"prompt"\`
		MaxTokens int    \`json:"max_tokens"\`
	}{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	reply, _ := providers.Complete(r.Context(), &pb.CompleteRequest{Prompt: body.Prompt, MaxTokens: int32(body.MaxTokens)})
	ok, _, leftTokens := charge(r.Context(), tenant, len(body.Prompt)/4+body.MaxTokens)
	if !ok {
		rw.Header().Set("Retry-After", "60")
		rw.Header().Set("X-RateLimit-Remaining", fmt.Sprintf("%d", leftTokens))
		rw.WriteHeader(http.StatusTooManyRequests)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(fmt.Sprintf(\`{"content":%q,"remaining_tokens":%d}\`, reply.Content, leftTokens)))
}

func main() {}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	pb "router/providerspb"
)

const (
	windowSeconds = 60
	limitRequests = 60
	limitTokens   = 100000
)

var (
	rdb       *redis.Client
	providers pb.ProviderClient
)

var reserveScript = redis.NewScript(\`
local req = tonumber(redis.call('HGET', KEYS[1], 'req')) or 0
local tok = tonumber(redis.call('HGET', KEYS[1], 'tok')) or 0
local want_req = tonumber(ARGV[1])
local want_tok = tonumber(ARGV[2])
if req + want_req > tonumber(ARGV[3]) or tok + want_tok > tonumber(ARGV[4]) then
  return {0, tonumber(ARGV[3]) - req, tonumber(ARGV[4]) - tok, redis.call('TTL', KEYS[1])}
end
redis.call('HINCRBY', KEYS[1], 'req', want_req)
redis.call('HINCRBY', KEYS[1], 'tok', want_tok)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[5])
end
return {1, tonumber(ARGV[3]) - req - want_req, tonumber(ARGV[4]) - tok - want_tok, redis.call('TTL', KEYS[1])}
\`)

func limitsKey(tenant string, window string) string {
	return fmt.Sprintf("limits:%s:%s", tenant, window)
}

func reserve(ctx context.Context, tenant string, tokens int) (bool, int64, int64, int64) {
	window := strconv.FormatInt(time.Now().Unix()/windowSeconds, 10)
	values, err := reserveScript.Run(ctx, rdb, []string{limitsKey(tenant, window)}, 1, tokens, limitRequests, limitTokens, windowSeconds).Int64Slice()
	if err != nil {
		panic(err)
	}
	return values[0] == 1, values[1], values[2], values[3]
}

func route(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	body := struct {
		Prompt    string \`json:"prompt"\`
		MaxTokens int    \`json:"max_tokens"\`
	}{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	wanted := len(body.Prompt)/4 + body.MaxTokens
	ok, _, leftTokens, ttl := reserve(r.Context(), tenant, wanted)
	if !ok {
		rw.Header().Set("Retry-After", fmt.Sprintf("%d", ttl))
		rw.Header().Set("X-RateLimit-Remaining", fmt.Sprintf("%d", leftTokens))
		rw.WriteHeader(http.StatusTooManyRequests)
		return
	}
	reply, err := providers.Complete(r.Context(), &pb.CompleteRequest{Prompt: body.Prompt, MaxTokens: int32(body.MaxTokens)})
	if err != nil {
		rw.WriteHeader(http.StatusBadGateway)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(fmt.Sprintf(\`{"content":%q,"remaining_tokens":%d}\`, reply.Content, leftTokens)))
}

func main() {}
`,
    },
    scala: {
      starter: `import java.nio.charset.StandardCharsets

import io.grpc.ManagedChannelBuilder
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class RouteRequest(prompt: String, max_tokens: Int)

object LimitsApi {
  implicit val system: ActorSystem = ActorSystem("model-router")
  implicit val routeFormat: RootJsonFormat[RouteRequest] = jsonFormat2(RouteRequest)

  val LimitRequests = 60L
  val LimitTokens = 100000L
  val jedis = new Jedis("redis", 6379)
  val stub = ProviderGrpc.blockingStub(ManagedChannelBuilder.forAddress("providers", 9000).usePlaintext().build())

  // TODO: replace the client-side GET-then-DECRBY with one atomic EVAL, give the window key a
  // TTL on first write, and reserve before calling the provider instead of charging after it.
  def charge(tenant: String, tokens: Long): (Boolean, Long, Long) = {
    val key = s"limits:$tenant"
    val leftReq = Option(jedis.get(key + ":req")).map(_.toLong).getOrElse(LimitRequests)
    val leftTokens = Option(jedis.get(key + ":tok")).map(_.toLong).getOrElse(LimitTokens)
    if (leftReq < 1 || tokens > leftTokens) {
      (false, leftReq, leftTokens)
    } else {
      jedis.decrBy(key + ":req", 1)
      jedis.decrBy(key + ":tok", tokens)
      (true, leftReq - 1, leftTokens - tokens)
    }
  }

  val route: Route =
    path("v1" / "route") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[RouteRequest]) { body =>
            val wanted = body.prompt.getBytes(StandardCharsets.UTF_8).length / 4 + body.max_tokens
            val reply = stub.complete(CompleteRequest(prompt = body.prompt, maxTokens = body.max_tokens))
            val (ok, _, leftTokens) = charge(tenant, wanted)
            if (!ok) {
              complete(
                HttpResponse(
                  StatusCodes.TooManyRequests,
                  headers = List(
                    RawHeader("Retry-After", "60"),
                    RawHeader("X-RateLimit-Remaining", leftTokens.toString)
                  ),
                  entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"tenant limit exceeded"}""")
                )
              )
            } else {
              complete(StatusCodes.OK, s"""{"content":"\${reply.content}","remaining_tokens":$leftTokens}""")
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
      solution: `import java.nio.charset.StandardCharsets

import io.grpc.ManagedChannelBuilder
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class RouteRequest(prompt: String, max_tokens: Int)

object LimitsApi {
  implicit val system: ActorSystem = ActorSystem("model-router")
  implicit val routeFormat: RootJsonFormat[RouteRequest] = jsonFormat2(RouteRequest)

  val WindowSeconds = 60L
  val LimitRequests = 60L
  val LimitTokens = 100000L
  val jedis = new Jedis("redis", 6379)
  val stub = ProviderGrpc.blockingStub(ManagedChannelBuilder.forAddress("providers", 9000).usePlaintext().build())

  val ReserveLua =
    """
      |local req = tonumber(redis.call('HGET', KEYS[1], 'req')) or 0
      |local tok = tonumber(redis.call('HGET', KEYS[1], 'tok')) or 0
      |local want_req = tonumber(ARGV[1])
      |local want_tok = tonumber(ARGV[2])
      |if req + want_req > tonumber(ARGV[3]) or tok + want_tok > tonumber(ARGV[4]) then
      |  return {0, tonumber(ARGV[3]) - req, tonumber(ARGV[4]) - tok, redis.call('TTL', KEYS[1])}
      |end
      |redis.call('HINCRBY', KEYS[1], 'req', want_req)
      |redis.call('HINCRBY', KEYS[1], 'tok', want_tok)
      |if redis.call('TTL', KEYS[1]) < 0 then
      |  redis.call('EXPIRE', KEYS[1], ARGV[5])
      |end
      |return {1, tonumber(ARGV[3]) - req - want_req, tonumber(ARGV[4]) - tok - want_tok, redis.call('TTL', KEYS[1])}
      |""".stripMargin

  def limitsKey(tenant: String, window: Long): String = s"limits:$tenant:$window"

  def reserve(tenant: String, tokens: Long): (Boolean, Long, Long, Long) = {
    val window = System.currentTimeMillis() / 1000 / WindowSeconds
    val result = jedis
      .eval(
        ReserveLua,
        1,
        limitsKey(tenant, window),
        "1",
        tokens.toString,
        LimitRequests.toString,
        LimitTokens.toString,
        WindowSeconds.toString
      )
      .asInstanceOf[java.util.List[Long]]
    (result.get(0) == 1L, result.get(1), result.get(2), result.get(3))
  }

  val route: Route =
    path("v1" / "route") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[RouteRequest]) { body =>
            val wanted = body.prompt.getBytes(StandardCharsets.UTF_8).length / 4 + body.max_tokens
            val (ok, _, leftTokens, ttl) = reserve(tenant, wanted)
            if (!ok) {
              complete(
                HttpResponse(
                  StatusCodes.TooManyRequests,
                  headers = List(
                    RawHeader("Retry-After", ttl.toString),
                    RawHeader("X-RateLimit-Remaining", leftTokens.toString)
                  ),
                  entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"tenant limit exceeded"}""")
                )
              )
            } else {
              val reply = stub.complete(CompleteRequest(prompt = body.prompt, maxTokens = body.max_tokens))
              complete(StatusCodes.OK, s"""{"content":"\${reply.content}","remaining_tokens":$leftTokens}""")
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
      starter: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include "providers.grpc.pb.h"

#include <string>
#include <tuple>

using json = nlohmann::json;

constexpr long long kLimitRequests = 60;
constexpr long long kLimitTokens = 100000;

std::unique_ptr<Provider::Stub> stub;

std::tuple<bool, long long, long long> charge(sw::redis::Redis& redis, const std::string& tenant, long long tokens) {
  // TODO: replace the client-side GET-then-DECRBY with one atomic EVAL, give the window key a
  // TTL on first write, and reserve before calling the provider instead of charging after it.
  const auto key = "limits:" + tenant;
  auto rawReq = redis.get(key + ":req");
  long long leftReq = rawReq ? std::stoll(*rawReq) : kLimitRequests;
  auto rawTok = redis.get(key + ":tok");
  long long leftTokens = rawTok ? std::stoll(*rawTok) : kLimitTokens;
  if (leftReq < 1 || tokens > leftTokens) return {false, leftReq, leftTokens};
  redis.decrby(key + ":req", 1);
  redis.decrby(key + ":tok", tokens);
  return {true, leftReq - 1, leftTokens - tokens};
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::SSLServer svr("cert.pem", "key.pem");
  auto channel = grpc::CreateChannel("providers:9000", grpc::InsecureChannelCredentials());
  stub = Provider::NewStub(channel);

  svr.Post("/v1/route", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto prompt = body.value("prompt", std::string());
    const long long wanted = static_cast<long long>(prompt.size()) / 4 + body.value("max_tokens", 256);

    grpc::ClientContext ctx;
    CompleteRequest request;
    request.set_prompt(prompt);
    request.set_max_tokens(body.value("max_tokens", 256));
    CompleteReply reply;
    const grpc::Status status = stub->Complete(&ctx, request, &reply);
    if (!status.ok()) {
      res.status = 502;
      res.set_content(R"({"error":"provider failed"})", "application/json");
      return;
    }
    const auto [ok, leftReq, leftTokens] = charge(redis, tenant, wanted);
    if (!ok) {
      res.status = 429;
      res.set_header("Retry-After", "60");
      res.set_header("X-RateLimit-Remaining", std::to_string(leftTokens));
      res.set_content(R"({"error":"tenant limit exceeded"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(json{{"content", reply.content()}, {"remaining_tokens", leftTokens}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include "providers.grpc.pb.h"

#include <algorithm>
#include <chrono>
#include <string>
#include <tuple>
#include <vector>

using json = nlohmann::json;

constexpr long long kWindowSeconds = 60;
constexpr long long kLimitRequests = 60;
constexpr long long kLimitTokens = 100000;

const char* kReserveLua = R"LUA(
local req = tonumber(redis.call('HGET', KEYS[1], 'req')) or 0
local tok = tonumber(redis.call('HGET', KEYS[1], 'tok')) or 0
local want_req = tonumber(ARGV[1])
local want_tok = tonumber(ARGV[2])
if req + want_req > tonumber(ARGV[3]) or tok + want_tok > tonumber(ARGV[4]) then
  return {0, tonumber(ARGV[3]) - req, tonumber(ARGV[4]) - tok, redis.call('TTL', KEYS[1])}
end
redis.call('HINCRBY', KEYS[1], 'req', want_req)
redis.call('HINCRBY', KEYS[1], 'tok', want_tok)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[5])
end
return {1, tonumber(ARGV[3]) - req - want_req, tonumber(ARGV[4]) - tok - want_tok, redis.call('TTL', KEYS[1])}
)LUA";

std::string limitsKey(const std::string& tenant, long long window) {
  return "limits:" + tenant + ":" + std::to_string(window);
}

std::unique_ptr<Provider::Stub> stub;

std::tuple<bool, long long, long long, long long> reserve(
    sw::redis::Redis& redis,
    const std::string& tenant,
    long long tokens) {
  const auto window = std::chrono::duration_cast<std::chrono::seconds>(
                          std::chrono::system_clock::now().time_since_epoch())
                          .count() /
                      kWindowSeconds;
  const auto result = redis.eval<std::vector<long long>>(
      kReserveLua,
      {limitsKey(tenant, window)},
      {1, tokens, kLimitRequests, kLimitTokens, kWindowSeconds});
  return {result[0] == 1, result[1], result[2], result[3]};
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::SSLServer svr("cert.pem", "key.pem");
  auto channel = grpc::CreateChannel("providers:9000", grpc::InsecureChannelCredentials());
  stub = Provider::NewStub(channel);

  svr.Post("/v1/route", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto prompt = body.value("prompt", std::string());
    const long long wanted = static_cast<long long>(prompt.size()) / 4 + body.value("max_tokens", 256);

    const auto [ok, leftRequests, leftTokens, ttl] = reserve(redis, tenant, wanted);
    if (!ok) {
      res.status = 429;
      res.set_header("Retry-After", std::to_string(std::max(ttl, 1LL)));
      res.set_header("X-RateLimit-Remaining", std::to_string(leftTokens));
      res.set_content(R"({"error":"tenant limit exceeded"})", "application/json");
      return;
    }
    grpc::ClientContext ctx;
    CompleteRequest request;
    request.set_prompt(prompt);
    request.set_max_tokens(body.value("max_tokens", 256));
    CompleteReply reply;
    const grpc::Status status = stub->Complete(&ctx, request, &reply);
    if (!status.ok()) {
      res.status = 502;
      res.set_content(R"({"error":"provider failed"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(json{{"content", reply.content()}, {"remaining_tokens", leftTokens}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question behind this step is atomicity under concurrency. A read-then-decrement limiter passes every serial test and fails exactly when the product is under load, which is when the limit matters. One Lua script makes read, check and increment a single step, and it can also set the window's expiry at creation, so the counters die with their window instead of accumulating forever. Reserving before the provider call is the second half of the contract: a limited request must never be paid for. The 429 headers are the third: clients that honor \`Retry-After\` and \`X-RateLimit-Remaining\` back off, clients that get a bare 429 retry immediately. Real gateways add sliding windows, per-model token weights, and a budget that is refunded when the provider call fails before generating.`,
};
