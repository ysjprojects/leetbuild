import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis velocity windows per card and device',
  concept: 'redis',
  file: 'state',
  focus: ['scorer', 'redis', 'model'],
  task: `## Task

**Starting point.** The starter is the velocity store the scorer uses at score time:
\`record_attempt(card_ref, device_id, account_ref)\` sends \`INCR vel:card:{card_ref}\` and
\`INCR vel:device:{device_id}\` from the client, \`velocity_snapshot\` reads both counters back,
\`should_alert\` compares them with literal thresholds, and
\`score_with_velocity(features, card_ref, device_id, account_ref)\` asks the model
(\`model.score_transaction\`), then counts. It serves the demo and hides five flaws.

**Failure mode the checks target.** A model call that fails is a free attempt for a card-testing
script; a reader landing between the two \`INCR\`s sees a card counted on a device that is not; a
busy card stays flagged forever; a ring of twenty accounts on one phone reads as one account
retrying; and the dashboard and the alert disagree about the same numbers.

- One Lua script (\`VELOCITY_LUA\`, run with \`EVAL\`) moves both windows and returns
  \`[attempts, accounts]\`.
- \`vel:card:{card_ref}\` counts attempts and expires \`ATTEMPT_WINDOW_S\` (3600 s) after its first
  write; \`vel:device:{device_id}\` is a set of account refs (\`SADD\`/\`SCARD\`) that expires
  \`DEVICE_WINDOW_S\` (86400 s) after its first write.
- \`score_with_velocity\` records the attempt before the model is called.
- \`VELOCITY_RULES\` (\`card_attempts_per_hour\` 5, \`device_accounts_per_day\` 3) is the one rule table:
  \`velocity_snapshot\` lists the rules exceeded in \`flags\`, and \`should_alert\` reads the same table.`,
  sequence: {
    participants: ['scorer', 'Redis', 'Fraud model'],
    messages: [
      {
        from: 'scorer',
        to: 'Redis',
        label: 'EVAL VELOCITY_LUA vel:card:{card} vel:device:{device} account',
        kind: 'sync',
      },
      {from: 'Redis', to: 'scorer', label: '[attempts, distinct accounts]', kind: 'reply'},
      {from: 'scorer', to: 'Fraud model', label: 'Score(vector): counted already', kind: 'sync'},
      {from: 'Fraud model', to: 'scorer', label: 'score / INVALID_ARGUMENT', kind: 'reply'},
      {from: 'scorer', to: 'Redis', label: 'velocity_snapshot · flags from VELOCITY_RULES', kind: 'sync'},
      {from: 'scorer', to: 'scorer', label: 'should_alert(snapshot) · same rules', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'atomic-script',
      title: 'One Lua script moves both windows',
      detail:
        'The card counter and the device set move in one `EVAL` of `VELOCITY_LUA`, so no reader or crash lands between them; the starter sends two `INCR`s from the client.',
      match: {
        python: {
          all: [/VELOCITY_LUA/, /\.eval\(|register_script\(/, /redis\.call\(\s*['"]SADD['"]/],
          none: [/r\.incr\(/],
        },
        typescript: {
          all: [/VELOCITY_LUA/, /\.eval\(|defineCommand\(/, /redis\.call\(\s*['"]SADD['"]/],
          none: [/redis\.incr\(/],
        },
        go: {
          all: [/velocityLua/, /redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]SADD['"]/],
          none: [/rdb\.Incr\(/],
        },
        scala: {all: [/VelocityLua/, /jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]SADD['"]/], none: [/jedis\.incr\(/]},
        cpp: {all: [/kVelocityLua/, /redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]SADD['"]/], none: [/redis\.incr\(/]},
      },
    },
    {
      id: 'window-expiry',
      title: 'Each window expires after its first write',
      detail:
        'The script sets `EXPIRE` on the card key (`ATTEMPT_WINDOW_S`) when it is created and on the device key (`DEVICE_WINDOW_S`) when it has no TTL yet, so an hour later the card starts from one again.',
      match: {
        python: {all: [/ATTEMPT_WINDOW_S/, /DEVICE_WINDOW_S/, /redis\.call\(\s*['"]EXPIRE['"]/]},
        typescript: {all: [/ATTEMPT_WINDOW_S/, /DEVICE_WINDOW_S/, /redis\.call\(\s*['"]EXPIRE['"]/]},
        go: {all: [/attemptWindowSeconds/, /deviceWindowSeconds/, /redis\.call\(\s*['"]EXPIRE['"]/]},
        scala: {all: [/AttemptWindowSeconds/, /DeviceWindowSeconds/, /redis\.call\(\s*['"]EXPIRE['"]/]},
        cpp: {all: [/kAttemptWindowSeconds/, /kDeviceWindowSeconds/, /redis\.call\(\s*['"]EXPIRE['"]/]},
      },
    },
    {
      id: 'count-before-model',
      title: 'The attempt is counted before the model is asked',
      detail:
        '`score_with_velocity` calls `record_attempt` first, so an attempt the model refuses or never answers still counts; the starter counts only after a successful score.',
      match: {
        python: {order: [/def score_with_velocity/, /record_attempt\(/, /model\.score_transaction\(/]},
        typescript: {order: [/function scoreWithVelocity/, /recordAttempt\(/, /scoreTransaction\(/]},
        go: {order: [/func scoreWithVelocity/, /recordAttempt\(/, /model\.ScoreTransaction\(/]},
        scala: {order: [/def scoreWithVelocity/, /recordAttempt\(/, /Model\.scoreTransaction\(/]},
        cpp: {order: [/scoreWithVelocity\(/, /recordAttempt\(/, /model::scoreTransaction\(/]},
      },
    },
    {
      id: 'distinct-accounts',
      title: 'The device window counts distinct accounts',
      detail:
        'The device key is a set of account refs (`SADD`, `SCARD`): three attempts by two accounts on one device count two; the starter counts attempts.',
      match: {
        python: {all: [/SADD/, /SCARD|scard\(/], none: [/incr\([^)\n]*vel:device/]},
        typescript: {all: [/SADD/, /SCARD|scard\(/], none: [/incr\([^)\n]*vel:device/]},
        go: {all: [/SADD/, /SCARD|SCard\(/], none: [/Incr\([^)\n]*vel:device/]},
        scala: {all: [/SADD/, /SCARD|scard\(/], none: [/incr\([^)\n]*vel:device/]},
        cpp: {all: [/SADD/, /SCARD|scard\(/], none: [/incr\([^)\n]*vel:device/]},
      },
    },
    {
      id: 'shared-rules',
      title: 'The snapshot and the alert read one rule table',
      detail:
        '`velocity_snapshot` flags every rule of `VELOCITY_RULES` the counts exceed, and `should_alert` compares against the same table, so a snapshot that flags a rule always alerts; the starter alerts on its own literals.',
      match: {
        python: {
          all: [
            /def velocity_snapshot(?:(?!\ndef )[\s\S])*?VELOCITY_RULES/,
            /def should_alert(?:(?!\ndef )[\s\S])*?VELOCITY_RULES/,
          ],
          none: [/>\s*(10|5)\b/],
        },
        typescript: {
          all: [
            /function velocitySnapshot(?:(?!\nexport )[\s\S])*?VELOCITY_RULES/,
            /function shouldAlert(?:(?!\nexport )[\s\S])*?VELOCITY_RULES/,
          ],
          none: [/>\s*(10|5)\b/],
        },
        go: {
          all: [
            /func velocitySnapshot(?:(?!\nfunc )[\s\S])*?velocityRules/,
            /func shouldAlert(?:(?!\nfunc )[\s\S])*?velocityRules/,
          ],
          none: [/>\s*(10|5)\b/],
        },
        scala: {
          all: [
            /def velocitySnapshot(?:(?!\n {2}def )[\s\S])*?VelocityRules/,
            /def shouldAlert(?:(?!\n {2}def )[\s\S])*?VelocityRules/,
          ],
          none: [/[^-]>\s*(10|5)L?\b/],
        },
        cpp: {
          all: [
            /Velocity velocitySnapshot(?:(?!\n\})[\s\S])*?kVelocityRules/,
            /bool shouldAlert(?:(?!\n\})[\s\S])*?kVelocityRules/,
          ],
          none: [/>\s*(10|5)\b/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from fraud import model  # model.score_transaction(features) -> verdict; raises model.InvalidFeatures

r = redis.Redis(host="redis", port=6379, decode_responses=True)

VELOCITY_RULES = {"card_attempts_per_hour": 5, "device_accounts_per_day": 3}


def record_attempt(card_ref: str, device_id: str, account_ref: str) -> dict:
    """Count one attempt on the card and the device; returns {card_attempts, device_accounts}."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    attempts = r.incr(f"vel:card:{card_ref}")
    accounts = r.incr(f"vel:device:{device_id}")
    return {"card_attempts": attempts, "device_accounts": accounts}


def velocity_snapshot(card_ref: str, device_id: str) -> dict:
    """The card's and the device's windows as they stand: {card_attempts, device_accounts, flags}."""
    attempts = int(r.get(f"vel:card:{card_ref}") or 0)
    accounts = int(r.get(f"vel:device:{device_id}") or 0)
    return {"card_attempts": attempts, "device_accounts": accounts, "flags": []}


def should_alert(snapshot: dict) -> bool:
    return snapshot["card_attempts"] > 10 or snapshot["device_accounts"] > 5


def score_with_velocity(features: dict, card_ref: str, device_id: str, account_ref: str) -> dict:
    """The model's verdict for the vector, with the velocity snapshot after this attempt."""
    verdict = model.score_transaction(features)
    record_attempt(card_ref, device_id, account_ref)
    return {**verdict, "velocity": velocity_snapshot(card_ref, device_id)}
`,
      solution: `import redis

from fraud import model  # model.score_transaction(features) -> verdict; raises model.InvalidFeatures

r = redis.Redis(host="redis", port=6379, decode_responses=True)

ATTEMPT_WINDOW_S = 3600
DEVICE_WINDOW_S = 86400
VELOCITY_RULES = {"card_attempts_per_hour": 5, "device_accounts_per_day": 3}

# KEYS[1] the card's attempts, KEYS[2] the device's accounts; ARGV[1] the account, ARGV[2] and
# ARGV[3] the windows. Each window starts with its first write and expires on its own.
VELOCITY_LUA = """
local attempts = redis.call('INCR', KEYS[1])
if attempts == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
redis.call('SADD', KEYS[2], ARGV[1])
if redis.call('TTL', KEYS[2]) == -1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
return {attempts, redis.call('SCARD', KEYS[2])}
"""


def record_attempt(card_ref: str, device_id: str, account_ref: str) -> dict:
    """Count one attempt on the card and the device; returns {card_attempts, device_accounts}."""
    attempts, accounts = r.eval(VELOCITY_LUA, 2, f"vel:card:{card_ref}", f"vel:device:{device_id}", account_ref, ATTEMPT_WINDOW_S, DEVICE_WINDOW_S)
    return {"card_attempts": int(attempts), "device_accounts": int(accounts)}


def velocity_snapshot(card_ref: str, device_id: str) -> dict:
    """The card's and the device's windows as they stand: {card_attempts, device_accounts, flags}."""
    attempts = int(r.get(f"vel:card:{card_ref}") or 0)
    accounts = r.scard(f"vel:device:{device_id}")
    values = {"card_attempts_per_hour": attempts, "device_accounts_per_day": accounts}
    flags = [rule for rule, limit in VELOCITY_RULES.items() if values[rule] > limit]
    return {"card_attempts": attempts, "device_accounts": accounts, "flags": flags}


def should_alert(snapshot: dict) -> bool:
    return (
        snapshot["card_attempts"] > VELOCITY_RULES["card_attempts_per_hour"]
        or snapshot["device_accounts"] > VELOCITY_RULES["device_accounts_per_day"]
    )


def score_with_velocity(features: dict, card_ref: str, device_id: str, account_ref: str) -> dict:
    """The model's verdict for the vector, with the velocity snapshot after this attempt."""
    record_attempt(card_ref, device_id, account_ref)  # counted first: a refused or failed call is still an attempt
    verdict = model.score_transaction(features)
    return {**verdict, "velocity": velocity_snapshot(card_ref, device_id)}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import type {Features} from 'fraud/features';
import {type Verdict, scoreTransaction} from 'fraud/model';

const redis = new Redis({host: 'redis', port: 6379});

export const VELOCITY_RULES = {card_attempts_per_hour: 5, device_accounts_per_day: 3};

export interface Velocity {
  card_attempts: number;
  device_accounts: number;
  flags: string[];
}

/** Count one attempt on the card and the device. */
export async function recordAttempt(cardRef: string, deviceId: string, accountRef: string): Promise<Velocity> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const attempts = await redis.incr(\`vel:card:\${cardRef}\`);
  const accounts = await redis.incr(\`vel:device:\${deviceId}\`);
  return {card_attempts: attempts, device_accounts: accounts, flags: []};
}

/** The card's and the device's windows as they stand. */
export async function velocitySnapshot(cardRef: string, deviceId: string): Promise<Velocity> {
  const attempts = Number((await redis.get(\`vel:card:\${cardRef}\`)) ?? 0);
  const accounts = Number((await redis.get(\`vel:device:\${deviceId}\`)) ?? 0);
  return {card_attempts: attempts, device_accounts: accounts, flags: []};
}

export function shouldAlert(snapshot: Velocity): boolean {
  return snapshot.card_attempts > 10 || snapshot.device_accounts > 5;
}

/** The model's verdict for the vector, with the velocity snapshot after this attempt. */
export async function scoreWithVelocity(features: Features, cardRef: string, deviceId: string, accountRef: string): Promise<Verdict & {velocity: Velocity}> {
  const verdict = await scoreTransaction(features);
  await recordAttempt(cardRef, deviceId, accountRef);
  return {...verdict, velocity: await velocitySnapshot(cardRef, deviceId)};
}
`,
      solution: `import Redis from 'ioredis';

import type {Features} from 'fraud/features';
import {type Verdict, scoreTransaction} from 'fraud/model';

const redis = new Redis({host: 'redis', port: 6379});

export const ATTEMPT_WINDOW_S = 3600;
export const DEVICE_WINDOW_S = 86400;
export const VELOCITY_RULES = {card_attempts_per_hour: 5, device_accounts_per_day: 3};

// KEYS[1] the card's attempts, KEYS[2] the device's accounts; ARGV[1] the account, ARGV[2] and
// ARGV[3] the windows. Each window starts with its first write and expires on its own.
export const VELOCITY_LUA = \`
local attempts = redis.call('INCR', KEYS[1])
if attempts == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
redis.call('SADD', KEYS[2], ARGV[1])
if redis.call('TTL', KEYS[2]) == -1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
return {attempts, redis.call('SCARD', KEYS[2])}
\`;

export interface Velocity {
  card_attempts: number;
  device_accounts: number;
  flags: string[];
}

/** Count one attempt on the card and the device. */
export async function recordAttempt(cardRef: string, deviceId: string, accountRef: string): Promise<Velocity> {
  const [attempts, accounts] = (await redis.eval(
    VELOCITY_LUA,
    2,
    \`vel:card:\${cardRef}\`,
    \`vel:device:\${deviceId}\`,
    accountRef,
    ATTEMPT_WINDOW_S,
    DEVICE_WINDOW_S,
  )) as [number, number];
  return {card_attempts: attempts, device_accounts: accounts, flags: []};
}

/** The card's and the device's windows as they stand. */
export async function velocitySnapshot(cardRef: string, deviceId: string): Promise<Velocity> {
  const attempts = Number((await redis.get(\`vel:card:\${cardRef}\`)) ?? 0);
  const accounts = await redis.scard(\`vel:device:\${deviceId}\`);
  const flags: string[] = [];
  if (attempts > VELOCITY_RULES.card_attempts_per_hour) flags.push('card_attempts_per_hour');
  if (accounts > VELOCITY_RULES.device_accounts_per_day) flags.push('device_accounts_per_day');
  return {card_attempts: attempts, device_accounts: accounts, flags};
}

export function shouldAlert(snapshot: Velocity): boolean {
  return snapshot.card_attempts > VELOCITY_RULES.card_attempts_per_hour || snapshot.device_accounts > VELOCITY_RULES.device_accounts_per_day;
}

/** The model's verdict for the vector, with the velocity snapshot after this attempt. */
export async function scoreWithVelocity(features: Features, cardRef: string, deviceId: string, accountRef: string): Promise<Verdict & {velocity: Velocity}> {
  await recordAttempt(cardRef, deviceId, accountRef); // counted first: a refused or failed call is still an attempt
  const verdict = await scoreTransaction(features);
  return {...verdict, velocity: await velocitySnapshot(cardRef, deviceId)};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"fraud/features" // features.Features
	"fraud/model"    // model.ScoreTransaction(ctx, features) (model.Verdict, error); model.ErrInvalidFeatures
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var velocityRules = map[string]int64{"card_attempts_per_hour": 5, "device_accounts_per_day": 3}

type velocity struct {
	CardAttempts   int64    \`json:"card_attempts"\`
	DeviceAccounts int64    \`json:"device_accounts"\`
	Flags          []string \`json:"flags"\`
}

// recordAttempt counts one attempt on the card and the device.
func recordAttempt(ctx context.Context, cardRef, deviceID, accountRef string) (velocity, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	attempts, err := rdb.Incr(ctx, "vel:card:"+cardRef).Result()
	if err != nil {
		return velocity{}, err
	}
	accounts, err := rdb.Incr(ctx, "vel:device:"+deviceID).Result()
	if err != nil {
		return velocity{}, err
	}
	return velocity{CardAttempts: attempts, DeviceAccounts: accounts}, nil
}

// velocitySnapshot is the card's and the device's windows as they stand.
func velocitySnapshot(ctx context.Context, cardRef, deviceID string) (velocity, error) {
	attempts, err := rdb.Get(ctx, "vel:card:"+cardRef).Int64()
	if err != nil && err != redis.Nil {
		return velocity{}, err
	}
	accounts, err := rdb.Get(ctx, "vel:device:"+deviceID).Int64()
	if err != nil && err != redis.Nil {
		return velocity{}, err
	}
	return velocity{CardAttempts: attempts, DeviceAccounts: accounts}, nil
}

func shouldAlert(v velocity) bool {
	return v.CardAttempts > 10 || v.DeviceAccounts > 5
}

// scoreWithVelocity is the model's verdict for the vector, with the velocity snapshot after this attempt.
func scoreWithVelocity(ctx context.Context, f features.Features, cardRef, deviceID, accountRef string) (model.Verdict, velocity, error) {
	verdict, err := model.ScoreTransaction(ctx, f)
	if err != nil {
		return model.Verdict{}, velocity{}, err
	}
	if _, err := recordAttempt(ctx, cardRef, deviceID, accountRef); err != nil {
		return model.Verdict{}, velocity{}, err
	}
	v, err := velocitySnapshot(ctx, cardRef, deviceID)
	return verdict, v, err
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"fraud/features" // features.Features
	"fraud/model"    // model.ScoreTransaction(ctx, features) (model.Verdict, error); model.ErrInvalidFeatures
)

const (
	attemptWindowSeconds = 3600
	deviceWindowSeconds  = 86400
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var velocityRules = map[string]int64{"card_attempts_per_hour": 5, "device_accounts_per_day": 3}

// KEYS[1] the card's attempts, KEYS[2] the device's accounts; ARGV[1] the account, ARGV[2] and
// ARGV[3] the windows. Each window starts with its first write and expires on its own.
const velocityLua = \`
local attempts = redis.call('INCR', KEYS[1])
if attempts == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
redis.call('SADD', KEYS[2], ARGV[1])
if redis.call('TTL', KEYS[2]) == -1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
return {attempts, redis.call('SCARD', KEYS[2])}
\`

var velocityScript = redis.NewScript(velocityLua)

type velocity struct {
	CardAttempts   int64    \`json:"card_attempts"\`
	DeviceAccounts int64    \`json:"device_accounts"\`
	Flags          []string \`json:"flags"\`
}

// recordAttempt counts one attempt on the card and the device.
func recordAttempt(ctx context.Context, cardRef, deviceID, accountRef string) (velocity, error) {
	keys := []string{"vel:card:" + cardRef, "vel:device:" + deviceID}
	counts, err := velocityScript.Run(ctx, rdb, keys, accountRef, attemptWindowSeconds, deviceWindowSeconds).Int64Slice()
	if err != nil {
		return velocity{}, err
	}
	return velocity{CardAttempts: counts[0], DeviceAccounts: counts[1]}, nil
}

// velocitySnapshot is the card's and the device's windows as they stand.
func velocitySnapshot(ctx context.Context, cardRef, deviceID string) (velocity, error) {
	attempts, err := rdb.Get(ctx, "vel:card:"+cardRef).Int64()
	if err != nil && err != redis.Nil {
		return velocity{}, err
	}
	accounts, err := rdb.SCard(ctx, "vel:device:"+deviceID).Result()
	if err != nil {
		return velocity{}, err
	}
	v := velocity{CardAttempts: attempts, DeviceAccounts: accounts, Flags: []string{}}
	if attempts > velocityRules["card_attempts_per_hour"] {
		v.Flags = append(v.Flags, "card_attempts_per_hour")
	}
	if accounts > velocityRules["device_accounts_per_day"] {
		v.Flags = append(v.Flags, "device_accounts_per_day")
	}
	return v, nil
}

func shouldAlert(v velocity) bool {
	return v.CardAttempts > velocityRules["card_attempts_per_hour"] || v.DeviceAccounts > velocityRules["device_accounts_per_day"]
}

// scoreWithVelocity is the model's verdict for the vector, with the velocity snapshot after this attempt.
func scoreWithVelocity(ctx context.Context, f features.Features, cardRef, deviceID, accountRef string) (model.Verdict, velocity, error) {
	// Counted first: a refused or failed call is still an attempt.
	if _, err := recordAttempt(ctx, cardRef, deviceID, accountRef); err != nil {
		return model.Verdict{}, velocity{}, err
	}
	verdict, err := model.ScoreTransaction(ctx, f)
	if err != nil {
		return model.Verdict{}, velocity{}, err
	}
	v, err := velocitySnapshot(ctx, cardRef, deviceID)
	return verdict, v, err
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import fraud.{FeatureVector, Model, Verdict} // Model.scoreTransaction(vector): Verdict; throws fraud.InvalidFeatures

final case class VelocityCounts(cardAttempts: Long, deviceAccounts: Long, flags: Seq[String])

object VelocityStore {
  val VelocityRules: Map[String, Long] = Map("card_attempts_per_hour" -> 5L, "device_accounts_per_day" -> 3L)

  private val jedis = new JedisPooled("redis", 6379)

  /** Count one attempt on the card and the device. */
  def recordAttempt(cardRef: String, deviceId: String, accountRef: String): VelocityCounts = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val attempts = jedis.incr(s"vel:card:$cardRef")
    val accounts = jedis.incr(s"vel:device:$deviceId")
    VelocityCounts(attempts, accounts, Seq.empty)
  }

  /** The card's and the device's windows as they stand. */
  def velocitySnapshot(cardRef: String, deviceId: String): VelocityCounts = {
    val attempts = Option(jedis.get(s"vel:card:$cardRef")).map(_.toLong).getOrElse(0L)
    val accounts = Option(jedis.get(s"vel:device:$deviceId")).map(_.toLong).getOrElse(0L)
    VelocityCounts(attempts, accounts, Seq.empty)
  }

  def shouldAlert(v: VelocityCounts): Boolean = v.cardAttempts > 10 || v.deviceAccounts > 5

  /** The model's verdict for the vector, with the velocity snapshot after this attempt. */
  def scoreWithVelocity(vector: FeatureVector, cardRef: String, deviceId: String, accountRef: String): (Verdict, VelocityCounts) = {
    val verdict = Model.scoreTransaction(vector)
    recordAttempt(cardRef, deviceId, accountRef)
    (verdict, velocitySnapshot(cardRef, deviceId))
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import fraud.{FeatureVector, Model, Verdict} // Model.scoreTransaction(vector): Verdict; throws fraud.InvalidFeatures

final case class VelocityCounts(cardAttempts: Long, deviceAccounts: Long, flags: Seq[String])

object VelocityStore {
  val AttemptWindowSeconds = 3600L
  val DeviceWindowSeconds = 86400L
  val VelocityRules: Map[String, Long] = Map("card_attempts_per_hour" -> 5L, "device_accounts_per_day" -> 3L)

  /** KEYS[1] the card's attempts, KEYS[2] the device's accounts; ARGV[1] the account, ARGV[2] and ARGV[3] the windows. */
  val VelocityLua: String =
    """local attempts = redis.call('INCR', KEYS[1])
      |if attempts == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
      |redis.call('SADD', KEYS[2], ARGV[1])
      |if redis.call('TTL', KEYS[2]) == -1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
      |return {attempts, redis.call('SCARD', KEYS[2])}
      |""".stripMargin

  private val jedis = new JedisPooled("redis", 6379)

  /** Count one attempt on the card and the device. */
  def recordAttempt(cardRef: String, deviceId: String, accountRef: String): VelocityCounts = {
    val keys = List(s"vel:card:$cardRef", s"vel:device:$deviceId").asJava
    val args = List(accountRef, AttemptWindowSeconds.toString, DeviceWindowSeconds.toString).asJava
    val counts = jedis.eval(VelocityLua, keys, args).asInstanceOf[java.util.List[java.lang.Long]].asScala.map(_.longValue)
    VelocityCounts(counts(0), counts(1), Seq.empty)
  }

  /** The card's and the device's windows as they stand. */
  def velocitySnapshot(cardRef: String, deviceId: String): VelocityCounts = {
    val attempts = Option(jedis.get(s"vel:card:$cardRef")).map(_.toLong).getOrElse(0L)
    val accounts = jedis.scard(s"vel:device:$deviceId")
    val flags = Seq("card_attempts_per_hour" -> attempts, "device_accounts_per_day" -> accounts).collect {
      case (rule, value) if value > VelocityRules(rule) => rule
    }
    VelocityCounts(attempts, accounts, flags)
  }

  def shouldAlert(v: VelocityCounts): Boolean =
    v.cardAttempts > VelocityRules("card_attempts_per_hour") || v.deviceAccounts > VelocityRules("device_accounts_per_day")

  /** The model's verdict for the vector, with the velocity snapshot after this attempt. */
  def scoreWithVelocity(vector: FeatureVector, cardRef: String, deviceId: String, accountRef: String): (Verdict, VelocityCounts) = {
    recordAttempt(cardRef, deviceId, accountRef) // counted first: a refused or failed call is still an attempt
    val verdict = Model.scoreTransaction(vector)
    (verdict, velocitySnapshot(cardRef, deviceId))
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <map>
#include <string>
#include <utility>
#include <vector>

#include "fraud/features.h"  // features::Features
#include "fraud/model.h"     // model::scoreTransaction(features) -> model::Verdict; throws model::InvalidFeatures

sw::redis::Redis redis("tcp://redis:6379");

const std::map<std::string, long long> kVelocityRules = {{"card_attempts_per_hour", 5}, {"device_accounts_per_day", 3}};

struct Velocity {
  long long card_attempts = 0;
  long long device_accounts = 0;
  std::vector<std::string> flags;
};

// Count one attempt on the card and the device.
Velocity recordAttempt(const std::string& card_ref, const std::string& device_id, const std::string& account_ref) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const long long attempts = redis.incr("vel:card:" + card_ref);
  const long long accounts = redis.incr("vel:device:" + device_id);
  return Velocity{attempts, accounts, {}};
}

// The card's and the device's windows as they stand.
Velocity velocitySnapshot(const std::string& card_ref, const std::string& device_id) {
  const auto attempts = redis.get("vel:card:" + card_ref);
  const auto accounts = redis.get("vel:device:" + device_id);
  return Velocity{attempts ? std::stoll(*attempts) : 0, accounts ? std::stoll(*accounts) : 0, {}};
}

bool shouldAlert(const Velocity& v) { return v.card_attempts > 10 || v.device_accounts > 5; }

// The model's verdict for the vector, with the velocity snapshot after this attempt.
std::pair<model::Verdict, Velocity> scoreWithVelocity(const features::Features& fx, const std::string& card_ref, const std::string& device_id,
                                                      const std::string& account_ref) {
  const model::Verdict verdict = model::scoreTransaction(fx);
  recordAttempt(card_ref, device_id, account_ref);
  return {verdict, velocitySnapshot(card_ref, device_id)};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <map>
#include <string>
#include <utility>
#include <vector>

#include "fraud/features.h"  // features::Features
#include "fraud/model.h"     // model::scoreTransaction(features) -> model::Verdict; throws model::InvalidFeatures

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kAttemptWindowSeconds = 3600;
constexpr long long kDeviceWindowSeconds = 86400;
const std::map<std::string, long long> kVelocityRules = {{"card_attempts_per_hour", 5}, {"device_accounts_per_day", 3}};

// KEYS[1] the card's attempts, KEYS[2] the device's accounts; ARGV[1] the account, ARGV[2] and
// ARGV[3] the windows. Each window starts with its first write and expires on its own.
const std::string kVelocityLua = R"lua(
local attempts = redis.call('INCR', KEYS[1])
if attempts == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
redis.call('SADD', KEYS[2], ARGV[1])
if redis.call('TTL', KEYS[2]) == -1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
return {attempts, redis.call('SCARD', KEYS[2])}
)lua";

struct Velocity {
  long long card_attempts = 0;
  long long device_accounts = 0;
  std::vector<std::string> flags;
};

// Count one attempt on the card and the device.
Velocity recordAttempt(const std::string& card_ref, const std::string& device_id, const std::string& account_ref) {
  const std::vector<std::string> keys = {"vel:card:" + card_ref, "vel:device:" + device_id};
  const std::vector<std::string> args = {account_ref, std::to_string(kAttemptWindowSeconds), std::to_string(kDeviceWindowSeconds)};
  const auto counts = redis.eval<std::vector<long long>>(kVelocityLua, keys, args);
  return Velocity{counts[0], counts[1], {}};
}

// The card's and the device's windows as they stand.
Velocity velocitySnapshot(const std::string& card_ref, const std::string& device_id) {
  const auto attempts = redis.get("vel:card:" + card_ref);
  Velocity v{attempts ? std::stoll(*attempts) : 0, redis.scard("vel:device:" + device_id), {}};
  if (v.card_attempts > kVelocityRules.at("card_attempts_per_hour")) v.flags.push_back("card_attempts_per_hour");
  if (v.device_accounts > kVelocityRules.at("device_accounts_per_day")) v.flags.push_back("device_accounts_per_day");
  return v;
}

bool shouldAlert(const Velocity& v) {
  return v.card_attempts > kVelocityRules.at("card_attempts_per_hour") || v.device_accounts > kVelocityRules.at("device_accounts_per_day");
}

// The model's verdict for the vector, with the velocity snapshot after this attempt.
std::pair<model::Verdict, Velocity> scoreWithVelocity(const features::Features& fx, const std::string& card_ref, const std::string& device_id,
                                                      const std::string& account_ref) {
  recordAttempt(card_ref, device_id, account_ref);  // counted first: a refused or failed call is still an attempt
  const model::Verdict verdict = model::scoreTransaction(fx);
  return {verdict, velocitySnapshot(card_ref, device_id)};
}
`,
    },
  },
  harness: {
    python: `import fraud_scoring_pb2_grpc
from fraud.features import derive_features
from fraud.risk_model import ModelPeer

VECTOR = derive_features({"age_days": 400, "chargebacks": 0}, 4200)


def _state(ctx):
    ctx.grpc.serve(fraud_scoring_pb2_grpc.add_ModelServicer_to_server, ModelPeer())
    return ctx.load("state")


def check_atomic_script(ctx):
    m = _state(ctx)
    seen = ctx.redis_after("vel:card:c-1", lambda: (ctx.redis.get("vel:card:c-1"), ctx.redis.exists("vel:device:d-1")))
    got = m.record_attempt("c-1", "d-1", "acct-1")
    assert seen.fired, "record_attempt never touched vel:card:c-1"
    assert seen.result in ((None, 0), ("1", 1)), f"right after vel:card:c-1 moved, a concurrent reader saw the card at {seen.result[0]!r} with vel:device:d-1 {'present' if seen.result[1] else 'absent'}: the two windows move in two commands, and a reader or a crash lands between them. Move both in one Lua script"
    assert (got["card_attempts"], got["device_accounts"]) == (1, 1), f"the first attempt must count 1 on the card and 1 account on the device, got {got}"


def check_window_expiry(ctx):
    m = _state(ctx)
    for _ in range(3):
        m.record_attempt("c-1", "d-1", "acct-1")
    ttl = ctx.redis.ttl("vel:card:c-1")
    assert 0 < ttl <= 3600, f"vel:card:c-1 has TTL {ttl}: the card window must expire ATTEMPT_WINDOW_S (3600 s) after its first write"
    ttl = ctx.redis.ttl("vel:device:d-1")
    assert 3600 < ttl <= 86400, f"vel:device:d-1 has TTL {ttl}: the device window must expire DEVICE_WINDOW_S (86400 s) after its first write"
    ctx.clock.advance(3601)
    got = m.record_attempt("c-1", "d-1", "acct-2")
    assert got["card_attempts"] == 1, f"an hour after its first attempt the card still counts {got['card_attempts']} attempts: the window never closes, so a busy card stays flagged"
    assert got["device_accounts"] == 2, f"inside the day the device must count acct-1 and acct-2, got {got['device_accounts']}"
    ctx.clock.advance(86400)
    got = m.record_attempt("c-1", "d-1", "acct-3")
    assert got["device_accounts"] == 1, f"a day later the device still counts {got['device_accounts']} accounts: its window must expire"


def check_count_before_model(ctx):
    m = _state(ctx)
    scored = m.score_with_velocity(VECTOR, "c-1", "d-1", "acct-1")
    assert scored.get("band") == "approve" and scored["velocity"]["card_attempts"] == 1, f"a first attempt must be scored and counted, got {scored}"
    refused = {**VECTOR, "feature_version": "fx-2"}
    try:
        m.score_with_velocity(refused, "c-1", "d-1", "acct-1")
    except m.model.InvalidFeatures:
        pass
    else:
        raise AssertionError("the model refuses a vector at fx-2 with INVALID_ARGUMENT: score_with_velocity must let model.InvalidFeatures through")
    attempts = ctx.redis.get("vel:card:c-1")
    assert attempts == "2", f"after two attempts, one the model refused, vel:card:c-1 holds {attempts!r}: an attempt the model did not score must still be counted. Record it before calling the model"


def check_distinct_accounts(ctx):
    m = _state(ctx)
    m.record_attempt("c-1", "d-1", "acct-1")
    m.record_attempt("c-2", "d-1", "acct-1")
    got = m.record_attempt("c-3", "d-1", "acct-2")
    assert got["device_accounts"] == 2, f"three attempts by two accounts on device d-1 counted {got['device_accounts']}: the device window counts distinct accounts, not attempts"
    snapshot = m.velocity_snapshot("c-3", "d-1")
    assert snapshot["device_accounts"] == 2, f"velocity_snapshot reports {snapshot['device_accounts']} accounts on d-1, expected 2"


def check_shared_rules(ctx):
    m = _state(ctx)
    for i in range(5):
        m.record_attempt("c-1", f"d-{i}", "acct-1")
    snapshot = m.velocity_snapshot("c-1", "d-0")
    assert snapshot.get("flags") == [] and not m.should_alert(snapshot), f"five attempts is the limit, not over it: the snapshot {snapshot} and should_alert must both say no"
    m.record_attempt("c-1", "d-0", "acct-1")
    snapshot = m.velocity_snapshot("c-1", "d-0")
    assert snapshot.get("flags") == ["card_attempts_per_hour"], f"six attempts on c-1 must flag card_attempts_per_hour (VELOCITY_RULES: 5), the snapshot is {snapshot}"
    assert m.should_alert(snapshot), f"the snapshot flags card_attempts_per_hour but should_alert says no: the alert reads other thresholds than VELOCITY_RULES ({snapshot})"
    for account in ("acct-2", "acct-3", "acct-4", "acct-5"):
        m.record_attempt("c-9", "d-7", account)
    snapshot = m.velocity_snapshot("c-9", "d-7")
    assert snapshot.get("flags") == ["device_accounts_per_day"] and m.should_alert(snapshot), f"four accounts on d-7 must flag device_accounts_per_day (VELOCITY_RULES: 3) and alert, the snapshot is {snapshot}, should_alert {m.should_alert(snapshot)}"
`,
    typescript: `const VECTOR = {feature_version: 'fx-3', account_age_days: 400, prior_chargebacks: 0, amount_cents: 4200};

function state(ctx) {
  const {modelPeer} = ctx.load('/support/fraud/risk_model.ts');
  ctx.grpc.serve(ctx.proto('fraud_scoring.proto').fraudscore.Model.service, modelPeer);
  return ctx.load('state');
}

export async function check_atomic_script(ctx) {
  const m = state(ctx);
  const seen = ctx.redisAfter('vel:card:c-1', () => [ctx.redis.get('vel:card:c-1'), ctx.redis.exists('vel:device:d-1')]);
  const got = await m.recordAttempt('c-1', 'd-1', 'acct-1');
  assert(seen.fired, 'recordAttempt never touched vel:card:c-1');
  const [card, device] = seen.result;
  assert((card === null && device === 0) || (card === '1' && device === 1), \`right after vel:card:c-1 moved, a concurrent reader saw the card at \${JSON.stringify(card)} with vel:device:d-1 \${device ? 'present' : 'absent'}: the two windows move in two commands, and a reader or a crash lands between them. Move both in one Lua script\`);
  assert(got.card_attempts === 1 && got.device_accounts === 1, \`the first attempt must count 1 on the card and 1 account on the device, got \${JSON.stringify(got)}\`);
}

export async function check_window_expiry(ctx) {
  const m = state(ctx);
  for (let i = 0; i < 3; i++) await m.recordAttempt('c-1', 'd-1', 'acct-1');
  let ttl = ctx.redis.ttl('vel:card:c-1');
  assert(0 < ttl && ttl <= 3600, \`vel:card:c-1 has TTL \${ttl}: the card window must expire ATTEMPT_WINDOW_S (3600 s) after its first write\`);
  ttl = ctx.redis.ttl('vel:device:d-1');
  assert(3600 < ttl && ttl <= 86400, \`vel:device:d-1 has TTL \${ttl}: the device window must expire DEVICE_WINDOW_S (86400 s) after its first write\`);
  ctx.clock.advance(3601);
  let got = await m.recordAttempt('c-1', 'd-1', 'acct-2');
  assert.equal(got.card_attempts, 1, \`an hour after its first attempt the card still counts \${got.card_attempts} attempts: the window never closes, so a busy card stays flagged\`);
  assert.equal(got.device_accounts, 2, \`inside the day the device must count acct-1 and acct-2, got \${got.device_accounts}\`);
  ctx.clock.advance(86400);
  got = await m.recordAttempt('c-1', 'd-1', 'acct-3');
  assert.equal(got.device_accounts, 1, \`a day later the device still counts \${got.device_accounts} accounts: its window must expire\`);
}

export async function check_count_before_model(ctx) {
  const m = state(ctx);
  const scored = await m.scoreWithVelocity(VECTOR, 'c-1', 'd-1', 'acct-1');
  assert(scored.band === 'approve' && scored.velocity.card_attempts === 1, \`a first attempt must be scored and counted, got \${JSON.stringify(scored)}\`);
  let refused = false;
  try {
    await m.scoreWithVelocity({...VECTOR, feature_version: 'fx-2'}, 'c-1', 'd-1', 'acct-1');
  } catch (e) {
    refused = (e as Error).constructor.name === 'InvalidFeatures';
  }
  assert(refused, 'the model refuses a vector at fx-2 with INVALID_ARGUMENT: scoreWithVelocity must let InvalidFeatures through');
  const attempts = ctx.redis.get('vel:card:c-1');
  assert.equal(attempts, '2', \`after two attempts, one the model refused, vel:card:c-1 holds \${JSON.stringify(attempts)}: an attempt the model did not score must still be counted. Record it before calling the model\`);
}

export async function check_distinct_accounts(ctx) {
  const m = state(ctx);
  await m.recordAttempt('c-1', 'd-1', 'acct-1');
  await m.recordAttempt('c-2', 'd-1', 'acct-1');
  const got = await m.recordAttempt('c-3', 'd-1', 'acct-2');
  assert.equal(got.device_accounts, 2, \`three attempts by two accounts on device d-1 counted \${got.device_accounts}: the device window counts distinct accounts, not attempts\`);
  const snapshot = await m.velocitySnapshot('c-3', 'd-1');
  assert.equal(snapshot.device_accounts, 2, \`velocitySnapshot reports \${snapshot.device_accounts} accounts on d-1, expected 2\`);
}

export async function check_shared_rules(ctx) {
  const m = state(ctx);
  for (let i = 0; i < 5; i++) await m.recordAttempt('c-1', \`d-\${i}\`, 'acct-1');
  let snapshot = await m.velocitySnapshot('c-1', 'd-0');
  assert((snapshot.flags ?? []).length === 0 && !m.shouldAlert(snapshot), \`five attempts is the limit, not over it: the snapshot \${JSON.stringify(snapshot)} and shouldAlert must both say no\`);
  await m.recordAttempt('c-1', 'd-0', 'acct-1');
  snapshot = await m.velocitySnapshot('c-1', 'd-0');
  assert.deepStrictEqual(snapshot.flags, ['card_attempts_per_hour'], \`six attempts on c-1 must flag card_attempts_per_hour (VELOCITY_RULES: 5), the snapshot is \${JSON.stringify(snapshot)}\`);
  assert(m.shouldAlert(snapshot), \`the snapshot flags card_attempts_per_hour but shouldAlert says no: the alert reads other thresholds than VELOCITY_RULES (\${JSON.stringify(snapshot)})\`);
  for (const account of ['acct-2', 'acct-3', 'acct-4', 'acct-5']) await m.recordAttempt('c-9', 'd-7', account);
  snapshot = await m.velocitySnapshot('c-9', 'd-7');
  assert(JSON.stringify(snapshot.flags) === '["device_accounts_per_day"]' && m.shouldAlert(snapshot), \`four accounts on d-7 must flag device_accounts_per_day (VELOCITY_RULES: 3) and alert, the snapshot is \${JSON.stringify(snapshot)}\`);
}
`,
    go: `package main

import (
	"context"
	"errors"
	"fmt"

	"fraud/features"
	pb "fraud/gen/fraud_scoring"
	"fraud/model"
	"fraud/riskmodel"

	"leetbuild/harness"
)

var (
	stateBg     = context.Background()
	stateVector = features.Features{AccountAgeDays: 400, AmountCents: 4200, FeatureVersion: features.FeatureVersion, PriorChargebacks: 0}
)

func serveModel(ctx *harness.Ctx) {
	pb.RegisterModelServer(ctx.GRPC.Server(""), riskmodel.Peer{})
}

func mustRecord(ctx *harness.Ctx, cardRef, deviceID, accountRef string) velocity {
	v, err := recordAttempt(stateBg, cardRef, deviceID, accountRef)
	ctx.NoError(err, "recordAttempt(%s, %s, %s) failed", cardRef, deviceID, accountRef)
	return v
}

func mustSnapshot(ctx *harness.Ctx, cardRef, deviceID string) velocity {
	v, err := velocitySnapshot(stateBg, cardRef, deviceID)
	ctx.NoError(err, "velocitySnapshot(%s, %s) failed", cardRef, deviceID)
	return v
}

func CheckAtomicScript(ctx *harness.Ctx) {
	serveModel(ctx)
	seen := ctx.Redis.After("vel:card:c-1", func() any {
		card, _ := ctx.Redis.Get("vel:card:c-1")
		return fmt.Sprintf("%s/%d", card, ctx.Redis.Exists("vel:device:d-1"))
	})
	got := mustRecord(ctx, "c-1", "d-1", "acct-1")
	ctx.Assert(seen.Fired, "recordAttempt never touched vel:card:c-1")
	ctx.Assert(seen.Result == "/0" || seen.Result == "1/1", "right after vel:card:c-1 moved, a concurrent reader saw card/device-exists %v: the two windows move in two commands, and a reader or a crash lands between them. Move both in one Lua script", seen.Result)
	ctx.Assert(got.CardAttempts == 1 && got.DeviceAccounts == 1, "the first attempt must count 1 on the card and 1 account on the device, got %+v", got)
}

func CheckWindowExpiry(ctx *harness.Ctx) {
	serveModel(ctx)
	for i := 0; i < 3; i++ {
		mustRecord(ctx, "c-1", "d-1", "acct-1")
	}
	ttl := ctx.Redis.TTL("vel:card:c-1")
	ctx.Assert(0 < ttl && ttl <= 3600, "vel:card:c-1 has TTL %d: the card window must expire attemptWindowSeconds (3600 s) after its first write", ttl)
	ttl = ctx.Redis.TTL("vel:device:d-1")
	ctx.Assert(3600 < ttl && ttl <= 86400, "vel:device:d-1 has TTL %d: the device window must expire deviceWindowSeconds (86400 s) after its first write", ttl)
	ctx.Clock.Advance(3601)
	got := mustRecord(ctx, "c-1", "d-1", "acct-2")
	ctx.Equal(got.CardAttempts, 1, "an hour after its first attempt the card window must start over (it never closes, so a busy card stays flagged); the attempts")
	ctx.Equal(got.DeviceAccounts, 2, "inside the day the device must count acct-1 and acct-2; the accounts")
	ctx.Clock.Advance(86400)
	got = mustRecord(ctx, "c-1", "d-1", "acct-3")
	ctx.Equal(got.DeviceAccounts, 1, "a day later the device window must start over; the accounts")
}

func CheckCountBeforeModel(ctx *harness.Ctx) {
	serveModel(ctx)
	verdict, v, err := scoreWithVelocity(stateBg, stateVector, "c-1", "d-1", "acct-1")
	ctx.NoError(err, "a first attempt failed")
	ctx.Assert(verdict.Band == "approve" && v.CardAttempts == 1, "a first attempt must be scored and counted, got %+v %+v", verdict, v)
	refused := stateVector
	refused.FeatureVersion = "fx-2"
	_, _, err = scoreWithVelocity(stateBg, refused, "c-1", "d-1", "acct-1")
	ctx.Assert(errors.Is(err, model.ErrInvalidFeatures), "the model refuses a vector at fx-2 with InvalidArgument: scoreWithVelocity must return model.ErrInvalidFeatures, got %v", err)
	attempts, _ := ctx.Redis.Get("vel:card:c-1")
	ctx.Equal(attempts, "2", "after two attempts, one the model refused, an attempt the model did not score must still be counted (record it before calling the model); vel:card:c-1")
}

func CheckDistinctAccounts(ctx *harness.Ctx) {
	serveModel(ctx)
	mustRecord(ctx, "c-1", "d-1", "acct-1")
	mustRecord(ctx, "c-2", "d-1", "acct-1")
	got := mustRecord(ctx, "c-3", "d-1", "acct-2")
	ctx.Equal(got.DeviceAccounts, 2, "three attempts by two accounts on device d-1: the device window counts distinct accounts, not attempts; the accounts")
	ctx.Equal(mustSnapshot(ctx, "c-3", "d-1").DeviceAccounts, 2, "velocitySnapshot's accounts on d-1")
}

func CheckSharedRules(ctx *harness.Ctx) {
	serveModel(ctx)
	for i := 0; i < 5; i++ {
		mustRecord(ctx, "c-1", fmt.Sprintf("d-%d", i), "acct-1")
	}
	snapshot := mustSnapshot(ctx, "c-1", "d-0")
	ctx.Assert(len(snapshot.Flags) == 0 && !shouldAlert(snapshot), "five attempts is the limit, not over it: the snapshot %+v and shouldAlert must both say no", snapshot)
	mustRecord(ctx, "c-1", "d-0", "acct-1")
	snapshot = mustSnapshot(ctx, "c-1", "d-0")
	ctx.Assert(len(snapshot.Flags) == 1 && snapshot.Flags[0] == "card_attempts_per_hour", "six attempts on c-1 must flag card_attempts_per_hour (velocityRules: 5), the snapshot is %+v", snapshot)
	ctx.Assert(shouldAlert(snapshot), "the snapshot flags card_attempts_per_hour but shouldAlert says no: the alert reads other thresholds than velocityRules (%+v)", snapshot)
	for _, account := range []string{"acct-2", "acct-3", "acct-4", "acct-5"} {
		mustRecord(ctx, "c-9", "d-7", account)
	}
	snapshot = mustSnapshot(ctx, "c-9", "d-7")
	ctx.Assert(len(snapshot.Flags) == 1 && snapshot.Flags[0] == "device_accounts_per_day" && shouldAlert(snapshot), "four accounts on d-7 must flag device_accounts_per_day (velocityRules: 3) and alert, the snapshot is %+v", snapshot)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>

#include "fraud/risk_model.h"
#include "fraud_scoring.grpc.pb.h"

namespace {

const features::Features kVector{features::kFeatureVersion, 400, 0, 4200};

void serveModel(harness::Ctx& ctx) {
  static riskmodel::Peer* peer = nullptr;
  delete peer;
  peer = new riskmodel::Peer;
  ctx.GRPC.Server("")->RegisterService(peer);
}

}  // namespace

void CheckAtomicScript(harness::Ctx& ctx) {
  serveModel(ctx);
  auto seen = std::make_shared<std::optional<std::string>>();
  ctx.Redis.After("vel:card:c-1", [&ctx, seen] {
    *seen = ctx.Redis.Get("vel:card:c-1").value_or("") + "/" + std::to_string(ctx.Redis.Exists("vel:device:d-1"));
  });
  const Velocity got = recordAttempt("c-1", "d-1", "acct-1");
  ctx.Assert(seen->has_value(), "recordAttempt never touched vel:card:c-1");
  ctx.Assert(**seen == "/0" || **seen == "1/1",
             "right after vel:card:c-1 moved, a concurrent reader saw card/device-exists %s: the two windows move in two commands, and a reader or a crash lands between them. Move both in one Lua script",
             **seen);
  ctx.Assert(got.card_attempts == 1 && got.device_accounts == 1, "the first attempt must count 1 on the card and 1 account on the device, got %d and %d", got.card_attempts, got.device_accounts);
}

void CheckWindowExpiry(harness::Ctx& ctx) {
  serveModel(ctx);
  for (int i = 0; i < 3; i++) recordAttempt("c-1", "d-1", "acct-1");
  long long ttl = ctx.Redis.TTL("vel:card:c-1");
  ctx.Assert(0 < ttl && ttl <= 3600, "vel:card:c-1 has TTL %d: the card window must expire kAttemptWindowSeconds (3600 s) after its first write", ttl);
  ttl = ctx.Redis.TTL("vel:device:d-1");
  ctx.Assert(3600 < ttl && ttl <= 86400, "vel:device:d-1 has TTL %d: the device window must expire kDeviceWindowSeconds (86400 s) after its first write", ttl);
  ctx.Clock.Advance(3601);
  Velocity got = recordAttempt("c-1", "d-1", "acct-2");
  ctx.Equal(got.card_attempts, 1, "an hour after its first attempt the card window must start over (it never closes, so a busy card stays flagged); the attempts");
  ctx.Equal(got.device_accounts, 2, "inside the day the device must count acct-1 and acct-2; the accounts");
  ctx.Clock.Advance(86400);
  got = recordAttempt("c-1", "d-1", "acct-3");
  ctx.Equal(got.device_accounts, 1, "a day later the device window must start over; the accounts");
}

void CheckCountBeforeModel(harness::Ctx& ctx) {
  serveModel(ctx);
  const auto [verdict, v] = scoreWithVelocity(kVector, "c-1", "d-1", "acct-1");
  ctx.Assert(verdict.band == "approve" && v.card_attempts == 1, "a first attempt must be scored and counted, got band %s and %d attempts", verdict.band, v.card_attempts);
  features::Features refused = kVector;
  refused.feature_version = "fx-2";
  bool threw = false;
  try {
    scoreWithVelocity(refused, "c-1", "d-1", "acct-1");
  } catch (const model::InvalidFeatures&) {
    threw = true;
  }
  ctx.Assert(threw, "the model refuses a vector at fx-2 with INVALID_ARGUMENT: scoreWithVelocity must let model::InvalidFeatures through");
  ctx.Equal(ctx.Redis.Get("vel:card:c-1"), std::optional<std::string>("2"),
            "after two attempts, one the model refused, an attempt the model did not score must still be counted (record it before calling the model); vel:card:c-1");
}

void CheckDistinctAccounts(harness::Ctx& ctx) {
  serveModel(ctx);
  recordAttempt("c-1", "d-1", "acct-1");
  recordAttempt("c-2", "d-1", "acct-1");
  const Velocity got = recordAttempt("c-3", "d-1", "acct-2");
  ctx.Equal(got.device_accounts, 2, "three attempts by two accounts on device d-1: the device window counts distinct accounts, not attempts; the accounts");
  ctx.Equal(velocitySnapshot("c-3", "d-1").device_accounts, 2, "velocitySnapshot's accounts on d-1");
}

void CheckSharedRules(harness::Ctx& ctx) {
  serveModel(ctx);
  for (int i = 0; i < 5; i++) recordAttempt("c-1", "d-" + std::to_string(i), "acct-1");
  Velocity snapshot = velocitySnapshot("c-1", "d-0");
  ctx.Assert(snapshot.flags.empty() && !shouldAlert(snapshot), "five attempts is the limit, not over it: the snapshot flags %q and shouldAlert must both say no", snapshot.flags);
  recordAttempt("c-1", "d-0", "acct-1");
  snapshot = velocitySnapshot("c-1", "d-0");
  ctx.Equal(snapshot.flags, std::vector<std::string>{"card_attempts_per_hour"}, "six attempts on c-1 must flag card_attempts_per_hour (kVelocityRules: 5); the flags");
  ctx.Assert(shouldAlert(snapshot), "the snapshot flags card_attempts_per_hour but shouldAlert says no: the alert reads other thresholds than kVelocityRules");
  for (const std::string account : {"acct-2", "acct-3", "acct-4", "acct-5"}) recordAttempt("c-9", "d-7", account);
  snapshot = velocitySnapshot("c-9", "d-7");
  ctx.Assert(snapshot.flags == std::vector<std::string>{"device_accounts_per_day"} && shouldAlert(snapshot),
             "four accounts on d-7 must flag device_accounts_per_day (kVelocityRules: 3) and alert, the flags are %q", snapshot.flags);
}
`,
  },
  hints: [
    'Fail the model on purpose: the card counter does not move. Score three times from one device with two accounts: the device says three. Wait a day: the counts are still there, and six attempts never alert.',
    '`score_with_velocity` counts after the model returns, so an exception skips the count. Both counters are plain `INCR`s with no expiry, sent as two commands, and `should_alert` keeps its own numbers.',
    'One `EVAL`: `INCR` the card key (`EXPIRE` when it is 1), `SADD` the account to the device key (`EXPIRE` when `TTL` is -1), return both counts. Call `record_attempt` first; build `flags` and `should_alert` from `VELOCITY_RULES`.',
  ],
  debrief: `Counting before scoring is what makes velocity a defence: a card-testing script lives on failed attempts, so an attempt the model never answered is still an attempt. The script makes the two windows one fact, and the set makes the device rule about people rather than retries. Windows that open with the first attempt and expire on their own are the cheapest correct shape; their weak spot is the boundary, where a burst split across two windows reads as two half-bursts. Production velocity stores slide the window (a sorted set of timestamps, or two buckets weighted by overlap), count distinct accounts with HyperLogLog at scale, and version the rule table so a decision records which thresholds applied.`,
};
