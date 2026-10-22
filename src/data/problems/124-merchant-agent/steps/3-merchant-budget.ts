import type {Step} from '@/lib/types';

export const merchantBudgetStep: Step = {
  id: 'merchant-budget',
  title: 'Per-shop budget, shop-scoped tool cache, write tools once',
  concept: 'redis',
  file: 'budget_cache',
  focus: ['api', 'redis', 'tools'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the spending layer the loop
calls: it charges a per-shop budget, caches tool results, and invokes tools. A single shop with budget
left sails through, so the demo passes. It hides a race, a leak, a cross-merchant cache and a
double write. Review it, fix it, and prove the fix.

Implement the spending layer every assist turn goes through:

- Each shop gets **30 requests** and **150 000 tokens** per **60-second window**. The key is
  \`budget:{shop}:{window}\` where \`window\` is \`floor(unix_seconds / 60)\`; a window-less key
  never resets.
- One **atomic Lua \`EVAL\`** reads both counters, rejects when either reservation does not fit, and
  increments both when it does, setting \`EXPIRE\` on first write. A read followed by a separate
  increment lets two concurrent turns both pass the same check.
- **Reserve before the model call.** The draft charges after the answer, so an over-budget turn has
  already been paid for.
- **Tool-result cache**: read-tool results are cached under \`tool:{shop}:{name}:{digest}\` (digest
  = SHA-256 of the args JSON) for **\`CACHE_TTL_S = 120\`** seconds. The draft keys by
  \`(name, digest)\` only — the same "customers from Toronto" query served from another shop's
  cache is a cross-merchant data leak.
- **Write tools run once per turn**: \`fill_product_form\` is claimed with \`SET NX EX\` on
  \`write:{shop}:{turn_id}:{name}\` (24 h); a second attempt in the same turn returns the stored
  result instead of filling the form again.

**Failure mode the checks target.** Two concurrent turns both pass the budget and overspend; a key
without a window locks a shop out after one busy minute, forever; a tenant-less cache key serves one
merchant's customer list to another; and a retried write tool edits the merchant's product twice.`,
  sequence: {
    participants: ['sidekick API', 'Redis', 'Model', 'Tools'],
    messages: [
      {from: 'sidekick API', to: 'Redis', label: 'EVAL reserve · budget:{shop}:{window}', kind: 'sync'},
      {from: 'Redis', to: 'sidekick API', label: '{1, 29, 148 400, 47}', kind: 'reply'},
      {from: 'sidekick API', to: 'Model', label: 'Complete(...) only after the reservation', kind: 'sync'},
      {from: 'Model', to: 'sidekick API', label: 'tool_call segment_customers', kind: 'reply'},
      {from: 'sidekick API', to: 'Redis', label: 'GET tool:{shop}:segment_customers:{digest}', kind: 'sync'},
      {from: 'Redis', to: 'sidekick API', label: 'miss', kind: 'reply'},
      {from: 'sidekick API', to: 'Tools', label: 'Invoke(shop, segment_customers, args)', kind: 'sync'},
      {
        from: 'sidekick API',
        to: 'Redis',
        label: 'SET … EX 120 · SET write:{shop}:{turn}:{name} NX for writes',
        kind: 'async',
      },
    ],
  },
  hints: [
    'The script does all of it on the server: `HGET` both counters, compare against the limits, `HINCRBY` both on success, `EXPIRE` when the key was just created. The key carries the shop and the minute bucket so budgets are per merchant and reset on their own.',
    'A cache key is a tenancy decision. Put the shop first — `tool:{shop}:{name}:{digest}` — and give the entry an `EX` of 120 s. Without the shop, the fastest path through your cache is the one that leaks.',
    'Write tools are not cacheable; they are claimable. `SET write:{shop}:{turn_id}:{name} pending NX EX 86400` succeeds once; when it fails, return what the first run stored. Call `reserve(...)` before `Complete(...)`, and return 429 with `Retry-After` when it refuses.',
  ],
  checks: [
    {
      id: 'atomic-reserve',
      title: 'Reserves both counters in one Lua script with expiry',
      detail:
        'Requests and tokens are read, checked and incremented inside one `EVAL`, which also sets `EXPIRE` on first write. A client-side read followed by `INCRBY` races: two turns can both observe budget that only one of them can spend.',
      match: {
        python: {all: [/RESERVE_LUA/, /\.eval\(/, /HINCRBY/, /EXPIRE/]},
        typescript: {all: [/RESERVE_LUA/, /\.eval\(/, /HINCRBY/, /EXPIRE/]},
        go: {all: [/(reserveScript|NewScript)/, /\.Run\(/, /HINCRBY/, /EXPIRE/]},
        scala: {all: [/ReserveLua/, /\.eval\(/, /HINCRBY/, /EXPIRE/]},
        cpp: {all: [/kReserveLua/, /\.eval</, /HINCRBY/, /EXPIRE/]},
      },
    },
    {
      id: 'shop-window-key',
      title: 'Keys the budget by shop and 60-second window',
      detail:
        'The key is `budget:{shop}:{window}` from the authenticated shop and the minute bucket (`WINDOW_S = 60`). The draft’s `budget:{shop}` never resets, so a shop that had one busy minute is locked out for good.',
      match: {
        python: {all: [/budget:\{shop\}:\{window\}/, /WINDOW_S\s*=\s*60/]},
        typescript: {all: [/budget:\$\{shop\}:\$\{window\}/, /WINDOW_S\s*=\s*60/]},
        go: {all: [/budget:%s:%d/, /windowSeconds\s*=\s*60/]},
        scala: {all: [/budget:\$shop:\$window/, /WindowSeconds\s*=\s*60/]},
        cpp: {all: [/"budget:"\s*\+\s*shop\s*\+\s*":"/, /kWindowSeconds\s*=\s*60/]},
      },
    },
    {
      id: 'shop-scoped-cache',
      title: 'Caches tool results per shop with a 120 s TTL',
      detail:
        'The tool cache key is `tool:{shop}:{name}:{digest}` and every entry is written with `EX CACHE_TTL_S` (120). The draft keys by tool and args only and never expires — a cross-merchant leak that persists.',
      match: {
        python: {all: [/tool:\{shop\}:\{name\}:\{digest\}/, /CACHE_TTL_S\s*=\s*120/, /ex\s*=\s*CACHE_TTL_S/]},
        typescript: {all: [/tool:\$\{shop\}:\$\{name\}:\$\{digest\}/, /CACHE_TTL_S\s*=\s*120/, /'EX',\s*CACHE_TTL_S/]},
        go: {all: [/tool:%s:%s:%s/, /cacheTTL\s*=\s*120\s*\*\s*time\.Second/, /\.Set\([^)]*cacheTTL\)/]},
        scala: {all: [/tool:\$shop:\$name:\$digest/, /CacheTtlS\s*=\s*120/, /\.setex\(/]},
        cpp: {all: [/"tool:"\s*\+\s*shop/, /kCacheTtlS\s*=\s*120/, /std::chrono::seconds\(kCacheTtlS\)/]},
      },
    },
    {
      id: 'write-once',
      title: 'Claims write tools with SET NX per shop and turn',
      detail:
        'A write tool is claimed with `SET write:{shop}:{turn_id}:{name} … NX EX` before it runs; a failed claim returns the stored result. The draft invokes `fill_product_form` on every attempt.',
      match: {
        python: {all: [/write:\{shop\}:\{turn_id\}:\{name\}/, /nx\s*=\s*True/]},
        typescript: {all: [/write:\$\{shop\}:\$\{turnId\}:\$\{name\}/, /'NX'/]},
        go: {all: [/write:%s:%s:%s/, /SetNX\(/]},
        scala: {all: [/write:\$shop:\$turnId:\$name/, /\.nx\(\)/]},
        cpp: {all: [/"write:"\s*\+\s*shop/, /UpdateType::NOT_EXIST/]},
      },
    },
    {
      id: 'reserve-first',
      title: 'Reserves before the model call',
      detail:
        'The reservation runs before `Complete`; a refused turn never reaches the model. The draft calls the model first and charges afterwards, so an over-budget turn is still paid for.',
      match: {
        python: {order: [/reserve\(/, /model\.Complete\(/]},
        typescript: {order: [/reserve\(/, /model\.Complete\(/]},
        go: {order: [/reserve\(/, /model\.Complete\(/]},
        scala: {order: [/reserve\(/, /model[\s\S]{0,80}\.complete\(/]},
        cpp: {order: [/reserve\(/, /model->Complete\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib

import grpc
import redis

import sidekick_pb2
import sidekick_pb2_grpc
from fastapi import HTTPException

r = redis.Redis(host="redis", port=6379, decode_responses=True)
model = sidekick_pb2_grpc.ModelStub(grpc.insecure_channel("model:9000"))
tools = sidekick_pb2_grpc.ToolsStub(grpc.insecure_channel("tools:9000"))

LIMIT_REQUESTS = 30
LIMIT_TOKENS = 150_000
WRITE_TOOLS = {"fill_product_form"}


def charge(shop: str, tokens: int) -> tuple[bool, int, int]:
    # TODO: replace the client-side GET-then-INCRBY with one atomic EVAL on a per-window key with
    # a TTL, scope the tool cache by shop and expire it, claim write tools with SET NX, and reserve
    # before the model call instead of charging after it.
    key = f"budget:{shop}"
    used_req = int(r.get(f"{key}:req") or 0)
    used_tok = int(r.get(f"{key}:tok") or 0)
    if used_req + 1 > LIMIT_REQUESTS or used_tok + tokens > LIMIT_TOKENS:
        return False, LIMIT_REQUESTS - used_req, LIMIT_TOKENS - used_tok
    r.incrby(f"{key}:req", 1)
    r.incrby(f"{key}:tok", tokens)
    return True, LIMIT_REQUESTS - used_req - 1, LIMIT_TOKENS - used_tok - tokens


def invoke_tool(shop: str, turn_id: str, name: str, args_json: str) -> str:
    digest = hashlib.sha256(args_json.encode("utf-8")).hexdigest()[:32]
    key = f"tool:{name}:{digest}"
    if name not in WRITE_TOOLS:
        cached = r.get(key)
        if cached is not None:
            return cached
    result = tools.Invoke(sidekick_pb2.InvokeRequest(shop=shop, name=name, args_json=args_json), timeout=10.0)
    if name not in WRITE_TOOLS:
        r.set(key, result.result_json)
    return result.result_json


def assist_turn(shop: str, turn_id: str, message: str, page: str, max_tokens: int) -> dict:
    wanted = len(message) // 4 + max_tokens
    request = sidekick_pb2.CompleteRequest(
        system="You are Sidekick.",
        messages=[sidekick_pb2.Message(role="user", content=f"[page: {page}] {message}")],
    )
    reply = model.Complete(request, timeout=10.0)
    ok, left_req, left_tok = charge(shop, wanted)
    if not ok:
        raise HTTPException(status_code=429, detail="shop budget exceeded", headers={"Retry-After": "60"})
    if reply.HasField("tool_call"):
        result = invoke_tool(shop, turn_id, reply.tool_call.name, reply.tool_call.args_json)
        return {"tool": reply.tool_call.name, "result": result, "remaining_tokens": left_tok}
    return {"reply": reply.text, "remaining_tokens": left_tok}
`,
      solution: `import hashlib
import json
import time

import grpc
import redis

import sidekick_pb2
import sidekick_pb2_grpc
from fastapi import HTTPException

r = redis.Redis(host="redis", port=6379, decode_responses=True)
model = sidekick_pb2_grpc.ModelStub(grpc.insecure_channel("model:9000"))
tools = sidekick_pb2_grpc.ToolsStub(grpc.insecure_channel("tools:9000"))

WINDOW_S = 60
LIMIT_REQUESTS = 30
LIMIT_TOKENS = 150_000
CACHE_TTL_S = 120
WRITE_CLAIM_TTL_S = 86_400
WRITE_TOOLS = {"fill_product_form"}

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


def budget_key(shop: str, window: int) -> str:
    return f"budget:{shop}:{window}"


def reserve(shop: str, tokens: int) -> tuple[bool, int, int, int]:
    window = int(time.time()) // WINDOW_S
    ok, left_req, left_tok, ttl = r.eval(
        RESERVE_LUA, 1, budget_key(shop, window), 1, tokens, LIMIT_REQUESTS, LIMIT_TOKENS, WINDOW_S
    )
    return bool(ok), int(left_req), int(left_tok), int(ttl)


def cache_key(shop: str, name: str, args_json: str) -> str:
    digest = hashlib.sha256(args_json.encode("utf-8")).hexdigest()[:32]
    return f"tool:{shop}:{name}:{digest}"


def invoke_once(shop: str, name: str, args_json: str) -> str:
    request = sidekick_pb2.InvokeRequest(shop=shop, name=name, args_json=args_json)
    return tools.Invoke(request, timeout=10.0).result_json


def invoke_write(shop: str, turn_id: str, name: str, args_json: str) -> str:
    """A write tool runs once per (shop, turn, tool): the claim is SET NX, the result is stored under it."""
    key = f"write:{shop}:{turn_id}:{name}"
    claimed = r.set(key, "pending", nx=True, ex=WRITE_CLAIM_TTL_S)
    if not claimed:
        stored = r.get(key)
        return stored if stored not in (None, "pending") else json.dumps({"status": "already_applied"})
    result = invoke_once(shop, name, args_json)
    r.set(key, result, ex=WRITE_CLAIM_TTL_S)
    return result


def invoke_tool(shop: str, turn_id: str, name: str, args_json: str) -> str:
    if name in WRITE_TOOLS:
        return invoke_write(shop, turn_id, name, args_json)
    key = cache_key(shop, name, args_json)
    cached = r.get(key)
    if cached is not None:
        return cached
    result = invoke_once(shop, name, args_json)
    r.set(key, result, ex=CACHE_TTL_S)
    return result


def assist_turn(shop: str, turn_id: str, message: str, page: str, max_tokens: int) -> dict:
    wanted = len(message) // 4 + max_tokens
    ok, left_req, left_tok, ttl = reserve(shop, wanted)
    if not ok:
        raise HTTPException(
            status_code=429,
            detail="shop budget exceeded",
            headers={"Retry-After": str(max(ttl, 1)), "X-RateLimit-Remaining": str(left_tok)},
        )
    request = sidekick_pb2.CompleteRequest(
        system="You are Sidekick.",
        messages=[sidekick_pb2.Message(role="user", content=f"[page: {page}] {message}")],
    )
    reply = model.Complete(request, timeout=10.0)
    if reply.HasField("tool_call"):
        result = invoke_tool(shop, turn_id, reply.tool_call.name, reply.tool_call.args_json)
        return {"tool": reply.tool_call.name, "result": result, "remaining_tokens": left_tok}
    return {"reply": reply.text, "remaining_tokens": left_tok}
`,
    },
    typescript: {
      starter: `/** Spending layer: a model-generated draft that charges after the call and caches across shops. */
import {createHash} from 'node:crypto';

import {Redis} from 'ioredis';

import {model, tools} from './clients';

const r = new Redis('redis://redis:6379');

const LIMIT_REQUESTS = 30;
const LIMIT_TOKENS = 150_000;
const WRITE_TOOLS: Record<string, true> = {fill_product_form: true};

export class BudgetExceeded extends Error {
  constructor(
    readonly retryAfter: number,
    readonly remainingTokens: number,
  ) {
    super('shop budget exceeded');
  }
}

async function charge(shop: string, tokens: number): Promise<[boolean, number, number]> {
  // TODO: replace the client-side GET-then-INCRBY with one atomic EVAL on a per-window key with
  // a TTL, scope the tool cache by shop and expire it, claim write tools with SET NX, and reserve
  // before the model call instead of charging after it.
  const key = \`budget:\${shop}\`;
  const usedReq = Number((await r.get(\`\${key}:req\`)) ?? 0);
  const usedTokens = Number((await r.get(\`\${key}:tok\`)) ?? 0);
  if (usedReq + 1 > LIMIT_REQUESTS || usedTokens + tokens > LIMIT_TOKENS)
    return [false, LIMIT_REQUESTS - usedReq, LIMIT_TOKENS - usedTokens];
  await r.incrby(\`\${key}:req\`, 1);
  await r.incrby(\`\${key}:tok\`, tokens);
  return [true, LIMIT_REQUESTS - usedReq - 1, LIMIT_TOKENS - usedTokens - tokens];
}

export async function invokeTool(shop: string, turnId: string, name: string, argsJson: string): Promise<string> {
  const digest = createHash('sha256').update(argsJson).digest('hex').slice(0, 32);
  const key = \`tool:\${name}:\${digest}\`;
  if (WRITE_TOOLS[name] !== true) {
    const cached = await r.get(key);
    if (cached !== null) return cached;
  }
  const result = await tools.Invoke({shop, name, args_json: argsJson});
  if (WRITE_TOOLS[name] !== true) await r.set(key, result.result_json);
  return result.result_json;
}

export async function assistTurn(shop: string, turnId: string, message: string, page: string, maxTokens: number) {
  const wanted = Math.floor(message.length / 4) + maxTokens;
  const reply = await model.Complete({
    system: 'You are Sidekick.',
    messages: [{role: 'user', content: \`[page: \${page}] \${message}\`}],
    tools: [],
    instructions: '',
  });
  const [ok, , leftTokens] = await charge(shop, wanted);
  if (!ok) throw new BudgetExceeded(60, leftTokens);
  if (reply.tool_call !== undefined) {
    const result = await invokeTool(shop, turnId, reply.tool_call.name, reply.tool_call.args_json);
    return {tool: reply.tool_call.name, result, remaining_tokens: leftTokens};
  }
  return {reply: reply.text, remaining_tokens: leftTokens};
}
`,
      solution: `/** Spending layer: atomic per-shop reservation first, shop-scoped tool cache, write tools claimed once. */
import {createHash} from 'node:crypto';

import {Redis} from 'ioredis';

import {model, tools} from './clients';

const r = new Redis('redis://redis:6379');

const WINDOW_S = 60;
const LIMIT_REQUESTS = 30;
const LIMIT_TOKENS = 150_000;
const CACHE_TTL_S = 120;
const WRITE_CLAIM_TTL_S = 86_400;
const WRITE_TOOLS: Record<string, true> = {fill_product_form: true};

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

export class BudgetExceeded extends Error {
  constructor(
    readonly retryAfter: number,
    readonly remainingTokens: number,
  ) {
    super('shop budget exceeded');
  }
}

async function reserve(shop: string, tokens: number): Promise<[boolean, number, number, number]> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const reply = (await r.eval(
    RESERVE_LUA,
    1,
    \`budget:\${shop}:\${window}\`,
    1,
    tokens,
    LIMIT_REQUESTS,
    LIMIT_TOKENS,
    WINDOW_S,
  )) as [number, number, number, number];
  return [reply[0] === 1, reply[1], reply[2], reply[3]];
}

function cacheKey(shop: string, name: string, argsJson: string): string {
  const digest = createHash('sha256').update(argsJson).digest('hex').slice(0, 32);
  return \`tool:\${shop}:\${name}:\${digest}\`;
}

/** A write tool runs once per (shop, turn, tool): the claim is SET NX, the result is stored under it. */
async function invokeWrite(shop: string, turnId: string, name: string, argsJson: string): Promise<string> {
  const key = \`write:\${shop}:\${turnId}:\${name}\`;
  const claimed = await r.set(key, 'pending', 'EX', WRITE_CLAIM_TTL_S, 'NX');
  if (claimed === null) {
    const stored = await r.get(key);
    return stored === null || stored === 'pending' ? JSON.stringify({status: 'already_applied'}) : stored;
  }
  const result = await tools.Invoke({shop, name, args_json: argsJson});
  await r.set(key, result.result_json, 'EX', WRITE_CLAIM_TTL_S);
  return result.result_json;
}

export async function invokeTool(shop: string, turnId: string, name: string, argsJson: string): Promise<string> {
  if (WRITE_TOOLS[name] === true) return invokeWrite(shop, turnId, name, argsJson);
  const key = cacheKey(shop, name, argsJson);
  const cached = await r.get(key);
  if (cached !== null) return cached;
  const result = await tools.Invoke({shop, name, args_json: argsJson});
  await r.set(key, result.result_json, 'EX', CACHE_TTL_S);
  return result.result_json;
}

export async function assistTurn(shop: string, turnId: string, message: string, page: string, maxTokens: number) {
  const wanted = Math.floor(message.length / 4) + maxTokens;
  const [ok, , leftTokens, ttl] = await reserve(shop, wanted);
  if (!ok) throw new BudgetExceeded(Math.max(ttl, 1), leftTokens);
  const reply = await model.Complete({
    system: 'You are Sidekick.',
    messages: [{role: 'user', content: \`[page: \${page}] \${message}\`}],
    tools: [],
    instructions: '',
  });
  if (reply.tool_call !== undefined) {
    const result = await invokeTool(shop, turnId, reply.tool_call.name, reply.tool_call.args_json);
    return {tool: reply.tool_call.name, result, remaining_tokens: leftTokens};
  }
  return {reply: reply.text, remaining_tokens: leftTokens};
}
`,
    },
    go: {
      starter: `package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/redis/go-redis/v9"

	pb "sidekick/sidekickpb"
)

const (
	limitRequests = 30
	limitTokens   = 150000
)

var writeTools = map[string]bool{"fill_product_form": true}

var (
	rdb      *redis.Client
	model    pb.ModelClient
	toolsRPC pb.ToolsClient
)

var ErrBudget = errors.New("shop budget exceeded")

func charge(ctx context.Context, shop string, tokens int64) (bool, int64, int64) {
	// TODO: replace the client-side GET-then-INCRBY with one atomic EVAL on a per-window key with
	// a TTL, scope the tool cache by shop and expire it, claim write tools with SetNX, and reserve
	// before the model call instead of charging after it.
	key := fmt.Sprintf("budget:%s", shop)
	usedReq, _ := rdb.Get(ctx, key+":req").Int64()
	usedTokens, _ := rdb.Get(ctx, key+":tok").Int64()
	if usedReq+1 > limitRequests || usedTokens+tokens > limitTokens {
		return false, limitRequests - usedReq, limitTokens - usedTokens
	}
	rdb.IncrBy(ctx, key+":req", 1)
	rdb.IncrBy(ctx, key+":tok", tokens)
	return true, limitRequests - usedReq - 1, limitTokens - usedTokens - tokens
}

func InvokeTool(ctx context.Context, shop, turnID, name, argsJSON string) (string, error) {
	sum := sha256.Sum256([]byte(argsJSON))
	key := fmt.Sprintf("tool:%s:%s", name, hex.EncodeToString(sum[:16]))
	if !writeTools[name] {
		if cached, err := rdb.Get(ctx, key).Result(); err == nil {
			return cached, nil
		}
	}
	result, err := toolsRPC.Invoke(ctx, &pb.InvokeRequest{Shop: shop, Name: name, ArgsJson: argsJSON})
	if err != nil {
		return "", err
	}
	if !writeTools[name] {
		rdb.Set(ctx, key, result.ResultJson, 0)
	}
	return result.ResultJson, nil
}

func AssistTurn(ctx context.Context, shop, turnID, message, page string, maxTokens int64) (map[string]any, error) {
	wanted := int64(len(message)/4) + maxTokens
	reply, err := model.Complete(ctx, &pb.CompleteRequest{
		System:   "You are Sidekick.",
		Messages: []*pb.Message{{Role: "user", Content: fmt.Sprintf("[page: %s] %s", page, message)}},
	})
	if err != nil {
		return nil, err
	}
	ok, _, leftTokens := charge(ctx, shop, wanted)
	if !ok {
		return nil, ErrBudget
	}
	if reply.ToolCall != nil {
		result, err := InvokeTool(ctx, shop, turnID, reply.ToolCall.Name, reply.ToolCall.ArgsJson)
		if err != nil {
			return nil, err
		}
		return map[string]any{"tool": reply.ToolCall.Name, "result": result, "remaining_tokens": leftTokens}, nil
	}
	return map[string]any{"reply": reply.Text, "remaining_tokens": leftTokens}, nil
}
`,
      solution: `package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	pb "sidekick/sidekickpb"
)

const (
	windowSeconds = 60
	limitRequests = 30
	limitTokens   = 150000
	cacheTTL      = 120 * time.Second
	writeClaimTTL = 24 * time.Hour
)

var writeTools = map[string]bool{"fill_product_form": true}

var (
	rdb      *redis.Client
	model    pb.ModelClient
	toolsRPC pb.ToolsClient
)

type BudgetError struct {
	RetryAfter      int64
	RemainingTokens int64
}

func (e *BudgetError) Error() string { return "shop budget exceeded" }

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

func reserve(ctx context.Context, shop string, tokens int64) (bool, int64, int64, int64, error) {
	window := time.Now().Unix() / windowSeconds
	key := fmt.Sprintf("budget:%s:%d", shop, window)
	values, err := reserveScript.Run(ctx, rdb, []string{key}, 1, tokens, limitRequests, limitTokens, windowSeconds).Int64Slice()
	if err != nil {
		return false, 0, 0, 0, err
	}
	return values[0] == 1, values[1], values[2], values[3], nil
}

func cacheKey(shop, name, argsJSON string) string {
	sum := sha256.Sum256([]byte(argsJSON))
	return fmt.Sprintf("tool:%s:%s:%s", shop, name, hex.EncodeToString(sum[:16]))
}

func invokeOnce(ctx context.Context, shop, name, argsJSON string) (string, error) {
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	result, err := toolsRPC.Invoke(callCtx, &pb.InvokeRequest{Shop: shop, Name: name, ArgsJson: argsJSON})
	if err != nil {
		return "", err
	}
	return result.ResultJson, nil
}

// invokeWrite runs a write tool once per (shop, turn, tool): the claim is SET NX, the result is stored under it.
func invokeWrite(ctx context.Context, shop, turnID, name, argsJSON string) (string, error) {
	key := fmt.Sprintf("write:%s:%s:%s", shop, turnID, name)
	claimed, err := rdb.SetNX(ctx, key, "pending", writeClaimTTL).Result()
	if err != nil {
		return "", err
	}
	if !claimed {
		stored, err := rdb.Get(ctx, key).Result()
		if err != nil || stored == "pending" {
			return \`{"status":"already_applied"}\`, nil
		}
		return stored, nil
	}
	result, err := invokeOnce(ctx, shop, name, argsJSON)
	if err != nil {
		return "", err
	}
	rdb.Set(ctx, key, result, writeClaimTTL)
	return result, nil
}

func InvokeTool(ctx context.Context, shop, turnID, name, argsJSON string) (string, error) {
	if writeTools[name] {
		return invokeWrite(ctx, shop, turnID, name, argsJSON)
	}
	key := cacheKey(shop, name, argsJSON)
	if cached, err := rdb.Get(ctx, key).Result(); err == nil {
		return cached, nil
	}
	result, err := invokeOnce(ctx, shop, name, argsJSON)
	if err != nil {
		return "", err
	}
	rdb.Set(ctx, key, result, cacheTTL)
	return result, nil
}

func AssistTurn(ctx context.Context, shop, turnID, message, page string, maxTokens int64) (map[string]any, error) {
	wanted := int64(len(message)/4) + maxTokens
	ok, _, leftTokens, ttl, err := reserve(ctx, shop, wanted)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, &BudgetError{RetryAfter: max(ttl, 1), RemainingTokens: leftTokens}
	}
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	reply, err := model.Complete(callCtx, &pb.CompleteRequest{
		System:   "You are Sidekick.",
		Messages: []*pb.Message{{Role: "user", Content: fmt.Sprintf("[page: %s] %s", page, message)}},
	})
	if err != nil {
		return nil, err
	}
	if reply.ToolCall != nil {
		result, err := InvokeTool(ctx, shop, turnID, reply.ToolCall.Name, reply.ToolCall.ArgsJson)
		if err != nil {
			return nil, err
		}
		return map[string]any{"tool": reply.ToolCall.Name, "result": result, "remaining_tokens": leftTokens}, nil
	}
	return map[string]any{"reply": reply.Text, "remaining_tokens": leftTokens}, nil
}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest

import io.grpc.ManagedChannelBuilder
import redis.clients.jedis.Jedis

final case class BudgetExceeded(retryAfter: Long, remainingTokens: Long) extends RuntimeException("shop budget exceeded")

object BudgetCache {
  val LimitRequests = 30L
  val LimitTokens = 150000L
  val WriteTools = Set("fill_product_form")

  val jedis = new Jedis("redis", 6379)
  val model = ModelGrpc.blockingStub(ManagedChannelBuilder.forAddress("model", 9000).usePlaintext().build())
  val tools = ToolsGrpc.blockingStub(ManagedChannelBuilder.forAddress("tools", 9000).usePlaintext().build())

  // TODO: replace the client-side GET-then-INCRBY with one atomic EVAL on a per-window key with a
  // TTL, scope the tool cache by shop and expire it, claim write tools with SET NX, and reserve
  // before the model call instead of charging after it.
  def charge(shop: String, tokens: Long): (Boolean, Long, Long) = {
    val key = s"budget:$shop"
    val usedReq = Option(jedis.get(key + ":req")).map(_.toLong).getOrElse(0L)
    val usedTokens = Option(jedis.get(key + ":tok")).map(_.toLong).getOrElse(0L)
    if (usedReq + 1 > LimitRequests || usedTokens + tokens > LimitTokens) {
      (false, LimitRequests - usedReq, LimitTokens - usedTokens)
    } else {
      jedis.incrBy(key + ":req", 1)
      jedis.incrBy(key + ":tok", tokens)
      (true, LimitRequests - usedReq - 1, LimitTokens - usedTokens - tokens)
    }
  }

  def digestOf(argsJson: String): String =
    MessageDigest.getInstance("SHA-256").digest(argsJson.getBytes("UTF-8")).take(16).map("%02x".format(_)).mkString

  def invokeTool(shop: String, turnId: String, name: String, argsJson: String): String = {
    val key = s"tool:$name:\${digestOf(argsJson)}"
    val cached = if (WriteTools.contains(name)) None else Option(jedis.get(key))
    cached.getOrElse {
      val result = tools.invoke(InvokeRequest(shop = shop, name = name, argsJson = argsJson)).resultJson
      if (!WriteTools.contains(name)) jedis.set(key, result)
      result
    }
  }

  def assistTurn(shop: String, turnId: String, message: String, page: String, maxTokens: Long): Map[String, String] = {
    val wanted = message.length / 4 + maxTokens
    val reply = model.complete(
      CompleteRequest(system = "You are Sidekick.", messages = Seq(Message(role = "user", content = s"[page: $page] $message")))
    )
    val (ok, _, leftTokens) = charge(shop, wanted)
    if (!ok) throw BudgetExceeded(60L, leftTokens)
    reply.toolCall match {
      case Some(call) =>
        val result = invokeTool(shop, turnId, call.name, call.argsJson)
        Map("tool" -> call.name, "result" -> result, "remaining_tokens" -> leftTokens.toString)
      case None =>
        Map("reply" -> reply.text, "remaining_tokens" -> leftTokens.toString)
    }
  }
}
`,
      solution: `import java.security.MessageDigest
import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder
import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams

final case class BudgetExceeded(retryAfter: Long, remainingTokens: Long) extends RuntimeException("shop budget exceeded")

object BudgetCache {
  val WindowSeconds = 60L
  val LimitRequests = 30L
  val LimitTokens = 150000L
  val CacheTtlS = 120L
  val WriteClaimTtlS = 86400L
  val WriteTools = Set("fill_product_form")

  val jedis = new Jedis("redis", 6379)
  val model = ModelGrpc.blockingStub(ManagedChannelBuilder.forAddress("model", 9000).usePlaintext().build())
  val tools = ToolsGrpc.blockingStub(ManagedChannelBuilder.forAddress("tools", 9000).usePlaintext().build())

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

  def reserve(shop: String, tokens: Long): (Boolean, Long, Long, Long) = {
    val window = System.currentTimeMillis() / 1000 / WindowSeconds
    val result = jedis
      .eval(
        ReserveLua,
        1,
        s"budget:$shop:$window",
        "1",
        tokens.toString,
        LimitRequests.toString,
        LimitTokens.toString,
        WindowSeconds.toString
      )
      .asInstanceOf[java.util.List[Long]]
    (result.get(0) == 1L, result.get(1), result.get(2), result.get(3))
  }

  def digestOf(argsJson: String): String =
    MessageDigest.getInstance("SHA-256").digest(argsJson.getBytes("UTF-8")).take(16).map("%02x".format(_)).mkString

  def cacheKey(shop: String, name: String, argsJson: String): String = {
    val digest = digestOf(argsJson)
    s"tool:$shop:$name:$digest"
  }

  def invokeOnce(shop: String, name: String, argsJson: String): String =
    tools
      .withDeadlineAfter(10000L, TimeUnit.MILLISECONDS)
      .invoke(InvokeRequest(shop = shop, name = name, argsJson = argsJson))
      .resultJson

  // A write tool runs once per (shop, turn, tool): the claim is SET NX, the result is stored under it.
  def invokeWrite(shop: String, turnId: String, name: String, argsJson: String): String = {
    val key = s"write:$shop:$turnId:$name"
    val claimed = jedis.set(key, "pending", SetParams.setParams().nx().ex(WriteClaimTtlS))
    if (claimed == null) {
      Option(jedis.get(key)).filter(_ != "pending").getOrElse("""{"status":"already_applied"}""")
    } else {
      val result = invokeOnce(shop, name, argsJson)
      jedis.setex(key, WriteClaimTtlS, result)
      result
    }
  }

  def invokeTool(shop: String, turnId: String, name: String, argsJson: String): String = {
    if (WriteTools.contains(name)) invokeWrite(shop, turnId, name, argsJson)
    else {
      val key = cacheKey(shop, name, argsJson)
      Option(jedis.get(key)).getOrElse {
        val result = invokeOnce(shop, name, argsJson)
        jedis.setex(key, CacheTtlS, result)
        result
      }
    }
  }

  def assistTurn(shop: String, turnId: String, message: String, page: String, maxTokens: Long): Map[String, String] = {
    val wanted = message.length / 4 + maxTokens
    val (ok, _, leftTokens, ttl) = reserve(shop, wanted)
    if (!ok) throw BudgetExceeded(math.max(ttl, 1L), leftTokens)
    val reply = model
      .withDeadlineAfter(10000L, TimeUnit.MILLISECONDS)
      .complete(
        CompleteRequest(
          system = "You are Sidekick.",
          messages = Seq(Message(role = "user", content = s"[page: $page] $message"))
        )
      )
    reply.toolCall match {
      case Some(call) =>
        val result = invokeTool(shop, turnId, call.name, call.argsJson)
        Map("tool" -> call.name, "result" -> result, "remaining_tokens" -> leftTokens.toString)
      case None =>
        Map("reply" -> reply.text, "remaining_tokens" -> leftTokens.toString)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include "sidekick.grpc.pb.h"

#include <iomanip>
#include <memory>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <tuple>

using json = nlohmann::json;

constexpr long long kLimitRequests = 30;
constexpr long long kLimitTokens = 150000;
const std::set<std::string> kWriteTools = {"fill_product_form"};

sw::redis::Redis redis("tcp://redis:6379");
std::unique_ptr<sidekick::Model::Stub> model =
    sidekick::Model::NewStub(grpc::CreateChannel("model:9000", grpc::InsecureChannelCredentials()));
std::unique_ptr<sidekick::Tools::Stub> tools =
    sidekick::Tools::NewStub(grpc::CreateChannel("tools:9000", grpc::InsecureChannelCredentials()));

struct BudgetExceeded : std::runtime_error {
  long long retryAfter;
  long long remainingTokens;
  BudgetExceeded(long long retry, long long remaining)
      : std::runtime_error("shop budget exceeded"), retryAfter(retry), remainingTokens(remaining) {}
};

std::string digestOf(const std::string& argsJson) {
  unsigned char hash[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(argsJson.data()), argsJson.size(), hash);
  std::ostringstream out;
  for (int i = 0; i < 16; i++) out << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(hash[i]);
  return out.str();
}

// TODO: replace the client-side GET-then-INCRBY with one atomic EVAL on a per-window key with a
// TTL, scope the tool cache by shop and expire it, claim write tools with SET NX, and reserve
// before the model call instead of charging after it.
std::tuple<bool, long long, long long> charge(const std::string& shop, long long tokens) {
  const auto key = "budget:" + shop;
  auto rawReq = redis.get(key + ":req");
  const long long usedReq = rawReq ? std::stoll(*rawReq) : 0;
  auto rawTok = redis.get(key + ":tok");
  const long long usedTokens = rawTok ? std::stoll(*rawTok) : 0;
  if (usedReq + 1 > kLimitRequests || usedTokens + tokens > kLimitTokens)
    return {false, kLimitRequests - usedReq, kLimitTokens - usedTokens};
  redis.incrby(key + ":req", 1);
  redis.incrby(key + ":tok", tokens);
  return {true, kLimitRequests - usedReq - 1, kLimitTokens - usedTokens - tokens};
}

std::string invokeTool(const std::string& shop, const std::string& turnId, const std::string& name, const std::string& argsJson) {
  const auto key = "tool:" + name + ":" + digestOf(argsJson);
  const bool isWrite = kWriteTools.count(name) > 0;
  if (!isWrite) {
    if (auto cached = redis.get(key)) return *cached;
  }
  grpc::ClientContext ctx;
  sidekick::InvokeRequest request;
  request.set_shop(shop);
  request.set_name(name);
  request.set_args_json(argsJson);
  sidekick::InvokeReply reply;
  const grpc::Status status = tools->Invoke(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("tool failed: " + status.error_message());
  if (!isWrite) redis.set(key, reply.result_json());
  return reply.result_json();
}

json assistTurn(const std::string& shop, const std::string& turnId, const std::string& message, const std::string& page, long long maxTokens) {
  const long long wanted = static_cast<long long>(message.size()) / 4 + maxTokens;
  grpc::ClientContext ctx;
  sidekick::CompleteRequest request;
  request.set_system("You are Sidekick.");
  auto* first = request.add_messages();
  first->set_role("user");
  first->set_content("[page: " + page + "] " + message);
  sidekick::CompleteReply reply;
  const grpc::Status status = model->Complete(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("model failed: " + status.error_message());
  const auto [ok, leftReq, leftTokens] = charge(shop, wanted);
  if (!ok) throw BudgetExceeded(60, leftTokens);
  if (reply.has_tool_call()) {
    const auto result = invokeTool(shop, turnId, reply.tool_call().name(), reply.tool_call().args_json());
    return json{{"tool", reply.tool_call().name()}, {"result", result}, {"remaining_tokens", leftTokens}};
  }
  return json{{"reply", reply.text()}, {"remaining_tokens", leftTokens}};
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include "sidekick.grpc.pb.h"

#include <algorithm>
#include <chrono>
#include <iomanip>
#include <memory>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <tuple>
#include <vector>

using json = nlohmann::json;

constexpr long long kWindowSeconds = 60;
constexpr long long kLimitRequests = 30;
constexpr long long kLimitTokens = 150000;
constexpr long long kCacheTtlS = 120;
constexpr long long kWriteClaimTtlS = 86400;
constexpr int kCallDeadlineMs = 10000;
const std::set<std::string> kWriteTools = {"fill_product_form"};

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

sw::redis::Redis redis("tcp://redis:6379");
std::unique_ptr<sidekick::Model::Stub> model =
    sidekick::Model::NewStub(grpc::CreateChannel("model:9000", grpc::InsecureChannelCredentials()));
std::unique_ptr<sidekick::Tools::Stub> tools =
    sidekick::Tools::NewStub(grpc::CreateChannel("tools:9000", grpc::InsecureChannelCredentials()));

struct BudgetExceeded : std::runtime_error {
  long long retryAfter;
  long long remainingTokens;
  BudgetExceeded(long long retry, long long remaining)
      : std::runtime_error("shop budget exceeded"), retryAfter(retry), remainingTokens(remaining) {}
};

std::chrono::system_clock::time_point callDeadline() {
  return std::chrono::system_clock::now() + std::chrono::milliseconds(kCallDeadlineMs);
}

std::tuple<bool, long long, long long, long long> reserve(const std::string& shop, long long tokens) {
  const auto window = std::chrono::duration_cast<std::chrono::seconds>(
                          std::chrono::system_clock::now().time_since_epoch())
                          .count() /
                      kWindowSeconds;
  const auto key = "budget:" + shop + ":" + std::to_string(window);
  const auto result = redis.eval<std::vector<long long>>(
      kReserveLua, {key}, {1, tokens, kLimitRequests, kLimitTokens, kWindowSeconds});
  return {result[0] == 1, result[1], result[2], result[3]};
}

std::string digestOf(const std::string& argsJson) {
  unsigned char hash[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(argsJson.data()), argsJson.size(), hash);
  std::ostringstream out;
  for (int i = 0; i < 16; i++) out << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(hash[i]);
  return out.str();
}

std::string invokeOnce(const std::string& shop, const std::string& name, const std::string& argsJson) {
  grpc::ClientContext ctx;
  ctx.set_deadline(callDeadline());
  sidekick::InvokeRequest request;
  request.set_shop(shop);
  request.set_name(name);
  request.set_args_json(argsJson);
  sidekick::InvokeReply reply;
  const grpc::Status status = tools->Invoke(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("tool failed: " + status.error_message());
  return reply.result_json();
}

// A write tool runs once per (shop, turn, tool): the claim is SET NX, the result is stored under it.
std::string invokeWrite(const std::string& shop, const std::string& turnId, const std::string& name, const std::string& argsJson) {
  const auto key = "write:" + shop + ":" + turnId + ":" + name;
  const bool claimed =
      redis.set(key, "pending", std::chrono::seconds(kWriteClaimTtlS), sw::redis::UpdateType::NOT_EXIST);
  if (!claimed) {
    const auto stored = redis.get(key);
    if (!stored || *stored == "pending") return R"({"status":"already_applied"})";
    return *stored;
  }
  const auto result = invokeOnce(shop, name, argsJson);
  redis.set(key, result, std::chrono::seconds(kWriteClaimTtlS));
  return result;
}

std::string invokeTool(const std::string& shop, const std::string& turnId, const std::string& name, const std::string& argsJson) {
  if (kWriteTools.count(name) > 0) return invokeWrite(shop, turnId, name, argsJson);
  const auto key = "tool:" + shop + ":" + name + ":" + digestOf(argsJson);
  if (auto cached = redis.get(key)) return *cached;
  const auto result = invokeOnce(shop, name, argsJson);
  redis.set(key, result, std::chrono::seconds(kCacheTtlS));
  return result;
}

json assistTurn(const std::string& shop, const std::string& turnId, const std::string& message, const std::string& page, long long maxTokens) {
  const long long wanted = static_cast<long long>(message.size()) / 4 + maxTokens;
  const auto [ok, leftReq, leftTokens, ttl] = reserve(shop, wanted);
  if (!ok) throw BudgetExceeded(std::max(ttl, 1LL), leftTokens);
  grpc::ClientContext ctx;
  ctx.set_deadline(callDeadline());
  sidekick::CompleteRequest request;
  request.set_system("You are Sidekick.");
  auto* first = request.add_messages();
  first->set_role("user");
  first->set_content("[page: " + page + "] " + message);
  sidekick::CompleteReply reply;
  const grpc::Status status = model->Complete(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("model failed: " + status.error_message());
  if (reply.has_tool_call()) {
    const auto result = invokeTool(shop, turnId, reply.tool_call().name(), reply.tool_call().args_json());
    return json{{"tool", reply.tool_call().name()}, {"result", result}, {"remaining_tokens", leftTokens}};
  }
  return json{{"reply", reply.text()}, {"remaining_tokens", leftTokens}};
}
`,
    },
  },
  debrief: `The interview question behind this step is tenancy under concurrency. A read-then-increment budget passes every serial test and fails when the assistant is busy, which is when the budget matters; one Lua script makes read, check and increment a single step and sets the window's expiry at creation, so a shop's counters die with their minute instead of accumulating forever. Reserving before the model call is the second half of the contract: a refused turn must never be paid for. The cache is where generated code quietly crosses merchants — a key built from the tool and its arguments is the same key for every shop that asks the same question, and the fastest path through the cache becomes the leak. The write claim is the agent-specific flaw: an assistant that fills product forms is a system that edits merchant data, and a retried turn, a retried tool call or a replayed request must not edit it twice. Real systems add per-tool TTLs (an analytics answer can live longer than a customer segment), invalidation when the merchant edits the underlying record, and a refund of reserved tokens when the model reports lower usage than estimated.`,
};
