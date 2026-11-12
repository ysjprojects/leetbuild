/**
 * Hand-written support modules the identity-service steps import but no step builds: the `identityd`
 * package. `identityd.accounts` is the accounts store (every account a Redis hash, the course's
 * stand-in for the accounts database), with the signup idempotency records, the verification retry
 * queue, the suppression list and the support audit trail. `identityd.handles` is the handle claim
 * store of step 2 as later steps use it: `claim_handles`, `release_handles` and `owner_of`. The five
 * languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'identityd/__init__.py': '',
  'identityd/accounts.py': `"""
The accounts store (provided): every account is a Redis hash account:{user_id} with user_id, email,
phone, name, status (unverified, verified, suppressed or suspended) and created_at (epoch seconds).
signup:{key} holds what a signup answered under its Idempotency-Key, for a day. verify:retry is the
verification retry queue (a sorted set of user ids scored by when the retry is due), verify:suppressed
the addresses that hard-bounced, audit:lookups the support reads (a list of JSON records).
"""
import json
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SIGNUP_TTL_S = 24 * 3600
RETRY_AFTER_S = 60

# Moves status from ARGV[1] to ARGV[2] only if the account still holds ARGV[1].
TRANSITION_LUA = """
if redis.call('HGET', KEYS[1], 'status') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2])
return 1
"""


def account_key(user_id: str) -> str:
    return f"account:{user_id}"


def new_user_id() -> str:
    """A fresh account id: u-1, u-2, …"""
    return f"u-{r.incr('account:seq')}"


def create_account(user_id: str, email: str, phone: str, name: str) -> dict:
    """Write the account row, unverified; returns it."""
    r.hset(
        account_key(user_id),
        mapping={"user_id": user_id, "email": email, "phone": phone, "name": name, "status": "unverified", "created_at": int(time.time())},
    )
    return get_account(user_id)


def get_account(user_id: str) -> dict | None:
    """The account row (created_at as an int), or None."""
    raw = r.hgetall(account_key(user_id))
    if not raw:
        return None
    return {**raw, "created_at": int(raw["created_at"])}


def set_status(user_id: str, status: str) -> None:
    r.hset(account_key(user_id), "status", status)


def transition(user_id: str, expected: str, status: str) -> bool:
    """Commit a status change: expected → status in one script; False when the account is not in expected."""
    return r.eval(TRANSITION_LUA, 1, account_key(user_id), expected, status) == 1


def signup_result(key: str) -> dict | None:
    """What the signup under this Idempotency-Key answered, if it was recorded."""
    raw = r.get(f"signup:{key}")
    return json.loads(raw) if raw else None


def record_signup(key: str, result: dict) -> None:
    """Record what the signup under this Idempotency-Key answered, for its retries."""
    r.set(f"signup:{key}", json.dumps(result), ex=SIGNUP_TTL_S)


def queue_retry(user_id: str) -> None:
    """Schedule another verification mail for the account, RETRY_AFTER_S from now."""
    r.zadd("verify:retry", {user_id: time.time() + RETRY_AFTER_S})


def pending_retries() -> list[str]:
    """The user ids waiting in the verification retry queue."""
    return r.zrange("verify:retry", 0, -1)


def suppress(user_id: str) -> None:
    """The account's address hard-bounced: add it to the suppression list and mark the account suppressed."""
    account = get_account(user_id)
    if account is not None:
        r.sadd("verify:suppressed", account["email"])
    set_status(user_id, "suppressed")


def is_suppressed(email: str) -> bool:
    return bool(r.sismember("verify:suppressed", email))


def record_audit(actor: str, user_id: str, reason: str) -> None:
    """Append a support read to the audit trail."""
    r.rpush("audit:lookups", json.dumps({"actor": actor, "user_id": user_id, "reason": reason, "at": int(time.time())}))


def audit_entries() -> list[dict]:
    """Every support read recorded so far, oldest first."""
    return [json.loads(raw) for raw in r.lrange("audit:lookups", 0, -1)]
`,
  'identityd/handles.py': `"""
The handle claims (provided; step 2 builds the same functions): handle:{kind}:{value} holds the user
id that owns an identity handle (kind email or phone, value canonical), with no expiry.
claim_handles takes every handle of a signup with SET NX, or none of them; release_handles gives
back only the handles the user still owns, each in one compare-and-delete script.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

HANDLE_PREFIX = "handle"

RELEASE_LUA = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
"""


def handle_key(kind: str, value: str) -> str:
    return f"{HANDLE_PREFIX}:{kind}:{value}"


def owner_of(kind: str, value: str) -> str | None:
    """The user id that owns the handle, or None."""
    return r.get(handle_key(kind, value))


def release_handles(user_id: str, handles: dict[str, str]) -> None:
    """Give back the handles (kind → value) that user_id still owns."""
    for kind, value in handles.items():
        r.eval(RELEASE_LUA, 1, handle_key(kind, value), user_id)


def claim_handles(user_id: str, handles: dict[str, str]) -> bool:
    """Claim every handle (kind → value) for user_id; False, holding none of them, when one is taken."""
    for kind, value in handles.items():
        if not r.set(handle_key(kind, value), user_id, nx=True):
            release_handles(user_id, handles)
            return False
    return True
`,
};

export const supportModulesTs: Record<string, string> = {
  'identityd/accounts.ts': `/**
 * The accounts store (provided): every account is a Redis hash account:{user_id} with user_id,
 * email, phone, name, status (unverified, verified, suppressed or suspended) and created_at (epoch
 * seconds). signup:{key} holds what a signup answered under its Idempotency-Key, for a day.
 * verify:retry is the verification retry queue (a sorted set of user ids scored by when the retry
 * is due), verify:suppressed the addresses that hard-bounced, audit:lookups the support reads (a
 * list of JSON records).
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const SIGNUP_TTL_S = 24 * 3600;
export const RETRY_AFTER_S = 60;

/** Moves status from ARGV[1] to ARGV[2] only if the account still holds ARGV[1]. */
export const TRANSITION_LUA = \`
if redis.call('HGET', KEYS[1], 'status') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2])
return 1
\`;

export interface Account {
  user_id: string;
  email: string;
  phone: string;
  name: string;
  status: string;
  created_at: number;
}

export interface AuditEntry {
  actor: string;
  user_id: string;
  reason: string;
  at: number;
}

export const accountKey = (userId: string): string => \`account:\${userId}\`;

const now = (): number => Math.floor(Date.now() / 1000);

/** A fresh account id: u-1, u-2, … */
export async function newUserId(): Promise<string> {
  return \`u-\${await redis.incr('account:seq')}\`;
}

/** The account row, or null. */
export async function getAccount(userId: string): Promise<Account | null> {
  const raw = await redis.hgetall(accountKey(userId));
  if (Object.keys(raw).length === 0) return null;
  return {
    user_id: raw.user_id,
    email: raw.email,
    phone: raw.phone,
    name: raw.name,
    status: raw.status,
    created_at: Number(raw.created_at),
  };
}

/** Write the account row, unverified; returns it. */
export async function createAccount(userId: string, email: string, phone: string, name: string): Promise<Account> {
  await redis.hset(accountKey(userId), {user_id: userId, email, phone, name, status: 'unverified', created_at: String(now())});
  return (await getAccount(userId)) as Account;
}

export async function setStatus(userId: string, status: string): Promise<void> {
  await redis.hset(accountKey(userId), 'status', status);
}

/** Commit a status change: expected → status in one script; false when the account is not in expected. */
export async function transition(userId: string, expected: string, status: string): Promise<boolean> {
  return (await redis.eval(TRANSITION_LUA, 1, accountKey(userId), expected, status)) === 1;
}

/** What the signup under this Idempotency-Key answered, if it was recorded. */
export async function signupResult(key: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(\`signup:\${key}\`);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

/** Record what the signup under this Idempotency-Key answered, for its retries. */
export async function recordSignup(key: string, result: Record<string, unknown>): Promise<void> {
  await redis.set(\`signup:\${key}\`, JSON.stringify(result), 'EX', SIGNUP_TTL_S);
}

/** Schedule another verification mail for the account, RETRY_AFTER_S from now. */
export async function queueRetry(userId: string): Promise<void> {
  await redis.zadd('verify:retry', now() + RETRY_AFTER_S, userId);
}

/** The user ids waiting in the verification retry queue. */
export async function pendingRetries(): Promise<string[]> {
  return redis.zrange('verify:retry', 0, -1);
}

/** The account's address hard-bounced: add it to the suppression list and mark the account suppressed. */
export async function suppress(userId: string): Promise<void> {
  const account = await getAccount(userId);
  if (account !== null) await redis.sadd('verify:suppressed', account.email);
  await setStatus(userId, 'suppressed');
}

export async function isSuppressed(email: string): Promise<boolean> {
  return (await redis.sismember('verify:suppressed', email)) === 1;
}

/** Append a support read to the audit trail. */
export async function recordAudit(actor: string, userId: string, reason: string): Promise<void> {
  await redis.rpush('audit:lookups', JSON.stringify({actor, user_id: userId, reason, at: now()}));
}

/** Every support read recorded so far, oldest first. */
export async function auditEntries(): Promise<AuditEntry[]> {
  return (await redis.lrange('audit:lookups', 0, -1)).map(raw => JSON.parse(raw) as AuditEntry);
}
`,
  'identityd/handles.ts': `/**
 * The handle claims (provided; step 2 builds the same functions): handle:{kind}:{value} holds the
 * user id that owns an identity handle (kind email or phone, value canonical), with no expiry.
 * claimHandles takes every handle of a signup with SET NX, or none of them; releaseHandles gives
 * back only the handles the user still owns, each in one compare-and-delete script.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const HANDLE_PREFIX = 'handle';

export const RELEASE_LUA = \`
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
\`;

export const handleKey = (kind: string, value: string): string => \`\${HANDLE_PREFIX}:\${kind}:\${value}\`;

/** The user id that owns the handle, or null. */
export async function ownerOf(kind: string, value: string): Promise<string | null> {
  return redis.get(handleKey(kind, value));
}

/** Give back the handles (kind → value) that userId still owns. */
export async function releaseHandles(userId: string, handles: Record<string, string>): Promise<void> {
  for (const [kind, value] of Object.entries(handles)) await redis.eval(RELEASE_LUA, 1, handleKey(kind, value), userId);
}

/** Claim every handle (kind → value) for userId; false, holding none of them, when one is taken. */
export async function claimHandles(userId: string, handles: Record<string, string>): Promise<boolean> {
  for (const [kind, value] of Object.entries(handles)) {
    if ((await redis.set(handleKey(kind, value), userId, 'NX')) === null) {
      await releaseHandles(userId, handles);
      return false;
    }
  }
  return true;
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'identityd/accounts/accounts.go': `// Package accounts is the accounts store (provided): every account is a Redis hash
// account:{user_id} with user_id, email, phone, name, status (unverified, verified, suppressed or
// suspended) and created_at (epoch seconds). signup:{key} holds what a signup answered under its
// Idempotency-Key, for a day. verify:retry is the verification retry queue (a sorted set of user
// ids scored by when the retry is due), verify:suppressed the addresses that hard-bounced,
// audit:lookups the support reads (a list of JSON records).
package accounts

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	signupTTL  = 24 * time.Hour
	retryAfter = 60 * time.Second
)

