import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis velocity windows per card and account',
  concept: 'redis',
  file: 'state',
  focus: ['scorer', 'redis', 'consumer'],
  task: `## Task

**Starting point.** The starter is the velocity store the scorer writes to at score time:
\`record_attempt\` issues two client-side \`INCR\` calls on a card key and a device key bucketed by
day, \`velocity_snapshot\` reads the raw counters back, \`should_alert\` compares them to literal
thresholds, and \`score_with_velocity\` calls the model and then counts. It serves the demo and hides
five flaws.

**Failure mode the checks target.** The starter scores first and counts afterwards, so a model
timeout is a free attempt; its keys carry only a day bucket and no TTL, so today's suspicious device
is still suspicious next month; it counts attempts where the rule is about distinct accounts, so a
ring of twenty accounts from one device reads as one account retrying; and its thresholds live as
literals in one function while the read path reports raw numbers, so the alert and the dashboard
disagree by construction.

- **One atomic script.** A single Lua \`EVAL\` (\`VELOCITY_LUA\`) increments the card's counter and
  adds the account to the device's set.
- **Windows expire on their own boundary.** The key carries its bucket
  (\`vel:card:{card_ref}:{hour}\`, \`vel:device:{device_id}:{day}\`) and the script sets the TTL on
  the first write of that bucket (\`EXPIRE\` with \`ATTEMPT_WINDOW_S\` / \`DEVICE_WINDOW_S\`).
- **Every attempt counts, including the failed ones.** The counter moves before the model call, and
  nothing on the model's failure path may skip it.
- **Distinct accounts per device per day**, not attempts: \`PFADD\`/\`PFCOUNT\` on the device key.
- **One rule set.** \`VELOCITY_RULES\` holds the thresholds and both \`velocity_snapshot\` and
  \`should_alert\` read it.`,
  sequence: {
    participants: ['Fraud Scorer', 'Velocity store', 'Redis', 'Fraud model'],
    messages: [
      {
        from: 'Fraud Scorer',
        to: 'Velocity store',
        label: 'record_attempt(card_ref, device_id, account_ref)',
        kind: 'sync',
      },
      {from: 'Velocity store', to: 'Redis', label: 'EVAL · INCR + EXPIRE · PFADD · PFCOUNT', kind: 'sync'},
      {from: 'Redis', to: 'Velocity store', label: '[attempts, distinct accounts]', kind: 'reply'},
      {from: 'Velocity store', to: 'Fraud Scorer', label: 'attempt counted before the model', kind: 'reply'},
      {from: 'Fraud Scorer', to: 'Fraud model', label: 'Score(features)', kind: 'sync'},
      {from: 'Fraud model', to: 'Fraud Scorer', label: 'score / timeout', kind: 'reply'},
      {
        from: 'Fraud Scorer',
        to: 'Velocity store',
        label: 'velocity_snapshot · should_alert(VELOCITY_RULES)',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'atomic-script',
      title: 'One atomic Lua EVAL counts the attempt',
      detail:
        'The counter update is a single script call, `redis.eval(VELOCITY_LUA, 2, …)` and its equivalents, not separate client-side writes. The starter issues two `INCR` calls from the client, so a crash or a concurrent attempt between them leaves the card and device windows disagreeing.',
      match: {
        python: {all: [/VELOCITY_LUA/, /redis\.eval\(/]},
        typescript: {all: [/VELOCITY_LUA/, /redis\.eval\(/]},
        go: {all: [/velocityLua/, /\.Eval\(/]},
        scala: {all: [/VelocityLua/, /jedis\s*\.eval\(/]},
        cpp: {all: [/kVelocityLua/, /redis\.eval/]},
      },
    },
    {
      id: 'window-expiry',
      title: 'Window keys expire on their own boundary',
      detail:
        'The script sets an expiry on first write, `EXPIRE`/`PEXPIRE` with the `ATTEMPT_WINDOW_S`/`DEVICE_WINDOW_S` constant, so an hourly and a daily window reset on schedule. The starter sets no TTL at all, so a flagged device stays flagged forever.',
      match: {
        python: {all: [/ATTEMPT_WINDOW_S/, /EXPIRE/]},
        typescript: {all: [/ATTEMPT_WINDOW_S/, /EXPIRE/]},
        go: {all: [/attemptWindowSeconds/, /EXPIRE/]},
        scala: {all: [/AttemptWindowSeconds/, /EXPIRE/]},
        cpp: {all: [/kAttemptWindowSeconds/, /EXPIRE/]},
      },
    },
    {
      id: 'count-before-model',
      title: 'The attempt is counted before the model is called',
      detail:
        'The script call happens before the model call, so a timeout, a retry or a terminal model error still counts the attempt. The starter calls the model first and counts afterwards, which makes every failed attempt invisible to velocity, the case fraud rings generate by the thousand.',
      match: {
        python: {order: [/redis\.eval\(/, /model\.score\(/]},
        typescript: {order: [/redis\.eval\(/, /model\.score\(/]},
        go: {order: [/\.Eval\(/, /model\.Score\(/]},
        scala: {order: [/jedis\s*\.eval\(/, /model\.score\(/]},
        cpp: {order: [/redis\.eval/, /model\.score\(/]},
      },
    },
    {
      id: 'distinct-accounts',
      title: 'Distinct accounts per device, not raw attempts',
      detail:
        'The device window counts distinct account references with `PFADD`/`PFCOUNT` (or a set with `SADD`/`SCARD`) under the `vel:device:{device_id}:{day}` key. The starter increments the same key as the card counter, so twenty accounts from one device look like one account retrying.',
      match: {
        python: {all: [/vel:device/, /PFADD/, /PFCOUNT/]},
        typescript: {all: [/vel:device/, /PFADD/, /PFCOUNT/]},
        go: {all: [/vel:device/, /PFADD/, /PFCOUNT/]},
        scala: {all: [/vel:device/, /PFADD/, /PFCOUNT/]},
        cpp: {all: [/vel:device/, /PFADD/, /PFCOUNT/]},
      },
    },
    {
      id: 'shared-rules',
      title: 'Reads and alerting share one rule set',
      detail:
        'Thresholds live in `VELOCITY_RULES`, and both `velocity_snapshot` (the read path) and `should_alert` (the alerting decision) consult it. The starter hardcodes the thresholds in the alerting call and reports raw counters from the read path, so the two drift apart with the first rule change.',
      match: {
        python: {all: [/VELOCITY_RULES/, /def velocity_snapshot\(/, /def should_alert\(/]},
        typescript: {all: [/VELOCITY_RULES/, /function velocitySnapshot\(/, /shouldAlert\(snapshot/]},
        go: {all: [/velocityRules/, /func velocitySnapshot\(/, /func shouldAlert\(/]},
        scala: {all: [/VelocityRules/, /def velocitySnapshot\(/, /def shouldAlert\(/]},
        cpp: {all: [/kVelocityRules/, /velocitySnapshot\(/, /shouldAlert\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time

from redis import Redis

logger = logging.getLogger("velocity")

redis = Redis(host="redis", port=6379)


def window_keys(card_ref: str, device_id: str, now: float | None = None) -> tuple[str, str]:
    """The window keys for this card and device."""
    moment = time.gmtime(now if now is not None else time.time())
    day = time.strftime("%Y%m%d", moment)
    return f"vel:card:{card_ref}:{day}", f"vel:device:{device_id}:{day}"


def record_attempt(card_ref: str, device_id: str, account_ref: str) -> tuple[int, int]:
    """Count the attempt for the card and the device."""
    card_key, device_key = window_keys(card_ref, device_id)
    attempts = redis.incr(card_key)
    accounts_seen = redis.incr(device_key)
    return int(attempts), int(accounts_seen)


def velocity_snapshot(card_ref: str, device_id: str) -> dict:
    """The counters alerting reads."""
    card_key, device_key = window_keys(card_ref, device_id)
    return {
        "card_key": card_key,
        "device_key": device_key,
        "card_attempts": int(redis.get(card_key) or 0),
        "device_accounts": int(redis.get(device_key) or 0),
    }


def should_alert(snapshot: dict) -> bool:
    """Alert on a burst for this card or this device."""
    return snapshot["card_attempts"] > 40 or snapshot["device_accounts"] > 5


def score_with_velocity(model, features: dict, card_ref: str, device_id: str, account_ref: str) -> tuple[dict, dict]:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    scored = model.score(features)
    record_attempt(card_ref, device_id, account_ref)
    logger.info("velocity card=%s device=%s", card_ref, device_id)
    return scored, velocity_snapshot(card_ref, device_id)
`,
      solution: `import logging
import time

from redis import Redis

logger = logging.getLogger("velocity")

redis = Redis(host="redis", port=6379)

ATTEMPT_WINDOW_S = 3600
DEVICE_WINDOW_S = 24 * 3600
# One rule set: the scorer enforces it, alerting reads it, and the dashboard shows it.
VELOCITY_RULES = {"card_attempts_per_hour": 20, "device_accounts_per_day": 5}
VELOCITY_LUA = """
local attempts = redis.call('INCR', KEYS[1])
if attempts == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
redis.call('PFADD', KEYS[2], ARGV[2])
if redis.call('TTL', KEYS[2]) < 0 then
  redis.call('EXPIRE', KEYS[2], ARGV[3])
end
return {attempts, redis.call('PFCOUNT', KEYS[2])}
"""


def window_keys(card_ref: str, device_id: str, now: float | None = None) -> tuple[str, str]:
    """The bucket lives in the key, so each hour and each day gets its own counter and its own TTL."""
    moment = time.gmtime(now if now is not None else time.time())
    hour = time.strftime("%Y%m%d%H", moment)
    day = time.strftime("%Y%m%d", moment)
    return f"vel:card:{card_ref}:{hour}", f"vel:device:{device_id}:{day}"


def record_attempt(card_ref: str, device_id: str, account_ref: str) -> tuple[int, int]:
    """Count the attempt and the account in one atomic step."""
    card_key, device_key = window_keys(card_ref, device_id)
    attempts, accounts_seen = redis.eval(
        VELOCITY_LUA, 2, card_key, device_key, ATTEMPT_WINDOW_S, account_ref, DEVICE_WINDOW_S
    )
    return int(attempts), int(accounts_seen)


def velocity_snapshot(card_ref: str, device_id: str) -> dict:
    """The read path: same keys, same windows, same rules as the write path."""
    card_key, device_key = window_keys(card_ref, device_id)
    snapshot = {
        "card_key": card_key,
        "device_key": device_key,
        "card_attempts": int(redis.get(card_key) or 0),
        "device_accounts": int(redis.pfcount(device_key)),
    }
    snapshot.update(VELOCITY_RULES)
    return snapshot


def should_alert(snapshot: dict) -> bool:
    """Alerting applies the thresholds the scorer enforces, never a second copy of them."""
    return (
        snapshot["card_attempts"] > VELOCITY_RULES["card_attempts_per_hour"]
        or snapshot["device_accounts"] > VELOCITY_RULES["device_accounts_per_day"]
    )


def score_with_velocity(model, features: dict, card_ref: str, device_id: str, account_ref: str) -> tuple[dict, dict]:
    attempts, accounts_seen = record_attempt(card_ref, device_id, account_ref)
    logger.info("velocity card=%s attempts=%d accounts=%d", card_ref, attempts, accounts_seen)
    # The attempt is already counted: if the model times out from here, the window still saw it,
    # which is exactly the case the starter loses.
    scored = model.score(features)
    return scored, velocity_snapshot(card_ref, device_id)
`,
    },
    typescript: {
      starter: `/** Velocity counters for the scorer. */
import Redis from 'ioredis';

export const redis = new Redis({host: 'redis', port: 6379});

function windowKeys(cardRef: string, deviceId: string, now = new Date()): [string, string] {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  return [\`vel:card:\${cardRef}:\${day}\`, \`vel:device:\${deviceId}:\${day}\`];
}

export async function recordAttempt(cardRef: string, deviceId: string, accountRef: string): Promise<[number, number]> {
  const [cardKey, deviceKey] = windowKeys(cardRef, deviceId);
  const attempts = await redis.incr(cardKey);
  const accountsSeen = await redis.incr(deviceKey);
  return [attempts, accountsSeen];
}

export interface VelocitySnapshot {
  card_key: string;
  device_key: string;
  card_attempts: number;
  device_accounts: number;
}

export async function velocitySnapshot(cardRef: string, deviceId: string): Promise<VelocitySnapshot> {
  const [cardKey, deviceKey] = windowKeys(cardRef, deviceId);
  return {
    card_key: cardKey,
    device_key: deviceKey,
    card_attempts: Number((await redis.get(cardKey)) ?? 0),
    device_accounts: Number((await redis.get(deviceKey)) ?? 0),
  };
}

export function shouldAlert(snapshot: VelocitySnapshot): boolean {
  return snapshot.card_attempts > 40 || snapshot.device_accounts > 5;
}

export async function scoreWithVelocity(
  model: {score: (features: Record<string, unknown>) => Promise<Record<string, unknown>>},
  features: Record<string, unknown>,
  cardRef: string,
  deviceId: string,
  accountRef: string,
): Promise<{scored: Record<string, unknown>; snapshot: VelocitySnapshot}> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const scored = await model.score(features);
  await recordAttempt(cardRef, deviceId, accountRef);
  return {scored, snapshot: await velocitySnapshot(cardRef, deviceId)};
}
`,
      solution: `/** Velocity windows: one atomic script per attempt, expiring on the window boundary. */
import Redis from 'ioredis';

export const redis = new Redis({host: 'redis', port: 6379});

const ATTEMPT_WINDOW_S = 3600;
const DEVICE_WINDOW_S = 24 * 3600;
// One rule set: the scorer enforces it, alerting reads it, and the dashboard shows it.
const VELOCITY_RULES = {card_attempts_per_hour: 20, device_accounts_per_day: 5};

const VELOCITY_LUA = \`
local attempts = redis.call('INCR', KEYS[1])
if attempts == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
redis.call('PFADD', KEYS[2], ARGV[2])
if redis.call('TTL', KEYS[2]) < 0 then
  redis.call('EXPIRE', KEYS[2], ARGV[3])
end
return {attempts, redis.call('PFCOUNT', KEYS[2])}
\`;

export interface VelocitySnapshot {
  card_key: string;
  device_key: string;
  card_attempts: number;
  device_accounts: number;
  rules: typeof VELOCITY_RULES;
}

function windowKeys(cardRef: string, deviceId: string, now = new Date()): [string, string] {
  const hour = now.toISOString().slice(0, 13).replaceAll(/[-:T]/g, '');
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  return [\`vel:card:\${cardRef}:\${hour}\`, \`vel:device:\${deviceId}:\${day}\`];
}

export async function recordAttempt(cardRef: string, deviceId: string, accountRef: string): Promise<[number, number]> {
  const [cardKey, deviceKey] = windowKeys(cardRef, deviceId);
  const [attempts, accountsSeen] = (await redis.eval(
    VELOCITY_LUA,
    2,
    cardKey,
    deviceKey,
    String(ATTEMPT_WINDOW_S),
    accountRef,
    String(DEVICE_WINDOW_S),
  )) as [number, number];
  return [Number(attempts), Number(accountsSeen)];
}

export async function velocitySnapshot(cardRef: string, deviceId: string): Promise<VelocitySnapshot> {
  const [cardKey, deviceKey] = windowKeys(cardRef, deviceId);
  return {
    card_key: cardKey,
    device_key: deviceKey,
    card_attempts: Number((await redis.get(cardKey)) ?? 0),
    device_accounts: Number(await redis.pfcount(deviceKey)),
    rules: VELOCITY_RULES,
  };
}

export function shouldAlert(snapshot: VelocitySnapshot): boolean {
  return (
    snapshot.card_attempts > VELOCITY_RULES.card_attempts_per_hour ||
    snapshot.device_accounts > VELOCITY_RULES.device_accounts_per_day
  );
}

export async function scoreWithVelocity(
  model: {score: (features: Record<string, unknown>) => Promise<Record<string, unknown>>},
  features: Record<string, unknown>,
  cardRef: string,
  deviceId: string,
  accountRef: string,
): Promise<{scored: Record<string, unknown>; snapshot: VelocitySnapshot}> {
  const [attempts, accountsSeen] = await recordAttempt(cardRef, deviceId, accountRef);
  // The attempt is already counted: a model timeout from here still shows up in the window.
  const scored = await model.score(features);
  const snapshot = await velocitySnapshot(cardRef, deviceId);
  return {scored: {...scored, attempts, accounts_seen: accountsSeen}, snapshot};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type FeatureVector map[string]any

type ScoreVerdict struct {
	Score    float64
	Band     string
	Fallback bool
}

type ModelScorer interface {
	Score(ctx context.Context, features FeatureVector) (ScoreVerdict, error)
}

func windowKeys(cardRef, deviceID string, now time.Time) (string, string) {
	return "vel:card:" + cardRef + ":" + now.UTC().Format("20060102"),
		"vel:device:" + deviceID + ":" + now.UTC().Format("20060102")
}

func recordAttempt(ctx context.Context, cardRef, deviceID, accountRef string) (int, int, error) {
	cardKey, deviceKey := windowKeys(cardRef, deviceID, time.Now())
	attempts, err := rdb.Incr(ctx, cardKey).Result()
	if err != nil {
		return 0, 0, err
	}
	accountsSeen, err := rdb.Incr(ctx, deviceKey).Result()
	if err != nil {
		return 0, 0, err
	}
	return int(attempts), int(accountsSeen), nil
}

type VelocitySnapshot struct {
	CardKey        string
	DeviceKey      string
	CardAttempts   int
	DeviceAccounts int
}

func velocitySnapshot(ctx context.Context, cardRef, deviceID string) (VelocitySnapshot, error) {
	cardKey, deviceKey := windowKeys(cardRef, deviceID, time.Now())
	attempts, err := rdb.Get(ctx, cardKey).Int()
	if err != nil && err != redis.Nil {
		return VelocitySnapshot{}, err
	}
	accountsSeen, err := rdb.Get(ctx, deviceKey).Int()
	if err != nil && err != redis.Nil {
		return VelocitySnapshot{}, err
	}
	return VelocitySnapshot{CardKey: cardKey, DeviceKey: deviceKey, CardAttempts: attempts, DeviceAccounts: accountsSeen}, nil
}

func shouldAlert(snapshot VelocitySnapshot) bool {
	return snapshot.CardAttempts > 40 || snapshot.DeviceAccounts > 5
}

func scoreWithVelocity(
	ctx context.Context,
	model ModelScorer,
	features FeatureVector,
	cardRef, deviceID, accountRef string,
) (ScoreVerdict, VelocitySnapshot, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	verdict, err := model.Score(ctx, features)
	if err != nil {
		return ScoreVerdict{}, VelocitySnapshot{}, err
	}
	attempts, accountsSeen, err := recordAttempt(ctx, cardRef, deviceID, accountRef)
	if err != nil {
		return ScoreVerdict{}, VelocitySnapshot{}, err
	}
	log.Printf("velocity card=%s attempts=%d accounts=%d", cardRef, attempts, accountsSeen)
	snapshot, err := velocitySnapshot(ctx, cardRef, deviceID)
	return verdict, snapshot, err
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	attemptWindowSeconds = 3600
	deviceWindowSeconds  = 24 * 3600
	cardKeyPrefix        = "vel:card"
	deviceKeyPrefix      = "vel:device"
)

// One rule set: the scorer enforces it, alerting reads it, and the dashboard shows it.
var velocityRules = map[string]int{
	"card_attempts_per_hour":  20,
	"device_accounts_per_day": 5,
}

const velocityLua = \`
local attempts = redis.call('INCR', KEYS[1])
if attempts == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
redis.call('PFADD', KEYS[2], ARGV[2])
if redis.call('TTL', KEYS[2]) < 0 then
  redis.call('EXPIRE', KEYS[2], ARGV[3])
end
return {attempts, redis.call('PFCOUNT', KEYS[2])}
\`

type FeatureVector map[string]any

type ScoreVerdict struct {
	Score    float64
	Band     string
	Fallback bool
}

type ModelScorer interface {
	Score(ctx context.Context, features FeatureVector) (ScoreVerdict, error)
}

type VelocitySnapshot struct {
	CardKey        string
	DeviceKey      string
	CardAttempts   int
	DeviceAccounts int
	Rules          map[string]int
}

// The bucket lives in the key, so each hour and each day gets its own counter and its own TTL.
func windowKeys(cardRef, deviceID string, now time.Time) (string, string) {
	return fmt.Sprintf("%s:%s:%s", cardKeyPrefix, cardRef, now.UTC().Format("2006010215")),
		fmt.Sprintf("%s:%s:%s", deviceKeyPrefix, deviceID, now.UTC().Format("20060102"))
}

func recordAttempt(ctx context.Context, cardRef, deviceID, accountRef string) (int, int, error) {
	cardKey, deviceKey := windowKeys(cardRef, deviceID, time.Now())
	values, err := rdb.Eval(ctx, velocityLua, []string{cardKey, deviceKey}, attemptWindowSeconds, accountRef, deviceWindowSeconds).Slice()
	if err != nil {
		return 0, 0, err
	}
	attempts, _ := values[0].(int64)
	accountsSeen, _ := values[1].(int64)
	return int(attempts), int(accountsSeen), nil
}

func velocitySnapshot(ctx context.Context, cardRef, deviceID string) (VelocitySnapshot, error) {
	cardKey, deviceKey := windowKeys(cardRef, deviceID, time.Now())
	attempts, err := rdb.Get(ctx, cardKey).Int()
	if err != nil && err != redis.Nil {
		return VelocitySnapshot{}, err
	}
	accountsSeen, err := rdb.PFCount(ctx, deviceKey).Result()
	if err != nil {
		return VelocitySnapshot{}, err
	}
	return VelocitySnapshot{
		CardKey:        cardKey,
		DeviceKey:      deviceKey,
		CardAttempts:   attempts,
		DeviceAccounts: int(accountsSeen),
		Rules:          velocityRules,
	}, nil
}

func shouldAlert(snapshot VelocitySnapshot) bool {
	return snapshot.CardAttempts > velocityRules["card_attempts_per_hour"] ||
		snapshot.DeviceAccounts > velocityRules["device_accounts_per_day"]
}

func scoreWithVelocity(
	ctx context.Context,
	model ModelScorer,
	features FeatureVector,
	cardRef, deviceID, accountRef string,
) (ScoreVerdict, VelocitySnapshot, error) {
	attempts, accountsSeen, err := recordAttempt(ctx, cardRef, deviceID, accountRef)
	if err != nil {
		return ScoreVerdict{}, VelocitySnapshot{}, err
	}
	log.Printf("velocity card=%s attempts=%d accounts=%d", cardRef, attempts, accountsSeen)
	// The attempt is already counted: a model timeout from here still shows up in the window.
	verdict, err := model.Score(ctx, features)
	if err != nil {
		return ScoreVerdict{}, VelocitySnapshot{}, err
	}
	snapshot, err := velocitySnapshot(ctx, cardRef, deviceID)
	return verdict, snapshot, err
}
`,
    },
    scala: {
      starter: `import java.text.SimpleDateFormat
import java.util.Date

import redis.clients.jedis.Jedis

object Velocity {
  val jedis = new Jedis("redis", 6379)

  case class VelocitySnapshot(cardKey: String, deviceKey: String, cardAttempts: Long, deviceAccounts: Long)

  def windowKeys(cardRef: String, deviceId: String, now: Date = new Date()): (String, String) = {
    val day = new SimpleDateFormat("yyyyMMdd").format(now)
    (s"vel:card:$cardRef:$day", s"vel:device:$deviceId:$day")
  }

  def recordAttempt(cardRef: String, deviceId: String, accountRef: String): (Long, Long) = {
    val (cardKey, deviceKey) = windowKeys(cardRef, deviceId)
    val attempts = jedis.incr(cardKey)
    val accountsSeen = jedis.incr(deviceKey)
    (attempts, accountsSeen)
  }

  def velocitySnapshot(cardRef: String, deviceId: String): VelocitySnapshot = {
    val (cardKey, deviceKey) = windowKeys(cardRef, deviceId)
    VelocitySnapshot(cardKey, deviceKey, counter(cardKey), counter(deviceKey))
  }

  private def counter(key: String): Long = Option(jedis.get(key)).map(_.toLong).getOrElse(0L)

  def shouldAlert(snapshot: VelocitySnapshot): Boolean =
    snapshot.cardAttempts > 40 || snapshot.deviceAccounts > 5

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  def scoreWithVelocity(model: ModelClient, features: Map[String, Any], cardRef: String, deviceId: String, accountRef: String): (Map[String, Any], VelocitySnapshot) = {
    val scored = model.score(features)
    recordAttempt(cardRef, deviceId, accountRef)
    (scored, velocitySnapshot(cardRef, deviceId))
  }

  class ModelClient {
    def score(features: Map[String, Any]): Map[String, Any] = Map("score" -> 0.5)
  }
}
`,
      solution: `import java.text.SimpleDateFormat
import java.util.Date

import redis.clients.jedis.Jedis

object Velocity {
  val AttemptWindowSeconds = 3600L
  val DeviceWindowSeconds = 24L * 3600
  val CardKeyPrefix = "vel:card"
  val DeviceKeyPrefix = "vel:device"
  // One rule set: the scorer enforces it, alerting reads it, and the dashboard shows it.
  val VelocityRules = Map("card_attempts_per_hour" -> 20, "device_accounts_per_day" -> 5)
  val jedis = new Jedis("redis", 6379)

  val VelocityLua =
    """
      |local attempts = redis.call('INCR', KEYS[1])
      |if attempts == 1 then
      |  redis.call('EXPIRE', KEYS[1], ARGV[1])
      |end
      |redis.call('PFADD', KEYS[2], ARGV[2])
      |if redis.call('TTL', KEYS[2]) < 0 then
      |  redis.call('EXPIRE', KEYS[2], ARGV[3])
      |end
      |return {attempts, redis.call('PFCOUNT', KEYS[2])}
      |""".stripMargin

  case class VelocitySnapshot(
      cardKey: String,
      deviceKey: String,
      cardAttempts: Long,
      deviceAccounts: Long,
      rules: Map[String, Int],
  )

  class ModelClient {
    def score(features: Map[String, Any]): Map[String, Any] = Map("score" -> 0.5)
  }

  // The bucket lives in the key, so each hour and each day gets its own counter and its own TTL.
  def windowKeys(cardRef: String, deviceId: String, now: Date = new Date()): (String, String) = {
    val hour = new SimpleDateFormat("yyyyMMddHH").format(now)
    val day = new SimpleDateFormat("yyyyMMdd").format(now)
    (s"$CardKeyPrefix:$cardRef:$hour", s"$DeviceKeyPrefix:$deviceId:$day")
  }

  def recordAttempt(cardRef: String, deviceId: String, accountRef: String): (Long, Long) = {
    val (cardKey, deviceKey) = windowKeys(cardRef, deviceId)
    val result = jedis
      .eval(VelocityLua, 2, cardKey, deviceKey, AttemptWindowSeconds.toString, accountRef, DeviceWindowSeconds.toString)
      .asInstanceOf[java.util.List[Long]]
    (result.get(0), result.get(1))
  }

  def velocitySnapshot(cardRef: String, deviceId: String): VelocitySnapshot = {
    val (cardKey, deviceKey) = windowKeys(cardRef, deviceId)
    VelocitySnapshot(cardKey, deviceKey, counter(cardKey), jedis.pfcount(deviceKey), VelocityRules)
  }

  private def counter(key: String): Long = Option(jedis.get(key)).map(_.toLong).getOrElse(0L)

  def shouldAlert(snapshot: VelocitySnapshot): Boolean =
    snapshot.cardAttempts > VelocityRules("card_attempts_per_hour") ||
      snapshot.deviceAccounts > VelocityRules("device_accounts_per_day")

  def scoreWithVelocity(
      model: ModelClient,
      features: Map[String, Any],
      cardRef: String,
      deviceId: String,
      accountRef: String,
  ): (Map[String, Any], VelocitySnapshot) = {
    val (attempts, accountsSeen) = recordAttempt(cardRef, deviceId, accountRef)
    // The attempt is already counted: a model timeout from here still shows up in the window.
    val scored = model.score(features)
    (scored ++ Map("attempts" -> attempts, "accounts_seen" -> accountsSeen), velocitySnapshot(cardRef, deviceId))
  }
}
`,
    },
    cpp: {
      starter: `// Velocity counters for the scorer.
#include <ctime>
#include <iomanip>
#include <sstream>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

using json = nlohmann::json;

struct VelocitySnapshot {
  std::string card_key;
  std::string device_key;
  long long card_attempts = 0;
  long long device_accounts = 0;
};

class ModelClient {
 public:
  json score(const json& features) { return json{{"score", 0.5}}; }
};

static ModelClient model;

static std::pair<std::string, std::string> windowKeys(const std::string& card_ref, const std::string& device_id) {
  const std::time_t now = std::time(nullptr);
  std::ostringstream day;
  day << std::put_time(std::gmtime(&now), "%Y%m%d");
  return {"vel:card:" + card_ref + ":" + day.str(), "vel:device:" + device_id + ":" + day.str()};
}

static std::pair<long long, long long> recordAttempt(sw::redis::Redis& redis, const std::string& card_ref,
                                                    const std::string& device_id) {
  const auto keys = windowKeys(card_ref, device_id);
  const auto attempts = redis.incr(keys.first);
  const auto accounts_seen = redis.incr(keys.second);
  return {attempts, accounts_seen};
}

static VelocitySnapshot velocitySnapshot(sw::redis::Redis& redis, const std::string& card_ref,
                                        const std::string& device_id) {
  const auto keys = windowKeys(card_ref, device_id);
  const auto card_raw = redis.get(keys.first);
  const auto device_raw = redis.get(keys.second);
  VelocitySnapshot snapshot;
  snapshot.card_key = keys.first;
  snapshot.device_key = keys.second;
  snapshot.card_attempts = card_raw ? std::stoll(*card_raw) : 0;
  snapshot.device_accounts = device_raw ? std::stoll(*device_raw) : 0;
  return snapshot;
}

static bool shouldAlert(const VelocitySnapshot& snapshot) {
  return snapshot.card_attempts > 40 || snapshot.device_accounts > 5;
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
static std::pair<json, VelocitySnapshot> scoreWithVelocity(sw::redis::Redis& redis, const json& features,
                                                          const std::string& card_ref, const std::string& device_id) {
  const json scored = model.score(features);
  recordAttempt(redis, card_ref, device_id);
  return {scored, velocitySnapshot(redis, card_ref, device_id)};
}
`,
      solution: `// Velocity windows: one atomic script per attempt, expiring on the window boundary.
#include <algorithm>
#include <cstdio>
#include <ctime>
#include <iomanip>
#include <map>
#include <sstream>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

using json = nlohmann::json;

constexpr long long kAttemptWindowSeconds = 3600;
constexpr long long kDeviceWindowSeconds = 24 * 3600;

// One rule set: the scorer enforces it, alerting reads it, and the dashboard shows it.
static const std::map<std::string, int> kVelocityRules = {
    {"card_attempts_per_hour", 20},
    {"device_accounts_per_day", 5},
};

static const char* kVelocityLua = R"(
local attempts = redis.call('INCR', KEYS[1])
if attempts == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
redis.call('PFADD', KEYS[2], ARGV[2])
if redis.call('TTL', KEYS[2]) < 0 then
  redis.call('EXPIRE', KEYS[2], ARGV[3])
end
return tostring(attempts) .. ':' .. tostring(redis.call('PFCOUNT', KEYS[2]))
)";

struct VelocitySnapshot {
  std::string card_key;
  std::string device_key;
  long long card_attempts = 0;
  long long device_accounts = 0;
};

class ModelClient {
 public:
  json score(const json& features) { return json{{"score", 0.5}, {"fallback", false}}; }
};

static ModelClient model;

// The bucket lives in the key, so each hour and each day gets its own counter and its own TTL.
static std::pair<std::string, std::string> windowKeys(const std::string& card_ref, const std::string& device_id) {
  const std::time_t now = std::time(nullptr);
  std::ostringstream hour;
  hour << std::put_time(std::gmtime(&now), "%Y%m%d%H");
  std::ostringstream day;
  day << std::put_time(std::gmtime(&now), "%Y%m%d");
  return {"vel:card:" + card_ref + ":" + hour.str(), "vel:device:" + device_id + ":" + day.str()};
}

static std::pair<long long, long long> recordAttempt(sw::redis::Redis& redis, const std::string& card_ref,
                                                    const std::string& device_id, const std::string& account_ref) {
  const auto keys = windowKeys(card_ref, device_id);
  const auto raw = redis.eval<std::string>(
      kVelocityLua,
      {keys.first, keys.second},
      {std::to_string(kAttemptWindowSeconds), account_ref, std::to_string(kDeviceWindowSeconds)});
  long long attempts = 0;
  long long accounts_seen = 0;
  std::sscanf(raw.c_str(), "%lld:%lld", &attempts, &accounts_seen);
  return {attempts, accounts_seen};
}

static VelocitySnapshot velocitySnapshot(sw::redis::Redis& redis, const std::string& card_ref,
                                        const std::string& device_id) {
  const auto keys = windowKeys(card_ref, device_id);
  const auto card_raw = redis.get(keys.first);
  VelocitySnapshot snapshot;
  snapshot.card_key = keys.first;
  snapshot.device_key = keys.second;
  snapshot.card_attempts = card_raw ? std::stoll(*card_raw) : 0;
  snapshot.device_accounts = redis.pfcount(keys.second);
  return snapshot;
}

static bool shouldAlert(const VelocitySnapshot& snapshot) {
  return snapshot.card_attempts > kVelocityRules.at("card_attempts_per_hour") ||
         snapshot.device_accounts > kVelocityRules.at("device_accounts_per_day");
}

static std::pair<json, VelocitySnapshot> scoreWithVelocity(sw::redis::Redis& redis, const json& features,
                                                          const std::string& card_ref, const std::string& device_id,
                                                          const std::string& account_ref) {
  const auto counted = recordAttempt(redis, card_ref, device_id, account_ref);
  // The attempt is already counted: a model timeout from here still shows up in the window.
  const json scored = model.score(features);
  json verdict = scored;
  verdict["attempts"] = counted.first;
  verdict["accounts_seen"] = counted.second;
  return {verdict, velocitySnapshot(redis, card_ref, device_id)};
}
`,
    },
  },
  hints: [
    'A device that cycled twenty accounts yesterday still shows as suspicious in a month, while the burst that timed out the model during the incident shows zero attempts on the dashboard.',
    '`window_keys` buckets by day with no `EXPIRE`, `record_attempt` runs after `model.score` with two plain `INCR` calls, and `should_alert` compares against literals the snapshot does not report.',
    'Move `record_attempt` above `model.score`; make it one `redis.eval(VELOCITY_LUA, …)` that does `INCR` + `EXPIRE` on the hour key and `PFADD`/`PFCOUNT` on the day key; read thresholds from `VELOCITY_RULES` in both `velocity_snapshot` and `should_alert`.',
  ],
  debrief: `The fix moves the count ahead of the model call because the counter exists for the attempts the model does not get to answer: a burst that times out the model is exactly the burst the window must see. Putting both keys in one Lua script keeps the card count and the device set consistent under concurrent attempts, and setting the TTL on the first write of a bucket turns a counter into a window that forgets on schedule. \`PFADD\`/\`PFCOUNT\` matches the rule being enforced, distinct accounts rather than attempts. Production velocity stores go further: a sorted set gives a sliding rather than a bucketed rate, hash tags keep the card and device keys in one cluster slot so the script stays atomic, and the snapshot is published with the decision so a case shows what the scorer saw.
`,
};
