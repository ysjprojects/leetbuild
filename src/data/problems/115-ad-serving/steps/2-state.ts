import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis frequency caps and pacing counters, atomic',
  concept: 'redis',
  file: 'state',
  focus: ['server', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the counter layer: it builds
the keys, increments, compares and returns a reservation. It hides two production flaws that only
appear under load or under a crash. Review it like the service owner, fix it, and prove the fix with
the checks below.

Implement the reservation the serve path uses, one call per serve:

\`\`\`python
reserve(campaign, user_hash, price_micros) -> {"allowed": bool, "seen": int, "spent_micros": int}
\`\`\`

- **One atomic decision per serve.** The frequency allowance and the pacing budget are checked and
  written by a single Lua script executed with \`EVALSHA\` (the script is loaded once with
  \`SCRIPT LOAD\`/\`script_load\`/\`scriptLoad\` and reused). Never check in one command and write in
  another: a burst of concurrent serves must not all read the same remaining budget and all pass.
- The script reads the user counter \`freq:{campaign_id}:{user_hash}\` **before** it increments it,
  and increments it **only when the serve is allowed**. An increment that happens before the
  decision burns a user's frequency on a crashed or filtered request.
- The pacing counter \`pace:{campaign_id}\` moves in the same script: allowed only when
  \`spent + price <= paced_budget\`, then incremented by \`price\` with \`INCRBY\`. The budget can
  never be overspent, even when fifty serves arrive at once.
- The user counter gets its TTL **at first write** (\`EXPIRE\` when the increment returns \`1\`) with
  the campaign's \`freq_window_s\`, so caps roll off at the end of the window instead of leaking keys
  forever.

**Failure mode the checks target.** The draft \`INCR\`s the user counter before it knows whether the
serve will happen, then updates the pacing counter in a second command and compares afterwards. A
crashed request still burns an impression, and a burst all reads the same \`spent\` value, so every
request in the burst passes the remaining budget. The missing \`EXPIRE\` is the slow one: without it
the counter never resets, and a user who was capped last month is still capped today.`,
  sequence: {
    participants: ['Ad Server', 'Redis', 'pacing script'],
    messages: [
      {from: 'Ad Server', to: 'Redis', label: 'EVALSHA reserve · KEYS[cap, pace]', kind: 'sync'},
      {from: 'Redis', to: 'pacing script', label: 'run once, in Redis', kind: 'sync'},
      {from: 'pacing script', to: 'pacing script', label: 'seen < cap ?', kind: 'sync'},
      {from: 'pacing script', to: 'pacing script', label: 'spent + price <= paced_budget ?', kind: 'sync'},
      {from: 'pacing script', to: 'Redis', label: 'INCR cap_key · EXPIRE window_s at first write', kind: 'sync'},
      {from: 'pacing script', to: 'Redis', label: 'INCRBY pace_key price', kind: 'sync'},
      {from: 'Redis', to: 'Ad Server', label: '{allowed, seen, spent_micros}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'keys',
      title: 'Scopes one counter per user and one per campaign',
      detail:
        'The per-user frequency counter is `freq:{campaign_id}:{user_hash}` and the pacing counter is `pace:{campaign_id}`; the draft already builds both keys this way, so only the atomicity, ordering and TTL around them are wrong.',
      match: {
        python: {all: [/FREQ_KEY_PREFIX/, /PACE_KEY_PREFIX/]},
        typescript: {all: [/FREQ_KEY_PREFIX/, /PACE_KEY_PREFIX/]},
        go: {all: [/freqKeyPrefix/, /paceKeyPrefix/]},
        scala: {all: [/FreqKeyPrefix/, /PaceKeyPrefix/]},
        cpp: {all: [/kFreqKeyPrefix/, /kPaceKeyPrefix/]},
      },
    },
    {
      id: 'atomic',
      title: 'One Lua script decides and writes both counters',
      detail:
        'The cap check, the pacing check, the user increment and the pacing increment all live in one script that is loaded once and invoked with `EVALSHA` per serve. The draft uses separate `INCR`/`INCRBY`/`GET` commands, so two serves can both read the same remaining budget.',
      match: {
        python: {all: [/RESERVE_SCRIPT/, /script_load/, /evalsha/]},
        typescript: {all: [/RESERVE_SCRIPT/, /script\(\s*['"]load['"]/, /evalsha/]},
        go: {all: [/reserveScript/, /redis\.NewScript/, /\.Run\(/]},
        scala: {all: [/ReserveScript/, /scriptLoad/, /evalsha/]},
        cpp: {all: [/kReserveScript/, /script_load/, /EVALSHA/]},
      },
    },
    {
      id: 'cap-before-increment',
      title: 'Reads the cap before it increments the allowance',
      detail:
        'Inside the script the user counter is read and compared with the cap **before** `INCR`, and the increment happens only on the allowed path. The draft increments first and decides afterwards, so a request that never returns an ad still burns an impression.',
      match: {
        python: {order: [/redis\.call\(\s*'get'\s*,\s*cap_key\)/, /redis\.call\(\s*'incr'\s*,\s*cap_key\)/]},
        typescript: {order: [/redis\.call\(\s*'get'\s*,\s*cap_key\)/, /redis\.call\(\s*'incr'\s*,\s*cap_key\)/]},
        go: {order: [/redis\.call\(\s*'get'\s*,\s*cap_key\)/, /redis\.call\(\s*'incr'\s*,\s*cap_key\)/]},
        scala: {order: [/redis\.call\(\s*'get'\s*,\s*cap_key\)/, /redis\.call\(\s*'incr'\s*,\s*cap_key\)/]},
        cpp: {order: [/redis\.call\(\s*'get'\s*,\s*cap_key\)/, /redis\.call\(\s*'incr'\s*,\s*cap_key\)/]},
      },
    },
    {
      id: 'ttl',
      title: 'Expires the cap key at the frequency window',
      detail:
        'The user counter is given a TTL when it is first written: the script runs `EXPIRE cap_key window_s` on the increment that returns `1`. The draft writes the key with no expiry, so the cap never rolls off.',
      match: {
        python: {
          all: [/\bwindow_s\b/],
          order: [/seen\s*==\s*1/, /redis\.call\(\s*'expire'\s*,\s*cap_key\s*,\s*window_s\)/],
        },
        typescript: {
          all: [/\bwindow_s\b/],
          order: [/seen\s*==\s*1/, /redis\.call\(\s*'expire'\s*,\s*cap_key\s*,\s*window_s\)/],
        },
        go: {
          all: [/\bwindow_s\b/],
          order: [/seen\s*==\s*1/, /redis\.call\(\s*'expire'\s*,\s*cap_key\s*,\s*window_s\)/],
        },
        scala: {
          all: [/\bwindow_s\b/],
          order: [/seen\s*==\s*1/, /redis\.call\(\s*'expire'\s*,\s*cap_key\s*,\s*window_s\)/],
        },
        cpp: {
          all: [/\bwindow_s\b/],
          order: [/seen\s*==\s*1/, /redis\.call\(\s*'expire'\s*,\s*cap_key\s*,\s*window_s\)/],
        },
      },
    },
    {
      id: 'no-overspend',
      title: 'Refuses the serve when the remaining budget is short',
      detail:
        'The script compares `spent + price > paced_budget` and returns `allowed = false` before any `INCRBY`, so a burst cannot spend past the budget; the increment only happens on the allowed path. The draft increments the pacing counter and compares afterwards.',
      match: {
        python: {
          all: [/spent\s*\+\s*price\s*>\s*paced_budget/, /redis\.call\(\s*'incrby'\s*,\s*pace_key\s*,\s*price\)/],
        },
        typescript: {
          all: [/spent\s*\+\s*price\s*>\s*paced_budget/, /redis\.call\(\s*'incrby'\s*,\s*pace_key\s*,\s*price\)/],
        },
        go: {all: [/spent\s*\+\s*price\s*>\s*paced_budget/, /redis\.call\(\s*'incrby'\s*,\s*pace_key\s*,\s*price\)/]},
        scala: {
          all: [/spent\s*\+\s*price\s*>\s*paced_budget/, /redis\.call\(\s*'incrby'\s*,\s*pace_key\s*,\s*price\)/],
        },
        cpp: {all: [/spent\s*\+\s*price\s*>\s*paced_budget/, /redis\.call\(\s*'incrby'\s*,\s*pace_key\s*,\s*price\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis  # redis-py

FREQ_KEY_PREFIX = "freq:"
PACE_KEY_PREFIX = "pace:"


def freq_key(campaign_id: str, user_hash: str) -> str:
    return f"{FREQ_KEY_PREFIX}{campaign_id}:{user_hash}"


def pace_key(campaign_id: str) -> str:
    return f"{PACE_KEY_PREFIX}{campaign_id}"


class PacingStore:
    def __init__(self, client: redis.Redis) -> None:
        self._client = client

    def reserve(self, campaign: dict, user_hash: str, price_micros: int) -> dict:
        # TODO: this draft increments the user's counter before it decides, updates the pacing
        # counter in a second command and compares after the fact, and never sets a TTL on the
        # cap key. Review all three flaws.
        cap_key = freq_key(campaign["campaign_id"], user_hash)
        charge_key = pace_key(campaign["campaign_id"])
        seen = int(self._client.incr(cap_key))
        spent = int(self._client.incrby(charge_key, price_micros))
        allowed = seen <= campaign["freq_cap_impressions"] and spent <= campaign["paced_budget_micros"]
        return {"allowed": allowed, "seen": seen, "spent_micros": spent}
`,
      solution: `import redis  # redis-py

FREQ_KEY_PREFIX = "freq:"
PACE_KEY_PREFIX = "pace:"

# One script decides and writes: the allowance and the pacing spend commit together, so a serve
# that is never returned does not burn an impression and a burst cannot pass the same budget.
RESERVE_SCRIPT = """
local cap_key = KEYS[1]
local pace_key = KEYS[2]
local cap = tonumber(ARGV[1])
local window_s = tonumber(ARGV[2])
local price = tonumber(ARGV[3])
local paced_budget = tonumber(ARGV[4])
local seen = tonumber(redis.call('get', cap_key) or '0')
if seen >= cap then
  return {0, seen, 0}
end
local spent = tonumber(redis.call('get', pace_key) or '0')
if spent + price > paced_budget then
  return {0, seen, spent}
end
seen = redis.call('incr', cap_key)
if seen == 1 then
  redis.call('expire', cap_key, window_s)
end
local new_spent = redis.call('incrby', pace_key, price)
return {1, seen, new_spent}
"""


def freq_key(campaign_id: str, user_hash: str) -> str:
    return f"{FREQ_KEY_PREFIX}{campaign_id}:{user_hash}"


def pace_key(campaign_id: str) -> str:
    return f"{PACE_KEY_PREFIX}{campaign_id}"


class PacingStore:
    def __init__(self, client: redis.Redis) -> None:
        self._client = client
        self._sha = client.script_load(RESERVE_SCRIPT)

    def reserve(self, campaign: dict, user_hash: str, price_micros: int) -> dict:
        """Allow, charge and count in one round trip, or allow nothing at all."""
        allowed, seen, spent = self._client.evalsha(
            self._sha,
            2,
            freq_key(campaign["campaign_id"], user_hash),
            pace_key(campaign["campaign_id"]),
            campaign["freq_cap_impressions"],
            campaign["freq_window_s"],
            price_micros,
            campaign["paced_budget_micros"],
        )
        return {"allowed": bool(allowed), "seen": int(seen), "spent_micros": int(spent)}
`,
    },
    typescript: {
      starter: `/** Frequency and pacing counters: a model-generated draft with three flaws. */
import Redis from 'ioredis';

export const FREQ_KEY_PREFIX = 'freq:';
export const PACE_KEY_PREFIX = 'pace:';

export interface Campaign {
  campaign_id: string;
  freq_cap_impressions: number;
  paced_budget_micros: number;
}

export interface Reservation {
  allowed: boolean;
  seen: number;
  spent_micros: number;
}

export const freqKey = (campaignId: string, userHash: string): string =>
  \`\${FREQ_KEY_PREFIX}\${campaignId}:\${userHash}\`;

export const paceKey = (campaignId: string): string => \`\${PACE_KEY_PREFIX}\${campaignId}\`;

export class PacingStore {
  constructor(private readonly redis: Redis) {}

  async reserve(campaign: Campaign, userHash: string, priceMicros: number): Promise<Reservation> {
    // TODO: this draft increments the user's counter before it decides, updates the pacing
    // counter in a second command and compares after the fact, and never sets a TTL on the cap
    // key. Review all three flaws.
    const seen = await this.redis.incr(freqKey(campaign.campaign_id, userHash));
    const spent = await this.redis.incrby(paceKey(campaign.campaign_id), priceMicros);
    const allowed = seen <= campaign.freq_cap_impressions && spent <= campaign.paced_budget_micros;
    return {allowed, seen, spent_micros: spent};
  }
}
`,
      solution: `/** Frequency and pacing counters: one atomic decision per serve. */
import Redis from 'ioredis';

export const FREQ_KEY_PREFIX = 'freq:';
export const PACE_KEY_PREFIX = 'pace:';

/** Loaded once, run once per serve: cap, pacing and both counters commit together. */
export const RESERVE_SCRIPT = \`
local cap_key = KEYS[1]
local pace_key = KEYS[2]
local cap = tonumber(ARGV[1])
local window_s = tonumber(ARGV[2])
local price = tonumber(ARGV[3])
local paced_budget = tonumber(ARGV[4])
local seen = tonumber(redis.call('get', cap_key) or '0')
if seen >= cap then
  return {0, seen, 0}
end
local spent = tonumber(redis.call('get', pace_key) or '0')
if spent + price > paced_budget then
  return {0, seen, spent}
end
seen = redis.call('incr', cap_key)
if seen == 1 then
  redis.call('expire', cap_key, window_s)
end
local new_spent = redis.call('incrby', pace_key, price)
return {1, seen, new_spent}
\`;

export interface Campaign {
  campaign_id: string;
  freq_cap_impressions: number;
  freq_window_s: number;
  paced_budget_micros: number;
}

export interface Reservation {
  allowed: boolean;
  seen: number;
  spent_micros: number;
}

export const freqKey = (campaignId: string, userHash: string): string =>
  \`\${FREQ_KEY_PREFIX}\${campaignId}:\${userHash}\`;

export const paceKey = (campaignId: string): string => \`\${PACE_KEY_PREFIX}\${campaignId}\`;

export class PacingStore {
  private sha: string | null = null;

  constructor(private readonly redis: Redis) {}

  async reserve(campaign: Campaign, userHash: string, priceMicros: number): Promise<Reservation> {
    this.sha ??= (await this.redis.script('load', RESERVE_SCRIPT)) as string;
    const reply = (await this.redis.evalsha(
      this.sha,
      2,
      freqKey(campaign.campaign_id, userHash),
      paceKey(campaign.campaign_id),
      campaign.freq_cap_impressions,
      campaign.freq_window_s,
      priceMicros,
      campaign.paced_budget_micros,
    )) as [number, number, number];
    return {allowed: reply[0] === 1, seen: reply[1], spent_micros: reply[2]};
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

const (
	freqKeyPrefix = "freq:"
	paceKeyPrefix = "pace:"
)

type Campaign struct {
	CampaignID         string
	FreqCapImpressions int
	PacedBudgetMicros  int64
}

type Reservation struct {
	Allowed     bool
	Seen        int
	SpentMicros int64
}

func freqKey(campaignID, userHash string) string {
	return fmt.Sprintf("%s%s:%s", freqKeyPrefix, campaignID, userHash)
}

func paceKey(campaignID string) string {
	return paceKeyPrefix + campaignID
}

type PacingStore struct {
	client *redis.Client
}

func NewPacingStore(client *redis.Client) *PacingStore {
	return &PacingStore{client: client}
}

func (s *PacingStore) Reserve(ctx context.Context, campaign Campaign, userHash string, priceMicros int64) (Reservation, error) {
	// TODO: this draft increments the user's counter before it decides, updates the pacing
	// counter in a second command and compares after the fact, and never sets a TTL on the cap
	// key. Review all three flaws.
	capKey := freqKey(campaign.CampaignID, userHash)
	spendKey := paceKey(campaign.CampaignID)
	seen, err := s.client.Incr(ctx, capKey).Result()
	if err != nil {
		return Reservation{}, err
	}
	spent, err := s.client.IncrBy(ctx, spendKey, priceMicros).Result()
	if err != nil {
		return Reservation{}, err
	}
	allowed := seen <= int64(campaign.FreqCapImpressions) && spent <= campaign.PacedBudgetMicros
	return Reservation{Allowed: allowed, Seen: int(seen), SpentMicros: spent}, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

const (
	freqKeyPrefix = "freq:"
	paceKeyPrefix = "pace:"
)

// reserveScript decides and writes in one round trip: the allowance and the pacing spend commit
// together, so a serve that is never returned does not burn an impression and a burst cannot
// pass the same remaining budget.
const reserveScript = \`
local cap_key = KEYS[1]
local pace_key = KEYS[2]
local cap = tonumber(ARGV[1])
local window_s = tonumber(ARGV[2])
local price = tonumber(ARGV[3])
local paced_budget = tonumber(ARGV[4])
local seen = tonumber(redis.call('get', cap_key) or '0')
if seen >= cap then
  return {0, seen, 0}
end
local spent = tonumber(redis.call('get', pace_key) or '0')
if spent + price > paced_budget then
  return {0, seen, spent}
end
seen = redis.call('incr', cap_key)
if seen == 1 then
  redis.call('expire', cap_key, window_s)
end
local new_spent = redis.call('incrby', pace_key, price)
return {1, seen, new_spent}
\`

type Campaign struct {
	CampaignID         string
	FreqCapImpressions int
	FreqWindowS        int
	PacedBudgetMicros  int64
}

type Reservation struct {
	Allowed     bool
	Seen        int
	SpentMicros int64
}

func freqKey(campaignID, userHash string) string {
	return fmt.Sprintf("%s%s:%s", freqKeyPrefix, campaignID, userHash)
}

func paceKey(campaignID string) string {
	return paceKeyPrefix + campaignID
}

type PacingStore struct {
	client *redis.Client
	script *redis.Script
}

func NewPacingStore(client *redis.Client) *PacingStore {
	return &PacingStore{client: client, script: redis.NewScript(reserveScript)}
}

func (s *PacingStore) Reserve(ctx context.Context, campaign Campaign, userHash string, priceMicros int64) (Reservation, error) {
	keys := []string{freqKey(campaign.CampaignID, userHash), paceKey(campaign.CampaignID)}
	raw, err := s.script.Run(
		ctx,
		s.client,
		keys,
		campaign.FreqCapImpressions,
		campaign.FreqWindowS,
		priceMicros,
		campaign.PacedBudgetMicros,
	).Slice()
	if err != nil {
		return Reservation{}, err
	}
	allowed, _ := raw[0].(int64)
	seen, _ := raw[1].(int64)
	spent, _ := raw[2].(int64)
	return Reservation{Allowed: allowed == 1, Seen: int(seen), SpentMicros: spent}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object PacingStore {
  val FreqKeyPrefix = "freq:"
  val PaceKeyPrefix = "pace:"
}

final case class Campaign(campaign_id: String, freq_cap_impressions: Int, paced_budget_micros: Long)

final case class Reservation(allowed: Boolean, seen: Long, spent_micros: Long)

class PacingStore(client: Jedis) {
  import PacingStore._

  def freqKey(campaignId: String, userHash: String): String = s"$FreqKeyPrefix$campaignId:$userHash"

  def paceKey(campaignId: String): String = s"$PaceKeyPrefix$campaignId"

  def reserve(campaign: Campaign, userHash: String, priceMicros: Long): Reservation = {
    // TODO: this draft increments the user's counter before it decides, updates the pacing
    // counter in a second command and compares after the fact, and never sets a TTL on the cap
    // key. Review all three flaws.
    val seen = client.incr(freqKey(campaign.campaign_id, userHash))
    val spent = client.incrBy(paceKey(campaign.campaign_id), priceMicros)
    val allowed = seen <= campaign.freq_cap_impressions && spent <= campaign.paced_budget_micros
    Reservation(allowed, seen, spent)
  }
}
`,
      solution: `import redis.clients.jedis.Jedis

import scala.jdk.CollectionConverters._

object PacingStore {
  val FreqKeyPrefix = "freq:"
  val PaceKeyPrefix = "pace:"
}

object Scripts {
  /** Loaded once, run once per serve: cap, pacing and both counters commit together. */
  val ReserveScript: String =
    """
local cap_key = KEYS[1]
local pace_key = KEYS[2]
local cap = tonumber(ARGV[1])
local window_s = tonumber(ARGV[2])
local price = tonumber(ARGV[3])
local paced_budget = tonumber(ARGV[4])
local seen = tonumber(redis.call('get', cap_key) or '0')
if seen >= cap then
  return {0, seen, 0}
end
local spent = tonumber(redis.call('get', pace_key) or '0')
if spent + price > paced_budget then
  return {0, seen, spent}
end
seen = redis.call('incr', cap_key)
if seen == 1 then
  redis.call('expire', cap_key, window_s)
end
local new_spent = redis.call('incrby', pace_key, price)
return {1, seen, new_spent}
"""
}

final case class Campaign(
    campaign_id: String,
    freq_cap_impressions: Int,
    freq_window_s: Int,
    paced_budget_micros: Long)

final case class Reservation(allowed: Boolean, seen: Long, spent_micros: Long)

class PacingStore(client: Jedis) {
  import PacingStore._

  private val scriptSha: String = client.scriptLoad(Scripts.ReserveScript)

  def freqKey(campaignId: String, userHash: String): String = s"$FreqKeyPrefix$campaignId:$userHash"

  def paceKey(campaignId: String): String = s"$PaceKeyPrefix$campaignId"

  def reserve(campaign: Campaign, userHash: String, priceMicros: Long): Reservation = {
    val reply = client.evalsha(
      scriptSha,
      2,
      freqKey(campaign.campaign_id, userHash),
      paceKey(campaign.campaign_id),
      campaign.freq_cap_impressions.toString,
      campaign.freq_window_s.toString,
      priceMicros.toString,
      campaign.paced_budget_micros.toString)
    val values = reply.asScala.map(_.toLong).toList
    Reservation(values.head == 1L, values(1), values(2))
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

const std::string kFreqKeyPrefix = "freq:";
const std::string kPaceKeyPrefix = "pace:";

struct Campaign {
  std::string campaign_id;
  int freq_cap_impressions;
  long paced_budget_micros;
};

struct Reservation {
  bool allowed;
  long seen;
  long spent_micros;
};

std::string freqKey(const std::string& campaignId, const std::string& userHash) {
  return kFreqKeyPrefix + campaignId + ":" + userHash;
}

std::string paceKey(const std::string& campaignId) { return kPaceKeyPrefix + campaignId; }

class PacingStore {
 public:
  explicit PacingStore(sw::redis::Redis& client) : client_(client) {}

  Reservation reserve(const Campaign& campaign, const std::string& userHash, long priceMicros) {
    // TODO: this draft increments the user's counter before it decides, updates the pacing
    // counter in a second command and compares after the fact, and never sets a TTL on the cap
    // key. Review all three flaws.
    const long seen = client_.incr(freqKey(campaign.campaign_id, userHash));
    const long spent = client_.incrby(paceKey(campaign.campaign_id), priceMicros);
    const bool allowed = seen <= campaign.freq_cap_impressions && spent <= campaign.paced_budget_micros;
    return Reservation{allowed, seen, spent};
  }

 private:
  sw::redis::Redis& client_;
};
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

const std::string kFreqKeyPrefix = "freq:";
const std::string kPaceKeyPrefix = "pace:";

// Loaded once with SCRIPT LOAD, run once per serve with EVALSHA: the allowance and the pacing
// spend commit together, so a serve that is never returned does not burn an impression.
const std::string kReserveScript = R"lua(
local cap_key = KEYS[1]
local pace_key = KEYS[2]
local cap = tonumber(ARGV[1])
local window_s = tonumber(ARGV[2])
local price = tonumber(ARGV[3])
local paced_budget = tonumber(ARGV[4])
local seen = tonumber(redis.call('get', cap_key) or '0')
if seen >= cap then
  return {0, seen, 0}
end
local spent = tonumber(redis.call('get', pace_key) or '0')
if spent + price > paced_budget then
  return {0, seen, spent}
end
seen = redis.call('incr', cap_key)
if seen == 1 then
  redis.call('expire', cap_key, window_s)
end
local new_spent = redis.call('incrby', pace_key, price)
return {1, seen, new_spent}
)lua";

struct Campaign {
  std::string campaign_id;
  int freq_cap_impressions;
  int freq_window_s;
  long paced_budget_micros;
};

struct Reservation {
  bool allowed;
  long seen;
  long spent_micros;
};

std::string freqKey(const std::string& campaignId, const std::string& userHash) {
  return kFreqKeyPrefix + campaignId + ":" + userHash;
}

std::string paceKey(const std::string& campaignId) { return kPaceKeyPrefix + campaignId; }

/** redis-plus-plus returns one value per EVALSHA, so the array reply is fetched as a command. */
std::vector<long long> evalReserve(sw::redis::Redis& client, const std::string& sha,
                                   const std::vector<std::string>& keys,
                                   const std::vector<std::string>& args) {
  return client.command<std::vector<long long>>("EVALSHA", sha, std::to_string(keys.size()), keys[0], keys[1],
                                                args[0], args[1], args[2], args[3]);
}

class PacingStore {
 public:
  explicit PacingStore(sw::redis::Redis& client) : client_(client), sha_(client.script_load(kReserveScript)) {}

  Reservation reserve(const Campaign& campaign, const std::string& userHash, long priceMicros) {
    const std::vector<std::string> keys{freqKey(campaign.campaign_id, userHash), paceKey(campaign.campaign_id)};
    const std::vector<std::string> args{std::to_string(campaign.freq_cap_impressions),
                                       std::to_string(campaign.freq_window_s),
                                       std::to_string(priceMicros),
                                       std::to_string(campaign.paced_budget_micros)};
    const auto reply = evalReserve(client_, sha_, keys, args);
    return Reservation{reply[0] == 1, reply[1], reply[2]};
  }

 private:
  sw::redis::Redis& client_;
  std::string sha_;
};
`,
    },
  },
  hints: [
    'Everything the decision needs is in one script: read `cap_key`, compare, read `pace_key`, compare, then write both. If you can point at a second round trip in the happy path, a burst can slip between the read and the write.',
    'Write the guard before the increment: only the path that returns `allowed = 1` reaches `INCR cap_key` and `INCRBY pace_key price`. Then set the TTL on the increment that returns `1` — that is the first write of the window, and the only one that needs `EXPIRE`.',
    'Return the three values the caller needs (`allowed`, `seen`, `spent_micros`) so the serve path can log and the delivery read can convert them back to money without a second Redis call.',
  ],
  debrief: `The interviewer is testing whether you can keep a counter honest under concurrency, and every flaw in the draft is an ordering flaw. Incrementing before the decision means the counter reflects requests rather than impressions; pacing in a second command means the read-modify-write race is visible to the whole burst; missing the TTL means the window never rolls. One Lua script fixes all three because Redis runs it to completion without interleaving: the checks and both writes are a single atomic step, and the TTL is set exactly once, at the first write. Real pacing layers go beyond a single budget: smooth spend against a diurnal curve, separate reservation from confirmation for a cancelled render, guard the script against a clock skew in the window bucket, and keep the pacing key's TTL aligned with the flight end so counters cannot outlive the campaign.`,
};