// Transition moves status from ARGV[1] to ARGV[2] only if the account still holds ARGV[1].
var transitionScript = redis.NewScript(\`
if redis.call('HGET', KEYS[1], 'status') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2])
return 1
\`)

// Account is one account row.
type Account struct {
	UserID    string \`json:"user_id"\`
	Email     string \`json:"email"\`
	Phone     string \`json:"phone"\`
	Name      string \`json:"name"\`
	Status    string \`json:"status"\`
	CreatedAt int64  \`json:"created_at"\`
}

// AuditEntry is one support read.
type AuditEntry struct {
	Actor  string \`json:"actor"\`
	UserID string \`json:"user_id"\`
	Reason string \`json:"reason"\`
	At     int64  \`json:"at"\`
}

// AccountKey is the hash of an account.
func AccountKey(userID string) string { return "account:" + userID }

// NewUserID is a fresh account id: u-1, u-2, …
func NewUserID(ctx context.Context) string {
	return fmt.Sprintf("u-%d", rdb.Incr(ctx, "account:seq").Val())
}

// GetAccount is the account row, or nil.
func GetAccount(ctx context.Context, userID string) (*Account, error) {
	raw, err := rdb.HGetAll(ctx, AccountKey(userID)).Result()
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	created, _ := strconv.ParseInt(raw["created_at"], 10, 64)
	return &Account{UserID: raw["user_id"], Email: raw["email"], Phone: raw["phone"], Name: raw["name"], Status: raw["status"], CreatedAt: created}, nil
}

// CreateAccount writes the account row, unverified, and returns it.
func CreateAccount(ctx context.Context, userID, email, phone, name string) (*Account, error) {
	fields := map[string]any{"user_id": userID, "email": email, "phone": phone, "name": name, "status": "unverified", "created_at": time.Now().Unix()}
	if err := rdb.HSet(ctx, AccountKey(userID), fields).Err(); err != nil {
		return nil, err
	}
	return GetAccount(ctx, userID)
}

// SetStatus writes the account's status.
func SetStatus(ctx context.Context, userID, status string) error {
	return rdb.HSet(ctx, AccountKey(userID), "status", status).Err()
}

// Transition commits a status change, expected → status, in one script; false when the account is not in expected.
func Transition(ctx context.Context, userID, expected, status string) (bool, error) {
	moved, err := transitionScript.Run(ctx, rdb, []string{AccountKey(userID)}, expected, status).Int64()
	return moved == 1, err
}

// SignupResult is what the signup under this Idempotency-Key answered, or nil.
func SignupResult(ctx context.Context, key string) (map[string]any, error) {
	raw, err := rdb.Get(ctx, "signup:"+key).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var result map[string]any
	return result, json.Unmarshal([]byte(raw), &result)
}

// RecordSignup records what the signup under this Idempotency-Key answered, for its retries.
func RecordSignup(ctx context.Context, key string, result map[string]any) error {
	raw, _ := json.Marshal(result)
	return rdb.Set(ctx, "signup:"+key, raw, signupTTL).Err()
}

// QueueRetry schedules another verification mail for the account, a minute from now.
func QueueRetry(ctx context.Context, userID string) error {
	due := float64(time.Now().Add(retryAfter).Unix())
	return rdb.ZAdd(ctx, "verify:retry", redis.Z{Score: due, Member: userID}).Err()
}

// PendingRetries is the user ids waiting in the verification retry queue.
func PendingRetries(ctx context.Context) []string {
	return rdb.ZRange(ctx, "verify:retry", 0, -1).Val()
}

// Suppress records that the account's address hard-bounced: the address joins the suppression
// list and the account is marked suppressed.
func Suppress(ctx context.Context, userID string) error {
	account, err := GetAccount(ctx, userID)
	if err != nil {
		return err
	}
	if account != nil {
		if err := rdb.SAdd(ctx, "verify:suppressed", account.Email).Err(); err != nil {
			return err
		}
	}
	return SetStatus(ctx, userID, "suppressed")
}

// IsSuppressed reports whether the address hard-bounced.
func IsSuppressed(ctx context.Context, email string) bool {
	return rdb.SIsMember(ctx, "verify:suppressed", email).Val()
}

// RecordAudit appends a support read to the audit trail.
func RecordAudit(ctx context.Context, actor, userID, reason string) error {
	raw, _ := json.Marshal(AuditEntry{Actor: actor, UserID: userID, Reason: reason, At: time.Now().Unix()})
	return rdb.RPush(ctx, "audit:lookups", raw).Err()
}

// AuditEntries is every support read recorded so far, oldest first.
func AuditEntries(ctx context.Context) []AuditEntry {
	var out []AuditEntry
	for _, raw := range rdb.LRange(ctx, "audit:lookups", 0, -1).Val() {
		var e AuditEntry
		if json.Unmarshal([]byte(raw), &e) == nil {
			out = append(out, e)
		}
	}
	return out
}
`,
  'identityd/handles/handles.go': `// Package handles is the handle claims (provided; step 2 builds the same functions):
// handle:{kind}:{value} holds the user id that owns an identity handle (kind email or phone, value
// canonical), with no expiry. ClaimHandles takes every handle of a signup with SET NX, or none of
// them; ReleaseHandles gives back only the handles the user still owns, each in one
// compare-and-delete script.
package handles

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// HandlePrefix starts every claim key.
const HandlePrefix = "handle"

var releaseScript = redis.NewScript(\`
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
\`)

// HandleKey is the claim key of a handle.
func HandleKey(kind, value string) string { return HandlePrefix + ":" + kind + ":" + value }

// OwnerOf is the user id that owns the handle, or "".
func OwnerOf(ctx context.Context, kind, value string) string {
	return rdb.Get(ctx, HandleKey(kind, value)).Val()
}

// ReleaseHandles gives back the handles (kind → value) that userID still owns.
func ReleaseHandles(ctx context.Context, userID string, handles map[string]string) error {
	for kind, value := range handles {
		if err := releaseScript.Run(ctx, rdb, []string{HandleKey(kind, value)}, userID).Err(); err != nil {
			return err
		}
	}
	return nil
}

// ClaimHandles claims every handle (kind → value) for userID; false, holding none of them, when one is taken.
func ClaimHandles(ctx context.Context, userID string, handles map[string]string) (bool, error) {
	for kind, value := range handles {
		won, err := rdb.SetNX(ctx, HandleKey(kind, value), userID, 0).Result()
		if err != nil {
			return false, err
		}
		if !won {
			return false, ReleaseHandles(ctx, userID, handles)
		}
	}
	return true, nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'identityd/accounts.h': `// The accounts store (provided): every account is a Redis hash account:{user_id} with user_id,
// email, phone, name, status (unverified, verified, suppressed or suspended) and created_at (epoch
// seconds). signup:{key} holds what a signup answered under its Idempotency-Key, for a day.
// verify:retry is the verification retry queue (a sorted set of user ids scored by when the retry
// is due), verify:suppressed the addresses that hard-bounced, audit:lookups the support reads (a
// list of JSON records).
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace accounts {

struct Account {
  std::string user_id;
  std::string email;
  std::string phone;
  std::string name;
  std::string status;
  long long created_at = 0;
};

inline nlohmann::json toJson(const Account& a) {
  return nlohmann::json{{"user_id", a.user_id}, {"email", a.email}, {"phone", a.phone},
                        {"name", a.name},       {"status", a.status}, {"created_at", a.created_at}};
}

inline const long long kSignupTtlSeconds = 24 * 3600;
inline const long long kRetryAfterSeconds = 60;

// Moves status from ARGV[1] to ARGV[2] only if the account still holds ARGV[1].
inline const std::string kTransitionLua = R"lua(
if redis.call('HGET', KEYS[1], 'status') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2])
return 1
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline long long nowSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

