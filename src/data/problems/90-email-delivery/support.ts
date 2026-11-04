/**
 * Hand-written support modules the email-delivery steps import but no step builds: the `mail`
 * package. `mail.address` normalizes an address and hashes it for events; `mail.store` is the
 * message store (records, the relay queue, idempotent sends, the attempt timeline) in Redis;
 * `mail.gate` is step 2's admission as later steps use it (suppression set and per-recipient minute
 * counter, decided in one Lua script); `mail.relay` is step 3's relay client (`deliver`). The five
 * languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'mail/__init__.py': '',
  'mail/address.py': `"""
Address helpers every step shares: normalize is the form suppression, rate limits and event keys
use (trimmed, lowercase); recipient_hash is the SHA-256 of it in hex, the name an address goes by
outside the message store.
"""
import hashlib


def normalize(address: str) -> str:
    return address.strip().lower()


def recipient_hash(address: str) -> str:
    return hashlib.sha256(normalize(address).encode()).hexdigest()
`,
  'mail/store.py': `"""
The message store (provided): every message is a Redis hash mail:msg:{id} with message_id, tenant,
recipient, template_id, subject, variables (JSON), state (queued, sent, bounced, suppressed or
deferred) and bounce_category ("" without a bounce). mail:queue lists the ids waiting for the relay
(a message leaves it once sent, bounced or suppressed); mail:msg:{id}:attempts holds the outcome
of every relay attempt, oldest first; mail:send:{tenant}:{key} the message id a send with that
Idempotency-Key created.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

QUEUE = "mail:queue"
TERMINAL = ("sent", "bounced", "suppressed")


def message_key(message_id: str) -> str:
    return f"mail:msg:{message_id}"


def enqueue(tenant: str, recipient: str, template_id: str, subject: str, variables: dict[str, str]) -> str:
    """Create the message in state queued and put it on the relay's queue; returns its id."""
    message_id = f"m-{r.incr('mail:seq')}"
    r.hset(
        message_key(message_id),
        mapping={
            "message_id": message_id,
            "tenant": tenant,
            "recipient": recipient,
            "template_id": template_id,
            "subject": subject,
            "variables": json.dumps(variables),
            "state": "queued",
            "bounce_category": "",
        },
    )
    r.rpush(QUEUE, message_id)
    return message_id


def load(message_id: str) -> dict | None:
    """The message as a dict (variables decoded), or None."""
    raw = r.hgetall(message_key(message_id))
    if not raw:
        return None
    return {**raw, "variables": json.loads(raw.get("variables") or "{}"), "bounce_category": raw.get("bounce_category", "")}


def queued() -> list[str]:
    """The ids waiting for the relay, oldest first."""
    return r.lrange(QUEUE, 0, -1)


def find_send(tenant: str, key: str) -> str | None:
    """The message id the send (tenant, Idempotency-Key) created, if any."""
    return r.get(f"mail:send:{tenant}:{key}")


def remember_send(tenant: str, key: str, message_id: str) -> None:
    """Record the message id the send (tenant, Idempotency-Key) created, for its replays."""
    r.set(f"mail:send:{tenant}:{key}", message_id)


def set_state(message_id: str, state: str, bounce_category: str = "") -> None:
    """Move the message to state; a sent, bounced or suppressed message leaves the queue."""
    r.hset(message_key(message_id), mapping={"state": state, "bounce_category": bounce_category})
    if state in TERMINAL:
        r.lrem(QUEUE, 0, message_id)


def record_attempt(message_id: str, outcome: str) -> int:
    """Append one relay attempt's outcome to the timeline; returns the attempt's number."""
    return r.rpush(f"{message_key(message_id)}:attempts", outcome)


def attempts(message_id: str) -> list[dict]:
    """The timeline: [{"attempt": 1, "outcome": "unavailable"}, ...], oldest first."""
    outcomes = r.lrange(f"{message_key(message_id)}:attempts", 0, -1)
    return [{"attempt": n + 1, "outcome": outcome} for n, outcome in enumerate(outcomes)]
`,
  'mail/gate.py': `"""
Admission (provided; step 2 builds the same three functions): mail:suppressed is the durable set of
suppressed addresses, mail:rate:{address}:{window} a per-recipient counter for one minute that
expires with it. admit decides both in one Lua script: "suppressed", "rate_limited" or "ok".
Every address is normalized first.
"""
import time

import redis

from mail.address import normalize

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SUPPRESSED_SET = "mail:suppressed"
RATE_LIMIT = 5
WINDOW_S = 60

ADMIT_LUA = """
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 'suppressed' end
local sent = redis.call('INCR', KEYS[2])
if sent == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
if sent > tonumber(ARGV[3]) then return 'rate_limited' end
return 'ok'
"""
admit_script = r.register_script(ADMIT_LUA)


def rate_key(address: str, now: float) -> str:
    return f"mail:rate:{address}:{int(now // WINDOW_S)}"


def suppress(address: str) -> None:
    r.sadd(SUPPRESSED_SET, normalize(address))


def is_suppressed(address: str) -> bool:
    return bool(r.sismember(SUPPRESSED_SET, normalize(address)))


def admit(address: str) -> str:
    address = normalize(address)
    return admit_script(keys=[SUPPRESSED_SET, rate_key(address, time.time())], args=[address, WINDOW_S, RATE_LIMIT])
`,
  'mail/relay.py': `"""
The relay client (provided; step 3 builds the same function): deliver hands a queued message to the
relay under its own message id with a 10-second deadline, retries UNAVAILABLE and soft bounces,
asks GetStatus before resending after a timeout, records every attempt, and ends the message in
sent, bounced (recorded and suppressed), suppressed or deferred.
"""
import time

import grpc

import email_delivery_pb2 as pb
import email_delivery_pb2_grpc as pb_grpc
from mail import gate, store

DEADLINE_S = 10
MAX_ATTEMPTS = 3
BACKOFF_S = 2

relay = pb_grpc.RelayStub(grpc.insecure_channel("relay:9000"))


def deliver(message_id: str) -> str:
    """Hand a queued message to the relay; returns the state it ends in."""
    message = store.load(message_id)
    request = pb.SendMailRequest(
        message_id=message_id,
        recipient=message["recipient"],
        template_id=message["template_id"],
        subject=message["subject"],
        variables=message["variables"],
    )
    for _ in range(MAX_ATTEMPTS):
        try:
            delivery = relay.SendMail(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.UNAVAILABLE:
                store.record_attempt(message_id, "unavailable")
                time.sleep(BACKOFF_S)
                continue
            if exc.code() != grpc.StatusCode.DEADLINE_EXCEEDED:
                raise
            delivery = relay.GetStatus(pb.StatusRequest(message_id=message_id), timeout=DEADLINE_S)
            if delivery.outcome == "unknown":
                store.record_attempt(message_id, "timeout")
                continue
        store.record_attempt(message_id, delivery.outcome)
        if delivery.outcome == "accepted":
            store.set_state(message_id, "sent")
            return "sent"
        if delivery.outcome == "hard_bounce":
            store.set_state(message_id, "bounced", delivery.bounce_category)
            gate.suppress(message["recipient"])
            return "bounced"
        if delivery.outcome == "suppressed":
            store.set_state(message_id, "suppressed")
            return "suppressed"
        time.sleep(BACKOFF_S)
    store.set_state(message_id, "deferred")
    return "deferred"
`,
};

export const supportModulesTs: Record<string, string> = {
  'mail/address.ts': `/**
 * Address helpers every step shares: normalize is the form suppression, rate limits and event keys
 * use (trimmed, lowercase); recipientHash is the SHA-256 of it in hex, the name an address goes by
 * outside the message store.
 */
