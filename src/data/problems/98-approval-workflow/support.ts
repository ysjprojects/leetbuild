/**
 * Hand-written support modules the approval-workflow steps import but no step builds: the
 * `approvals` package. `policy` is the chain policy store (the current definition of every chain:
 * a version and its approvers in order); `store` is the request store (one hash per submitted
 * request, plus the Idempotency-Key index); `chain` is the approval state machine of step 2 as
 * later steps use it (`start_chain`, `advance`, one Lua compare-and-swap per decision); `outbox`
 * is the table a relay republishes from when the broker rejected an event. The five languages keep
 * the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

/** One decision as one compare-and-swap: step 2's solution and the provided `chain.advance` run this script. */
export const ADVANCE_LUA = `local key = KEYS[1]
if redis.call('EXISTS', key) == 0 then return {'0', '-1', 'missing', 'no such request'} end
local index = tonumber(redis.call('HGET', key, 'step_index'))
local status = redis.call('HGET', key, 'status')
if status ~= 'pending' then return {'0', tostring(index), status, 'chain closed'} end
if tonumber(ARGV[1]) ~= index then return {'0', tostring(index), status, 'stale step'} end
if redis.call('HGET', key, 'current_approver') ~= ARGV[2] then return {'0', tostring(index), status, 'not the current approver'} end
if ARGV[3] ~= 'approved' and ARGV[3] ~= 'rejected' then return {'0', tostring(index), status, 'unknown decision'} end
redis.call('HSET', key, 'decision:' .. index, ARGV[3], 'actor:' .. index, ARGV[2])
if ARGV[3] == 'rejected' then
  redis.call('HSET', key, 'status', 'rejected', 'current_approver', '')
  return {'1', tostring(index), 'rejected', ''}
end
local next_index = index + 1
if next_index >= tonumber(redis.call('HGET', key, 'step_count')) then
  redis.call('HSET', key, 'step_index', next_index, 'status', 'approved', 'current_approver', '')
  return {'1', tostring(next_index), 'approved', ''}
end
redis.call('HSET', key, 'step_index', next_index, 'current_approver', redis.call('HGET', key, 'approver:' .. next_index))
return {'1', tostring(next_index), 'pending', ''}
`;

/** The Lua script with its lines indented for a Scala `stripMargin` string (step 2's Scala solution uses it too). */
export const ADVANCE_LUA_SCALA = ADVANCE_LUA.trimEnd()
  .split('\n')
  .map((line, i) => (i === 0 ? line : `      |${line}`))
  .join('\n');