inline std::string accountKey(const std::string& user_id) { return "account:" + user_id; }

// A fresh account id: u-1, u-2, …
inline std::string newUserId() { return "u-" + std::to_string(redis().incr("account:seq")); }

// The account row, or none.
inline std::optional<Account> getAccount(const std::string& user_id) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall(accountKey(user_id), std::inserter(raw, raw.begin()));
  if (raw.empty()) return std::nullopt;
  Account a;
  a.user_id = raw["user_id"];
  a.email = raw["email"];
  a.phone = raw["phone"];
  a.name = raw["name"];
  a.status = raw["status"];
  a.created_at = raw["created_at"].empty() ? 0 : std::stoll(raw["created_at"]);
  return a;
}

// Write the account row, unverified; returns it.
inline Account createAccount(const std::string& user_id, const std::string& email, const std::string& phone,
                             const std::string& name) {
  redis().hset(accountKey(user_id), {std::make_pair(std::string("user_id"), user_id),
                                     std::make_pair(std::string("email"), email),
                                     std::make_pair(std::string("phone"), phone),
                                     std::make_pair(std::string("name"), name),
                                     std::make_pair(std::string("status"), std::string("unverified")),
                                     std::make_pair(std::string("created_at"), std::to_string(nowSeconds()))});
  return *getAccount(user_id);
}