import {createHash} from 'node:crypto';

export const normalize = (address: string): string => address.trim().toLowerCase();

export const recipientHash = (address: string): string => createHash('sha256').update(normalize(address)).digest('hex');
`,
  'mail/store.ts': `/**
 * The message store (provided): every message is a Redis hash mail:msg:{id} with message_id,
 * tenant, recipient, template_id, subject, variables (JSON), state (queued, sent, bounced,
 * suppressed or deferred) and bounce_category ("" without a bounce). mail:queue lists the ids
 * waiting for the relay (a message leaves it once sent, bounced or suppressed);
 * mail:msg:{id}:attempts holds the outcome of every relay attempt, oldest first;
 * mail:send:{tenant}:{key} the message id a send with that Idempotency-Key created.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const QUEUE = 'mail:queue';
const TERMINAL = ['sent', 'bounced', 'suppressed'];

export interface Message {
  message_id: string;
  tenant: string;
  recipient: string;
  template_id: string;
  subject: string;
  variables: Record<string, string>;
  state: string;
  bounce_category: string;
}

export interface Attempt {
  attempt: number;
  outcome: string;
}

export const messageKey = (messageId: string): string => \`mail:msg:\${messageId}\`;

/** Create the message in state queued and put it on the relay's queue; returns its id. */
export async function enqueue(
  tenant: string,
  recipient: string,
  templateId: string,
  subject: string,
  variables: Record<string, string>,
): Promise<string> {
  const messageId = \`m-\${await redis.incr('mail:seq')}\`;
  await redis.hset(messageKey(messageId), {
    message_id: messageId,
    tenant,
    recipient,
    template_id: templateId,
    subject,
    variables: JSON.stringify(variables),
    state: 'queued',
    bounce_category: '',
  });
  await redis.rpush(QUEUE, messageId);
  return messageId;
}

/** The message (variables decoded), or null. */
export async function load(messageId: string): Promise<Message | null> {
  const raw = await redis.hgetall(messageKey(messageId));
  if (Object.keys(raw).length === 0) return null;
  return {
    message_id: raw.message_id,
    tenant: raw.tenant,
    recipient: raw.recipient,
    template_id: raw.template_id,
    subject: raw.subject,
    variables: JSON.parse(raw.variables || '{}') as Record<string, string>,
    state: raw.state,
    bounce_category: raw.bounce_category ?? '',
  };
}

/** The ids waiting for the relay, oldest first. */
export async function queued(): Promise<string[]> {
  return redis.lrange(QUEUE, 0, -1);
}

/** The message id the send (tenant, Idempotency-Key) created, if any. */
export async function findSend(tenant: string, key: string): Promise<string | null> {
  return redis.get(\`mail:send:\${tenant}:\${key}\`);
}

/** Record the message id the send (tenant, Idempotency-Key) created, for its replays. */
export async function rememberSend(tenant: string, key: string, messageId: string): Promise<void> {
  await redis.set(\`mail:send:\${tenant}:\${key}\`, messageId);
}

/** Move the message to state; a sent, bounced or suppressed message leaves the queue. */
export async function setState(messageId: string, state: string, bounceCategory = ''): Promise<void> {
  await redis.hset(messageKey(messageId), {state, bounce_category: bounceCategory});
  if (TERMINAL.includes(state)) await redis.lrem(QUEUE, 0, messageId);
}

/** Append one relay attempt's outcome to the timeline; returns the attempt's number. */
export async function recordAttempt(messageId: string, outcome: string): Promise<number> {
  return redis.rpush(\`\${messageKey(messageId)}:attempts\`, outcome);
}

/** The timeline: [{attempt: 1, outcome: 'unavailable'}, ...], oldest first. */
export async function attempts(messageId: string): Promise<Attempt[]> {
  const outcomes = await redis.lrange(\`\${messageKey(messageId)}:attempts\`, 0, -1);
  return outcomes.map((outcome, n) => ({attempt: n + 1, outcome}));
}
`,
  'mail/gate.ts': `/**
 * Admission (provided; step 2 builds the same three functions): mail:suppressed is the durable set
 * of suppressed addresses, mail:rate:{address}:{window} a per-recipient counter for one minute that
 * expires with it. admit decides both in one Lua script: 'suppressed', 'rate_limited' or 'ok'.
 * Every address is normalized first.
 */
import Redis from 'ioredis';

import {normalize} from 'mail/address';

export const SUPPRESSED_SET = 'mail:suppressed';
export const RATE_LIMIT = 5;
export const WINDOW_S = 60;

export const ADMIT_LUA = \`
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 'suppressed' end
local sent = redis.call('INCR', KEYS[2])
if sent == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
if sent > tonumber(ARGV[3]) then return 'rate_limited' end
return 'ok'
\`;

interface GateRedis extends Redis {
  admitScript(suppressedSet: string, rateKey: string, address: string, windowS: number, limit: number): Promise<string>;
}

const redis = new Redis({host: 'redis', port: 6379}) as GateRedis;
redis.defineCommand('admitScript', {numberOfKeys: 2, lua: ADMIT_LUA});

export const rateKey = (address: string, nowMs: number): string => \`mail:rate:\${address}:\${Math.floor(nowMs / 1000 / WINDOW_S)}\`;

export async function suppress(address: string): Promise<void> {
  await redis.sadd(SUPPRESSED_SET, normalize(address));
}

export async function isSuppressed(address: string): Promise<boolean> {
  return (await redis.sismember(SUPPRESSED_SET, normalize(address))) === 1;
}

export async function admit(address: string): Promise<string> {
  const normalized = normalize(address);
  return redis.admitScript(SUPPRESSED_SET, rateKey(normalized, Date.now()), normalized, WINDOW_S, RATE_LIMIT);
}
`,
  'mail/relay.ts': `/**
 * The relay client (provided; step 3 builds the same function): deliver hands a queued message to
 * the relay under its own message id with a 10-second deadline, retries UNAVAILABLE and soft
 * bounces, asks GetStatus before resending after a timeout, records every attempt, and ends the
 * message in sent, bounced (recorded and suppressed), suppressed or deferred.
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {suppress} from 'mail/gate';
import {load, recordAttempt, setState} from 'mail/store';

export const DEADLINE_MS = 10_000;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = 2000;

interface Delivery {
  outcome: string;
  bounce_category: string;
}

interface SendMailRequest {
  message_id: string;
  recipient: string;
  template_id: string;
  subject: string;
  variables: Record<string, string>;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('email_delivery.proto')) as unknown as {
  smtprelay: {Relay: grpc.ServiceClientConstructor};
};
const relay = new pkg.smtprelay.Relay('relay:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  SendMail(request: SendMailRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<Delivery>;
  GetStatus(request: {message_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<Delivery>;
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Hand a queued message to the relay; resolves to the state it ends in. */
export async function deliver(messageId: string): Promise<string> {
  const message = await load(messageId);
  if (message === null) throw new Error(\`no message \${messageId}\`);
  const request = {
    message_id: messageId,
    recipient: message.recipient,
    template_id: message.template_id,
    subject: message.subject,
    variables: message.variables,
  };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let delivery: Delivery;
    try {
      delivery = await relay.SendMail(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    } catch (e) {
      const {code} = e as grpc.ServiceError;
      if (code === grpc.status.UNAVAILABLE) {
        await recordAttempt(messageId, 'unavailable');
        await sleep(BACKOFF_MS);
        continue;
      }
      if (code !== grpc.status.DEADLINE_EXCEEDED) throw e;
      delivery = await relay.GetStatus({message_id: messageId}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
      if (delivery.outcome === 'unknown') {
        await recordAttempt(messageId, 'timeout');
        continue;
      }
    }
    await recordAttempt(messageId, delivery.outcome);
    if (delivery.outcome === 'accepted') {
      await setState(messageId, 'sent');
      return 'sent';
    }
    if (delivery.outcome === 'hard_bounce') {
      await setState(messageId, 'bounced', delivery.bounce_category);
      await suppress(message.recipient);
      return 'bounced';
    }
    if (delivery.outcome === 'suppressed') {
      await setState(messageId, 'suppressed');
      return 'suppressed';
    }
    await sleep(BACKOFF_MS);
  }
  await setState(messageId, 'deferred');
  return 'deferred';
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'mail/address/address.go': `// Package address holds the helpers every step shares: Normalize is the form suppression, rate
// limits and event keys use (trimmed, lowercase); RecipientHash is the SHA-256 of it in hex, the
// name an address goes by outside the message store.
package address

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// Normalize trims and lowercases an address.
func Normalize(addr string) string {
	return strings.ToLower(strings.TrimSpace(addr))
}

// RecipientHash is the hex SHA-256 of the normalized address.
func RecipientHash(addr string) string {
	sum := sha256.Sum256([]byte(Normalize(addr)))
	return hex.EncodeToString(sum[:])
}
`,
  'mail/store/store.go': `// Package store is the message store (provided): every message is a Redis hash mail:msg:{id} with
// message_id, tenant, recipient, template_id, subject, variables (JSON), state (queued, sent,
// bounced, suppressed or deferred) and bounce_category ("" without a bounce). mail:queue lists the
// ids waiting for the relay (a message leaves it once sent, bounced or suppressed);
// mail:msg:{id}:attempts holds the outcome of every relay attempt, oldest first;
// mail:send:{tenant}:{key} the message id a send with that Idempotency-Key created.
package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Queue lists the ids waiting for the relay.
const Queue = "mail:queue"

// Message is one email as the store holds it.
type Message struct {
	MessageID      string            \`json:"message_id"\`
	Tenant         string            \`json:"tenant"\`
	Recipient      string            \`json:"recipient"\`
	TemplateID     string            \`json:"template_id"\`
	Subject        string            \`json:"subject"\`
	Variables      map[string]string \`json:"variables"\`
	State          string            \`json:"state"\`
	BounceCategory string            \`json:"bounce_category"\`
}

// Attempt is one relay attempt on the timeline.
type Attempt struct {
	Attempt int    \`json:"attempt"\`
	Outcome string \`json:"outcome"\`
}

// MessageKey is the hash of one message.
func MessageKey(messageID string) string { return "mail:msg:" + messageID }

// Enqueue creates the message in state queued and puts it on the relay's queue; it returns its id.
func Enqueue(ctx context.Context, tenant, recipient, templateID, subject string, variables map[string]string) string {
	if variables == nil {
		variables = map[string]string{}
	}
	messageID := fmt.Sprintf("m-%d", rdb.Incr(ctx, "mail:seq").Val())
	vars, _ := json.Marshal(variables)
	rdb.HSet(ctx, MessageKey(messageID), map[string]any{
		"message_id": messageID, "tenant": tenant, "recipient": recipient, "template_id": templateID,
		"subject": subject, "variables": string(vars), "state": "queued", "bounce_category": "",
	})
	rdb.RPush(ctx, Queue, messageID)
	return messageID
}

// Load is the message (variables decoded), or nil.
func Load(ctx context.Context, messageID string) *Message {
	raw := rdb.HGetAll(ctx, MessageKey(messageID)).Val()
	if len(raw) == 0 {
		return nil
	}
	m := &Message{MessageID: raw["message_id"], Tenant: raw["tenant"], Recipient: raw["recipient"], TemplateID: raw["template_id"],
		Subject: raw["subject"], Variables: map[string]string{}, State: raw["state"], BounceCategory: raw["bounce_category"]}
	json.Unmarshal([]byte(raw["variables"]), &m.Variables)
	return m
}

// Queued is the ids waiting for the relay, oldest first.
func Queued(ctx context.Context) []string { return rdb.LRange(ctx, Queue, 0, -1).Val() }

// FindSend is the message id the send (tenant, Idempotency-Key) created, or "".
func FindSend(ctx context.Context, tenant, key string) string {
	return rdb.Get(ctx, "mail:send:"+tenant+":"+key).Val()
}

// RememberSend records the message id the send (tenant, Idempotency-Key) created, for its replays.
func RememberSend(ctx context.Context, tenant, key, messageID string) {
	rdb.Set(ctx, "mail:send:"+tenant+":"+key, messageID, 0)
}

// SetState moves the message to state; a sent, bounced or suppressed message leaves the queue.
func SetState(ctx context.Context, messageID, state, bounceCategory string) {
	rdb.HSet(ctx, MessageKey(messageID), map[string]any{"state": state, "bounce_category": bounceCategory})
	if state == "sent" || state == "bounced" || state == "suppressed" {
		rdb.LRem(ctx, Queue, 0, messageID)
	}
}

// RecordAttempt appends one relay attempt's outcome to the timeline and returns its number.
func RecordAttempt(ctx context.Context, messageID, outcome string) int {
	return int(rdb.RPush(ctx, MessageKey(messageID)+":attempts", outcome).Val())
}

// Attempts is the timeline, oldest first.
func Attempts(ctx context.Context, messageID string) []Attempt {
	out := []Attempt{}
	for n, outcome := range rdb.LRange(ctx, MessageKey(messageID)+":attempts", 0, -1).Val() {
		out = append(out, Attempt{Attempt: n + 1, Outcome: outcome})
	}
	return out
}
`,
  'mail/gate/gate.go': `// Package gate is admission (provided; step 2 builds the same three functions): mail:suppressed is
// the durable set of suppressed addresses, mail:rate:{address}:{window} a per-recipient counter for
// one minute that expires with it. Admit decides both in one Lua script: "suppressed",
// "rate_limited" or "ok". Every address is normalized first.
package gate

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"mail/address"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	SuppressedSet = "mail:suppressed"
	RateLimit     = 5
	WindowSeconds = 60
)

var admitScript = redis.NewScript(\`
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 'suppressed' end
local sent = redis.call('INCR', KEYS[2])
if sent == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
if sent > tonumber(ARGV[3]) then return 'rate_limited' end
return 'ok'
\`)

// RateKey is the counter of one normalized address for the minute holding now.
func RateKey(addr string, now time.Time) string {
	return fmt.Sprintf("mail:rate:%s:%d", addr, now.Unix()/WindowSeconds)
}

// Suppress adds the address to the suppression set for good.
func Suppress(ctx context.Context, recipient string) error {
	return rdb.SAdd(ctx, SuppressedSet, address.Normalize(recipient)).Err()
}

// IsSuppressed reports whether the address is suppressed.
func IsSuppressed(ctx context.Context, recipient string) (bool, error) {
	return rdb.SIsMember(ctx, SuppressedSet, address.Normalize(recipient)).Result()
}

// Admit is "suppressed", "rate_limited" or "ok" for one more email to the address.
func Admit(ctx context.Context, recipient string) (string, error) {
	addr := address.Normalize(recipient)
	return admitScript.Run(ctx, rdb, []string{SuppressedSet, RateKey(addr, time.Now())}, addr, WindowSeconds, RateLimit).Text()
}
`,
  'mail/relay/relay.go': `// Package relay is the relay client (provided; step 3 builds the same function): Deliver hands a
// queued message to the relay under its own message id with a 10-second deadline, retries
// UNAVAILABLE and soft bounces, asks GetStatus before resending after a timeout, records every
// attempt, and ends the message in sent, bounced (recorded and suppressed), suppressed or deferred.
package relay

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "mail/gen/email_delivery"
	"mail/gate"
	"mail/store"
)

const (
	Deadline    = 10 * time.Second
	MaxAttempts = 3
	Backoff     = 2 * time.Second
)

var (
	conn, _ = grpc.NewClient("relay:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	client  = pb.NewRelayClient(conn)
)

// Deliver hands a queued message to the relay and returns the state it ends in.
func Deliver(ctx context.Context, messageID string) (string, error) {
	message := store.Load(ctx, messageID)
	if message == nil {
		return "", fmt.Errorf("no message %s", messageID)
	}
	request := &pb.SendMailRequest{MessageId: messageID, Recipient: message.Recipient, TemplateId: message.TemplateID,
		Subject: message.Subject, Variables: message.Variables}
	for attempt := 0; attempt < MaxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, Deadline)
		delivery, err := client.SendMail(callCtx, request)
		cancel()
		switch status.Code(err) {
		case codes.OK:
		case codes.Unavailable:
			store.RecordAttempt(ctx, messageID, "unavailable")
			time.Sleep(Backoff)
			continue
		case codes.DeadlineExceeded:
			statusCtx, cancelStatus := context.WithTimeout(ctx, Deadline)
			delivery, err = client.GetStatus(statusCtx, &pb.StatusRequest{MessageId: messageID})
			cancelStatus()
			if err != nil {
				return "", err
			}
			if delivery.GetOutcome() == "unknown" {
				store.RecordAttempt(ctx, messageID, "timeout")
				continue
			}
		default:
			return "", err
		}
		store.RecordAttempt(ctx, messageID, delivery.GetOutcome())
		switch delivery.GetOutcome() {
		case "accepted":
			store.SetState(ctx, messageID, "sent", "")
			return "sent", nil
		case "hard_bounce":
			store.SetState(ctx, messageID, "bounced", delivery.GetBounceCategory())
			return "bounced", gate.Suppress(ctx, message.Recipient)
		case "suppressed":
			store.SetState(ctx, messageID, "suppressed", "")
			return "suppressed", nil
		}
		time.Sleep(Backoff)
	}
	store.SetState(ctx, messageID, "deferred", "")
	return "deferred", nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'mail/address.h': `// Address helpers every step shares: normalize is the form suppression, rate limits and event keys
// use (trimmed, lowercase); recipientHash is the SHA-256 of it in hex, the name an address goes by
// outside the message store.
#pragma once

#include <openssl/sha.h>

#include <cctype>
#include <string>

namespace mail::address {

inline std::string normalize(const std::string& addr) {
  const auto first = addr.find_first_not_of(" \\t\\r\\n");
  if (first == std::string::npos) return "";
  const auto last = addr.find_last_not_of(" \\t\\r\\n");
  std::string out = addr.substr(first, last - first + 1);
  for (char& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return out;
}

inline std::string recipientHash(const std::string& addr) {
  const std::string normalized = normalize(addr);
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(normalized.data()), normalized.size(), digest);
  static const char* kHex = "0123456789abcdef";
  std::string out;
  for (unsigned char b : digest) {
    out += kHex[b >> 4];
    out += kHex[b & 15];
  }
  return out;
}

}  // namespace mail::address
`,
  'mail/store.h': `// The message store (provided): every message is a Redis hash mail:msg:{id} with message_id,
// tenant, recipient, template_id, subject, variables (JSON), state (queued, sent, bounced,
// suppressed or deferred) and bounce_category ("" without a bounce). mail:queue lists the ids
// waiting for the relay (a message leaves it once sent, bounced or suppressed);
// mail:msg:{id}:attempts holds the outcome of every relay attempt, oldest first;
// mail:send:{tenant}:{key} the message id a send with that Idempotency-Key created.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace mail::store {

struct Message {
  std::string message_id;
  std::string tenant;
  std::string recipient;
  std::string template_id;
  std::string subject;
  std::map<std::string, std::string> variables;
  std::string state;
  std::string bounce_category;
};

struct Attempt {
  long attempt = 0;
  std::string outcome;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline const std::string kQueue = "mail:queue";

inline std::string messageKey(const std::string& message_id) { return "mail:msg:" + message_id; }

// Create the message in state queued and put it on the relay's queue; returns its id.
inline std::string enqueue(const std::string& tenant, const std::string& recipient, const std::string& template_id,
                           const std::string& subject, const std::map<std::string, std::string>& variables) {
  const std::string message_id = "m-" + std::to_string(redis().incr("mail:seq"));
  const std::map<std::string, std::string> fields = {
      {"message_id", message_id}, {"tenant", tenant},   {"recipient", recipient},
      {"template_id", template_id}, {"subject", subject}, {"variables", nlohmann::json(variables).dump()},
      {"state", "queued"},          {"bounce_category", ""}};
  redis().hset(messageKey(message_id), fields.begin(), fields.end());
  redis().rpush(kQueue, message_id);
  return message_id;
}

// The message (variables decoded), or none.
inline std::optional<Message> load(const std::string& message_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(messageKey(message_id));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  Message m;
  m.message_id = text("message_id");
  m.tenant = text("tenant");
  m.recipient = text("recipient");
  m.template_id = text("template_id");
  m.subject = text("subject");
  if (!text("variables").empty()) m.variables = nlohmann::json::parse(text("variables")).get<std::map<std::string, std::string>>();
  m.state = text("state");
  m.bounce_category = text("bounce_category");
  return m;
}

// The ids waiting for the relay, oldest first.
inline std::vector<std::string> queued() { return redis().lrange(kQueue, 0, -1); }

// The message id the send (tenant, Idempotency-Key) created, if any.
inline std::optional<std::string> findSend(const std::string& tenant, const std::string& key) {
  const auto found = redis().get("mail:send:" + tenant + ":" + key);
  if (!found) return std::nullopt;
  return std::string(*found);
}

// Record the message id the send (tenant, Idempotency-Key) created, for its replays.
inline void rememberSend(const std::string& tenant, const std::string& key, const std::string& message_id) {
  redis().set("mail:send:" + tenant + ":" + key, message_id);
}

// Move the message to state; a sent, bounced or suppressed message leaves the queue.
inline void setState(const std::string& message_id, const std::string& state, const std::string& bounce_category = "") {
  redis().hset(messageKey(message_id), {{"state", state}, {"bounce_category", bounce_category}});
  if (state == "sent" || state == "bounced" || state == "suppressed") redis().lrem(kQueue, 0, message_id);
}

// Append one relay attempt's outcome to the timeline; returns the attempt's number.
inline long recordAttempt(const std::string& message_id, const std::string& outcome) {
  return static_cast<long>(redis().rpush(messageKey(message_id) + ":attempts", outcome));
}

// The timeline, oldest first.
inline std::vector<Attempt> attempts(const std::string& message_id) {
  std::vector<Attempt> out;
  for (const std::string& outcome : redis().lrange(messageKey(message_id) + ":attempts", 0, -1)) {
    out.push_back(Attempt{static_cast<long>(out.size()) + 1, outcome});
  }
  return out;
}

}  // namespace mail::store
`,
  'mail/gate.h': `// Admission (provided; step 2 builds the same three functions): mail:suppressed is the durable set
// of suppressed addresses, mail:rate:{address}:{window} a per-recipient counter for one minute that
// expires with it. admit decides both in one Lua script: "suppressed", "rate_limited" or "ok".
// Every address is normalized first.
#pragma once

#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

#include "mail/address.h"

namespace mail::gate {

inline const std::string kSuppressedSet = "mail:suppressed";
constexpr long kRateLimit = 5;
constexpr long kWindowSeconds = 60;

inline const std::string kAdmitLua = R"lua(
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 'suppressed' end
local sent = redis.call('INCR', KEYS[2])
if sent == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
if sent > tonumber(ARGV[3]) then return 'rate_limited' end
return 'ok'
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The counter of one normalized address for the current minute.
inline std::string rateKey(const std::string& addr) {
  const long now = static_cast<long>(std::chrono::duration_cast<std::chrono::seconds>(
                                         std::chrono::system_clock::now().time_since_epoch())
                                         .count());
  return "mail:rate:" + addr + ":" + std::to_string(now / kWindowSeconds);
}

inline void suppress(const std::string& recipient) { redis().sadd(kSuppressedSet, address::normalize(recipient)); }

inline bool isSuppressed(const std::string& recipient) {
  return redis().sismember(kSuppressedSet, address::normalize(recipient));
}

inline std::string admit(const std::string& recipient) {
  const std::string addr = address::normalize(recipient);
  return redis().eval<std::string>(kAdmitLua, {kSuppressedSet, rateKey(addr)},
                                   {addr, std::to_string(kWindowSeconds), std::to_string(kRateLimit)});
}

}  // namespace mail::gate
`,
  'mail/relay.h': `// The relay client (provided; step 3 builds the same function): deliver hands a queued message to
// the relay under its own message id with a 10-second deadline, retries UNAVAILABLE and soft
// bounces, asks GetStatus before resending after a timeout, records every attempt, and ends the
// message in sent, bounced (recorded and suppressed), suppressed or deferred.
#pragma once

#include <grpcpp/grpcpp.h>

#include <chrono>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>

#include "email_delivery.grpc.pb.h"
#include "mail/gate.h"
#include "mail/store.h"

namespace mail::relay {

constexpr std::chrono::seconds kDeadline{10};
constexpr int kMaxAttempts = 3;
constexpr std::chrono::seconds kBackoff{2};

inline smtprelay::Relay::Stub& stub() {
  static auto s = smtprelay::Relay::NewStub(grpc::CreateChannel("relay:9000", grpc::InsecureChannelCredentials()));
  return *s;
}

// Hand a queued message to the relay; returns the state it ends in.
inline std::string deliver(const std::string& message_id) {
  const auto message = store::load(message_id);
  if (!message) throw std::out_of_range("no message " + message_id);
  smtprelay::SendMailRequest request;
  request.set_message_id(message_id);
  request.set_recipient(message->recipient);
  request.set_template_id(message->template_id);
  request.set_subject(message->subject);
  for (const auto& [name, value] : message->variables) (*request.mutable_variables())[name] = value;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    smtprelay::Delivery delivery;
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    const grpc::Status sent = stub().SendMail(&ctx, request, &delivery);
    if (sent.error_code() == grpc::StatusCode::UNAVAILABLE) {
      store::recordAttempt(message_id, "unavailable");
      std::this_thread::sleep_for(kBackoff);
      continue;
    }
    if (sent.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
      grpc::ClientContext status_ctx;
      status_ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
      smtprelay::StatusRequest status_request;
      status_request.set_message_id(message_id);
      const grpc::Status asked = stub().GetStatus(&status_ctx, status_request, &delivery);
      if (!asked.ok()) throw std::runtime_error("relay status: " + asked.error_message());
      if (delivery.outcome() == "unknown") {
        store::recordAttempt(message_id, "timeout");
        continue;
      }
    } else if (!sent.ok()) {
      throw std::runtime_error("relay: " + sent.error_message());
    }
    store::recordAttempt(message_id, delivery.outcome());
    if (delivery.outcome() == "accepted") {
      store::setState(message_id, "sent");
      return "sent";
    }
    if (delivery.outcome() == "hard_bounce") {
      store::setState(message_id, "bounced", delivery.bounce_category());
      gate::suppress(message->recipient);
      return "bounced";
    }
    if (delivery.outcome() == "suppressed") {
      store::setState(message_id, "suppressed");
      return "suppressed";
    }
    std::this_thread::sleep_for(kBackoff);
  }
  store::setState(message_id, "deferred");
  return "deferred";
}

}  // namespace mail::relay
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('mail', 'Address')]: `package mail

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/**
 * Address helpers every step shares: normalize is the form suppression, rate limits and event keys
 * use (trimmed, lowercase); recipientHash is the SHA-256 of it in hex, the name an address goes by
 * outside the message store.
 */
object Address {
  def normalize(address: String): String = address.trim.toLowerCase

  def recipientHash(address: String): String =
    MessageDigest.getInstance("SHA-256").digest(normalize(address).getBytes(StandardCharsets.UTF_8)).map("%02x".format(_)).mkString
}
`,
  [scalaPath('mail', 'Store')]: `package mail

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

/**
 * The message store (provided): every message is a Redis hash mail:msg:{id} with message_id,
 * tenant, recipient, template_id, subject, variables (JSON), state (queued, sent, bounced,
 * suppressed or deferred) and bounce_category ("" without a bounce). mail:queue lists the ids
 * waiting for the relay (a message leaves it once sent, bounced or suppressed);
 * mail:msg:{id}:attempts holds the outcome of every relay attempt, oldest first;
 * mail:send:{tenant}:{key} the message id a send with that Idempotency-Key created.
 */
object Store {
  final case class Message(
      messageId: String,
      tenant: String,
      recipient: String,
      templateId: String,
      subject: String,
      variables: Map[String, String],
      state: String,
      bounceCategory: String)

  final case class Attempt(attempt: Int, outcome: String)

  val jedis = new JedisPooled("redis", 6379)

  val Queue = "mail:queue"
  private val Terminal = Set("sent", "bounced", "suppressed")

  def messageKey(messageId: String): String = s"mail:msg:$messageId"

  /** Create the message in state queued and put it on the relay's queue; returns its id. */
  def enqueue(tenant: String, recipient: String, templateId: String, subject: String, variables: Map[String, String]): String = {
    val messageId = s"m-\${jedis.incr("mail:seq")}"
    val fields = Map(
      "message_id" -> messageId, "tenant" -> tenant, "recipient" -> recipient, "template_id" -> templateId,
      "subject" -> subject, "variables" -> variables.toJson.compactPrint, "state" -> "queued", "bounce_category" -> "")
    jedis.hset(messageKey(messageId), fields.asJava)
    jedis.rpush(Queue, messageId)
    messageId
  }

  /** The message (variables decoded), if it exists. */
  def load(messageId: String): Option[Message] = {
    val raw = jedis.hgetAll(messageKey(messageId)).asScala.toMap
    if (raw.isEmpty) None
    else {
      val variables = raw.get("variables").filter(_.nonEmpty).map(_.parseJson.convertTo[Map[String, String]]).getOrElse(Map.empty)
      Some(Message(raw("message_id"), raw("tenant"), raw("recipient"), raw("template_id"), raw("subject"), variables,
        raw("state"), raw.getOrElse("bounce_category", "")))
    }
  }

  /** The ids waiting for the relay, oldest first. */
  def queued(): Seq[String] = jedis.lrange(Queue, 0, -1).asScala.toSeq

  /** The message id the send (tenant, Idempotency-Key) created, if any. */
  def findSend(tenant: String, key: String): Option[String] = Option(jedis.get(s"mail:send:$tenant:$key"))

  /** Record the message id the send (tenant, Idempotency-Key) created, for its replays. */
  def rememberSend(tenant: String, key: String, messageId: String): Unit = {
    jedis.set(s"mail:send:$tenant:$key", messageId)
    ()
  }

  /** Move the message to state; a sent, bounced or suppressed message leaves the queue. */
  def setState(messageId: String, state: String, bounceCategory: String = ""): Unit = {
    jedis.hset(messageKey(messageId), Map("state" -> state, "bounce_category" -> bounceCategory).asJava)
    if (Terminal.contains(state)) jedis.lrem(Queue, 0, messageId)
    ()
  }

  /** Append one relay attempt's outcome to the timeline; returns the attempt's number. */
  def recordAttempt(messageId: String, outcome: String): Int = jedis.rpush(s"\${messageKey(messageId)}:attempts", outcome).toInt

  /** The timeline, oldest first. */
  def attempts(messageId: String): Seq[Attempt] =
    jedis.lrange(s"\${messageKey(messageId)}:attempts", 0, -1).asScala.toSeq.zipWithIndex.map { case (outcome, n) => Attempt(n + 1, outcome) }
}
`,
  [scalaPath('mail', 'Gate')]: `package mail

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * Admission (provided; step 2 builds the same three functions): mail:suppressed is the durable set
 * of suppressed addresses, mail:rate:{address}:{window} a per-recipient counter for one minute that
 * expires with it. admit decides both in one Lua script: "suppressed", "rate_limited" or "ok".
 * Every address is normalized first.
 */
object Gate {
  val jedis = new JedisPooled("redis", 6379)

  val SuppressedSet = "mail:suppressed"
  val RateLimit = 5
  val WindowSeconds = 60L

  val AdmitLua: String =
    """if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 'suppressed' end
      |local sent = redis.call('INCR', KEYS[2])
      |if sent == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
      |if sent > tonumber(ARGV[3]) then return 'rate_limited' end
      |return 'ok'
      |""".stripMargin

  def rateKey(address: String, nowMillis: Long): String = s"mail:rate:$address:\${nowMillis / 1000 / WindowSeconds}"

  def suppress(address: String): Unit = {
    jedis.sadd(SuppressedSet, Address.normalize(address))
    ()
  }

  def isSuppressed(address: String): Boolean = jedis.sismember(SuppressedSet, Address.normalize(address))

  def admit(address: String): String = {
    val normalized = Address.normalize(address)
    val keys = List(SuppressedSet, rateKey(normalized, System.currentTimeMillis())).asJava
    jedis.eval(AdmitLua, keys, List(normalized, WindowSeconds.toString, RateLimit.toString).asJava).toString
  }
}
`,
  [scalaPath('mail', 'Relay')]: `package mail

import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import smtprelay.email_delivery.{Delivery, RelayGrpc, SendMailRequest, StatusRequest}

/**
 * The relay client (provided; step 3 builds the same function): deliver hands a queued message to
 * the relay under its own message id with a 10-second deadline, retries UNAVAILABLE and soft
 * bounces, asks GetStatus before resending after a timeout, records every attempt, and ends the
 * message in sent, bounced (recorded and suppressed), suppressed or deferred.
 */
object Relay {
  val DeadlineSeconds = 10L
  val MaxAttempts = 3
  val BackoffMillis = 2000L

  private val relay = RelayGrpc.blockingStub(ManagedChannelBuilder.forAddress("relay", 9000).usePlaintext().build())

  /** One SendMail; None when the attempt settled nothing (unavailable, or a timeout the relay never saw). */
  private def sendOnce(messageId: String, request: SendMailRequest): Option[Delivery] =
    try Some(relay.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).sendMail(request))
    catch {
      case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.UNAVAILABLE =>
        Store.recordAttempt(messageId, "unavailable")
        Thread.sleep(BackoffMillis)
        None
      case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED =>
        val status = relay.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).getStatus(StatusRequest(messageId = messageId))
        if (status.outcome == "unknown") {
          Store.recordAttempt(messageId, "timeout")
          None
        } else Some(status)
    }

  /** Hand a queued message to the relay; returns the state it ends in. */
  def deliver(messageId: String): String = {
    val message = Store.load(messageId).getOrElse(throw new NoSuchElementException(s"no message $messageId"))
    val request = SendMailRequest(messageId = messageId, recipient = message.recipient, templateId = message.templateId,
      subject = message.subject, variables = message.variables)
    def attempt(n: Int): String =
      if (n > MaxAttempts) {
        Store.setState(messageId, "deferred")
        "deferred"
      } else
        sendOnce(messageId, request) match {
          case None => attempt(n + 1)
          case Some(delivery) =>
            Store.recordAttempt(messageId, delivery.outcome)
            delivery.outcome match {
              case "accepted" =>
                Store.setState(messageId, "sent")
                "sent"
              case "hard_bounce" =>
                Store.setState(messageId, "bounced", delivery.bounceCategory)
                Gate.suppress(message.recipient)
                "bounced"
              case "suppressed" =>
                Store.setState(messageId, "suppressed")
                "suppressed"
              case _ =>
                Thread.sleep(BackoffMillis)
                attempt(n + 1)
            }
        }
    attempt(1)
  }
}
`,
};