export const supportModules: Record<string, string> = {
  'approvals/__init__.py': '',
  'approvals/policy.py': `"""
The chain policy store (provided): policy:{chain_id} is a Redis hash with the current definition of
a chain, its version and its approvers in order (comma-joined). define_chain is the policy admin's
path (a new definition replaces the old one); resolve_approvers answers the current definition.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def define_chain(chain_id: str, version: int, approvers: list[str]) -> None:
    """Make (version, approvers) the current definition of chain_id."""
    r.hset(f"policy:{chain_id}", mapping={"version": version, "approvers": ",".join(approvers)})


def resolve_approvers(chain_id: str) -> dict | None:
    """The current definition {"version": int, "approvers": [actor ids]}, or None for an unknown chain."""
    raw = r.hgetall(f"policy:{chain_id}")
    if not raw:
        return None
    return {"version": int(raw["version"]), "approvers": [a for a in raw["approvers"].split(",") if a]}
`,
  'approvals/store.py': `"""
The request store (provided): request:{id} is a Redis hash with request_id, tenant, requester,
chain_id, chain_version, approvers (comma-joined), why and amount_cents. idem:{tenant}:{key} holds
the id of the request a submit with that Idempotency-Key stored; request:seq numbers the requests.
A request is a dict with chain_version and amount_cents as ints and approvers as a list.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def new_request_id() -> str:
    """A fresh request id: r-1, r-2, ..."""
    return f"r-{r.incr('request:seq')}"


def put(request: dict, idem_key: str) -> None:
    """Store the request; with a non-empty Idempotency-Key, index it under (tenant, key) too."""
    r.hset(
        f"request:{request['request_id']}",
        mapping={
            "request_id": request["request_id"],
            "tenant": request["tenant"],
            "requester": request["requester"],
            "chain_id": request["chain_id"],
            "chain_version": request["chain_version"],
            "approvers": ",".join(request["approvers"]),
            "why": request["why"],
            "amount_cents": request["amount_cents"],
        },
    )
    if idem_key:
        r.set(f"idem:{request['tenant']}:{idem_key}", request["request_id"])


def load(request_id: str) -> dict | None:
    """The stored request, or None."""
    raw = r.hgetall(f"request:{request_id}")
    if not raw:
        return None
    return {
        **raw,
        "chain_version": int(raw["chain_version"]),
        "amount_cents": int(raw["amount_cents"]),
        "approvers": [a for a in raw["approvers"].split(",") if a],
    }


def get(tenant: str, idem_key: str) -> dict | None:
    """The request a submit with this (tenant, Idempotency-Key) stored, if any."""
    request_id = r.get(f"idem:{tenant}:{idem_key}")
    return load(request_id) if request_id else None
`,
  'approvals/chain.py': `"""
The approval state machine (provided; step 2 builds the same two functions). approval:{id}:state is
one Redis hash per request: step_index, step_count, status (pending, approved or rejected),
current_approver, approver:{i} per step, and decision:{i} and actor:{i} per decided step. It has no
TTL. advance runs one Lua script: it refuses a closed chain, a stale step_index, an actor who is not
the current approver and an unknown decision, records the decision, and moves exactly one step (a
rejection closes the chain). It answers {"advanced", "step_index", "status", "reason"}.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

ADVANCE_LUA = """
${ADVANCE_LUA}"""
advance_script = r.register_script(ADVANCE_LUA)


def state_key(request_id: str) -> str:
    return f"approval:{request_id}:state"


def start_chain(request_id: str, approvers: list[str]) -> None:
    """Open the chain at step 0 with the pinned approvers."""
    fields = {"step_index": 0, "step_count": len(approvers), "status": "pending", "current_approver": approvers[0]}
    for i, approver in enumerate(approvers):
        fields[f"approver:{i}"] = approver
    r.hset(state_key(request_id), mapping=fields)


def advance(request_id: str, step_index: int, actor: str, decision: str) -> dict:
    """Record actor's decision ("approved" or "rejected") on step step_index, if it is still the current step and theirs."""
    advanced, index, status, reason = advance_script(keys=[state_key(request_id)], args=[step_index, actor, decision])
    return {"advanced": advanced == "1", "step_index": int(index), "status": status, "reason": reason}
`,
  'approvals/outbox.py': `"""
The outbox (provided): the Redis list outbox holds one JSON row {"topic", "key", "payload"} per event
the broker did not take; a relay republishes the rows in order.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def insert(topic: str, key: str, payload: dict) -> None:
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
};

export const supportModulesTs: Record<string, string> = {
  'approvals/policy.ts': `/**
 * The chain policy store (provided): policy:{chain_id} is a Redis hash with the current definition of
 * a chain, its version and its approvers in order (comma-joined). defineChain is the policy admin's
 * path (a new definition replaces the old one); resolveApprovers answers the current definition.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface ChainPolicy {
  version: number;
  approvers: string[];
}

/** Make (version, approvers) the current definition of chainId. */
export async function defineChain(chainId: string, version: number, approvers: string[]): Promise<void> {
  await redis.hset(\`policy:\${chainId}\`, {version: String(version), approvers: approvers.join(',')});
}

/** The current definition, or null for an unknown chain. */
export async function resolveApprovers(chainId: string): Promise<ChainPolicy | null> {
  const raw = await redis.hgetall(\`policy:\${chainId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {version: Number(raw.version), approvers: raw.approvers.split(',').filter(a => a !== '')};
}
`,
  'approvals/store.ts': `/**
 * The request store (provided): request:{id} is a Redis hash with request_id, tenant, requester,
 * chain_id, chain_version, approvers (comma-joined), why and amount_cents. idem:{tenant}:{key} holds
 * the id of the request a submit with that Idempotency-Key stored; request:seq numbers the requests.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface ApprovalRequest {
  request_id: string;
  tenant: string;
  requester: string;
  chain_id: string;
  chain_version: number;
  approvers: string[];
  why: string;
  amount_cents: number;
}

/** A fresh request id: r-1, r-2, ... */
export async function newRequestId(): Promise<string> {
  return \`r-\${await redis.incr('request:seq')}\`;
}

/** Store the request; with a non-empty Idempotency-Key, index it under (tenant, key) too. */
export async function put(request: ApprovalRequest, idemKey: string): Promise<void> {
  await redis.hset(\`request:\${request.request_id}\`, {
    request_id: request.request_id,
    tenant: request.tenant,
    requester: request.requester,
    chain_id: request.chain_id,
    chain_version: String(request.chain_version),
    approvers: request.approvers.join(','),
    why: request.why,
    amount_cents: String(request.amount_cents),
  });
  if (idemKey !== '') await redis.set(\`idem:\${request.tenant}:\${idemKey}\`, request.request_id);
}

/** The stored request, or null. */
export async function load(requestId: string): Promise<ApprovalRequest | null> {
  const raw = await redis.hgetall(\`request:\${requestId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {
    request_id: raw.request_id,
    tenant: raw.tenant,
    requester: raw.requester,
    chain_id: raw.chain_id,
    chain_version: Number(raw.chain_version),
    approvers: raw.approvers.split(',').filter(a => a !== ''),
    why: raw.why,
    amount_cents: Number(raw.amount_cents),
  };
}

/** The request a submit with this (tenant, Idempotency-Key) stored, if any. */
export async function get(tenant: string, idemKey: string): Promise<ApprovalRequest | null> {
  const requestId = await redis.get(\`idem:\${tenant}:\${idemKey}\`);
  return requestId === null ? null : load(requestId);
}
`,
  'approvals/chain.ts': `/**
 * The approval state machine (provided; step 2 builds the same two functions). approval:{id}:state
 * is one Redis hash per request: step_index, step_count, status (pending, approved or rejected),
 * current_approver, approver:{i} per step, and decision:{i} and actor:{i} per decided step. It has
 * no TTL. advance runs one Lua script: it refuses a closed chain, a stale step_index, an actor who is
 * not the current approver and an unknown decision, records the decision, and moves exactly one step
 * (a rejection closes the chain).
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const ADVANCE_LUA = \`
${ADVANCE_LUA}\`;

export interface Outcome {
  advanced: boolean;
  step_index: number;
  status: string;
  reason: string;
}

export const stateKey = (requestId: string): string => \`approval:\${requestId}:state\`;

/** Open the chain at step 0 with the pinned approvers. */
export async function startChain(requestId: string, approvers: string[]): Promise<void> {
  const fields: Record<string, string> = {
    step_index: '0',
    step_count: String(approvers.length),
    status: 'pending',
    current_approver: approvers[0],
  };
  approvers.forEach((approver, i) => {
    fields[\`approver:\${i}\`] = approver;
  });
  await redis.hset(stateKey(requestId), fields);
}

/** Record actor's decision ("approved" or "rejected") on step stepIndex, if it is still the current step and theirs. */
export async function advance(requestId: string, stepIndex: number, actor: string, decision: string): Promise<Outcome> {
  const [advanced, index, status, reason] = (await redis.eval(ADVANCE_LUA, 1, stateKey(requestId), String(stepIndex), actor, decision)) as string[];
  return {advanced: advanced === '1', step_index: Number(index), status, reason};
}
`,
  'approvals/outbox.ts': `/**
 * The outbox (provided): the Redis list outbox holds one JSON row {topic, key, payload} per event the
 * broker did not take; a relay republishes the rows in order.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export async function insert(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'approvals/policy/policy.go': `// Package policy is the chain policy store (provided): policy:{chain_id} is a Redis hash with the
// current definition of a chain, its version and its approvers in order (comma-joined).
// DefineChain is the policy admin's path (a new definition replaces the old one); ResolveApprovers
// answers the current definition.
package policy

import (
	"context"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Chain is one definition of a chain: its version and its approvers in order.
type Chain struct {
	Version   int
	Approvers []string
}

// DefineChain makes (version, approvers) the current definition of chainID.
func DefineChain(ctx context.Context, chainID string, version int, approvers []string) error {
	return rdb.HSet(ctx, "policy:"+chainID, "version", strconv.Itoa(version), "approvers", strings.Join(approvers, ",")).Err()
}

// ResolveApprovers is the current definition of chainID, or nil for an unknown chain.
func ResolveApprovers(ctx context.Context, chainID string) (*Chain, error) {
	raw, err := rdb.HGetAll(ctx, "policy:"+chainID).Result()
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	version, _ := strconv.Atoi(raw["version"])
	chain := &Chain{Version: version}
	for _, a := range strings.Split(raw["approvers"], ",") {
		if a != "" {
			chain.Approvers = append(chain.Approvers, a)
		}
	}
	return chain, nil
}
`,
  'approvals/store/store.go': `// Package store is the request store (provided): request:{id} is a Redis hash with request_id,
// tenant, requester, chain_id, chain_version, approvers (comma-joined), why and amount_cents.
// idem:{tenant}:{key} holds the id of the request a submit with that Idempotency-Key stored;
// request:seq numbers the requests.
package store

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Request is one submitted approval request.
type Request struct {
	RequestID    string   \`json:"request_id"\`
	Tenant       string   \`json:"tenant"\`
	Requester    string   \`json:"requester"\`
	ChainID      string   \`json:"chain_id"\`
	ChainVersion int      \`json:"chain_version"\`
	Approvers    []string \`json:"approvers"\`
	Why          string   \`json:"why"\`
	AmountCents  int64    \`json:"amount_cents"\`
}

// NewRequestID is a fresh request id: r-1, r-2, ...
func NewRequestID(ctx context.Context) (string, error) {
	n, err := rdb.Incr(ctx, "request:seq").Result()
	return fmt.Sprintf("r-%d", n), err
}

// Put stores the request; with a non-empty Idempotency-Key, it indexes it under (tenant, key) too.
func Put(ctx context.Context, req *Request, idemKey string) error {
	err := rdb.HSet(ctx, "request:"+req.RequestID,
		"request_id", req.RequestID, "tenant", req.Tenant, "requester", req.Requester, "chain_id", req.ChainID,
		"chain_version", strconv.Itoa(req.ChainVersion), "approvers", strings.Join(req.Approvers, ","),
		"why", req.Why, "amount_cents", strconv.FormatInt(req.AmountCents, 10)).Err()
	if err != nil || idemKey == "" {
		return err
	}
	return rdb.Set(ctx, "idem:"+req.Tenant+":"+idemKey, req.RequestID, 0).Err()
}

// Load is the stored request, or nil.
func Load(ctx context.Context, requestID string) (*Request, error) {
	raw, err := rdb.HGetAll(ctx, "request:"+requestID).Result()
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	version, _ := strconv.Atoi(raw["chain_version"])
	amount, _ := strconv.ParseInt(raw["amount_cents"], 10, 64)
	req := &Request{RequestID: raw["request_id"], Tenant: raw["tenant"], Requester: raw["requester"], ChainID: raw["chain_id"],
		ChainVersion: version, Why: raw["why"], AmountCents: amount}
	for _, a := range strings.Split(raw["approvers"], ",") {
		if a != "" {
			req.Approvers = append(req.Approvers, a)
		}
	}
	return req, nil
}

// Get is the request a submit with this (tenant, Idempotency-Key) stored, or nil.
func Get(ctx context.Context, tenant, idemKey string) (*Request, error) {
	requestID, err := rdb.Get(ctx, "idem:"+tenant+":"+idemKey).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return Load(ctx, requestID)
}
`,
  'approvals/chain/chain.go': `// Package chain is the approval state machine (provided; step 2 builds the same two functions).
// approval:{id}:state is one Redis hash per request: step_index, step_count, status (pending,
// approved or rejected), current_approver, approver:{i} per step, and decision:{i} and actor:{i}
// per decided step. It has no TTL. Advance runs one Lua script: it refuses a closed chain, a stale
// step_index, an actor who is not the current approver and an unknown decision, records the
// decision, and moves exactly one step (a rejection closes the chain).
package chain

import (
	"context"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var advanceScript = redis.NewScript(\`
${ADVANCE_LUA}\`)

// Outcome is what a decision did to the chain.
type Outcome struct {
	Advanced  bool   \`json:"advanced"\`
	StepIndex int    \`json:"step_index"\`
	Status    string \`json:"status"\`
	Reason    string \`json:"reason"\`
}

// StateKey is the hash holding a request's approval state.
func StateKey(requestID string) string {
	return "approval:" + requestID + ":state"
}

// StartChain opens the chain at step 0 with the pinned approvers.
func StartChain(ctx context.Context, requestID string, approvers []string) error {
	fields := []any{"step_index", "0", "step_count", strconv.Itoa(len(approvers)), "status", "pending", "current_approver", approvers[0]}
	for i, approver := range approvers {
		fields = append(fields, fmt.Sprintf("approver:%d", i), approver)
	}
	return rdb.HSet(ctx, StateKey(requestID), fields...).Err()
}

// Advance records actor's decision ("approved" or "rejected") on step stepIndex, if it is still the
// current step and theirs.
func Advance(ctx context.Context, requestID string, stepIndex int, actor, decision string) (Outcome, error) {
	reply, err := advanceScript.Run(ctx, rdb, []string{StateKey(requestID)}, stepIndex, actor, decision).StringSlice()
	if err != nil {
		return Outcome{}, err
	}
	index, _ := strconv.Atoi(reply[1])
	return Outcome{Advanced: reply[0] == "1", StepIndex: index, Status: reply[2], Reason: reply[3]}, nil
}
`,
  'approvals/outbox/outbox.go': `// Package outbox is the outbox (provided): the Redis list outbox holds one JSON row
// {"topic", "key", "payload"} per event the broker did not take; a relay republishes the rows in order.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Insert appends one row for the relay.
func Insert(ctx context.Context, topic, key string, payload map[string]any) error {
	row, err := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, "outbox", row).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'approvals/policy.h': `// The chain policy store (provided): policy:{chain_id} is a Redis hash with the current definition
// of a chain, its version and its approvers in order (comma-joined). defineChain is the policy
// admin's path (a new definition replaces the old one); resolveApprovers answers the current
// definition.
#pragma once

#include <sw/redis++/redis++.h>

#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

namespace policy {

struct Chain {
  long version = 0;
  std::vector<std::string> approvers;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Make (version, approvers) the current definition of chain_id.
inline void defineChain(const std::string& chain_id, long version, const std::vector<std::string>& approvers) {
  std::string joined;
  for (const auto& a : approvers) joined += (joined.empty() ? "" : ",") + a;
  redis().hset("policy:" + chain_id, {std::make_pair(std::string("version"), std::to_string(version)), std::make_pair(std::string("approvers"), joined)});
}

// The current definition of chain_id, or none for an unknown chain.
inline std::optional<Chain> resolveApprovers(const std::string& chain_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("policy:" + chain_id);
  if (raw.empty()) return std::nullopt;
  Chain chain;
  chain.version = std::stol(raw.at("version"));
  std::stringstream list(raw.at("approvers"));
  for (std::string a; std::getline(list, a, ',');) {
    if (!a.empty()) chain.approvers.push_back(a);
  }
  return chain;
}

}  // namespace policy
`,
  'approvals/store.h': `// The request store (provided): request:{id} is a Redis hash with request_id, tenant, requester,
// chain_id, chain_version, approvers (comma-joined), why and amount_cents. idem:{tenant}:{key} holds
// the id of the request a submit with that Idempotency-Key stored; request:seq numbers the requests.
#pragma once

#include <sw/redis++/redis++.h>

#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace store {

struct Request {
  std::string request_id;
  std::string tenant;
  std::string requester;
  std::string chain_id;
  long chain_version = 0;
  std::vector<std::string> approvers;
  std::string why;
  long long amount_cents = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// A fresh request id: r-1, r-2, ...
inline std::string newRequestId() { return "r-" + std::to_string(redis().incr("request:seq")); }

// Store the request; with a non-empty Idempotency-Key, index it under (tenant, key) too.
inline void put(const Request& request, const std::string& idem_key) {
  std::string approvers;
  for (const auto& a : request.approvers) approvers += (approvers.empty() ? "" : ",") + a;
  const std::vector<std::pair<std::string, std::string>> fields = {
      {"request_id", request.request_id}, {"tenant", request.tenant},
      {"requester", request.requester},   {"chain_id", request.chain_id},
      {"chain_version", std::to_string(request.chain_version)},
      {"approvers", approvers},           {"why", request.why},
      {"amount_cents", std::to_string(request.amount_cents)}};
  redis().hset("request:" + request.request_id, fields.begin(), fields.end());
  if (!idem_key.empty()) redis().set("idem:" + request.tenant + ":" + idem_key, request.request_id);
}

// The stored request, or none.
inline std::optional<Request> load(const std::string& request_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("request:" + request_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  Request request;
  request.request_id = text("request_id");
  request.tenant = text("tenant");
  request.requester = text("requester");
  request.chain_id = text("chain_id");
  request.chain_version = std::stol(text("chain_version"));
  std::stringstream list(text("approvers"));
  for (std::string a; std::getline(list, a, ',');) {
    if (!a.empty()) request.approvers.push_back(a);
  }
  request.why = text("why");
  request.amount_cents = std::stoll(text("amount_cents"));
  return request;
}

// The request a submit with this (tenant, Idempotency-Key) stored, if any.
inline std::optional<Request> get(const std::string& tenant, const std::string& idem_key) {
  const auto request_id = redis().get("idem:" + tenant + ":" + idem_key);
  if (!request_id) return std::nullopt;
  return load(*request_id);
}

}  // namespace store
`,
  'approvals/chain.h': `// The approval state machine (provided; step 2 builds the same two functions). approval:{id}:state
// is one Redis hash per request: step_index, step_count, status (pending, approved or rejected),
// current_approver, approver:{i} per step, and decision:{i} and actor:{i} per decided step. It has
// no TTL. advance runs one Lua script: it refuses a closed chain, a stale step_index, an actor who
// is not the current approver and an unknown decision, records the decision, and moves exactly one
// step (a rejection closes the chain).
#pragma once

#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <utility>
#include <vector>

namespace chain {

struct Outcome {
  bool advanced = false;
  long step_index = 0;
  std::string status;
  std::string reason;
};

inline const std::string kAdvanceLua = R"lua(
${ADVANCE_LUA})lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string stateKey(const std::string& request_id) { return "approval:" + request_id + ":state"; }

// Open the chain at step 0 with the pinned approvers.
inline void startChain(const std::string& request_id, const std::vector<std::string>& approvers) {
  std::vector<std::pair<std::string, std::string>> fields = {
      {"step_index", "0"}, {"step_count", std::to_string(approvers.size())}, {"status", "pending"}, {"current_approver", approvers.at(0)}};
  for (size_t i = 0; i < approvers.size(); i++) fields.emplace_back("approver:" + std::to_string(i), approvers[i]);
  redis().hset(stateKey(request_id), fields.begin(), fields.end());
}

// Record actor's decision ("approved" or "rejected") on step step_index, if it is still the current
// step and theirs.
inline Outcome advance(const std::string& request_id, long step_index, const std::string& actor, const std::string& decision) {
  std::vector<std::string> reply;
  redis().eval(kAdvanceLua, {stateKey(request_id)}, {std::to_string(step_index), actor, decision}, std::back_inserter(reply));
  return Outcome{reply.at(0) == "1", std::stol(reply.at(1)), reply.at(2), reply.at(3)};
}

}  // namespace chain
`,
  'approvals/outbox.h': `// The outbox (provided): the Redis list outbox holds one JSON row {"topic", "key", "payload"} per
// event the broker did not take; a relay republishes the rows in order.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

namespace outbox {

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline void insert(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace outbox
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('approvals', 'Policy')]: `package approvals

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The chain policy store (provided): policy:{chain_id} is a Redis hash with the current definition of
 * a chain, its version and its approvers in order (comma-joined). defineChain is the policy admin's
 * path (a new definition replaces the old one); resolveApprovers answers the current definition.
 */
object Policy {
  final case class Chain(version: Long, approvers: Seq[String])

  val jedis = new JedisPooled("redis", 6379)

  /** Make (version, approvers) the current definition of chainId. */
  def defineChain(chainId: String, version: Long, approvers: Seq[String]): Unit =
    jedis.hset(s"policy:$chainId", Map("version" -> version.toString, "approvers" -> approvers.mkString(",")).asJava)

  /** The current definition of chainId, or None for an unknown chain. */
  def resolveApprovers(chainId: String): Option[Chain] = {
    val raw = jedis.hgetAll(s"policy:$chainId").asScala
    if (raw.isEmpty) None
    else Some(Chain(raw("version").toLong, raw("approvers").split(",").toSeq.filter(_.nonEmpty)))
  }
}
`,
  [scalaPath('approvals', 'Store')]: `package approvals

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The request store (provided): request:{id} is a Redis hash with request_id, tenant, requester,
 * chain_id, chain_version, approvers (comma-joined), why and amount_cents. idem:{tenant}:{key} holds
 * the id of the request a submit with that Idempotency-Key stored; request:seq numbers the requests.
 */
object Store {
  final case class Request(
      requestId: String,
      tenant: String,
      requester: String,
      chainId: String,
      chainVersion: Long,
      approvers: Seq[String],
      why: String,
      amountCents: Long)

  val jedis = new JedisPooled("redis", 6379)

  /** A fresh request id: r-1, r-2, ... */
  def newRequestId(): String = s"r-\${jedis.incr("request:seq")}"

  /** Store the request; with a non-empty Idempotency-Key, index it under (tenant, key) too. */
  def put(request: Request, idemKey: String): Unit = {
    jedis.hset(
      s"request:\${request.requestId}",
      Map(
        "request_id" -> request.requestId,
        "tenant" -> request.tenant,
        "requester" -> request.requester,
        "chain_id" -> request.chainId,
        "chain_version" -> request.chainVersion.toString,
        "approvers" -> request.approvers.mkString(","),
        "why" -> request.why,
        "amount_cents" -> request.amountCents.toString).asJava)
    if (idemKey.nonEmpty) jedis.set(s"idem:\${request.tenant}:$idemKey", request.requestId)
  }

  /** The stored request, if any. */
  def load(requestId: String): Option[Request] = {
    val raw = jedis.hgetAll(s"request:$requestId").asScala
    if (raw.isEmpty) None
    else
      Some(
        Request(raw("request_id"), raw("tenant"), raw("requester"), raw("chain_id"), raw("chain_version").toLong,
          raw("approvers").split(",").toSeq.filter(_.nonEmpty), raw("why"), raw("amount_cents").toLong))
  }

  /** The request a submit with this (tenant, Idempotency-Key) stored, if any. */
  def get(tenant: String, idemKey: String): Option[Request] =
    Option(jedis.get(s"idem:$tenant:$idemKey")).flatMap(load)
}
`,
  [scalaPath('approvals', 'Chain')]: `package approvals

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The approval state machine (provided; step 2 builds the same two functions). approval:{id}:state
 * is one Redis hash per request: step_index, step_count, status (pending, approved or rejected),
 * current_approver, approver:{i} per step, and decision:{i} and actor:{i} per decided step. It has
 * no TTL. advance runs one Lua script: it refuses a closed chain, a stale step_index, an actor who is
 * not the current approver and an unknown decision, records the decision, and moves exactly one step
 * (a rejection closes the chain).
 */
object Chain {
  final case class Outcome(advanced: Boolean, stepIndex: Long, status: String, reason: String)

  val jedis = new JedisPooled("redis", 6379)

  val AdvanceLua: String =
    """${ADVANCE_LUA_SCALA}
      |""".stripMargin

  def stateKey(requestId: String): String = s"approval:$requestId:state"

  /** Open the chain at step 0 with the pinned approvers. */
  def startChain(requestId: String, approvers: Seq[String]): Unit = {
    val fields = Map("step_index" -> "0", "step_count" -> approvers.size.toString, "status" -> "pending", "current_approver" -> approvers.head) ++
      approvers.zipWithIndex.map { case (approver, i) => s"approver:$i" -> approver }
    jedis.hset(stateKey(requestId), fields.asJava)
  }

  /** Record actor's decision ("approved" or "rejected") on step stepIndex, if it is still the current step and theirs. */
  def advance(requestId: String, stepIndex: Long, actor: String, decision: String): Outcome = {
    val reply = jedis
      .eval(AdvanceLua, List(stateKey(requestId)).asJava, List(stepIndex.toString, actor, decision).asJava)
      .asInstanceOf[java.util.List[String]]
      .asScala
    Outcome(reply(0) == "1", reply(1).toLong, reply(2), reply(3))
  }
}
`,
  [scalaPath('approvals', 'Outbox')]: `package approvals

import redis.clients.jedis.JedisPooled
import spray.json._

/**
 * The outbox (provided): the Redis list outbox holds one JSON row {"topic", "key", "payload"} per event
 * the broker did not take; a relay republishes the rows in order.
 */
object Outbox {
  val jedis = new JedisPooled("redis", 6379)

  def insert(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
};
