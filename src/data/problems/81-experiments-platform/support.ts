/**
 * Hand-written support modules the experiments-platform steps import but no step builds: the
 * `expd` package. `expd.store` is the experiment store (Redis hashes, the course's stand-in for the
 * experiments database: designs, status, ramp percentage, exposure and conversion counts).
 * `expd.bucket` is the deterministic bucketing every assignment uses (32-bit FNV-1a, as GrowthBook
 * hashes). `expd.stats` compares a variant with control: lift, its 95 % interval and a two-sided
 * p-value. The five languages keep the same keys and numbers, so a harness reads one layout
 * whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'expd/__init__.py': '',
  'expd/store.py': `"""
The experiment store (provided): every experiment is a Redis hash exp:{id} with id, name, unit,
salt, split (the variants in order, "control:50,treatment:50"), min_sample, status (running,
paused or stopped), percent (the traffic the ramp has reached) and version. exp:{id}:exposures
and exp:{id}:conversions count units per variant: the exposure consumer (step 4) writes the first,
the metrics pipeline the second. An experiment is returned as a dict with variants as
[{"key": ..., "weight": ...}] and the numbers as ints.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def encode_split(variants: list[dict]) -> str:
    return ",".join(f"{v['key']}:{v['weight']}" for v in variants)


def decode_split(text: str) -> list[dict]:
    variants = []
    for part in text.split(","):
        if part:
            key, weight = part.rsplit(":", 1)
            variants.append({"key": key, "weight": int(weight)})
    return variants


def _experiment(raw: dict) -> dict | None:
    if not raw:
        return None
    return {
        "id": raw["id"],
        "name": raw.get("name", ""),
        "unit": raw["unit"],
        "salt": raw["salt"],
        "variants": decode_split(raw["split"]),
        "min_sample": int(raw["min_sample"]),
        "status": raw["status"],
        "percent": int(raw["percent"]),
        "version": int(raw["version"]),
    }


def get(experiment_id: str) -> dict | None:
    """The experiment, or None."""
    return _experiment(r.hgetall(f"exp:{experiment_id}"))


def create(design: dict) -> dict:
    """A new experiment from a design (name, unit, variants, min_sample, salt): version 1, running, at 0 percent. The salt defaults to the experiment id."""
    experiment_id = f"exp-{r.incr('exp:seq')}"
    r.hset(
        f"exp:{experiment_id}",
        mapping={
            "id": experiment_id,
            "name": design.get("name") or "",
            "unit": design["unit"],
            "salt": design.get("salt") or experiment_id,
            "split": encode_split(design["variants"]),
            "min_sample": int(design["min_sample"]),
            "status": "running",
            "percent": 0,
            "version": 1,
        },
    )
    return get(experiment_id)


def update(experiment_id: str, fields: dict) -> dict:
    """The admin writer the bulk tools use: writes the given fields (name, unit, salt, variants, min_sample) in place, whatever the experiment's status."""
    if not r.exists(f"exp:{experiment_id}"):
        raise KeyError(experiment_id)
    mapping = {}
    for name, value in fields.items():
        if name == "variants":
            mapping["split"] = encode_split(value)
        elif name in ("name", "unit", "salt", "min_sample"):
            mapping[name] = str(value)
    if mapping:
        r.hset(f"exp:{experiment_id}", mapping=mapping)
    return get(experiment_id)


def set_status(experiment_id: str, status: str) -> None:
    r.hset(f"exp:{experiment_id}", "status", status)


def set_percent(experiment_id: str, percent: int) -> None:
    r.hset(f"exp:{experiment_id}", "percent", int(percent))


def add_exposure(experiment_id: str, variant: str) -> int:
    """Count one exposed unit for the variant; returns the new count."""
    return r.hincrby(f"exp:{experiment_id}:exposures", variant, 1)


def exposures(experiment_id: str) -> dict[str, int]:
    return {k: int(v) for k, v in r.hgetall(f"exp:{experiment_id}:exposures").items()}


def conversions(experiment_id: str) -> dict[str, int]:
    return {k: int(v) for k, v in r.hgetall(f"exp:{experiment_id}:conversions").items()}
`,
  'expd/bucket.py': `"""
Deterministic bucketing (provided): bucket_of hashes "{experiment_id}:{salt}:{unit_id}" with 32-bit
FNV-1a (over the UTF-8 bytes) into 0..99; variant_for walks the split's cumulative weights, so with
control:50,treatment:50 buckets 0-49 are control and 50-99 treatment.
"""


def fnv1a32(text: str) -> int:
    h = 0x811C9DC5
    for byte in text.encode():
        h = ((h ^ byte) * 0x01000193) & 0xFFFFFFFF
    return h


def bucket_of(experiment_id: str, unit_id: str, salt: str) -> int:
    return fnv1a32(f"{experiment_id}:{salt}:{unit_id}") % 100


def variant_for(variants: list[dict], bucket: int) -> str:
    edge = 0
    for variant in variants:
        edge += variant["weight"]
        if bucket < edge:
            return variant["key"]
    return variants[-1]["key"]
`,
  'expd/stats.py': `"""
Two-proportion comparison (provided): a variant's conversion rate against control's. lift is the
absolute difference of the rates, ci_low/ci_high its 95 % interval (unpooled standard error),
p_value the two-sided p-value of the pooled z-test. With no exposures on either side there is
nothing to compare: lift 0, interval [0, 0], p_value 1.
"""
import math

Z_95 = 1.959964


def compare(control_exposures: int, control_conversions: int, exposures: int, conversions: int) -> dict:
    if control_exposures == 0 or exposures == 0:
        return {"lift": 0.0, "ci_low": 0.0, "ci_high": 0.0, "p_value": 1.0}
    pc = control_conversions / control_exposures
    pt = conversions / exposures
    lift = pt - pc
    se = math.sqrt(pc * (1 - pc) / control_exposures + pt * (1 - pt) / exposures)
    pooled = (control_conversions + conversions) / (control_exposures + exposures)
    se0 = math.sqrt(pooled * (1 - pooled) * (1 / control_exposures + 1 / exposures))
    p_value = 1.0 if se0 == 0 else math.erfc(abs(lift) / se0 / math.sqrt(2))
    return {"lift": lift, "ci_low": lift - Z_95 * se, "ci_high": lift + Z_95 * se, "p_value": p_value}
`,
};

export const supportModulesTs: Record<string, string> = {
  'expd/store.ts': `/**
 * The experiment store (provided): every experiment is a Redis hash exp:{id} with id, name, unit,
 * salt, split (the variants in order, "control:50,treatment:50"), min_sample, status (running,
 * paused or stopped), percent (the traffic the ramp has reached) and version. exp:{id}:exposures
 * and exp:{id}:conversions count units per variant: the exposure consumer (step 4) writes the
 * first, the metrics pipeline the second.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Variant {
  key: string;
  weight: number;
}

export interface Design {
  name: string;
  unit: string;
  variants: Variant[];
  min_sample: number;
  salt?: string | null;
}

export interface Experiment {
  id: string;
  name: string;
  unit: string;
  salt: string;
  variants: Variant[];
  min_sample: number;
  status: string;
  percent: number;
  version: number;
}

export const encodeSplit = (variants: Variant[]): string => variants.map(v => \`\${v.key}:\${v.weight}\`).join(',');

export function decodeSplit(text: string): Variant[] {
  return text
    .split(',')
    .filter(part => part !== '')
    .map(part => {
      const at = part.lastIndexOf(':');
      return {key: part.slice(0, at), weight: Number(part.slice(at + 1))};
    });
}

function experiment(raw: Record<string, string>): Experiment | null {
  if (Object.keys(raw).length === 0) return null;
  return {
    id: raw.id,
    name: raw.name ?? '',
    unit: raw.unit,
    salt: raw.salt,
    variants: decodeSplit(raw.split),
    min_sample: Number(raw.min_sample),
    status: raw.status,
    percent: Number(raw.percent),
    version: Number(raw.version),
  };
}

/** The experiment, or null. */
export async function get(experimentId: string): Promise<Experiment | null> {
  return experiment(await redis.hgetall(\`exp:\${experimentId}\`));
}

/** A new experiment from a design: version 1, running, at 0 percent. The salt defaults to the experiment id. */
export async function create(design: Design): Promise<Experiment> {
  const id = \`exp-\${await redis.incr('exp:seq')}\`;
  await redis.hset(\`exp:\${id}\`, {
    id,
    name: design.name ?? '',
    unit: design.unit,
    salt: design.salt || id,
    split: encodeSplit(design.variants),
    min_sample: String(design.min_sample),
    status: 'running',
    percent: '0',
    version: '1',
  });
  return (await get(id)) as Experiment;
}

/** The admin writer the bulk tools use: writes the given fields (name, unit, salt, variants, min_sample) in place, whatever the experiment's status. */
export async function update(experimentId: string, fields: Record<string, unknown>): Promise<Experiment> {
  if ((await redis.exists(\`exp:\${experimentId}\`)) === 0) throw new Error(\`no experiment \${experimentId}\`);
  const mapping: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (name === 'variants') mapping.split = encodeSplit(value as Variant[]);
    else if (['name', 'unit', 'salt', 'min_sample'].includes(name)) mapping[name] = String(value);
  }
  if (Object.keys(mapping).length > 0) await redis.hset(\`exp:\${experimentId}\`, mapping);
  return (await get(experimentId)) as Experiment;
}

export async function setStatus(experimentId: string, status: string): Promise<void> {
  await redis.hset(\`exp:\${experimentId}\`, 'status', status);
}

export async function setPercent(experimentId: string, percent: number): Promise<void> {
  await redis.hset(\`exp:\${experimentId}\`, 'percent', String(percent));
}

/** Count one exposed unit for the variant; returns the new count. */
export async function addExposure(experimentId: string, variant: string): Promise<number> {
  return redis.hincrby(\`exp:\${experimentId}:exposures\`, variant, 1);
}

async function counts(key: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(await redis.hgetall(key))) out[k] = Number(v);
  return out;
}

export const exposures = (experimentId: string): Promise<Record<string, number>> => counts(\`exp:\${experimentId}:exposures\`);
export const conversions = (experimentId: string): Promise<Record<string, number>> => counts(\`exp:\${experimentId}:conversions\`);
`,
  'expd/bucket.ts': `/**
 * Deterministic bucketing (provided): bucketOf hashes "{experimentId}:{salt}:{unitId}" with 32-bit
 * FNV-1a (over the UTF-8 bytes) into 0..99; variantFor walks the split's cumulative weights, so with
 * control:50,treatment:50 buckets 0-49 are control and 50-99 treatment.
 */
import type {Variant} from 'expd/store';

export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return h >>> 0;
}

export const bucketOf = (experimentId: string, unitId: string, salt: string): number => fnv1a32(\`\${experimentId}:\${salt}:\${unitId}\`) % 100;

export function variantFor(variants: Variant[], bucket: number): string {
  let edge = 0;
  for (const variant of variants) {
    edge += variant.weight;
    if (bucket < edge) return variant.key;
  }
  return variants[variants.length - 1].key;
}
`,
  'expd/stats.ts': `/**
 * Two-proportion comparison (provided): a variant's conversion rate against control's. lift is the
 * absolute difference of the rates, ci_low/ci_high its 95 % interval (unpooled standard error),
 * p_value the two-sided p-value of the pooled z-test. With no exposures on either side there is
 * nothing to compare: lift 0, interval [0, 0], p_value 1.
 */
export interface Comparison {
  lift: number;
  ci_low: number;
  ci_high: number;
  p_value: number;
}

export const Z_95 = 1.959964;

/** The complementary error function (Numerical Recipes' erfcc: fractional error below 1.2e-7). */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

export function compare(controlExposures: number, controlConversions: number, exposures: number, conversions: number): Comparison {
  if (controlExposures === 0 || exposures === 0) return {lift: 0, ci_low: 0, ci_high: 0, p_value: 1};
  const pc = controlConversions / controlExposures;
  const pt = conversions / exposures;
  const lift = pt - pc;
  const se = Math.sqrt((pc * (1 - pc)) / controlExposures + (pt * (1 - pt)) / exposures);
  const pooled = (controlConversions + conversions) / (controlExposures + exposures);
  const se0 = Math.sqrt(pooled * (1 - pooled) * (1 / controlExposures + 1 / exposures));
  const p = se0 === 0 ? 1 : erfc(Math.abs(lift) / se0 / Math.SQRT2);
  return {lift, ci_low: lift - Z_95 * se, ci_high: lift + Z_95 * se, p_value: p};
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'expd/store/store.go': `// Package store is the experiment store (provided): every experiment is a Redis hash exp:{id}
// with id, name, unit, salt, split (the variants in order, "control:50,treatment:50"),
// min_sample, status (running, paused or stopped), percent (the traffic the ramp has reached) and
// version. exp:{id}:exposures and exp:{id}:conversions count units per variant: the exposure
// consumer (step 4) writes the first, the metrics pipeline the second.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Variant is one arm of the split.
type Variant struct {
	Key    string \`json:"key"\`
	Weight int    \`json:"weight"\`
}

// Design is what an experiment is created from (a request body decodes into one).
type Design struct {
	Name      string    \`json:"name"\`
	Unit      string    \`json:"unit"\`
	Variants  []Variant \`json:"variants"\`
	MinSample int       \`json:"min_sample"\`
	Salt      string    \`json:"salt"\`
}

// Experiment is a stored experiment.
type Experiment struct {
	ID        string    \`json:"id"\`
	Name      string    \`json:"name"\`
	Unit      string    \`json:"unit"\`
	Salt      string    \`json:"salt"\`
	Variants  []Variant \`json:"variants"\`
	MinSample int       \`json:"min_sample"\`
	Status    string    \`json:"status"\`
	Percent   int       \`json:"percent"\`
	Version   int       \`json:"version"\`
}

// EncodeSplit is the split as the hash stores it.
func EncodeSplit(variants []Variant) string {
	parts := make([]string, 0, len(variants))
	for _, v := range variants {
		parts = append(parts, v.Key+":"+strconv.Itoa(v.Weight))
	}
	return strings.Join(parts, ",")
}

// DecodeSplit reads a stored split.
func DecodeSplit(text string) []Variant {
	variants := []Variant{}
	for _, part := range strings.Split(text, ",") {
		at := strings.LastIndex(part, ":")
		if at < 0 {
			continue
		}
		weight, _ := strconv.Atoi(part[at+1:])
		variants = append(variants, Variant{Key: part[:at], Weight: weight})
	}
	return variants
}

// Get is the experiment, or nil.
func Get(ctx context.Context, experimentID string) *Experiment {
	raw := rdb.HGetAll(ctx, "exp:"+experimentID).Val()
	if len(raw) == 0 {
		return nil
	}
	minSample, _ := strconv.Atoi(raw["min_sample"])
	percent, _ := strconv.Atoi(raw["percent"])
	version, _ := strconv.Atoi(raw["version"])
	return &Experiment{ID: raw["id"], Name: raw["name"], Unit: raw["unit"], Salt: raw["salt"], Variants: DecodeSplit(raw["split"]),
		MinSample: minSample, Status: raw["status"], Percent: percent, Version: version}
}

// Create makes a new experiment from a design: version 1, running, at 0 percent. The salt
// defaults to the experiment id.
func Create(ctx context.Context, design Design) *Experiment {
	id := fmt.Sprintf("exp-%d", rdb.Incr(ctx, "exp:seq").Val())
	salt := design.Salt
	if salt == "" {
		salt = id
	}
	rdb.HSet(ctx, "exp:"+id, map[string]any{"id": id, "name": design.Name, "unit": design.Unit, "salt": salt,
		"split": EncodeSplit(design.Variants), "min_sample": strconv.Itoa(design.MinSample), "status": "running", "percent": "0", "version": "1"})
	return Get(ctx, id)
}

// Update is the admin writer the bulk tools use: it writes the given fields (name, unit, salt,
// variants, min_sample) in place, whatever the experiment's status.
func Update(ctx context.Context, experimentID string, fields map[string]any) (*Experiment, error) {
	if rdb.Exists(ctx, "exp:"+experimentID).Val() == 0 {
		return nil, fmt.Errorf("no experiment %s", experimentID)
	}
	mapping := map[string]any{}
	for name, value := range fields {
		switch name {
		case "variants":
			raw, _ := json.Marshal(value)
			var variants []Variant
			json.Unmarshal(raw, &variants)
			mapping["split"] = EncodeSplit(variants)
		case "name", "unit", "salt":
			mapping[name] = fmt.Sprint(value)
		case "min_sample":
			if f, ok := value.(float64); ok {
				mapping[name] = strconv.Itoa(int(f))
			} else {
				mapping[name] = fmt.Sprint(value)
			}
		}
	}
	if len(mapping) > 0 {
		rdb.HSet(ctx, "exp:"+experimentID, mapping)
	}
	return Get(ctx, experimentID), nil
}

// SetStatus sets running, paused or stopped.
func SetStatus(ctx context.Context, experimentID, status string) {
	rdb.HSet(ctx, "exp:"+experimentID, "status", status)
}

// SetPercent records the traffic the ramp has reached.
func SetPercent(ctx context.Context, experimentID string, percent int) {
	rdb.HSet(ctx, "exp:"+experimentID, "percent", strconv.Itoa(percent))
}

// AddExposure counts one exposed unit for the variant and returns the new count.
func AddExposure(ctx context.Context, experimentID, variant string) (int64, error) {
	return rdb.HIncrBy(ctx, "exp:"+experimentID+":exposures", variant, 1).Result()
}

func counts(ctx context.Context, key string) map[string]int64 {
	out := map[string]int64{}
	for k, v := range rdb.HGetAll(ctx, key).Val() {
		n, _ := strconv.ParseInt(v, 10, 64)
		out[k] = n
	}
	return out
}

// Exposures counts exposed units per variant.
func Exposures(ctx context.Context, experimentID string) map[string]int64 {
	return counts(ctx, "exp:"+experimentID+":exposures")
}

// Conversions counts converted units per variant.
func Conversions(ctx context.Context, experimentID string) map[string]int64 {
	return counts(ctx, "exp:"+experimentID+":conversions")
}
`,
  'expd/bucket/bucket.go': `// Package bucket is deterministic bucketing (provided): BucketOf hashes
// "{experimentID}:{salt}:{unitID}" with 32-bit FNV-1a (over the UTF-8 bytes) into 0..99; VariantFor
// walks the split's cumulative weights, so with control:50,treatment:50 buckets 0-49 are control
// and 50-99 treatment.
package bucket

import "expd/store"

// Fnv1a32 is 32-bit FNV-1a over the string's bytes.
func Fnv1a32(text string) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < len(text); i++ {
		h = (h ^ uint32(text[i])) * 0x01000193
	}
	return h
}

// BucketOf is the unit's bucket in 0..99.
func BucketOf(experimentID, unitID, salt string) int {
	return int(Fnv1a32(experimentID+":"+salt+":"+unitID) % 100)
}

// VariantFor is the variant whose cumulative weight range holds the bucket.
func VariantFor(variants []store.Variant, bucket int) string {
	edge := 0
	for _, v := range variants {
		edge += v.Weight
		if bucket < edge {
			return v.Key
		}
	}
	return variants[len(variants)-1].Key
}
`,
  'expd/stats/stats.go': `// Package stats is the two-proportion comparison (provided): a variant's conversion rate against
// control's. Lift is the absolute difference of the rates, CILow/CIHigh its 95 % interval
// (unpooled standard error), PValue the two-sided p-value of the pooled z-test. With no exposures
// on either side there is nothing to compare: lift 0, interval [0, 0], p-value 1.
package stats

import "math"

// Z95 is the two-sided 95 % normal quantile.
const Z95 = 1.959964

// Comparison is one variant against control.
type Comparison struct {
	Lift   float64 \`json:"lift"\`
	CILow  float64 \`json:"ci_low"\`
	CIHigh float64 \`json:"ci_high"\`
	PValue float64 \`json:"p_value"\`
}

// Compare compares a variant's conversions with control's.
func Compare(controlExposures, controlConversions, exposures, conversions int64) Comparison {
	if controlExposures == 0 || exposures == 0 {
		return Comparison{PValue: 1}
	}
	cn, cx, n, x := float64(controlExposures), float64(controlConversions), float64(exposures), float64(conversions)
	pc, pt := cx/cn, x/n
	lift := pt - pc
	se := math.Sqrt(pc*(1-pc)/cn + pt*(1-pt)/n)
	pooled := (cx + x) / (cn + n)
	se0 := math.Sqrt(pooled * (1 - pooled) * (1/cn + 1/n))
	p := 1.0
	if se0 > 0 {
		p = math.Erfc(math.Abs(lift) / se0 / math.Sqrt2)
	}
	return Comparison{Lift: lift, CILow: lift - Z95*se, CIHigh: lift + Z95*se, PValue: p}
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'expd/store.h': `// The experiment store (provided): every experiment is a Redis hash exp:{id} with id, name, unit,
// salt, split (the variants in order, "control:50,treatment:50"), min_sample, status (running,
// paused or stopped), percent (the traffic the ramp has reached) and version. exp:{id}:exposures
// and exp:{id}:conversions count units per variant: the exposure consumer (step 4) writes the
// first, the metrics pipeline the second.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

struct Variant {
  std::string key;
  long weight = 0;
};

// What an experiment is created from.
struct Design {
  std::string name;
  std::string unit;
  std::vector<Variant> variants;
  long min_sample = 0;
  std::string salt;
};

struct Experiment {
  std::string id;
  std::string name;
  std::string unit;
  std::string salt;
  std::vector<Variant> variants;
  long min_sample = 0;
  std::string status;
  long percent = 0;
  long version = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string encodeSplit(const std::vector<Variant>& variants) {
  std::string out;
  for (const Variant& v : variants) out += (out.empty() ? "" : ",") + v.key + ":" + std::to_string(v.weight);
  return out;
}

inline std::vector<Variant> decodeSplit(const std::string& text) {
  std::vector<Variant> variants;
  size_t start = 0;
  while (start < text.size()) {
    size_t stop = text.find(',', start);
    if (stop == std::string::npos) stop = text.size();
    const std::string part = text.substr(start, stop - start);
    const size_t at = part.rfind(':');
    if (at != std::string::npos) variants.push_back(Variant{part.substr(0, at), std::stol(part.substr(at + 1))});
    start = stop + 1;
  }
  return variants;
}

// The experiment as a JSON response carries it.
inline nlohmann::json toJson(const Experiment& e) {
  nlohmann::json variants = nlohmann::json::array();
  for (const Variant& v : e.variants) variants.push_back({{"key", v.key}, {"weight", v.weight}});
  return {{"id", e.id},           {"name", e.name},     {"unit", e.unit},       {"salt", e.salt},       {"variants", variants},
          {"min_sample", e.min_sample}, {"status", e.status}, {"percent", e.percent}, {"version", e.version}};
}

// The experiment, or none.
inline std::optional<Experiment> get(const std::string& experiment_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("exp:" + experiment_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  Experiment e;
  e.id = text("id");
  e.name = text("name");
  e.unit = text("unit");
  e.salt = text("salt");
  e.variants = decodeSplit(text("split"));
  e.min_sample = std::stol(text("min_sample"));
  e.status = text("status");
  e.percent = std::stol(text("percent"));
  e.version = std::stol(text("version"));
  return e;
}

// A new experiment from a design: version 1, running, at 0 percent. The salt defaults to the
// experiment id.
inline Experiment create(const Design& design) {
  const std::string id = "exp-" + std::to_string(redis().incr("exp:seq"));
  redis().hset("exp:" + id, {{"id", id},
                             {"name", design.name},
                             {"unit", design.unit},
                             {"salt", design.salt.empty() ? id : design.salt},
                             {"split", encodeSplit(design.variants)},
                             {"min_sample", std::to_string(design.min_sample)},
                             {"status", "running"},
                             {"percent", "0"},
                             {"version", "1"}});
  return *get(id);
}

// The admin writer the bulk tools use: writes the given fields (name, unit, salt, variants,
// min_sample) in place, whatever the experiment's status.
inline Experiment update(const std::string& experiment_id, const nlohmann::json& fields) {
  if (!redis().exists("exp:" + experiment_id)) throw std::out_of_range("no experiment " + experiment_id);
  std::map<std::string, std::string> mapping;
  for (const auto& [name, value] : fields.items()) {
    if (name == "variants" && value.is_array()) {
      std::vector<Variant> variants;
      for (const auto& v : value) variants.push_back(Variant{v.value("key", ""), v.value("weight", 0L)});
      mapping["split"] = encodeSplit(variants);
    } else if (name == "name" || name == "unit" || name == "salt" || name == "min_sample") {
      mapping[name] = value.is_string() ? value.get<std::string>() : value.dump();
    }
  }
  if (!mapping.empty()) redis().hset("exp:" + experiment_id, mapping.begin(), mapping.end());
  return *get(experiment_id);
}

inline void setStatus(const std::string& experiment_id, const std::string& status) {
  redis().hset("exp:" + experiment_id, "status", status);
}

inline void setPercent(const std::string& experiment_id, long percent) {
  redis().hset("exp:" + experiment_id, "percent", std::to_string(percent));
}

// Count one exposed unit for the variant; returns the new count.
inline long long addExposure(const std::string& experiment_id, const std::string& variant) {
  return redis().hincrby("exp:" + experiment_id + ":exposures", variant, 1);
}

inline std::map<std::string, long long> counts(const std::string& key) {
  std::unordered_map<std::string, std::string> raw = redis().hgetall(key);
  std::map<std::string, long long> out;
  for (const auto& [k, v] : raw) out[k] = std::stoll(v);
  return out;
}

inline std::map<std::string, long long> exposures(const std::string& experiment_id) {
  return counts("exp:" + experiment_id + ":exposures");
}

inline std::map<std::string, long long> conversions(const std::string& experiment_id) {
  return counts("exp:" + experiment_id + ":conversions");
}

}  // namespace store
`,
  'expd/bucket.h': `// Deterministic bucketing (provided): bucketOf hashes "{experiment_id}:{salt}:{unit_id}" with
// 32-bit FNV-1a (over the UTF-8 bytes) into 0..99; variantFor walks the split's cumulative
// weights, so with control:50,treatment:50 buckets 0-49 are control and 50-99 treatment.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "expd/store.h"

namespace bucket {

inline uint32_t fnv1a32(const std::string& text) {
  uint32_t h = 0x811c9dc5u;
  for (const unsigned char byte : text) h = (h ^ byte) * 0x01000193u;
  return h;
}

inline int bucketOf(const std::string& experiment_id, const std::string& unit_id, const std::string& salt) {
  return static_cast<int>(fnv1a32(experiment_id + ":" + salt + ":" + unit_id) % 100);
}

inline std::string variantFor(const std::vector<store::Variant>& variants, int bucket) {
  long edge = 0;
  for (const store::Variant& v : variants) {
    edge += v.weight;
    if (bucket < edge) return v.key;
  }
  return variants.back().key;
}

}  // namespace bucket
`,
  'expd/stats.h': `// Two-proportion comparison (provided): a variant's conversion rate against control's. lift is the
// absolute difference of the rates, ci_low/ci_high its 95 % interval (unpooled standard error),
// p_value the two-sided p-value of the pooled z-test. With no exposures on either side there is
// nothing to compare: lift 0, interval [0, 0], p_value 1.
#pragma once

#include <cmath>

namespace stats {

constexpr double kZ95 = 1.959964;

struct Comparison {
  double lift = 0;
  double ci_low = 0;
  double ci_high = 0;
  double p_value = 1;
};

inline Comparison compare(long long control_exposures, long long control_conversions, long long exposures, long long conversions) {
  if (control_exposures == 0 || exposures == 0) return Comparison{};
  const double cn = static_cast<double>(control_exposures), cx = static_cast<double>(control_conversions);
  const double n = static_cast<double>(exposures), x = static_cast<double>(conversions);
  const double pc = cx / cn, pt = x / n;
  const double lift = pt - pc;
  const double se = std::sqrt(pc * (1 - pc) / cn + pt * (1 - pt) / n);
  const double pooled = (cx + x) / (cn + n);
  const double se0 = std::sqrt(pooled * (1 - pooled) * (1 / cn + 1 / n));
  const double p = se0 > 0 ? std::erfc(std::fabs(lift) / se0 / std::sqrt(2.0)) : 1.0;
  return Comparison{lift, lift - kZ95 * se, lift + kZ95 * se, p};
}

}  // namespace stats
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('expd', 'Store')]: `package expd

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The experiment store (provided): every experiment is a Redis hash exp:{id} with id, name, unit,
 * salt, split (the variants in order, "control:50,treatment:50"), min_sample, status (running,
 * paused or stopped), percent (the traffic the ramp has reached) and version. exp:{id}:exposures
 * and exp:{id}:conversions count units per variant: the exposure consumer (step 4) writes the
 * first, the metrics pipeline the second.
 */
object Store {
  final case class Variant(key: String, weight: Int)
  final case class Design(name: String, unit: String, variants: Seq[Variant], minSample: Int, salt: Option[String])
  final case class Experiment(id: String, name: String, unit: String, salt: String, variants: Seq[Variant], minSample: Int, status: String, percent: Int, version: Int)

  val jedis = new JedisPooled("redis", 6379)

  def encodeSplit(variants: Seq[Variant]): String = variants.map(v => s"\${v.key}:\${v.weight}").mkString(",")

  def decodeSplit(text: String): Seq[Variant] =
    text.split(",").toSeq.filter(_.contains(":")).map { part =>
      val at = part.lastIndexOf(':')
      Variant(part.substring(0, at), part.substring(at + 1).toInt)
    }

  /** The experiment as a JSON response carries it. */
  def toJson(e: Experiment): JsObject = JsObject(
    "id" -> JsString(e.id), "name" -> JsString(e.name), "unit" -> JsString(e.unit), "salt" -> JsString(e.salt),
    "variants" -> JsArray(e.variants.map(v => JsObject("key" -> JsString(v.key), "weight" -> JsNumber(v.weight))).toVector),
    "min_sample" -> JsNumber(e.minSample), "status" -> JsString(e.status), "percent" -> JsNumber(e.percent), "version" -> JsNumber(e.version))

  /** The experiment, if it exists. */
  def get(experimentId: String): Option[Experiment] = {
    val raw = jedis.hgetAll(s"exp:$experimentId").asScala.toMap
    if (raw.isEmpty) None
    else Some(Experiment(raw("id"), raw.getOrElse("name", ""), raw("unit"), raw("salt"), decodeSplit(raw("split")), raw("min_sample").toInt, raw("status"), raw("percent").toInt, raw("version").toInt))
  }

  /** A new experiment from a design: version 1, running, at 0 percent. The salt defaults to the experiment id. */
  def create(design: Design): Experiment = {
    val id = s"exp-\${jedis.incr("exp:seq")}"
    jedis.hset(s"exp:$id", Map(
      "id" -> id, "name" -> design.name, "unit" -> design.unit, "salt" -> design.salt.filter(_.nonEmpty).getOrElse(id),
      "split" -> encodeSplit(design.variants), "min_sample" -> design.minSample.toString, "status" -> "running", "percent" -> "0", "version" -> "1").asJava)
    get(id).get
  }

  /** The admin writer the bulk tools use: writes the given fields (name, unit, salt, variants, min_sample) in place, whatever the experiment's status. */
  def update(experimentId: String, fields: JsObject): Experiment = {
    if (!jedis.exists(s"exp:$experimentId")) throw new NoSuchElementException(s"no experiment $experimentId")
    val mapping = fields.fields.collect {
      case ("variants", JsArray(items)) =>
        "split" -> encodeSplit(items.map { item =>
          val f = item.asJsObject.fields
          Variant(f.get("key").collect { case JsString(s) => s }.getOrElse(""), f.get("weight").collect { case JsNumber(n) => n.toInt }.getOrElse(0))
        })
      case (name @ ("name" | "unit" | "salt"), JsString(s)) => name -> s
      case ("min_sample", JsNumber(n)) => "min_sample" -> n.toInt.toString
    }
    if (mapping.nonEmpty) jedis.hset(s"exp:$experimentId", mapping.asJava)
    get(experimentId).get
  }

  def setStatus(experimentId: String, status: String): Unit = jedis.hset(s"exp:$experimentId", "status", status)

  def setPercent(experimentId: String, percent: Int): Unit = jedis.hset(s"exp:$experimentId", "percent", percent.toString)

  /** Count one exposed unit for the variant; returns the new count. */
  def addExposure(experimentId: String, variant: String): Long = jedis.hincrBy(s"exp:$experimentId:exposures", variant, 1)

  private def counts(key: String): Map[String, Long] = jedis.hgetAll(key).asScala.toMap.map { case (k, v) => k -> v.toLong }

  def exposures(experimentId: String): Map[String, Long] = counts(s"exp:$experimentId:exposures")

  def conversions(experimentId: String): Map[String, Long] = counts(s"exp:$experimentId:conversions")
}
`,
  [scalaPath('expd', 'Bucket')]: `package expd

import java.nio.charset.StandardCharsets.UTF_8

/**
 * Deterministic bucketing (provided): bucketOf hashes "{experimentId}:{salt}:{unitId}" with 32-bit
 * FNV-1a (over the UTF-8 bytes) into 0..99; variantFor walks the split's cumulative weights, so with
 * control:50,treatment:50 buckets 0-49 are control and 50-99 treatment.
 */
object Bucket {
  def fnv1a32(text: String): Long =
    text.getBytes(UTF_8).foldLeft(0x811c9dc5L)((h, b) => ((h ^ (b & 0xff)) * 0x01000193L) & 0xffffffffL)

  def bucketOf(experimentId: String, unitId: String, salt: String): Int = (fnv1a32(s"$experimentId:$salt:$unitId") % 100).toInt

  def variantFor(variants: Seq[Store.Variant], bucket: Int): String = {
    val edges = variants.scanLeft(0)(_ + _.weight).tail
    variants.zip(edges).find { case (_, edge) => bucket < edge }.map(_._1.key).getOrElse(variants.last.key)
  }
}
`,
  [scalaPath('expd', 'Stats')]: `package expd

/**
 * Two-proportion comparison (provided): a variant's conversion rate against control's. lift is the
 * absolute difference of the rates, ciLow/ciHigh its 95 % interval (unpooled standard error),
 * pValue the two-sided p-value of the pooled z-test. With no exposures on either side there is
 * nothing to compare: lift 0, interval [0, 0], p-value 1.
 */
object Stats {
  final case class Comparison(lift: Double, ciLow: Double, ciHigh: Double, pValue: Double)

  val Z95 = 1.959964

  /** The complementary error function (Numerical Recipes' erfcc: fractional error below 1.2e-7). */
  def erfc(x: Double): Double = {
    val z = math.abs(x)
    val t = 1 / (1 + 0.5 * z)
    val r = t * math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
      t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))))
    if (x >= 0) r else 2 - r
  }

  def compare(controlExposures: Long, controlConversions: Long, exposures: Long, conversions: Long): Comparison =
    if (controlExposures == 0 || exposures == 0) Comparison(0, 0, 0, 1)
    else {
      val (cn, cx, n, x) = (controlExposures.toDouble, controlConversions.toDouble, exposures.toDouble, conversions.toDouble)
      val pc = cx / cn
      val pt = x / n
      val lift = pt - pc
      val se = math.sqrt(pc * (1 - pc) / cn + pt * (1 - pt) / n)
      val pooled = (cx + x) / (cn + n)
      val se0 = math.sqrt(pooled * (1 - pooled) * (1 / cn + 1 / n))
      val p = if (se0 > 0) erfc(math.abs(lift) / se0 / math.sqrt(2)) else 1.0
      Comparison(lift, lift - Z95 * se, lift + Z95 * se, p)
    }
}
`,
};
