import type {Step} from '@/lib/types';

export const merchantBudgetStep: Step = {
  id: 'merchant-budget',
  title: 'Per-shop budget, shop-scoped tool cache, write tools once',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'budget_cache',
  focus: ['api', 'redis', 'tools'],
  task: `## Task

**Starting point.** The starter is the spending layer step 2's loop calls. \`reserve(shop, tokens)\`
reads \`requests\` and \`tokens\` from the hash \`budget:{shop}\` with \`HMGET\` and \`HINCRBY\`s both when
the call fits (**30** requests, **150 000** tokens). \`invoke_tool(shop, turn_id, name, args_json)\`
caches a read tool's \`Tools.Invoke\` result under \`tool:{name}:{sha256(args)}\` with no TTL and
invokes a write tool on every call. It serves the demo and hides 5 flaws.

**Failure mode the checks target.** Two replicas both pass the check and overspend. A shop that had
one busy minute is refused for good. A "customers from Toronto" answer computed for one merchant is
served to another, and stays stale forever. A retried turn fills the merchant's product form twice.

- The limits hold per **60-second window**: the hash is \`budget:{shop}:{window}\` with
  \`window = unix_seconds // WINDOW_S\`, and it expires with its window.
- One Lua script (\`RESERVE_LUA\`) reads both counters, refuses when either would pass its limit,
  and \`HINCRBY\`s both otherwise, setting \`EXPIRE\` on first write.
- Read results are cached under \`tool:{shop}:{name}:{digest}\` for \`CACHE_TTL_S = 120\`.
- A write tool (\`writes\` in the catalog) is claimed with \`SET NX\` on
  \`write:{shop}:{turn_id}:{name}\` (24 h): a second call in the turn answers the stored result.`,
  sequence: {
    participants: ['agent loop', 'budget_cache', 'Redis', 'Tools'],
    messages: [
      {from: 'agent loop', to: 'budget_cache', label: 'reserve(shop, 2000)', kind: 'sync'},
      {from: 'budget_cache', to: 'Redis', label: 'EVALSHA RESERVE_LUA budget:{shop}:{window}', kind: 'sync'},
      {from: 'Redis', to: 'budget_cache', label: '1 (reserved) · 0 (over the limit)', kind: 'reply'},
      {from: 'agent loop', to: 'budget_cache', label: 'invoke_tool(shop, turn, segment_customers, args)', kind: 'sync'},
      {from: 'budget_cache', to: 'Redis', label: 'GET tool:{shop}:segment_customers:{digest}', kind: 'sync'},
      {from: 'budget_cache', to: 'Tools', label: 'Invoke · 10 s (on a miss)', kind: 'sync'},
      {
        from: 'budget_cache',
        to: 'Redis',
        label: 'SET … EX 120 · writes: SET write:{shop}:{turn}:{name} NX',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'atomic-reserve',
      title: 'Reserves both counters in one Lua script',
      detail:
        'A shop with one request left and two replicas reserving at once: exactly one gets it and the hash holds 30, not 31. The read, the limit test and both increments run in one script. The starter reads, then increments, in separate commands.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /HINCRBY/], none: [/\br\.hincrby\(|\.hmget\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /HINCRBY/], none: [/redis\.hincrby\(|redis\.hmget\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /HINCRBY/], none: [/rdb\.HIncrBy\(|rdb\.HMGet\(/]},
        scala: {all: [/jedis\.eval\(/, /HINCRBY/], none: [/jedis\.hincrBy\(|jedis\.hmget\(/]},
        cpp: {all: [/redis\.eval</, /HINCRBY/], none: [/redis\.hincrby\(|redis\.hmget\(/]},
      },
    },
    {
      id: 'budget-window',
      title: 'Counts per 60-second window that expires',
      detail:
        'The 31st reservation in a minute is refused, the budget hash has a TTL of at most 60 s, and a minute later the shop reserves again; 100 000 tokens plus 60 000 is refused, plus 50 000 fits. The starter keeps one counter forever.',
      match: {
        python: {all: [/\/\/\s*WINDOW_S\b/, /EXPIRE/]},
        typescript: {all: [/\/\s*WINDOW_S\b/, /EXPIRE/]},
        go: {all: [/\/\s*windowSeconds\b/, /EXPIRE/]},
        scala: {all: [/\/\s*WindowS\b/, /EXPIRE/]},
        cpp: {all: [/\/\s*kWindowS\b/, /EXPIRE/]},
      },
    },
    {
      id: 'shop-scoped-cache',
      title: 'Keys the tool cache by shop',
      detail:
        "Shop s1's second identical segment query is a cache hit; shop s2 asking the same thing gets its own Invoke and its own customers. The starter's key has no shop, so s2 gets s1's answer.",
      match: {
        python: {all: [/f["']tool:\{shop\}:/]},
        typescript: {all: [/tool:\$\{shop\}:/]},
        go: {all: [/"tool:"\s*\+\s*shop\s*\+/]},
        scala: {all: [/s"tool:\$shop:/]},
        cpp: {all: [/"tool:"\s*\+\s*shop\s*\+/]},
      },
    },
    {
      id: 'cache-ttl',
      title: 'Expires cached tool results after 120 s',
      detail:
        'A cached result has a TTL of at most 120 s, and after 121 s the next call reaches the tool again. The starter caches forever, so a merchant who adds a customer never sees it.',
      match: {
        python: {all: [/ex\s*=\s*CACHE_TTL_S/]},
        typescript: {all: [/['"]EX['"],\s*CACHE_TTL_S/]},
        go: {all: [/rdb\.Set\([^\n]*cacheTTL\)/]},
        scala: {all: [/\.ex\(\s*CacheTtlS\s*\)/]},
        cpp: {all: [/redis\.set\([^\n]*kCacheTtl/]},
      },
    },
    {
      id: 'write-once',
      title: 'Runs a write tool once per turn',
      detail:
        'Two `fill_product_form` calls in one turn reach the tool once and answer the same result; the claim key lives about a day; another turn fills again. The starter invokes the write on every call.',
      match: {
        python: {all: [/nx\s*=\s*True/, /write:\{shop\}:\{turn_id\}/]},
        typescript: {all: [/['"]NX['"]/, /write:\$\{shop\}:\$\{turnId\}/]},
        go: {all: [/\.SetNX\(/, /"write:"\s*\+\s*shop/]},
        scala: {all: [/\.nx\(\)/, /s"write:\$shop:\$turnId/]},
        cpp: {all: [/UpdateType::NOT_EXIST/, /"write:"\s*\+\s*shop/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib

import grpc
import redis

import merchant_agent_pb2
import merchant_agent_pb2_grpc
from sidekick.catalog import CATALOG
from sidekick.config import TOOLS_ADDR

MAX_REQUESTS = 30
MAX_TOKENS = 150_000
TOOL_DEADLINE_S = 10.0

r = redis.Redis(host="redis", port=6379, decode_responses=True)
tools = merchant_agent_pb2_grpc.ToolsStub(grpc.insecure_channel(TOOLS_ADDR))


def reserve(shop: str, tokens: int) -> bool:
    """Reserve one model call and its tokens for the shop; False when either does not fit."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    key = f"budget:{shop}"
    requests, used = r.hmget(key, "requests", "tokens")
    if int(requests or 0) + 1 > MAX_REQUESTS or int(used or 0) + tokens > MAX_TOKENS:
        return False
    r.hincrby(key, "requests", 1)
    r.hincrby(key, "tokens", tokens)
    return True


def invoke_tool(shop: str, turn_id: str, name: str, args_json: str) -> str:
    """The tool's result for the shop: reads from the cache when it can."""
    request = merchant_agent_pb2.InvokeRequest(shop=shop, turn_id=turn_id, name=name, args_json=args_json)
    tool = CATALOG.get(name)
    if tool is not None and tool.writes:
        return tools.Invoke(request, timeout=TOOL_DEADLINE_S).result_json
    key = f"tool:{name}:{hashlib.sha256(args_json.encode('utf-8')).hexdigest()}"
    cached = r.get(key)
    if cached is not None:
        return cached
    result = tools.Invoke(request, timeout=TOOL_DEADLINE_S).result_json
    r.set(key, result)
    return result
`,
      solution: `import hashlib
import time

import grpc
import redis

import merchant_agent_pb2
import merchant_agent_pb2_grpc
from sidekick.catalog import CATALOG
from sidekick.config import TOOLS_ADDR

MAX_REQUESTS = 30
MAX_TOKENS = 150_000
WINDOW_S = 60
CACHE_TTL_S = 120
WRITE_CLAIM_TTL_S = 86_400
TOOL_DEADLINE_S = 10.0

# KEYS[1] the shop's window; ARGV tokens, max requests, max tokens, window seconds. 1 reserved, 0 refused.
RESERVE_LUA = """
local requests = tonumber(redis.call('HGET', KEYS[1], 'requests') or '0')
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or '0')
local want = tonumber(ARGV[1])
if requests + 1 > tonumber(ARGV[2]) or tokens + want > tonumber(ARGV[3]) then
  return 0
end
redis.call('HINCRBY', KEYS[1], 'requests', 1)
redis.call('HINCRBY', KEYS[1], 'tokens', want)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
return 1
"""

r = redis.Redis(host="redis", port=6379, decode_responses=True)
tools = merchant_agent_pb2_grpc.ToolsStub(grpc.insecure_channel(TOOLS_ADDR))
reserve_script = r.register_script(RESERVE_LUA)


def reserve(shop: str, tokens: int) -> bool:
    """Reserve one model call and its tokens in the shop's current minute; False when either does not fit."""
    window = int(time.time()) // WINDOW_S
    return reserve_script(keys=[f"budget:{shop}:{window}"], args=[tokens, MAX_REQUESTS, MAX_TOKENS, WINDOW_S]) == 1


def invoke_tool(shop: str, turn_id: str, name: str, args_json: str) -> str:
    """The tool's result for the shop: reads from the shop's cache, writes once per turn."""
    request = merchant_agent_pb2.InvokeRequest(shop=shop, turn_id=turn_id, name=name, args_json=args_json)
    tool = CATALOG.get(name)
    if tool is not None and tool.writes:
        claim = f"write:{shop}:{turn_id}:{name}"
        if not r.set(claim, "", nx=True, ex=WRITE_CLAIM_TTL_S):
            return r.get(claim) or ""  # this turn already wrote: answer what it wrote
        try:
            result = tools.Invoke(request, timeout=TOOL_DEADLINE_S).result_json
        except grpc.RpcError:
            r.delete(claim)  # nothing was written: let a retry try again
            raise
        r.set(claim, result, ex=WRITE_CLAIM_TTL_S)
        return result
    key = f"tool:{shop}:{name}:{hashlib.sha256(args_json.encode('utf-8')).hexdigest()}"
    cached = r.get(key)
    if cached is not None:
        return cached
    result = tools.Invoke(request, timeout=TOOL_DEADLINE_S).result_json
    r.set(key, result, ex=CACHE_TTL_S)
    return result
`,
    },
    typescript: {
      starter: `import {createHash} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {CATALOG} from 'sidekick/catalog';
import {TOOLS_ADDR} from 'sidekick/config';

export const MAX_REQUESTS = 30;
export const MAX_TOKENS = 150_000;
export const TOOL_DEADLINE_MS = 10_000;

interface InvokeRequest {
  shop: string;
  turn_id: string;
  name: string;
  args_json: string;
}
interface ToolsClient {
  Invoke(request: InvokeRequest, options?: {deadline: number}): Promise<{result_json: string}>;
}

const {sidekickrpc} = grpc.loadPackageDefinition(protoLoader.loadSync('merchant_agent.proto')) as unknown as {
  sidekickrpc: {Tools: new (target: string, credentials: grpc.ChannelCredentials) => ToolsClient};
};
const tools = new sidekickrpc.Tools(TOOLS_ADDR, grpc.credentials.createInsecure());
export const redis = new Redis({host: 'redis', port: 6379});

/** Reserve one model call and its tokens for the shop; false when either does not fit. */
export async function reserve(shop: string, tokens: number): Promise<boolean> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const key = \`budget:\${shop}\`;
  const [requests, used] = await redis.hmget(key, 'requests', 'tokens');
  if (Number(requests ?? 0) + 1 > MAX_REQUESTS || Number(used ?? 0) + tokens > MAX_TOKENS) return false;
  await redis.hincrby(key, 'requests', 1);
  await redis.hincrby(key, 'tokens', tokens);
  return true;
}

/** The tool's result for the shop: reads from the cache when it can. */
export async function invokeTool(shop: string, turnId: string, name: string, argsJson: string): Promise<string> {
  const request = {shop, turn_id: turnId, name, args_json: argsJson};
  if (Object.hasOwn(CATALOG, name) && CATALOG[name].writes) {
    return (await tools.Invoke(request, {deadline: Date.now() + TOOL_DEADLINE_MS})).result_json;
  }
  const key = \`tool:\${name}:\${createHash('sha256').update(argsJson).digest('hex')}\`;
  const cached = await redis.get(key);
  if (cached !== null) return cached;
  const result = (await tools.Invoke(request, {deadline: Date.now() + TOOL_DEADLINE_MS})).result_json;
  await redis.set(key, result);
  return result;
}
`,
      solution: `import {createHash} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {CATALOG} from 'sidekick/catalog';
import {TOOLS_ADDR} from 'sidekick/config';

export const MAX_REQUESTS = 30;
export const MAX_TOKENS = 150_000;
export const WINDOW_S = 60;
export const CACHE_TTL_S = 120;
export const WRITE_CLAIM_TTL_S = 86_400;
export const TOOL_DEADLINE_MS = 10_000;

/** KEYS[1] the shop's window; ARGV tokens, max requests, max tokens, window seconds. 1 reserved, 0 refused. */
export const RESERVE_LUA = \`
local requests = tonumber(redis.call('HGET', KEYS[1], 'requests') or '0')
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or '0')
local want = tonumber(ARGV[1])
if requests + 1 > tonumber(ARGV[2]) or tokens + want > tonumber(ARGV[3]) then
  return 0
end
redis.call('HINCRBY', KEYS[1], 'requests', 1)
redis.call('HINCRBY', KEYS[1], 'tokens', want)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
return 1
\`;

interface InvokeRequest {
  shop: string;
  turn_id: string;
  name: string;
  args_json: string;
}
interface ToolsClient {
  Invoke(request: InvokeRequest, options?: {deadline: number}): Promise<{result_json: string}>;
}
interface BudgetRedis extends Redis {
  reserveBudget(key: string, tokens: number, maxRequests: number, maxTokens: number, windowS: number): Promise<number>;
}

const {sidekickrpc} = grpc.loadPackageDefinition(protoLoader.loadSync('merchant_agent.proto')) as unknown as {
  sidekickrpc: {Tools: new (target: string, credentials: grpc.ChannelCredentials) => ToolsClient};
};
const tools = new sidekickrpc.Tools(TOOLS_ADDR, grpc.credentials.createInsecure());
export const redis = new Redis({host: 'redis', port: 6379}) as BudgetRedis;
redis.defineCommand('reserveBudget', {numberOfKeys: 1, lua: RESERVE_LUA});

/** Reserve one model call and its tokens in the shop's current minute; false when either does not fit. */
export async function reserve(shop: string, tokens: number): Promise<boolean> {
  const window = Math.floor(Math.floor(Date.now() / 1000) / WINDOW_S);
  return (await redis.reserveBudget(\`budget:\${shop}:\${window}\`, tokens, MAX_REQUESTS, MAX_TOKENS, WINDOW_S)) === 1;
}

/** The tool's result for the shop: reads from the shop's cache, writes once per turn. */
export async function invokeTool(shop: string, turnId: string, name: string, argsJson: string): Promise<string> {
  const request = {shop, turn_id: turnId, name, args_json: argsJson};
  if (Object.hasOwn(CATALOG, name) && CATALOG[name].writes) {
    const claim = \`write:\${shop}:\${turnId}:\${name}\`;
    if ((await redis.set(claim, '', 'EX', WRITE_CLAIM_TTL_S, 'NX')) === null) return (await redis.get(claim)) ?? ''; // this turn already wrote
    let result: string;
    try {
      result = (await tools.Invoke(request, {deadline: Date.now() + TOOL_DEADLINE_MS})).result_json;
    } catch (err) {
      await redis.del(claim); // nothing was written: let a retry try again
      throw err;
    }
    await redis.set(claim, result, 'EX', WRITE_CLAIM_TTL_S);
    return result;
  }
  const key = \`tool:\${shop}:\${name}:\${createHash('sha256').update(argsJson).digest('hex')}\`;
  const cached = await redis.get(key);
  if (cached !== null) return cached;
  const result = (await tools.Invoke(request, {deadline: Date.now() + TOOL_DEADLINE_MS})).result_json;
  await redis.set(key, result, 'EX', CACHE_TTL_S);
  return result;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"sidekick/catalog" // catalog.Lookup(name) — provided
	"sidekick/config"  // config.ToolsAddr — provided
	pb "sidekickrpc/gen/merchant_agent"
)

const (
	maxRequests  = 30
	maxTokens    = 150_000
	toolDeadline = 10 * time.Second
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})
var toolsConn, _ = grpc.NewClient(config.ToolsAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
var toolsClient = pb.NewToolsClient(toolsConn)

// reserve reserves one model call and its tokens for the shop; false when either does not fit.
func reserve(ctx context.Context, shop string, tokens int64) (bool, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	key := "budget:" + shop
	counts, err := rdb.HMGet(ctx, key, "requests", "tokens").Result()
	if err != nil {
		return false, err
	}
	requests, used := int64(0), int64(0)
	if s, ok := counts[0].(string); ok {
		requests, _ = strconv.ParseInt(s, 10, 64)
	}
	if s, ok := counts[1].(string); ok {
		used, _ = strconv.ParseInt(s, 10, 64)
	}
	if requests+1 > maxRequests || used+tokens > maxTokens {
		return false, nil
	}
	if err := rdb.HIncrBy(ctx, key, "requests", 1).Err(); err != nil {
		return false, err
	}
	return true, rdb.HIncrBy(ctx, key, "tokens", tokens).Err()
}

func callTool(ctx context.Context, shop, turnID, name, argsJSON string) (string, error) {
	callCtx, cancel := context.WithTimeout(ctx, toolDeadline)
	defer cancel()
	reply, err := toolsClient.Invoke(callCtx, &pb.InvokeRequest{Shop: shop, TurnId: turnID, Name: name, ArgsJson: argsJSON})
	if err != nil {
		return "", err
	}
	return reply.GetResultJson(), nil
}

// invokeTool is the tool's result for the shop: reads from the cache when it can.
func invokeTool(ctx context.Context, shop, turnID, name, argsJSON string) (string, error) {
	if tool, ok := catalog.Lookup(name); ok && tool.Writes {
		return callTool(ctx, shop, turnID, name, argsJSON)
	}
	sum := sha256.Sum256([]byte(argsJSON))
	key := "tool:" + name + ":" + hex.EncodeToString(sum[:])
	cached, err := rdb.Get(ctx, key).Result()
	if err == nil {
		return cached, nil
	}
	if !errors.Is(err, redis.Nil) {
		return "", err
	}
	result, err := callTool(ctx, shop, turnID, name, argsJSON)
	if err != nil {
		return "", err
	}
	return result, rdb.Set(ctx, key, result, 0).Err()
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"sidekick/catalog" // catalog.Lookup(name) — provided
	"sidekick/config"  // config.ToolsAddr — provided
	pb "sidekickrpc/gen/merchant_agent"
)

const (
	maxRequests   = 30
	maxTokens     = 150_000
	windowSeconds = 60
	cacheTTL      = 120 * time.Second
	writeClaimTTL = 24 * time.Hour
	toolDeadline  = 10 * time.Second
)

// KEYS[1] the shop's window; ARGV tokens, max requests, max tokens, window seconds. 1 reserved, 0 refused.
var reserveScript = redis.NewScript(\`
local requests = tonumber(redis.call('HGET', KEYS[1], 'requests') or '0')
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or '0')
local want = tonumber(ARGV[1])
if requests + 1 > tonumber(ARGV[2]) or tokens + want > tonumber(ARGV[3]) then
  return 0
end
redis.call('HINCRBY', KEYS[1], 'requests', 1)
redis.call('HINCRBY', KEYS[1], 'tokens', want)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
return 1
\`)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})
var toolsConn, _ = grpc.NewClient(config.ToolsAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
var toolsClient = pb.NewToolsClient(toolsConn)

// reserve reserves one model call and its tokens in the shop's current minute; false when either does not fit.
func reserve(ctx context.Context, shop string, tokens int64) (bool, error) {
	window := time.Now().Unix() / windowSeconds
	key := "budget:" + shop + ":" + strconv.FormatInt(window, 10)
	reserved, err := reserveScript.Run(ctx, rdb, []string{key}, tokens, maxRequests, maxTokens, windowSeconds).Int()
	return reserved == 1, err
}

func callTool(ctx context.Context, shop, turnID, name, argsJSON string) (string, error) {
	callCtx, cancel := context.WithTimeout(ctx, toolDeadline)
	defer cancel()
	reply, err := toolsClient.Invoke(callCtx, &pb.InvokeRequest{Shop: shop, TurnId: turnID, Name: name, ArgsJson: argsJSON})
	if err != nil {
		return "", err
	}
	return reply.GetResultJson(), nil
}

// invokeTool is the tool's result for the shop: reads from the shop's cache, writes once per turn.
func invokeTool(ctx context.Context, shop, turnID, name, argsJSON string) (string, error) {
	if tool, ok := catalog.Lookup(name); ok && tool.Writes {
		claim := "write:" + shop + ":" + turnID + ":" + name
		claimed, err := rdb.SetNX(ctx, claim, "", writeClaimTTL).Result()
		if err != nil {
			return "", err
		}
		if !claimed {
			return rdb.Get(ctx, claim).Val(), nil // this turn already wrote: answer what it wrote
		}
		result, err := callTool(ctx, shop, turnID, name, argsJSON)
		if err != nil {
			rdb.Del(ctx, claim) // nothing was written: let a retry try again
			return "", err
		}
		return result, rdb.Set(ctx, claim, result, writeClaimTTL).Err()
	}
	sum := sha256.Sum256([]byte(argsJSON))
	key := "tool:" + shop + ":" + name + ":" + hex.EncodeToString(sum[:])
	cached, err := rdb.Get(ctx, key).Result()
	if err == nil {
		return cached, nil
	}
	if !errors.Is(err, redis.Nil) {
		return "", err
	}
	result, err := callTool(ctx, shop, turnID, name, argsJSON)
	if err != nil {
		return "", err
	}
	return result, rdb.Set(ctx, key, result, cacheTTL).Err()
}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest
import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder
import redis.clients.jedis.JedisPooled

import sidekick.{Catalog, Config}
import sidekickrpc.merchant_agent.{InvokeRequest, ToolsGrpc}

object BudgetCache {
  val MaxRequests = 30L
  val MaxTokens = 150000L
  val ToolDeadlineMs = 10000L

  private val jedis = new JedisPooled("redis", 6379)
  private val tools = ToolsGrpc.blockingStub(ManagedChannelBuilder.forTarget(Config.ToolsAddr).usePlaintext().build())

  private def sha256Hex(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes("UTF-8")).map("%02x".format(_)).mkString

  /** Reserve one model call and its tokens for the shop; false when either does not fit. */
  def reserve(shop: String, tokens: Long): Boolean = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val key = s"budget:$shop"
    val counts = jedis.hmget(key, "requests", "tokens")
    val requests = Option(counts.get(0)).map(_.toLong).getOrElse(0L)
    val used = Option(counts.get(1)).map(_.toLong).getOrElse(0L)
    if (requests + 1 > MaxRequests || used + tokens > MaxTokens) false
    else {
      jedis.hincrBy(key, "requests", 1)
      jedis.hincrBy(key, "tokens", tokens)
      true
    }
  }

  private def call(shop: String, turnId: String, name: String, argsJson: String): String =
    tools
      .withDeadlineAfter(ToolDeadlineMs, TimeUnit.MILLISECONDS)
      .invoke(InvokeRequest(shop = shop, turnId = turnId, name = name, argsJson = argsJson))
      .resultJson

  /** The tool's result for the shop: reads from the cache when it can. */
  def invokeTool(shop: String, turnId: String, name: String, argsJson: String): String =
    if (Catalog.lookup(name).exists(_.writes)) call(shop, turnId, name, argsJson)
    else {
      val key = s"tool:$name:\${sha256Hex(argsJson)}"
      Option(jedis.get(key)).getOrElse {
        val result = call(shop, turnId, name, argsJson)
        jedis.set(key, result)
        result
      }
    }
}
`,
      solution: `import java.security.MessageDigest
import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

import sidekick.{Catalog, Config}
import sidekickrpc.merchant_agent.{InvokeRequest, ToolsGrpc}

object BudgetCache {
  val MaxRequests = 30L
  val MaxTokens = 150000L
  val WindowS = 60L
  val CacheTtlS = 120L
  val WriteClaimTtlS = 86400L
  val ToolDeadlineMs = 10000L

  /** KEYS[1] the shop's window; ARGV tokens, max requests, max tokens, window seconds. 1 reserved, 0 refused. */
  val ReserveLua: String =
    """local requests = tonumber(redis.call('HGET', KEYS[1], 'requests') or '0')
      |local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or '0')
      |local want = tonumber(ARGV[1])
      |if requests + 1 > tonumber(ARGV[2]) or tokens + want > tonumber(ARGV[3]) then
      |  return 0
      |end
      |redis.call('HINCRBY', KEYS[1], 'requests', 1)
      |redis.call('HINCRBY', KEYS[1], 'tokens', want)
      |if redis.call('TTL', KEYS[1]) < 0 then
      |  redis.call('EXPIRE', KEYS[1], ARGV[4])
      |end
      |return 1
      |""".stripMargin

  private val jedis = new JedisPooled("redis", 6379)
  private val tools = ToolsGrpc.blockingStub(ManagedChannelBuilder.forTarget(Config.ToolsAddr).usePlaintext().build())

  private def sha256Hex(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes("UTF-8")).map("%02x".format(_)).mkString

  /** Reserve one model call and its tokens in the shop's current minute; false when either does not fit. */
  def reserve(shop: String, tokens: Long): Boolean = {
    val window = System.currentTimeMillis() / 1000 / WindowS
    val args = List(tokens, MaxRequests, MaxTokens, WindowS).map(_.toString)
    jedis.eval(ReserveLua, List(s"budget:$shop:$window").asJava, args.asJava).asInstanceOf[java.lang.Long] == 1L
  }

  private def call(shop: String, turnId: String, name: String, argsJson: String): String =
    tools
      .withDeadlineAfter(ToolDeadlineMs, TimeUnit.MILLISECONDS)
      .invoke(InvokeRequest(shop = shop, turnId = turnId, name = name, argsJson = argsJson))
      .resultJson

  /** The tool's result for the shop: reads from the shop's cache, writes once per turn. */
  def invokeTool(shop: String, turnId: String, name: String, argsJson: String): String =
    if (Catalog.lookup(name).exists(_.writes)) {
      val claim = s"write:$shop:$turnId:$name"
      if (jedis.set(claim, "", SetParams.setParams().nx().ex(WriteClaimTtlS)) == null) {
        Option(jedis.get(claim)).getOrElse("") // this turn already wrote: answer what it wrote
      } else {
        val result =
          try call(shop, turnId, name, argsJson)
          catch {
            case e: StatusRuntimeException =>
              jedis.del(claim) // nothing was written: let a retry try again
              throw e
          }
        jedis.set(claim, result, SetParams.setParams().ex(WriteClaimTtlS))
        result
      }
    } else {
      val key = s"tool:$shop:$name:\${sha256Hex(argsJson)}"
      Option(jedis.get(key)).getOrElse {
        val result = call(shop, turnId, name, argsJson)
        jedis.set(key, result, SetParams.setParams().ex(CacheTtlS))
        result
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <vector>

#include "digest.h"            // sha256_hex(bytes) — provided
#include "merchant_agent.grpc.pb.h"
#include "sidekick/catalog.h"  // catalog::lookup(name) — provided
#include "sidekick/config.h"   // config::kToolsAddr — provided

constexpr long long kMaxRequests = 30;
constexpr long long kMaxTokens = 150000;
constexpr std::chrono::seconds kToolDeadline{10};

sw::redis::Redis redis("tcp://redis:6379");
auto tools_stub = sidekickrpc::Tools::NewStub(grpc::CreateChannel(config::kToolsAddr, grpc::InsecureChannelCredentials()));

// Reserve one model call and its tokens for the shop; false when either does not fit.
bool reserve(const std::string& shop, long long tokens) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string key = "budget:" + shop;
  std::vector<sw::redis::OptionalString> counts;
  redis.hmget(key, {"requests", "tokens"}, std::back_inserter(counts));
  const long long requests = counts[0] ? std::stoll(*counts[0]) : 0;
  const long long used = counts[1] ? std::stoll(*counts[1]) : 0;
  if (requests + 1 > kMaxRequests || used + tokens > kMaxTokens) return false;
  redis.hincrby(key, "requests", 1);
  redis.hincrby(key, "tokens", tokens);
  return true;
}

std::string call_tool(const std::string& shop, const std::string& turn_id, const std::string& name, const std::string& args_json) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kToolDeadline);
  sidekickrpc::InvokeRequest request;
  request.set_shop(shop);
  request.set_turn_id(turn_id);
  request.set_name(name);
  request.set_args_json(args_json);
  sidekickrpc::InvokeReply reply;
  const grpc::Status status = tools_stub->Invoke(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("tools: " + status.error_message());
  return reply.result_json();
}

// The tool's result for the shop: reads from the cache when it can.
std::string invoke_tool(const std::string& shop, const std::string& turn_id, const std::string& name, const std::string& args_json) {
  const catalog::Tool* tool = catalog::lookup(name);
  if (tool != nullptr && tool->writes) return call_tool(shop, turn_id, name, args_json);
  const std::string key = "tool:" + name + ":" + sha256_hex(args_json);
  if (const auto cached = redis.get(key)) return *cached;
  const std::string result = call_tool(shop, turn_id, name, args_json);
  redis.set(key, result);
  return result;
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "digest.h"            // sha256_hex(bytes) — provided
#include "merchant_agent.grpc.pb.h"
#include "sidekick/catalog.h"  // catalog::lookup(name) — provided
#include "sidekick/config.h"   // config::kToolsAddr — provided

constexpr long long kMaxRequests = 30;
constexpr long long kMaxTokens = 150000;
constexpr long long kWindowS = 60;
constexpr std::chrono::seconds kCacheTtl{120};
constexpr std::chrono::seconds kWriteClaimTtl{86400};
constexpr std::chrono::seconds kToolDeadline{10};

// KEYS[1] the shop's window; ARGV tokens, max requests, max tokens, window seconds. 1 reserved, 0 refused.
const std::string kReserveLua = R"lua(
local requests = tonumber(redis.call('HGET', KEYS[1], 'requests') or '0')
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or '0')
local want = tonumber(ARGV[1])
if requests + 1 > tonumber(ARGV[2]) or tokens + want > tonumber(ARGV[3]) then
  return 0
end
redis.call('HINCRBY', KEYS[1], 'requests', 1)
redis.call('HINCRBY', KEYS[1], 'tokens', want)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
return 1
)lua";

sw::redis::Redis redis("tcp://redis:6379");
auto tools_stub = sidekickrpc::Tools::NewStub(grpc::CreateChannel(config::kToolsAddr, grpc::InsecureChannelCredentials()));

// Reserve one model call and its tokens in the shop's current minute; false when either does not fit.
bool reserve(const std::string& shop, long long tokens) {
  const long long now_s = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string key = "budget:" + shop + ":" + std::to_string(now_s / kWindowS);
  return redis.eval<long long>(kReserveLua, {key},
                               {std::to_string(tokens), std::to_string(kMaxRequests), std::to_string(kMaxTokens), std::to_string(kWindowS)}) == 1;
}

std::string call_tool(const std::string& shop, const std::string& turn_id, const std::string& name, const std::string& args_json) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kToolDeadline);
  sidekickrpc::InvokeRequest request;
  request.set_shop(shop);
  request.set_turn_id(turn_id);
  request.set_name(name);
  request.set_args_json(args_json);
  sidekickrpc::InvokeReply reply;
  const grpc::Status status = tools_stub->Invoke(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("tools: " + status.error_message());
  return reply.result_json();
}

// The tool's result for the shop: reads from the shop's cache, writes once per turn.
std::string invoke_tool(const std::string& shop, const std::string& turn_id, const std::string& name, const std::string& args_json) {
  const catalog::Tool* tool = catalog::lookup(name);
  if (tool != nullptr && tool->writes) {
    const std::string claim = "write:" + shop + ":" + turn_id + ":" + name;
    if (!redis.set(claim, "", kWriteClaimTtl, sw::redis::UpdateType::NOT_EXIST)) return redis.get(claim).value_or("");  // this turn already wrote
    std::string result;
    try {
      result = call_tool(shop, turn_id, name, args_json);
    } catch (...) {
      redis.del(claim);  // nothing was written: let a retry try again
      throw;
    }
    redis.set(claim, result, kWriteClaimTtl);
    return result;
  }
  const std::string key = "tool:" + shop + ":" + name + ":" + sha256_hex(args_json);
  if (const auto cached = redis.get(key)) return *cached;
  const std::string result = call_tool(shop, turn_id, name, args_json);
  redis.set(key, result, kCacheTtl);
  return result;
}
`,
    },
  },
  harness: {
    python: `import merchant_agent_pb2
import merchant_agent_pb2_grpc
from sidekick import config, tools

TORONTO = '{"query":"default_address_city = Toronto"}'
SEO = '{"product_id":"p-1","field":"seo_description"}'


class ToolsPeer(merchant_agent_pb2_grpc.ToolsServicer):
    """The stand-in tools: answers from sidekick.tools."""

    def Invoke(self, request, context):
        return merchant_agent_pb2.InvokeReply(result_json=tools.invoke(request.shop, request.name, request.args_json))


def _world(ctx):
    ctx.grpc.serve(merchant_agent_pb2_grpc.add_ToolsServicer_to_server, ToolsPeer(), config.TOOLS_ADDR)
    return ctx.load("budget_cache")


def _invoked(ctx):
    return [(call.request.shop, call.request.name) for call in ctx.grpc.calls_to("Invoke")]


def check_atomic_reserve(ctx):
    m = _world(ctx)
    sent = []
    original = m.r.execute_command

    def recording(*args, **kwargs):
        sent.append(str(args[0]).upper())
        return original(*args, **kwargs)

    m.r.execute_command = recording
    assert m.reserve("s1", 2000) is True, "the first reservation of a fresh shop must fit"
    scripted = [cmd for cmd in sent if cmd in ("EVAL", "EVALSHA")]
    assert scripted, f"reserve sent {sent} to Redis: the read, the limit test and both increments must run inside one EVAL/EVALSHA, or two replicas both pass the test"
    client_side = [cmd for cmd in sent if cmd in ("HGET", "HMGET", "HGETALL", "HINCRBY", "HSET", "GET", "INCRBY")]
    assert not client_side, f"reserve sent {sent}: {client_side} from the client let another replica land between the read and the increment"
    keys = ctx.redis.keys("budget:s1*")
    assert len(keys) == 1 and ctx.redis.hgetall(keys[0]) == {"requests": "1", "tokens": "2000"}, f"one reservation counts one request and its tokens: {[(k, ctx.redis.hgetall(k)) for k in keys]}"


def check_budget_window(ctx):
    m = _world(ctx)
    results = [m.reserve("s1", 2000) for _ in range(31)]
    assert results[:30] == [True] * 30, f"30 requests fit in a minute, got {results[:30].count(True)} reserved"
    assert results[30] is False, "the 31st request in a minute must be refused"
    keys = ctx.redis.keys("budget:s1*")
    assert keys, "reserve left no budget:s1… key"
    ttl = ctx.redis.ttl(keys[0])
    assert 0 < ttl <= 60, f"{keys[0]} has TTL {ttl}: the counter must expire with its 60 s window, or a shop that had one busy minute is refused for good"
    ctx.clock.advance(60)
    assert m.reserve("s1", 2000) is True, "a minute later the shop is in a new window and must reserve again"
    assert m.reserve("s2", 100_000) is True, "100 000 tokens fit in 150 000"
    assert m.reserve("s2", 60_000) is False, "100 000 + 60 000 tokens is over 150 000 and must be refused"
    assert m.reserve("s2", 50_000) is True, "a refused reservation must not count: 100 000 + 50 000 fits exactly"


def check_shop_scoped_cache(ctx):
    m = _world(ctx)
    first = m.invoke_tool("s1", "t-1", "segment_customers", TORONTO)
    again = m.invoke_tool("s1", "t-2", "segment_customers", TORONTO)
    assert '"shop":"s1"' in first and again == first, f"s1 asked twice and must get its own answer twice: {first!r}, {again!r}"
    assert len(_invoked(ctx)) == 1, f"s1's second identical query must be a cache hit, the tool was called {len(_invoked(ctx))} times"
    other = m.invoke_tool("s2", "t-3", "segment_customers", TORONTO)
    assert '"shop":"s2"' in other, f"s2 asked the same question and got {other!r}: another merchant's customers, served from the cache"
    assert _invoked(ctx) == [("s1", "segment_customers"), ("s2", "segment_customers")], f"each shop's first query reaches the tool: {_invoked(ctx)}"


def check_cache_ttl(ctx):
    m = _world(ctx)
    m.invoke_tool("s1", "t-1", "segment_customers", TORONTO)
    keys = ctx.redis.keys("tool:*")
    assert len(keys) == 1, f"one read leaves one cache key, found {keys}"
    ttl = ctx.redis.ttl(keys[0])
    assert 0 < ttl <= 120, f"{keys[0]} has TTL {ttl}: cached results expire after CACHE_TTL_S = 120"
    ctx.clock.advance(121)
    m.invoke_tool("s1", "t-2", "segment_customers", TORONTO)
    assert len(_invoked(ctx)) == 2, f"after 121 s the next query must reach the tool again, it was called {len(_invoked(ctx))} times: a customer added a minute ago is invisible"


def check_write_once(ctx):
    m = _world(ctx)
    first = m.invoke_tool("s1", "t-1", "fill_product_form", SEO)
    again = m.invoke_tool("s1", "t-1", "fill_product_form", SEO)
    assert _invoked(ctx) == [("s1", "fill_product_form")], f"two fill_product_form calls in turn t-1 reached the tool {len(_invoked(ctx))} times: the form was filled twice"
    assert again == first, f"the second call in the turn answers the stored result: {first!r} then {again!r}"
    ttl = ctx.redis.ttl("write:s1:t-1:fill_product_form")
    assert 82_800 <= ttl <= 86_400, f"the claim write:s1:t-1:fill_product_form must live about a day, TTL {ttl}"
    m.invoke_tool("s1", "t-2", "fill_product_form", SEO)
    assert len(_invoked(ctx)) == 2, "another turn is another write"
`,
    typescript: `const TORONTO = '{"query":"default_address_city = Toronto"}';
const SEO = '{"product_id":"p-1","field":"seo_description"}';

/** The stand-in tools, the learner's module. */
function world(ctx) {
  const {sidekickrpc} = ctx.proto('merchant_agent.proto');
  const config = ctx.load('/support/sidekick/config.ts');
  const tools = ctx.load('/support/sidekick/tools.ts');
  ctx.grpc.serve(sidekickrpc.Tools.service, {
    Invoke(call, callback) {
      callback(null, {result_json: tools.invoke(call.request.shop, call.request.name, call.request.args_json)});
    },
  }, config.TOOLS_ADDR);
  return ctx.load('budget_cache');
}

const invoked = (ctx): string[] => ctx.grpc.callsTo('Invoke').map(call => call.request.shop + ' ' + call.request.name);

export async function check_atomic_reserve(ctx) {
  const m = world(ctx);
  const window = Math.floor(Math.floor(ctx.clock.now() / 1000) / 60);
  const keys = ['budget:s1', \`budget:s1:\${window}\`];
  for (const key of keys) ctx.redis.hset(key, {requests: 29, tokens: 0});
  let other = '';
  // another replica reserving the last request, landing right after this one's first command
  for (const key of keys) {
    ctx.redisAfter(key, () => {
      if (other !== '') return;
      if (Number(ctx.redis.hget(key, 'requests') ?? 0) + 1 > 30) {
        other = 'refused';
        return;
      }
      ctx.redis.hincrby(key, 'requests', 1);
      ctx.redis.hincrby(key, 'tokens', 2000);
      other = 'reserved';
    });
  }
  const mine = (await m.reserve('s1', 2000)) ? 'reserved' : 'refused';
  assert(other !== '', 'reserve never touched budget:s1 or budget:s1:{window}');
  assert.deepEqual([mine, other].sort(), ['refused', 'reserved'], \`one request was left and two replicas got \${mine} and \${other}: the read and the increments must run in one script\`);
  const counts = keys.map(key => Number(ctx.redis.hget(key, 'requests') ?? 0));
  assert(Math.max(...counts) === 30, \`the budget hash must stop at 30 requests, it holds \${JSON.stringify(counts)}\`);
}

export async function check_budget_window(ctx) {
  const m = world(ctx);
  const results: boolean[] = [];
  for (let i = 0; i < 31; i += 1) results.push(await m.reserve('s1', 2000));
  assert.equal(results.slice(0, 30).filter(Boolean).length, 30, \`30 requests fit in a minute, got \${results.slice(0, 30).filter(Boolean).length} reserved\`);
  assert.equal(results[30], false, 'the 31st request in a minute must be refused');
  const keys = ctx.redis.keys('budget:s1*');
  assert(keys.length > 0, 'reserve left no budget:s1… key');
  const ttl = ctx.redis.ttl(keys[0]);
  assert(ttl > 0 && ttl <= 60, \`\${keys[0]} has TTL \${ttl}: the counter must expire with its 60 s window, or a shop that had one busy minute is refused for good\`);
  ctx.clock.advance(60);
  assert.equal(await m.reserve('s1', 2000), true, 'a minute later the shop is in a new window and must reserve again');
  assert.equal(await m.reserve('s2', 100_000), true, '100 000 tokens fit in 150 000');
  assert.equal(await m.reserve('s2', 60_000), false, '100 000 + 60 000 tokens is over 150 000 and must be refused');
  assert.equal(await m.reserve('s2', 50_000), true, 'a refused reservation must not count: 100 000 + 50 000 fits exactly');
}

export async function check_shop_scoped_cache(ctx) {
  const m = world(ctx);
  const first = await m.invokeTool('s1', 't-1', 'segment_customers', TORONTO);
  const again = await m.invokeTool('s1', 't-2', 'segment_customers', TORONTO);
  assert(first.includes('"shop":"s1"') && again === first, \`s1 asked twice and must get its own answer twice: \${first}, \${again}\`);
  assert.equal(invoked(ctx).length, 1, \`s1's second identical query must be a cache hit, the tool was called \${invoked(ctx).length} times\`);
  const other = await m.invokeTool('s2', 't-3', 'segment_customers', TORONTO);
  assert(other.includes('"shop":"s2"'), \`s2 asked the same question and got \${other}: another merchant's customers, served from the cache\`);
  assert.deepEqual(invoked(ctx), ['s1 segment_customers', 's2 segment_customers'], \`each shop's first query reaches the tool: \${JSON.stringify(invoked(ctx))}\`);
}

export async function check_cache_ttl(ctx) {
  const m = world(ctx);
  await m.invokeTool('s1', 't-1', 'segment_customers', TORONTO);
  const keys = ctx.redis.keys('tool:*');
  assert.equal(keys.length, 1, \`one read leaves one cache key, found \${JSON.stringify(keys)}\`);
  const ttl = ctx.redis.ttl(keys[0]);
  assert(ttl > 0 && ttl <= 120, \`\${keys[0]} has TTL \${ttl}: cached results expire after CACHE_TTL_S = 120\`);
  ctx.clock.advance(121);
  await m.invokeTool('s1', 't-2', 'segment_customers', TORONTO);
  assert.equal(invoked(ctx).length, 2, \`after 121 s the next query must reach the tool again, it was called \${invoked(ctx).length} times: a customer added a minute ago is invisible\`);
}

export async function check_write_once(ctx) {
  const m = world(ctx);
  const first = await m.invokeTool('s1', 't-1', 'fill_product_form', SEO);
  const again = await m.invokeTool('s1', 't-1', 'fill_product_form', SEO);
  assert.deepEqual(invoked(ctx), ['s1 fill_product_form'], \`two fill_product_form calls in turn t-1 reached the tool \${invoked(ctx).length} times: the form was filled twice\`);
  assert.equal(again, first, \`the second call in the turn answers the stored result: \${first} then \${again}\`);
  const ttl = ctx.redis.ttl('write:s1:t-1:fill_product_form');
  assert(ttl >= 82_800 && ttl <= 86_400, \`the claim write:s1:t-1:fill_product_form must live about a day, TTL \${ttl}\`);
  await m.invokeTool('s1', 't-2', 'fill_product_form', SEO);
  assert.equal(invoked(ctx).length, 2, 'another turn is another write');
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"sidekick/config"
	"sidekick/tools"
	pb "sidekickrpc/gen/merchant_agent"

	"leetbuild/harness"
)

const (
	budgetToronto = \`{"query":"default_address_city = Toronto"}\`
	budgetSeo     = \`{"product_id":"p-1","field":"seo_description"}\`
)

// budgetTools is the stand-in tools: answers from sidekick/tools.
type budgetTools struct {
	pb.UnimplementedToolsServer
}

func (budgetTools) Invoke(_ context.Context, req *pb.InvokeRequest) (*pb.InvokeReply, error) {
	return &pb.InvokeReply{ResultJson: tools.Invoke(req.GetShop(), req.GetName(), req.GetArgsJson())}, nil
}

func budgetWorld(ctx *harness.Ctx) {
	pb.RegisterToolsServer(ctx.GRPC.Server(config.ToolsAddr), &budgetTools{})
}

func budgetReserve(ctx *harness.Ctx, shop string, tokens int64) bool {
	ok, err := reserve(context.Background(), shop, tokens)
	ctx.NoError(err, "reserve(%q, %d)", shop, tokens)
	return ok
}

func budgetInvoke(ctx *harness.Ctx, shop, turnID, name, args string) string {
	out, err := invokeTool(context.Background(), shop, turnID, name, args)
	ctx.NoError(err, "invokeTool(%q, %q, %q)", shop, turnID, name)
	return out
}

func budgetInvoked(ctx *harness.Ctx) []string {
	out := []string{}
	for _, c := range ctx.GRPC.CallsTo("Invoke", "") {
		req, _ := c.Request.(*pb.InvokeRequest)
		out = append(out, req.GetShop()+" "+req.GetName())
	}
	return out
}

func CheckAtomicReserve(ctx *harness.Ctx) {
	budgetWorld(ctx)
	window := ctx.Clock.Now() / 1000 / 60
	keys := []string{"budget:s1", fmt.Sprintf("budget:s1:%d", window)}
	for _, key := range keys {
		ctx.Redis.Do("HSET", key, "requests", 29, "tokens", 0)
	}
	other := ""
	// another replica reserving the last request, landing right after this one's first command
	for _, k := range keys {
		key := k
		ctx.Redis.After(key, func() any {
			if other != "" {
				return nil
			}
			n, _ := strconv.Atoi(ctx.Redis.HGetAll(key)["requests"])
			if n+1 > 30 {
				other = "refused"
				return nil
			}
			ctx.Redis.Do("HINCRBY", key, "requests", 1)
			ctx.Redis.Do("HINCRBY", key, "tokens", 2000)
			other = "reserved"
			return nil
		})
	}
	mine := "refused"
	if budgetReserve(ctx, "s1", 2000) {
		mine = "reserved"
	}
	ctx.Assert(other != "", "reserve never touched budget:s1 or budget:s1:{window}")
	ctx.Assert(mine != other, "one request was left and two replicas got %s and %s: the read and the increments must run in one script", mine, other)
	most := 0
	for _, key := range keys {
		n, _ := strconv.Atoi(ctx.Redis.HGetAll(key)["requests"])
		if n > most {
			most = n
		}
	}
	ctx.Equal(most, 30, "the budget hash must stop at 30 requests; requests")
}

func CheckBudgetWindow(ctx *harness.Ctx) {
	budgetWorld(ctx)
	reserved := 0
	for i := 0; i < 30; i++ {
		if budgetReserve(ctx, "s1", 2000) {
			reserved++
		}
	}
	ctx.Equal(reserved, 30, "30 requests fit in a minute; reserved")
	ctx.Assert(!budgetReserve(ctx, "s1", 2000), "the 31st request in a minute must be refused")
	keys := ctx.Redis.Keys("budget:s1*")
	ctx.Assert(len(keys) > 0, "reserve left no budget:s1… key")
	ttl := ctx.Redis.TTL(keys[0])
	ctx.Assert(ttl > 0 && ttl <= 60, "%s has TTL %d: the counter must expire with its 60 s window, or a shop that had one busy minute is refused for good", keys[0], ttl)
	ctx.Clock.Advance(60)
	ctx.Assert(budgetReserve(ctx, "s1", 2000), "a minute later the shop is in a new window and must reserve again")
	ctx.Assert(budgetReserve(ctx, "s2", 100000), "100 000 tokens fit in 150 000")
	ctx.Assert(!budgetReserve(ctx, "s2", 60000), "100 000 + 60 000 tokens is over 150 000 and must be refused")
	ctx.Assert(budgetReserve(ctx, "s2", 50000), "a refused reservation must not count: 100 000 + 50 000 fits exactly")
}

func CheckShopScopedCache(ctx *harness.Ctx) {
	budgetWorld(ctx)
	first := budgetInvoke(ctx, "s1", "t-1", "segment_customers", budgetToronto)
	again := budgetInvoke(ctx, "s1", "t-2", "segment_customers", budgetToronto)
	ctx.Assert(strings.Contains(first, \`"shop":"s1"\`) && again == first, "s1 asked twice and must get its own answer twice: %s, %s", first, again)
	ctx.Equal(len(budgetInvoked(ctx)), 1, "s1's second identical query must be a cache hit; tool calls")
	other := budgetInvoke(ctx, "s2", "t-3", "segment_customers", budgetToronto)
	ctx.Assert(strings.Contains(other, \`"shop":"s2"\`), "s2 asked the same question and got %s: another merchant's customers, served from the cache", other)
	ctx.Equal(budgetInvoked(ctx), []string{"s1 segment_customers", "s2 segment_customers"}, "each shop's first query reaches the tool")
}

func CheckCacheTtl(ctx *harness.Ctx) {
	budgetWorld(ctx)
	budgetInvoke(ctx, "s1", "t-1", "segment_customers", budgetToronto)
	keys := ctx.Redis.Keys("tool:*")
	ctx.Equal(len(keys), 1, "one read leaves one cache key (%v)", keys)
	ttl := ctx.Redis.TTL(keys[0])
	ctx.Assert(ttl > 0 && ttl <= 120, "%s has TTL %d: cached results expire after cacheTTL = 120 s", keys[0], ttl)
	ctx.Clock.Advance(121)
	budgetInvoke(ctx, "s1", "t-2", "segment_customers", budgetToronto)
	ctx.Equal(len(budgetInvoked(ctx)), 2, "after 121 s the next query must reach the tool again (a customer added a minute ago is invisible); tool calls")
}

func CheckWriteOnce(ctx *harness.Ctx) {
	budgetWorld(ctx)
	first := budgetInvoke(ctx, "s1", "t-1", "fill_product_form", budgetSeo)
	again := budgetInvoke(ctx, "s1", "t-1", "fill_product_form", budgetSeo)
	ctx.Equal(budgetInvoked(ctx), []string{"s1 fill_product_form"}, "two fill_product_form calls in turn t-1 must fill the form once; tool calls")
	ctx.Equal(again, first, "the second call in the turn answers the stored result")
	ttl := ctx.Redis.TTL("write:s1:t-1:fill_product_form")
	ctx.Assert(ttl >= 82800 && ttl <= 86400, "the claim write:s1:t-1:fill_product_form must live about a day, TTL %d", ttl)
	budgetInvoke(ctx, "s1", "t-2", "fill_product_form", budgetSeo)
	ctx.Equal(len(budgetInvoked(ctx)), 2, "another turn is another write; tool calls")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <cstdlib>
#include <string>
#include <vector>

#include "merchant_agent.grpc.pb.h"
#include "sidekick/config.h"
#include "sidekick/tools.h"

namespace {

const std::string kToronto = R"({"query":"default_address_city = Toronto"})";
const std::string kSeo = R"({"product_id":"p-1","field":"seo_description"})";

// The stand-in tools: answers from sidekick/tools.h.
class BudgetTools final : public sidekickrpc::Tools::Service {
 public:
  grpc::Status Invoke(grpc::ServerContext*, const sidekickrpc::InvokeRequest* req, sidekickrpc::InvokeReply* reply) override {
    reply->set_result_json(tools::invoke(req->shop(), req->name(), req->args_json()));
    return grpc::Status::OK;
  }
};

void budgetWorld(harness::Ctx& ctx) {
  static BudgetTools peer;
  ctx.GRPC.Server(config::kToolsAddr)->RegisterService(&peer);
}

std::vector<std::string> budgetInvoked(harness::Ctx& ctx) {
  std::vector<std::string> out;
  for (const auto& c : ctx.GRPC.CallsTo("Invoke")) {
    const auto req = c.Request<sidekickrpc::InvokeRequest>();
    out.push_back(req.shop() + " " + req.name());
  }
  return out;
}

long long requestsIn(harness::Ctx& ctx, const std::string& key) {
  const auto raw = ctx.Redis.HGet(key, "requests");
  return raw ? std::strtoll(raw->c_str(), nullptr, 10) : 0;
}

}  // namespace

void CheckAtomicReserve(harness::Ctx& ctx) {
  budgetWorld(ctx);
  const long long window = ctx.Clock.Now() / 1000 / 60;
  const std::vector<std::string> keys = {"budget:s1", "budget:s1:" + std::to_string(window)};
  for (const auto& key : keys) ctx.Redis.Do("HSET", key, "requests", 29, "tokens", 0);
  std::string other;
  // another replica reserving the last request, landing right after this one's first command
  for (const auto& key : keys) {
    ctx.Redis.After(key, [&ctx, &other, key] {
      if (!other.empty()) return;
      if (requestsIn(ctx, key) + 1 > 30) {
        other = "refused";
        return;
      }
      ctx.Redis.Do("HINCRBY", key, "requests", 1);
      ctx.Redis.Do("HINCRBY", key, "tokens", 2000);
      other = "reserved";
    });
  }
  const std::string mine = reserve("s1", 2000) ? "reserved" : "refused";
  ctx.Assert(!other.empty(), "reserve never touched budget:s1 or budget:s1:{window}");
  ctx.Assert(mine != other, "one request was left and two replicas got %s and %s: the read and the increments must run in one script", mine, other);
  ctx.Equal(std::max(requestsIn(ctx, keys[0]), requestsIn(ctx, keys[1])), 30, "the budget hash must stop at 30 requests; requests");
}

void CheckBudgetWindow(harness::Ctx& ctx) {
  budgetWorld(ctx);
  int reserved = 0;
  for (int i = 0; i < 30; ++i) reserved += reserve("s1", 2000) ? 1 : 0;
  ctx.Equal(reserved, 30, "30 requests fit in a minute; reserved");
  ctx.Assert(!reserve("s1", 2000), "the 31st request in a minute must be refused");
  const auto keys = ctx.Redis.Keys("budget:s1*");
  ctx.Assert(!keys.empty(), "reserve left no budget:s1… key");
  const long long ttl = ctx.Redis.TTL(keys[0]);
  ctx.Assert(ttl > 0 && ttl <= 60, "%s has TTL %d: the counter must expire with its 60 s window, or a shop that had one busy minute is refused for good", keys[0], ttl);
  ctx.Clock.Advance(60);
  ctx.Assert(reserve("s1", 2000), "a minute later the shop is in a new window and must reserve again");
  ctx.Assert(reserve("s2", 100000), "100 000 tokens fit in 150 000");
  ctx.Assert(!reserve("s2", 60000), "100 000 + 60 000 tokens is over 150 000 and must be refused");
  ctx.Assert(reserve("s2", 50000), "a refused reservation must not count: 100 000 + 50 000 fits exactly");
}

void CheckShopScopedCache(harness::Ctx& ctx) {
  budgetWorld(ctx);
  const std::string first = invoke_tool("s1", "t-1", "segment_customers", kToronto);
  const std::string again = invoke_tool("s1", "t-2", "segment_customers", kToronto);
  ctx.Assert(first.find(R"("shop":"s1")") != std::string::npos && again == first, "s1 asked twice and must get its own answer twice: %s, %s", first, again);
  ctx.Equal(budgetInvoked(ctx).size(), 1, "s1's second identical query must be a cache hit; tool calls");
  const std::string other = invoke_tool("s2", "t-3", "segment_customers", kToronto);
  ctx.Assert(other.find(R"("shop":"s2")") != std::string::npos, "s2 asked the same question and got %s: another merchant's customers, served from the cache", other);
  ctx.Equal(budgetInvoked(ctx), std::vector<std::string>{"s1 segment_customers", "s2 segment_customers"}, "each shop's first query reaches the tool");
}

void CheckCacheTtl(harness::Ctx& ctx) {
  budgetWorld(ctx);
  invoke_tool("s1", "t-1", "segment_customers", kToronto);
  const auto keys = ctx.Redis.Keys("tool:*");
  ctx.Equal(keys.size(), 1, "one read leaves one cache key (%v)", keys);
  const long long ttl = ctx.Redis.TTL(keys[0]);
  ctx.Assert(ttl > 0 && ttl <= 120, "%s has TTL %d: cached results expire after kCacheTtl = 120 s", keys[0], ttl);
  ctx.Clock.Advance(121);
  invoke_tool("s1", "t-2", "segment_customers", kToronto);
  ctx.Equal(budgetInvoked(ctx).size(), 2, "after 121 s the next query must reach the tool again (a customer added a minute ago is invisible); tool calls");
}

void CheckWriteOnce(harness::Ctx& ctx) {
  budgetWorld(ctx);
  const std::string first = invoke_tool("s1", "t-1", "fill_product_form", kSeo);
  const std::string again = invoke_tool("s1", "t-1", "fill_product_form", kSeo);
  ctx.Equal(budgetInvoked(ctx), std::vector<std::string>{"s1 fill_product_form"}, "two fill_product_form calls in turn t-1 must fill the form once; tool calls");
  ctx.Equal(again, first, "the second call in the turn answers the stored result");
  const long long ttl = ctx.Redis.TTL("write:s1:t-1:fill_product_form");
  ctx.Assert(ttl >= 82800 && ttl <= 86400, "the claim write:s1:t-1:fill_product_form must live about a day, TTL %d", ttl);
  invoke_tool("s1", "t-2", "fill_product_form", kSeo);
  ctx.Equal(budgetInvoked(ctx).size(), 2, "another turn is another write; tool calls");
}
`,
  },
  hints: [
    "Symptom: a shop over its limit still gets answers when two admin tabs ask at once, a shop that was busy last Tuesday is refused today, and one merchant's segment answer names another merchant's customers.",
    'Mechanism: `HMGET` and the two `HINCRBY`s are separate round trips, so two replicas both read 29; `budget:{shop}` never expires or rolls over; the cache key has no shop and no TTL; a write tool is invoked on every call.',
    'Change: `RESERVE_LUA` via `register_script` on `budget:{shop}:{window}` with `EXPIRE` on first write; cache key `tool:{shop}:{name}:{digest}` with `ex=CACHE_TTL_S`; for writes `SET write:{shop}:{turn_id}:{name} NX EX 86400` before `Invoke`, and answer the stored value when the claim exists.',
  ],
  debrief: `Every key in this step names its owner and its lifetime. The budget belongs to a shop and a minute, so the shop is in the key, the window is in the key, and the key expires with the window; the script makes "read, test, increment" one step, because replicas share Redis and nothing else. The tool cache is merchant data, so its key carries the shop, and its TTL is how stale an answer may be. A write is claimed before it runs, so a retry answers the first result instead of acting twice, and the claim is released when the call fails. Production systems also refund the unused part of a reservation once the model reports real usage, and invalidate a shop's cached reads when one of its writes lands.`,
};