inline void setStatus(const std::string& user_id, const std::string& status) {
  redis().hset(accountKey(user_id), "status", status);
}

// Commit a status change: expected → status in one script; false when the account is not in expected.
inline bool transition(const std::string& user_id, const std::string& expected, const std::string& status) {
  return redis().eval<long long>(kTransitionLua, {accountKey(user_id)}, {expected, status}) == 1;
}

// What the signup under this Idempotency-Key answered, if it was recorded.
inline std::optional<nlohmann::json> signupResult(const std::string& key) {
  const auto raw = redis().get("signup:" + key);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// Record what the signup under this Idempotency-Key answered, for its retries.
inline void recordSignup(const std::string& key, const nlohmann::json& result) {
  redis().set("signup:" + key, result.dump(), std::chrono::seconds(kSignupTtlSeconds));
}

// Schedule another verification mail for the account, kRetryAfterSeconds from now.
inline void queueRetry(const std::string& user_id) {
  redis().zadd("verify:retry", user_id, static_cast<double>(nowSeconds() + kRetryAfterSeconds));
}

// The user ids waiting in the verification retry queue.
inline std::vector<std::string> pendingRetries() {
  std::vector<std::string> out;
  redis().zrange("verify:retry", 0, -1, std::back_inserter(out));
  return out;
}

// The account's address hard-bounced: add it to the suppression list and mark the account suppressed.
inline void suppress(const std::string& user_id) {
  if (const auto account = getAccount(user_id)) redis().sadd("verify:suppressed", account->email);
  setStatus(user_id, "suppressed");
}

inline bool isSuppressed(const std::string& email) { return redis().sismember("verify:suppressed", email); }

// Append a support read to the audit trail.
inline void recordAudit(const std::string& actor, const std::string& user_id, const std::string& reason) {
  redis().rpush("audit:lookups",
                nlohmann::json{{"actor", actor}, {"user_id", user_id}, {"reason", reason}, {"at", nowSeconds()}}.dump());
}

// Every support read recorded so far, oldest first.
inline std::vector<nlohmann::json> auditEntries() {
  std::vector<std::string> raw;
  redis().lrange("audit:lookups", 0, -1, std::back_inserter(raw));
  std::vector<nlohmann::json> out;
  for (const auto& r : raw) out.push_back(nlohmann::json::parse(r));
  return out;
}

}  // namespace accounts
`,
  'identityd/handles.h': `// The handle claims (provided; step 2 builds the same functions): handle:{kind}:{value} holds the
