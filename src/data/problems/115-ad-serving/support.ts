/**
 * Hand-written support modules the ad-serving steps import but no step builds: the `ads.store`
 * package. It is the campaign store (every campaign a Redis hash, the course's stand-in for the
 * campaign database) and the counters the serve path shares: the per-user frequency counter and the
 * per-campaign pacing counter step 2 writes and step 1 reads, the render counter step 4 commits and
 * step 5 reads, the outbox step 4 falls back to, and the house ad step 3 serves. The five languages
 * keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'ads/__init__.py': '',
  'ads/store.py': `"""
The campaign store (provided). A campaign is a Redis hash campaign:{id} with campaign_id,
advertiser_id, version, state (active, paused or exhausted), placement, creative_id, bid_micros,
freq_cap, freq_window_s, paced_budget_micros, goal_impressions, start_ts and end_ts (epoch
seconds); placement:{name}:campaigns is the set of campaigns that target a placement.

The serve path's counters: freq:{campaign_id}:{user_hash} (the user's impressions in the frequency
window) and pace:{campaign_id} (micros reserved at serve), written by step 2's reservation;
render:{campaign_id}, a hash of impressions and spend_micros counted when the ad rendered; outbox,
a list of JSON rows {topic, key, payload} the relay publishes when the broker did not take them.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

NUMBERS = ("version", "bid_micros", "freq_cap", "freq_window_s", "paced_budget_micros", "goal_impressions", "start_ts", "end_ts")

# The creative a slot gets when no paid ad can fill it: never billed, counted apart.
HOUSE_AD = {"campaign_id": "house", "creative_id": "house-default", "price_micros": 0}


def put_campaign(campaign: dict) -> None:
    """Write (or replace) a campaign and add it to its placement."""
    r.hset(f"campaign:{campaign['campaign_id']}", mapping={name: str(value) for name, value in campaign.items()})
    r.sadd(f"placement:{campaign['placement']}:campaigns", campaign["campaign_id"])


def get_campaign(campaign_id: str) -> dict | None:
    """The campaign, numbers as ints, or None."""
    raw = r.hgetall(f"campaign:{campaign_id}")
    if not raw:
        return None
    return {name: int(value) if name in NUMBERS else value for name, value in raw.items()}


def campaigns_for(placement: str) -> list[dict]:
    """Every campaign that targets the placement, whatever its state, by campaign id."""
    found = (get_campaign(campaign_id) for campaign_id in sorted(r.smembers(f"placement:{placement}:campaigns")))
    return [campaign for campaign in found if campaign is not None]


def frequency(campaign_id: str, user_hash: str) -> int:
    """The user's impressions of the campaign in the current frequency window."""
    return int(r.get(f"freq:{campaign_id}:{user_hash}") or 0)


def spent(campaign_id: str) -> int:
    """Micros the serve path reserved for the campaign so far (the pacing counter)."""
    return int(r.get(f"pace:{campaign_id}") or 0)


def count_render(campaign_id: str, price_micros: int) -> None:
    """Count one rendered impression and its price, in one transaction."""
    pipe = r.pipeline()
    pipe.hincrby(f"render:{campaign_id}", "impressions", 1)
    pipe.hincrby(f"render:{campaign_id}", "spend_micros", price_micros)
    pipe.execute()


def rendered(campaign_id: str) -> dict:
    """The impressions and spend_micros counted at render."""
    raw = r.hgetall(f"render:{campaign_id}")
    return {"impressions": int(raw.get("impressions", 0)), "spend_micros": int(raw.get("spend_micros", 0))}


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """Queue an event the broker did not take, for the relay to publish later."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
};

export const supportModulesTs: Record<string, string> = {
  'ads/store.ts': `/**
 * The campaign store (provided). A campaign is a Redis hash campaign:{id} with campaign_id,
 * advertiser_id, version, state (active, paused or exhausted), placement, creative_id, bid_micros,
 * freq_cap, freq_window_s, paced_budget_micros, goal_impressions, start_ts and end_ts (epoch
 * seconds); placement:{name}:campaigns is the set of campaigns that target a placement.
 *
 * The serve path's counters: freq:{campaign_id}:{user_hash} (the user's impressions in the
 * frequency window) and pace:{campaign_id} (micros reserved at serve), written by step 2's
 * reservation; render:{campaign_id}, a hash of impressions and spend_micros counted when the ad
 * rendered; outbox, a list of JSON rows {topic, key, payload} the relay publishes when the broker
 * did not take them.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Campaign {
  campaign_id: string;
  advertiser_id: string;
  version: number;
  state: string;
  placement: string;
  creative_id: string;
  bid_micros: number;
  freq_cap: number;
  freq_window_s: number;
  paced_budget_micros: number;
  goal_impressions: number;
  start_ts: number;
  end_ts: number;
}

export interface Ad {
  campaign_id: string;
  creative_id: string;
  price_micros: number;
}

/** What the page sends when an ad has rendered. */
export interface Beacon {
  beacon_id: string;
  campaign_id: string;
  creative_id: string;
  user_hash: string;
  price_micros: number;
}

const NUMBERS = ['version', 'bid_micros', 'freq_cap', 'freq_window_s', 'paced_budget_micros', 'goal_impressions', 'start_ts', 'end_ts'];

/** The creative a slot gets when no paid ad can fill it: never billed, counted apart. */
export const HOUSE_AD: Ad = {campaign_id: 'house', creative_id: 'house-default', price_micros: 0};

/** Write (or replace) a campaign and add it to its placement. */
export async function putCampaign(campaign: Campaign): Promise<void> {
  await redis.hset(\`campaign:\${campaign.campaign_id}\`, Object.fromEntries(Object.entries(campaign).map(([name, value]) => [name, String(value)])));
  await redis.sadd(\`placement:\${campaign.placement}:campaigns\`, campaign.campaign_id);
}

/** The campaign, or null. */
export async function getCampaign(campaignId: string): Promise<Campaign | null> {
  const raw = await redis.hgetall(\`campaign:\${campaignId}\`);
  if (Object.keys(raw).length === 0) return null;
  return Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, NUMBERS.includes(name) ? Number(value) : value])) as unknown as Campaign;
}

/** Every campaign that targets the placement, whatever its state, by campaign id. */
export async function campaignsFor(placement: string): Promise<Campaign[]> {
  const ids = (await redis.smembers(\`placement:\${placement}:campaigns\`)).sort();
  const found = await Promise.all(ids.map(id => getCampaign(id)));
  return found.filter((c): c is Campaign => c !== null);
}

/** The user's impressions of the campaign in the current frequency window. */
export async function frequency(campaignId: string, userHash: string): Promise<number> {
  return Number((await redis.get(\`freq:\${campaignId}:\${userHash}\`)) ?? 0);
}

/** Micros the serve path reserved for the campaign so far (the pacing counter). */
export async function spent(campaignId: string): Promise<number> {
  return Number((await redis.get(\`pace:\${campaignId}\`)) ?? 0);
}

/** Count one rendered impression and its price, in one transaction. */
export async function countRender(campaignId: string, priceMicros: number): Promise<void> {
  await redis.multi().hincrby(\`render:\${campaignId}\`, 'impressions', 1).hincrby(\`render:\${campaignId}\`, 'spend_micros', priceMicros).exec();
}

/** The impressions and spend_micros counted at render. */
export async function rendered(campaignId: string): Promise<{impressions: number; spend_micros: number}> {
  const raw = await redis.hgetall(\`render:\${campaignId}\`);
  return {impressions: Number(raw.impressions ?? 0), spend_micros: Number(raw.spend_micros ?? 0)};
}

/** Queue an event the broker did not take, for the relay to publish later. */
export async function insertOutbox(topic: string, key: string, payload: object): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'ads/store/store.go': `// Package store is the campaign store (provided). A campaign is a Redis hash campaign:{id} with
// campaign_id, advertiser_id, version, state (active, paused or exhausted), placement, creative_id,
// bid_micros, freq_cap, freq_window_s, paced_budget_micros, goal_impressions, start_ts and end_ts
// (epoch seconds); placement:{name}:campaigns is the set of campaigns that target a placement.
//
// The serve path's counters: freq:{campaign_id}:{user_hash} (the user's impressions in the
// frequency window) and pace:{campaign_id} (micros reserved at serve), written by step 2's
// reservation; render:{campaign_id}, a hash of impressions and spend_micros counted when the ad
// rendered; outbox, a list of JSON rows {topic, key, payload} the relay publishes when the broker
// did not take them.
package store

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Campaign is one campaign row.
type Campaign struct {
	CampaignID        string \`json:"campaign_id"\`
	AdvertiserID      string \`json:"advertiser_id"\`
	Version           int64  \`json:"version"\`
	State             string \`json:"state"\`
	Placement         string \`json:"placement"\`
	CreativeID        string \`json:"creative_id"\`
	BidMicros         int64  \`json:"bid_micros"\`
	FreqCap           int64  \`json:"freq_cap"\`
	FreqWindowS       int64  \`json:"freq_window_s"\`
	PacedBudgetMicros int64  \`json:"paced_budget_micros"\`
	GoalImpressions   int64  \`json:"goal_impressions"\`
	StartTs           int64  \`json:"start_ts"\`
	EndTs             int64  \`json:"end_ts"\`
}

// Ad is the creative a serve answers with.
type Ad struct {
	CampaignID  string \`json:"campaign_id"\`
	CreativeID  string \`json:"creative_id"\`
	PriceMicros int64  \`json:"price_micros"\`
}

// Beacon is what the page sends when an ad has rendered.
type Beacon struct {
	BeaconID    string \`json:"beacon_id"\`
	CampaignID  string \`json:"campaign_id"\`
	CreativeID  string \`json:"creative_id"\`
	UserHash    string \`json:"user_hash"\`
	PriceMicros int64  \`json:"price_micros"\`
}

// Rendered is what was counted at render.
type Rendered struct {
	Impressions int64 \`json:"impressions"\`
	SpendMicros int64 \`json:"spend_micros"\`
}

// HouseAd is the creative a slot gets when no paid ad can fill it: never billed, counted apart.
var HouseAd = Ad{CampaignID: "house", CreativeID: "house-default", PriceMicros: 0}

func number(raw map[string]string, name string) int64 {
	n, _ := strconv.ParseInt(raw[name], 10, 64)
	return n
}

// PutCampaign writes (or replaces) a campaign and adds it to its placement.
func PutCampaign(ctx context.Context, c Campaign) {
	rdb.HSet(ctx, "campaign:"+c.CampaignID, map[string]any{
		"campaign_id": c.CampaignID, "advertiser_id": c.AdvertiserID, "version": c.Version, "state": c.State,
		"placement": c.Placement, "creative_id": c.CreativeID, "bid_micros": c.BidMicros, "freq_cap": c.FreqCap,
		"freq_window_s": c.FreqWindowS, "paced_budget_micros": c.PacedBudgetMicros, "goal_impressions": c.GoalImpressions,
		"start_ts": c.StartTs, "end_ts": c.EndTs,
	})
	rdb.SAdd(ctx, "placement:"+c.Placement+":campaigns", c.CampaignID)
}

// GetCampaign is the campaign, or nil.
func GetCampaign(ctx context.Context, campaignID string) *Campaign {
	raw := rdb.HGetAll(ctx, "campaign:"+campaignID).Val()
	if len(raw) == 0 {
		return nil
	}
	return &Campaign{
		CampaignID: raw["campaign_id"], AdvertiserID: raw["advertiser_id"], Version: number(raw, "version"), State: raw["state"],
		Placement: raw["placement"], CreativeID: raw["creative_id"], BidMicros: number(raw, "bid_micros"), FreqCap: number(raw, "freq_cap"),
		FreqWindowS: number(raw, "freq_window_s"), PacedBudgetMicros: number(raw, "paced_budget_micros"),
		GoalImpressions: number(raw, "goal_impressions"), StartTs: number(raw, "start_ts"), EndTs: number(raw, "end_ts"),
	}
}

// CampaignsFor is every campaign that targets the placement, whatever its state, by campaign id.
func CampaignsFor(ctx context.Context, placement string) []Campaign {
	ids := rdb.SMembers(ctx, "placement:"+placement+":campaigns").Val()
	sort.Strings(ids)
	var out []Campaign
	for _, id := range ids {
		if c := GetCampaign(ctx, id); c != nil {
			out = append(out, *c)
		}
	}
	return out
}

// Frequency is the user's impressions of the campaign in the current frequency window.
func Frequency(ctx context.Context, campaignID, userHash string) int64 {
	n, _ := rdb.Get(ctx, "freq:"+campaignID+":"+userHash).Int64()
	return n
}

// Spent is the micros the serve path reserved for the campaign so far (the pacing counter).
func Spent(ctx context.Context, campaignID string) int64 {
	n, _ := rdb.Get(ctx, "pace:"+campaignID).Int64()
	return n
}

// CountRender counts one rendered impression and its price, in one transaction.
func CountRender(ctx context.Context, campaignID string, priceMicros int64) error {
	_, err := rdb.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		pipe.HIncrBy(ctx, "render:"+campaignID, "impressions", 1)
		pipe.HIncrBy(ctx, "render:"+campaignID, "spend_micros", priceMicros)
		return nil
	})
	return err
}

// RenderedOf is what was counted at render for the campaign.
func RenderedOf(ctx context.Context, campaignID string) Rendered {
	raw := rdb.HGetAll(ctx, "render:"+campaignID).Val()
	return Rendered{Impressions: number(raw, "impressions"), SpendMicros: number(raw, "spend_micros")}
}

// InsertOutbox queues an event the broker did not take, for the relay to publish later.
func InsertOutbox(ctx context.Context, topic, key string, payload map[string]any) error {
	row, err := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, "outbox", row).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'ads/store.h': `// The campaign store (provided). A campaign is a Redis hash campaign:{id} with campaign_id,
// advertiser_id, version, state (active, paused or exhausted), placement, creative_id, bid_micros,
// freq_cap, freq_window_s, paced_budget_micros, goal_impressions, start_ts and end_ts (epoch
// seconds); placement:{name}:campaigns is the set of campaigns that target a placement.
//
// The serve path's counters: freq:{campaign_id}:{user_hash} (the user's impressions in the
// frequency window) and pace:{campaign_id} (micros reserved at serve), written by step 2's
// reservation; render:{campaign_id}, a hash of impressions and spend_micros counted when the ad
// rendered; outbox, a list of JSON rows {topic, key, payload} the relay publishes when the broker
// did not take them.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <iterator>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace store {

struct Campaign {
  std::string campaign_id;
  std::string advertiser_id;
  long long version = 0;
  std::string state;
  std::string placement;
  std::string creative_id;
  long long bid_micros = 0;
  long long freq_cap = 0;
  long long freq_window_s = 0;
  long long paced_budget_micros = 0;
  long long goal_impressions = 0;
  long long start_ts = 0;
  long long end_ts = 0;
};

// The creative a serve answers with.
struct Ad {
  std::string campaign_id;
  std::string creative_id;
  long long price_micros = 0;
};

// What the page sends when an ad has rendered.
struct Beacon {
  std::string beacon_id;
  std::string campaign_id;
  std::string creative_id;
  std::string user_hash;
  long long price_micros = 0;
};

// What was counted at render.
struct Rendered {
  long long impressions = 0;
  long long spend_micros = 0;
};

// The creative a slot gets when no paid ad can fill it: never billed, counted apart.
inline const Ad kHouseAd{"house", "house-default", 0};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline long long number(const std::unordered_map<std::string, std::string>& raw, const std::string& name) {
  const auto it = raw.find(name);
  return it == raw.end() || it->second.empty() ? 0 : std::stoll(it->second);
}

// Write (or replace) a campaign and add it to its placement.
inline void putCampaign(const Campaign& c) {
  const auto s = [](long long n) { return std::to_string(n); };
  redis().hset("campaign:" + c.campaign_id,
               {std::make_pair(std::string("campaign_id"), c.campaign_id), {"advertiser_id", c.advertiser_id}, {"version", s(c.version)},
                {"state", c.state}, {"placement", c.placement}, {"creative_id", c.creative_id}, {"bid_micros", s(c.bid_micros)},
                {"freq_cap", s(c.freq_cap)}, {"freq_window_s", s(c.freq_window_s)}, {"paced_budget_micros", s(c.paced_budget_micros)},
                {"goal_impressions", s(c.goal_impressions)}, {"start_ts", s(c.start_ts)}, {"end_ts", s(c.end_ts)}});
  redis().sadd("placement:" + c.placement + ":campaigns", c.campaign_id);
}

// The campaign, or none.
inline std::optional<Campaign> getCampaign(const std::string& campaign_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("campaign:" + campaign_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  Campaign c;
  c.campaign_id = text("campaign_id");
  c.advertiser_id = text("advertiser_id");
  c.version = number(raw, "version");
  c.state = text("state");
  c.placement = text("placement");
  c.creative_id = text("creative_id");
  c.bid_micros = number(raw, "bid_micros");
  c.freq_cap = number(raw, "freq_cap");
  c.freq_window_s = number(raw, "freq_window_s");
  c.paced_budget_micros = number(raw, "paced_budget_micros");
  c.goal_impressions = number(raw, "goal_impressions");
  c.start_ts = number(raw, "start_ts");
  c.end_ts = number(raw, "end_ts");
  return c;
}

// Every campaign that targets the placement, whatever its state, by campaign id.
inline std::vector<Campaign> campaignsFor(const std::string& placement) {
  std::vector<std::string> ids;
  redis().smembers("placement:" + placement + ":campaigns", std::back_inserter(ids));
  std::sort(ids.begin(), ids.end());
  std::vector<Campaign> out;
  for (const auto& id : ids) {
    if (const auto c = getCampaign(id)) out.push_back(*c);
  }
  return out;
}

// The user's impressions of the campaign in the current frequency window.
inline long long frequency(const std::string& campaign_id, const std::string& user_hash) {
  const auto raw = redis().get("freq:" + campaign_id + ":" + user_hash);
  return raw ? std::stoll(*raw) : 0;
}

// Micros the serve path reserved for the campaign so far (the pacing counter).
inline long long spent(const std::string& campaign_id) {
  const auto raw = redis().get("pace:" + campaign_id);
  return raw ? std::stoll(*raw) : 0;
}

// Count one rendered impression and its price, in one transaction.
inline void countRender(const std::string& campaign_id, long long price_micros) {
  auto tx = redis().transaction();
  tx.hincrby("render:" + campaign_id, "impressions", 1).hincrby("render:" + campaign_id, "spend_micros", price_micros).exec();
}

// What was counted at render for the campaign.
inline Rendered rendered(const std::string& campaign_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("render:" + campaign_id);
  return Rendered{number(raw, "impressions"), number(raw, "spend_micros")};
}

// Queue an event the broker did not take, for the relay to publish later.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace store
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('ads', 'Store')]: `package ads

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The campaign store (provided). A campaign is a Redis hash campaign:{id} with campaign_id,
 * advertiser_id, version, state (active, paused or exhausted), placement, creative_id, bid_micros,
 * freq_cap, freq_window_s, paced_budget_micros, goal_impressions, start_ts and end_ts (epoch
 * seconds); placement:{name}:campaigns is the set of campaigns that target a placement.
 *
 * The serve path's counters: freq:{campaign_id}:{user_hash} (the user's impressions in the
 * frequency window) and pace:{campaign_id} (micros reserved at serve), written by step 2's
 * reservation; render:{campaign_id}, a hash of impressions and spend_micros counted when the ad
 * rendered; outbox, a list of JSON rows {topic, key, payload} the relay publishes when the broker
 * did not take them.
 */
object Store {
  final case class Campaign(
      campaignId: String,
      advertiserId: String,
      version: Long,
      state: String,
      placement: String,
      creativeId: String,
      bidMicros: Long,
      freqCap: Long,
      freqWindowS: Long,
      pacedBudgetMicros: Long,
      goalImpressions: Long,
      startTs: Long,
      endTs: Long
  )

  /** The creative a serve answers with. */
  final case class Ad(campaignId: String, creativeId: String, priceMicros: Long)

  /** What the page sends when an ad has rendered. */
  final case class Beacon(beaconId: String, campaignId: String, creativeId: String, userHash: String, priceMicros: Long)

  /** What was counted at render. */
  final case class Rendered(impressions: Long, spendMicros: Long)

  /** The creative a slot gets when no paid ad can fill it: never billed, counted apart. */
  val HouseAd: Ad = Ad("house", "house-default", 0L)

  val jedis = new JedisPooled("redis", 6379)

  private def number(raw: Map[String, String], name: String): Long = raw.get(name).filter(_.nonEmpty).map(_.toLong).getOrElse(0L)

  /** Write (or replace) a campaign and add it to its placement. */
  def putCampaign(c: Campaign): Unit = {
    jedis.hset(
      s"campaign:\${c.campaignId}",
      Map(
        "campaign_id" -> c.campaignId, "advertiser_id" -> c.advertiserId, "version" -> c.version.toString, "state" -> c.state,
        "placement" -> c.placement, "creative_id" -> c.creativeId, "bid_micros" -> c.bidMicros.toString, "freq_cap" -> c.freqCap.toString,
        "freq_window_s" -> c.freqWindowS.toString, "paced_budget_micros" -> c.pacedBudgetMicros.toString,
        "goal_impressions" -> c.goalImpressions.toString, "start_ts" -> c.startTs.toString, "end_ts" -> c.endTs.toString
      ).asJava
    )
    jedis.sadd(s"placement:\${c.placement}:campaigns", c.campaignId)
  }

  /** The campaign, if it exists. */
  def getCampaign(campaignId: String): Option[Campaign] = {
    val raw = jedis.hgetAll(s"campaign:$campaignId").asScala.toMap
    if (raw.isEmpty) None
    else
      Some(
        Campaign(
          raw.getOrElse("campaign_id", ""), raw.getOrElse("advertiser_id", ""), number(raw, "version"), raw.getOrElse("state", ""),
          raw.getOrElse("placement", ""), raw.getOrElse("creative_id", ""), number(raw, "bid_micros"), number(raw, "freq_cap"),
          number(raw, "freq_window_s"), number(raw, "paced_budget_micros"), number(raw, "goal_impressions"), number(raw, "start_ts"),
          number(raw, "end_ts")
        )
      )
  }

  /** Every campaign that targets the placement, whatever its state, by campaign id. */
  def campaignsFor(placement: String): Seq[Campaign] =
    jedis.smembers(s"placement:$placement:campaigns").asScala.toSeq.sorted.flatMap(getCampaign)

  /** The user's impressions of the campaign in the current frequency window. */
  def frequency(campaignId: String, userHash: String): Long = Option(jedis.get(s"freq:$campaignId:$userHash")).map(_.toLong).getOrElse(0L)

  /** Micros the serve path reserved for the campaign so far (the pacing counter). */
  def spent(campaignId: String): Long = Option(jedis.get(s"pace:$campaignId")).map(_.toLong).getOrElse(0L)

  /** Count one rendered impression and its price, in one transaction. */
  def countRender(campaignId: String, priceMicros: Long): Unit = {
    val tx = jedis.multi()
    tx.hincrBy(s"render:$campaignId", "impressions", 1L)
    tx.hincrBy(s"render:$campaignId", "spend_micros", priceMicros)
    tx.exec()
  }

  /** What was counted at render for the campaign. */
  def rendered(campaignId: String): Rendered = {
    val raw = jedis.hgetAll(s"render:$campaignId").asScala.toMap
    Rendered(number(raw, "impressions"), number(raw, "spend_micros"))
  }

  /** Queue an event the broker did not take, for the relay to publish later. */
  def insertOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
};