// user id that owns an identity handle (kind email or phone, value canonical), with no expiry.
// claimHandles takes every handle of a signup with SET NX, or none of them; releaseHandles gives
// back only the handles the user still owns, each in one compare-and-delete script.
#pragma once

#include <sw/redis++/redis++.h>

#include <map>
#include <optional>
#include <string>

namespace handles {

using Handles = std::map<std::string, std::string>;  // kind → canonical value

inline const std::string kHandlePrefix = "handle";

inline const std::string kReleaseLua = R"lua(
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string handleKey(const std::string& kind, const std::string& value) {
  return kHandlePrefix + ":" + kind + ":" + value;
}

// The user id that owns the handle, or none.
inline std::optional<std::string> ownerOf(const std::string& kind, const std::string& value) {
  const auto owner = redis().get(handleKey(kind, value));
  if (!owner) return std::nullopt;
  return *owner;
}

// Give back the handles that user_id still owns.
inline void releaseHandles(const std::string& user_id, const Handles& handles) {
  for (const auto& [kind, value] : handles) redis().eval<long long>(kReleaseLua, {handleKey(kind, value)}, {user_id});
}

// Claim every handle for user_id; false, holding none of them, when one is taken.
inline bool claimHandles(const std::string& user_id, const Handles& handles) {
  for (const auto& [kind, value] : handles) {
    if (!redis().set(handleKey(kind, value), user_id, std::chrono::milliseconds(0), sw::redis::UpdateType::NOT_EXIST)) {
      releaseHandles(user_id, handles);
      return false;
    }
  }
  return true;
}

}  // namespace handles
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('identityd', 'Accounts')]: `package identityd

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The accounts store (provided): every account is a Redis hash account:{user_id} with user_id,
 * email, phone, name, status (unverified, verified, suppressed or suspended) and created_at (epoch
 * seconds). signup:{key} holds what a signup answered under its Idempotency-Key, for a day.
 * verify:retry is the verification retry queue (a sorted set of user ids scored by when the retry
 * is due), verify:suppressed the addresses that hard-bounced, audit:lookups the support reads (a
 * list of JSON records).
 */
object Accounts {
  final case class Account(userId: String, email: String, phone: String, name: String, status: String, createdAt: Long) {
    def toJson: JsObject = JsObject(
      "user_id" -> JsString(userId), "email" -> JsString(email), "phone" -> JsString(phone),
      "name" -> JsString(name), "status" -> JsString(status), "created_at" -> JsNumber(createdAt))
  }

  val SignupTtlSeconds: Long = 24 * 3600L
  val RetryAfterSeconds: Long = 60L

  /** Moves status from ARGV[1] to ARGV[2] only if the account still holds ARGV[1]. */
  val TransitionLua: String =
    """if redis.call('HGET', KEYS[1], 'status') ~= ARGV[1] then return 0 end
      |redis.call('HSET', KEYS[1], 'status', ARGV[2])
      |return 1
      |""".stripMargin

  val jedis = new JedisPooled("redis", 6379)

  private def now: Long = System.currentTimeMillis() / 1000

  def accountKey(userId: String): String = s"account:$userId"

  /** A fresh account id: u-1, u-2, … */
  def newUserId(): String = s"u-\${jedis.incr("account:seq")}"

  /** The account row, if it exists. */
  def getAccount(userId: String): Option[Account] = {
    val raw = jedis.hgetAll(accountKey(userId)).asScala.toMap
    if (raw.isEmpty) None
    else Some(Account(raw("user_id"), raw("email"), raw("phone"), raw("name"), raw("status"), raw.get("created_at").map(_.toLong).getOrElse(0L)))
  }

  /** Write the account row, unverified; returns it. */
  def createAccount(userId: String, email: String, phone: String, name: String): Account = {
    jedis.hset(accountKey(userId), Map("user_id" -> userId, "email" -> email, "phone" -> phone, "name" -> name, "status" -> "unverified", "created_at" -> now.toString).asJava)
    getAccount(userId).get
  }

  def setStatus(userId: String, status: String): Unit = jedis.hset(accountKey(userId), "status", status)

  /** Commit a status change: expected → status in one script; false when the account is not in expected. */
  def transition(userId: String, expected: String, status: String): Boolean =
    jedis.eval(TransitionLua, List(accountKey(userId)).asJava, List(expected, status).asJava).asInstanceOf[java.lang.Long] == 1L

  /** What the signup under this Idempotency-Key answered, if it was recorded. */
  def signupResult(key: String): Option[JsObject] = Option(jedis.get(s"signup:$key")).map(_.parseJson.asJsObject)

  /** Record what the signup under this Idempotency-Key answered, for its retries. */
  def recordSignup(key: String, result: JsObject): Unit =
    jedis.set(s"signup:$key", result.compactPrint, SetParams.setParams().ex(SignupTtlSeconds))

  /** Schedule another verification mail for the account, RetryAfterSeconds from now. */
  def queueRetry(userId: String): Unit = jedis.zadd("verify:retry", (now + RetryAfterSeconds).toDouble, userId)

  /** The user ids waiting in the verification retry queue. */
  def pendingRetries(): Seq[String] = jedis.zrange("verify:retry", 0, -1).asScala.toSeq

  /** The account's address hard-bounced: add it to the suppression list and mark the account suppressed. */
  def suppress(userId: String): Unit = {
    getAccount(userId).foreach(account => jedis.sadd("verify:suppressed", account.email))
    setStatus(userId, "suppressed")
  }

  def isSuppressed(email: String): Boolean = jedis.sismember("verify:suppressed", email)

  /** Append a support read to the audit trail. */
  def recordAudit(actor: String, userId: String, reason: String): Unit =
    jedis.rpush("audit:lookups", JsObject("actor" -> JsString(actor), "user_id" -> JsString(userId), "reason" -> JsString(reason), "at" -> JsNumber(now)).compactPrint)

  /** Every support read recorded so far, oldest first. */
  def auditEntries(): Seq[JsObject] = jedis.lrange("audit:lookups", 0, -1).asScala.toSeq.map(_.parseJson.asJsObject)
}
`,
  [scalaPath('identityd', 'Handles')]: `package identityd

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

/**
 * The handle claims (provided; step 2 builds the same functions): handle:{kind}:{value} holds the
 * user id that owns an identity handle (kind email or phone, value canonical), with no expiry.
 * claimHandles takes every handle of a signup with SET NX, or none of them; releaseHandles gives
 * back only the handles the user still owns, each in one compare-and-delete script.
 */
object Handles {
  val HandlePrefix = "handle"

  val ReleaseLua: String =
    """if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      |return redis.call('DEL', KEYS[1])
      |""".stripMargin

  val jedis = new JedisPooled("redis", 6379)

  def handleKey(kind: String, value: String): String = s"$HandlePrefix:$kind:$value"

  /** The user id that owns the handle, if any. */
  def ownerOf(kind: String, value: String): Option[String] = Option(jedis.get(handleKey(kind, value)))

  /** Give back the handles (kind → value) that userId still owns. */
  def releaseHandles(userId: String, handles: Map[String, String]): Unit =
    handles.foreach { case (kind, value) => jedis.eval(ReleaseLua, List(handleKey(kind, value)).asJava, List(userId).asJava) }

  /** Claim every handle (kind → value) for userId; false, holding none of them, when one is taken. */
  def claimHandles(userId: String, handles: Map[String, String]): Boolean = {
    val lost = handles.exists { case (kind, value) => jedis.set(handleKey(kind, value), userId, SetParams.setParams().nx()) == null }
    if (lost) releaseHandles(userId, handles)
    !lost
  }
}
`,
};
