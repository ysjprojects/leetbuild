import type {Step} from '@/lib/types';

export const gateSnapshotStep: Step = {
  id: 'gate-snapshot',
  title: 'The snapshot: one hash, zero network calls per decision',
  concept: 'redis',
  file: 'gates',
  focus: ['web', 'redis'],
  task: `## Task

Implement the half of Stormcrow every app server runs: a **snapshot** of all gates held in memory, a
**loader** that refreshes it, and \`get_variant(name, attrs)\` — a pure function over the snapshot.
Step 1 publishes gates as JSON in the hash \`gates\` (field = gate name) and bumps \`gates:version\` on
every change.

- \`refresh()\`: \`GET gates:version\`; if it equals the snapshot's version, **stop** (one cheap command per
  poll). Otherwise \`HGETALL gates\`, parse every gate and replace the snapshot in **one assignment** —
  a request never sees half a reload. Return whether anything changed. The loader calls it at start-up
  and every \`POLL_INTERVAL_S\` (10 s) in the background.
- \`get_variant(name, attrs)\` makes **no I/O at all**: an unknown gate answers \`OFF\`; an unexpired
  **override** for \`attrs.user_id\` wins; otherwise the first **population** whose every \`match\` entry equals
  the caller's attribute (\`{}\` matches everyone) decides, and a gate with no matching population answers
  its \`default\`.
- The variant is **stateless**: \`bucket = int(sha256("{seed}:{user_id}")[:8 hex], 16) % 10000\`. Walk the
  population's \`mix\` **in order**; a share of \`pct\` owns the next \`pct × 100\` buckets, and the first share
  whose edge is above the bucket wins. Raising a share from 10 to 20 then keeps every user who already had
  it — the boundary moves, nobody is reshuffled.

:::widget percent-rollout {}

> The post's lesson: *avoid I/O in the feature gating system*. The loader pays one \`GET\` every ten
> seconds for the whole fleet; a page that evaluates thirty gates pays nothing.`,
  sequence: {
    participants: ['app server', 'loader', 'Redis'],
    messages: [
      {from: 'loader', to: 'Redis', label: 'GET gates:version', kind: 'sync'},
      {from: 'Redis', to: 'loader', label: '"7" (was 6)', kind: 'reply'},
      {from: 'loader', to: 'Redis', label: 'HGETALL gates', kind: 'sync'},
      {from: 'Redis', to: 'loader', label: '{button_color: {…}, …}', kind: 'reply'},
      {from: 'loader', to: 'app server', label: 'snapshot = v7 (one assignment)', kind: 'async'},
      {
        from: 'app server',
        to: 'app server',
        label: 'get_variant("button_color", ana): sha256 → bucket 4123 → RED_BUTTON',
        kind: 'sync',
      },
      {from: 'loader', to: 'Redis', label: 'GET gates:version (10 s later)', kind: 'sync'},
      {from: 'Redis', to: 'loader', label: '"7" — unchanged, no HGETALL', kind: 'reply'},
    ],
  },
  hints: [
    'Write `bucket` and `pick` first and test them in your head: `seed:user` → sha256 → first 8 hex digits → integer → `% 10000`; then cumulative edges `pct * 100` walked in mix order. Everything else is lookups.',
    'The snapshot is one value — version plus a map of gates. `refresh` builds a complete new one and swaps the reference at the end; never mutate the map requests are reading.',
    'Match a population with "every entry of `match` equals the attribute of the same name"; an empty match object is therefore true for everyone. Check overrides before populations, and compare `expires_at` against the current time in seconds.',
  ],
  checks: [
    {
      id: 'stateless-hash',
      title: 'Assigns variants by hashing seed and user',
      detail:
        'The bucket is the first 8 hex digits of `sha256("{seed}:{user_id}")` as an integer modulo 10 000 — identical on every server and across restarts, and the same for two gates sharing a seed.',
      match: {
        python: {all: [/hashlib\.sha256\(/, /%\s*BUCKETS/]},
        typescript: {all: [/createHash\(\s*['"]sha256['"]\s*\)/, /%\s*BUCKETS/]},
        go: {all: [/sha256\.Sum256\(/, /%\s*buckets/]},
        scala: {all: [/"SHA-256"/, /%\s*Buckets/]},
        cpp: {all: [/sha256_hex\(/, /%\s*kBuckets/]},
      },
    },
    {
      id: 'fall-through',
      title: 'First matching population wins; none → default',
      detail:
        'Populations are tried in order and the first whose `match` entries all equal the caller’s attributes decides the mix; `{}` matches everyone; no match answers the gate’s `default`, an unknown gate answers `OFF`.',
      match: {
        python: {all: [/for population in /, /return pick\(/, /\.get\("default"/]},
        typescript: {all: [/for \(const \w+ of gate\.populations\)/, /return pick\(/, /return gate\.default/]},
        go: {all: [/for _, \w+ := range gate\.Populations/, /return pick\(/, /return gate\.Default/]},
        scala: {all: [/populations\s*\.find\(|collectFirst/, /getOrElse\(gate\.default\)|gate\.default/]},
        cpp: {all: [/for \(const auto& \w+ : gate\.populations\)/, /return pick\(/, /return gate\.default_variant/]},
      },
    },
    {
      id: 'monotone-rollout',
      title: 'Shares are cumulative edges in mix order',
      detail:
        'A share of `pct` owns the next `pct × 100` buckets after the shares before it; growing a share only moves its edge, so every user already assigned to it stays assigned.',
      match: {
        python: {all: [/edge \+= share\["pct"\]/, /if b < edge/]},
        typescript: {all: [/edge \+= share\.pct/, /if \(b < edge\)/]},
        go: {all: [/edge \+= share\.Pct/, /if b < edge/]},
        scala: {all: [/edge \+= share\.pct/, /if \(b < edge\)/]},
        cpp: {all: [/edge \+= share\.pct/, /if \(b < edge\)/]},
      },
    },
    {
      id: 'snapshot',
      title: 'Loads on version change only, evaluates without I/O',
      detail:
        '`refresh` reads `gates:version` and returns at once when it has not moved; only a changed version costs the `HGETALL`; the snapshot is replaced whole, and `get_variant` never touches Redis.',
      match: {
        python: {order: [/r\.get\("gates:version"\)/, /r\.hgetall\("gates"\)/], all: [/== snapshot\.version/]},
        typescript: {
          order: [/redis\.get\('gates:version'\)/, /redis\.hgetall\('gates'\)/],
          all: [/=== snapshot\.version/],
        },
        go: {order: [/rdb\.Get\(ctx, "gates:version"\)/, /rdb\.HGetAll\(ctx, "gates"\)/], all: [/== current\.Version/]},
        scala: {order: [/jedis\.get\("gates:version"\)/, /jedis\.hgetAll\("gates"\)/], all: [/== snapshot\.version/]},
        cpp: {order: [/redis\.get\("gates:version"\)/, /redis\.hgetall\("gates"/], all: [/== current->version/]},
      },
    },
    {
      id: 'overrides',
      title: 'An unexpired override pins the variant',
      detail:
        'An override entry for the caller’s `user_id` with `expires_at` in the future answers its variant before any population is tried; an expired one is ignored.',
      match: {
        python: {order: [/override\["expires_at"\] > now/, /for population in /]},
        typescript: {order: [/\.expires_at > now/, /for \(const \w+ of gate\.populations\)/]},
        go: {order: [/\.ExpiresAt > now/, /for _, \w+ := range gate\.Populations/]},
        scala: {order: [/\.expiresAt > now/, /populations\s*\.find\(|collectFirst/]},
        cpp: {order: [/\.expires_at > now/, /for \(const auto& \w+ : gate\.populations\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Feature gates on every app server: the config snapshot, its loader, and the pure decision over it."""
import hashlib
import json
import threading
import time
from dataclasses import dataclass, field

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

BUCKETS = 10_000
POLL_INTERVAL_S = 10
OFF = "OFF"


@dataclass
class Snapshot:
    """Every gate, as published: {name: {seed, default, populations: [{match, mix: [{variant, pct}]}], overrides}}."""

    version: int = 0
    gates: dict[str, dict] = field(default_factory=dict)


snapshot = Snapshot()


def bucket(seed: str, user_id: str) -> int:
    """0..9999, the same on every server."""
    # TODO: int(sha256("{seed}:{user_id}").hexdigest()[:8], 16) % BUCKETS
    raise NotImplementedError


def pick(mix: list[dict], b: int) -> str:
    """The share whose cumulative edge is the first above the bucket."""
    # TODO: walk mix in order; each share owns pct * (BUCKETS // 100) buckets
    raise NotImplementedError


def get_variant(name: str, attrs: dict) -> str:
    """No I/O: unknown gate → OFF; unexpired override → its variant; first matching population → pick; else default."""
    # TODO
    raise NotImplementedError


def refresh() -> bool:
    """GET gates:version; unchanged → False. Otherwise HGETALL gates, parse, replace the snapshot in one assignment."""
    global snapshot
    # TODO
    raise NotImplementedError


def start_loader(interval_s: float = POLL_INTERVAL_S) -> threading.Thread:
    """Load once now, then refresh every interval_s in the background; a failed poll keeps the last snapshot."""
    refresh()

    def loop() -> None:
        while True:
            time.sleep(interval_s)
            try:
                refresh()
            except redis.RedisError:
                pass  # serve the snapshot we have

    thread = threading.Thread(target=loop, name="gates-loader", daemon=True)
    thread.start()
    return thread
`,
      solution: `"""Feature gates on every app server: the config snapshot, its loader, and the pure decision over it."""
import hashlib
import json
import threading
import time
from dataclasses import dataclass, field

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

BUCKETS = 10_000
POLL_INTERVAL_S = 10
OFF = "OFF"


@dataclass
class Snapshot:
    """Every gate, as published: {name: {seed, default, populations: [{match, mix: [{variant, pct}]}], overrides}}."""

    version: int = 0
    gates: dict[str, dict] = field(default_factory=dict)


snapshot = Snapshot()


def bucket(seed: str, user_id: str) -> int:
    """0..9999, the same on every server."""
    digest = hashlib.sha256(f"{seed}:{user_id}".encode()).hexdigest()
    return int(digest[:8], 16) % BUCKETS


def pick(mix: list[dict], b: int) -> str:
    """The share whose cumulative edge is the first above the bucket."""
    edge = 0
    for share in mix:
        edge += share["pct"] * (BUCKETS // 100)
        if b < edge:
            return share["variant"]
    return mix[-1]["variant"]


def get_variant(name: str, attrs: dict) -> str:
    """No I/O: unknown gate → OFF; unexpired override → its variant; first matching population → pick; else default."""
    gate = snapshot.gates.get(name)
    if gate is None:
        return OFF
    now = time.time()
    for override in gate.get("overrides", []):
        if override["user_id"] == attrs["user_id"] and override["expires_at"] > now:
            return override["variant"]
    for population in gate["populations"]:
        if all(attrs.get(key) == value for key, value in population["match"].items()):
            return pick(population["mix"], bucket(gate["seed"], attrs["user_id"]))
    return gate.get("default", OFF)


def refresh() -> bool:
    """GET gates:version; unchanged → False. Otherwise HGETALL gates, parse, replace the snapshot in one assignment."""
    global snapshot
    version = int(r.get("gates:version") or 0)
    if version == snapshot.version:
        return False
    gates = {name: json.loads(raw) for name, raw in r.hgetall("gates").items()}
    snapshot = Snapshot(version, gates)
    return True


def start_loader(interval_s: float = POLL_INTERVAL_S) -> threading.Thread:
    """Load once now, then refresh every interval_s in the background; a failed poll keeps the last snapshot."""
    refresh()

    def loop() -> None:
        while True:
            time.sleep(interval_s)
            try:
                refresh()
            except redis.RedisError:
                pass  # serve the snapshot we have

    thread = threading.Thread(target=loop, name="gates-loader", daemon=True)
    thread.start()
    return thread
`,
    },
    typescript: {
      starter: `/** Feature gates on every app server: the config snapshot, its loader, and the pure decision over it. */
import {createHash} from 'node:crypto';
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const BUCKETS = 10_000;
export const POLL_INTERVAL_S = 10;
export const OFF = 'OFF';

export interface Share {
  variant: string;
  pct: number;
}
export interface Population {
  match: Record<string, string>;
  mix: Share[];
}
export interface Override {
  user_id: string;
  variant: string;
  expires_at: number;
}
/** A gate as step 1 publishes it. */
export interface Gate {
  name: string;
  seed: string;
  default: string;
  populations: Population[];
  overrides: Override[];
  version: number;
}
export interface Snapshot {
  version: number;
  gates: Map<string, Gate>;
}
export type Attrs = Record<string, string> & {user_id: string};

export let snapshot: Snapshot = {version: 0, gates: new Map()};

/** 0..9999, the same on every server. */
export function bucket(seed: string, userId: string): number {
  // TODO: parseInt(sha256(\`\${seed}:\${userId}\`).hex.slice(0, 8), 16) % BUCKETS
  throw new Error('not implemented');
}

/** The share whose cumulative edge is the first above the bucket. */
export function pick(mix: Share[], b: number): string {
  // TODO: walk mix in order; each share owns pct * (BUCKETS / 100) buckets
  throw new Error('not implemented');
}

/** No I/O: unknown gate → OFF; unexpired override → its variant; first matching population → pick; else default. */
export function getVariant(name: string, attrs: Attrs): string {
  // TODO
  throw new Error('not implemented');
}

/** GET gates:version; unchanged → false. Otherwise HGETALL gates, parse, replace the snapshot in one assignment. */
export async function refresh(): Promise<boolean> {
  // TODO
  throw new Error('not implemented');
}

let loader: ReturnType<typeof setInterval> | null = null;

/** Load once now, then refresh every intervalS in the background; a failed poll keeps the last snapshot. */
export async function startLoader(intervalS = POLL_INTERVAL_S): Promise<void> {
  await refresh();
  loader = setInterval(() => void refresh().catch(() => undefined), intervalS * 1000);
}

export function stopLoader(): void {
  if (loader !== null) clearInterval(loader);
  loader = null;
}
`,
      solution: `/** Feature gates on every app server: the config snapshot, its loader, and the pure decision over it. */
import {createHash} from 'node:crypto';
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const BUCKETS = 10_000;
export const POLL_INTERVAL_S = 10;
export const OFF = 'OFF';

export interface Share {
  variant: string;
  pct: number;
}
export interface Population {
  match: Record<string, string>;
  mix: Share[];
}
export interface Override {
  user_id: string;
  variant: string;
  expires_at: number;
}
/** A gate as step 1 publishes it. */
export interface Gate {
  name: string;
  seed: string;
  default: string;
  populations: Population[];
  overrides: Override[];
  version: number;
}
export interface Snapshot {
  version: number;
  gates: Map<string, Gate>;
}
export type Attrs = Record<string, string> & {user_id: string};

export let snapshot: Snapshot = {version: 0, gates: new Map()};

/** 0..9999, the same on every server. */
export function bucket(seed: string, userId: string): number {
  const hex = createHash('sha256').update(\`\${seed}:\${userId}\`).digest('hex').slice(0, 8);
  return parseInt(hex, 16) % BUCKETS;
}

/** The share whose cumulative edge is the first above the bucket. */
export function pick(mix: Share[], b: number): string {
  let edge = 0;
  for (const share of mix) {
    edge += share.pct * (BUCKETS / 100);
    if (b < edge) return share.variant;
  }
  return mix[mix.length - 1].variant;
}

/** No I/O: unknown gate → OFF; unexpired override → its variant; first matching population → pick; else default. */
export function getVariant(name: string, attrs: Attrs): string {
  const gate = snapshot.gates.get(name);
  if (gate === undefined) return OFF;
  const now = Date.now() / 1000;
  const override = (gate.overrides ?? []).find(o => o.user_id === attrs.user_id && o.expires_at > now);
  if (override !== undefined) return override.variant;
  for (const population of gate.populations) {
    if (Object.entries(population.match).every(([key, value]) => attrs[key] === value)) {
      return pick(population.mix, bucket(gate.seed, attrs.user_id));
    }
  }
  return gate.default;
}

/** GET gates:version; unchanged → false. Otherwise HGETALL gates, parse, replace the snapshot in one assignment. */
export async function refresh(): Promise<boolean> {
  const version = Number((await redis.get('gates:version')) ?? 0);
  if (version === snapshot.version) return false;
  const gates = new Map<string, Gate>();
  for (const [name, raw] of Object.entries(await redis.hgetall('gates'))) gates.set(name, JSON.parse(raw) as Gate);
  snapshot = {version, gates};
  return true;
}

let loader: ReturnType<typeof setInterval> | null = null;

/** Load once now, then refresh every intervalS in the background; a failed poll keeps the last snapshot. */
export async function startLoader(intervalS = POLL_INTERVAL_S): Promise<void> {
  await refresh();
  loader = setInterval(() => void refresh().catch(() => undefined), intervalS * 1000);
}

export function stopLoader(): void {
  if (loader !== null) clearInterval(loader);
  loader = null;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	buckets      = 10_000
	pollInterval = 10 * time.Second
	off          = "OFF"
)

type Share struct {
	Variant string \`json:"variant"\`
	Pct     int    \`json:"pct"\`
}

type Population struct {
	Match map[string]string \`json:"match"\`
	Mix   []Share           \`json:"mix"\`
}

type Override struct {
	UserID    string \`json:"user_id"\`
	Variant   string \`json:"variant"\`
	ExpiresAt int64  \`json:"expires_at"\`
}

// Gate is a gate as step 1 publishes it.
type Gate struct {
	Name        string       \`json:"name"\`
	Seed        string       \`json:"seed"\`
	Default     string       \`json:"default"\`
	Populations []Population \`json:"populations"\`
	Overrides   []Override   \`json:"overrides"\`
	Version     int          \`json:"version"\`
}

type Snapshot struct {
	Version int
	Gates   map[string]Gate
}

// snapshotBox holds the live snapshot; Store replaces it whole, so readers never see a half-loaded map.
type snapshotBox struct{ v atomic.Value }

func (b *snapshotBox) Load() *Snapshot   { return b.v.Load().(*Snapshot) }
func (b *snapshotBox) Store(s *Snapshot) { b.v.Store(s) }

var snapshot snapshotBox

func init() { snapshot.Store(&Snapshot{Gates: map[string]Gate{}}) }

// bucket is 0..9999, the same on every server.
func bucket(seed, userID string) int {
	// TODO: first 4 bytes of sha256("seed:userID") as a big-endian uint32, % buckets
	panic("not implemented")
}

// pick returns the share whose cumulative edge is the first above the bucket.
func pick(mix []Share, b int) string {
	// TODO: walk mix in order; each share owns pct * (buckets / 100) buckets
	panic("not implemented")
}

// getVariant does no I/O: unknown gate → OFF; unexpired override → its variant; first matching population → pick; else default.
func getVariant(name string, attrs map[string]string) string {
	// TODO
	panic("not implemented")
}

// refresh GETs gates:version; unchanged → false. Otherwise HGETALL gates, parse, replace the snapshot in one store.
func refresh(ctx context.Context) (bool, error) {
	// TODO
	panic("not implemented")
}

// startLoader loads once now, then refreshes every interval in the background; a failed poll keeps the last snapshot.
func startLoader(ctx context.Context, interval time.Duration) error {
	if _, err := refresh(ctx); err != nil {
		return fmt.Errorf("initial load: %w", err)
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_, _ = refresh(ctx) // serve the snapshot we have
			}
		}
	}()
	return nil
}

func main() {
	ctx := context.Background()
	if err := startLoader(ctx, pollInterval); err != nil {
		panic(err)
	}
	_ = json.Marshal
	_ = binary.BigEndian
	_ = sha256.Sum256
	select {}
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	buckets      = 10_000
	pollInterval = 10 * time.Second
	off          = "OFF"
)

type Share struct {
	Variant string \`json:"variant"\`
	Pct     int    \`json:"pct"\`
}

type Population struct {
	Match map[string]string \`json:"match"\`
	Mix   []Share           \`json:"mix"\`
}

type Override struct {
	UserID    string \`json:"user_id"\`
	Variant   string \`json:"variant"\`
	ExpiresAt int64  \`json:"expires_at"\`
}

// Gate is a gate as step 1 publishes it.
type Gate struct {
	Name        string       \`json:"name"\`
	Seed        string       \`json:"seed"\`
	Default     string       \`json:"default"\`
	Populations []Population \`json:"populations"\`
	Overrides   []Override   \`json:"overrides"\`
	Version     int          \`json:"version"\`
}

type Snapshot struct {
	Version int
	Gates   map[string]Gate
}

// snapshotBox holds the live snapshot; Store replaces it whole, so readers never see a half-loaded map.
type snapshotBox struct{ v atomic.Value }

func (b *snapshotBox) Load() *Snapshot   { return b.v.Load().(*Snapshot) }
func (b *snapshotBox) Store(s *Snapshot) { b.v.Store(s) }

var snapshot snapshotBox

func init() { snapshot.Store(&Snapshot{Gates: map[string]Gate{}}) }

// bucket is 0..9999, the same on every server.
func bucket(seed, userID string) int {
	sum := sha256.Sum256([]byte(seed + ":" + userID))
	return int(binary.BigEndian.Uint32(sum[:4]) % buckets)
}

// pick returns the share whose cumulative edge is the first above the bucket.
func pick(mix []Share, b int) string {
	edge := 0
	for _, share := range mix {
		edge += share.Pct * (buckets / 100)
		if b < edge {
			return share.Variant
		}
	}
	return mix[len(mix)-1].Variant
}

// getVariant does no I/O: unknown gate → OFF; unexpired override → its variant; first matching population → pick; else default.
func getVariant(name string, attrs map[string]string) string {
	gate, ok := snapshot.Load().Gates[name]
	if !ok {
		return off
	}
	now := time.Now().Unix()
	for _, override := range gate.Overrides {
		if override.UserID == attrs["user_id"] && override.ExpiresAt > now {
			return override.Variant
		}
	}
	for _, population := range gate.Populations {
		if matches(population.Match, attrs) {
			return pick(population.Mix, bucket(gate.Seed, attrs["user_id"]))
		}
	}
	return gate.Default
}

func matches(match, attrs map[string]string) bool {
	for key, value := range match {
		if attrs[key] != value {
			return false
		}
	}
	return true
}

// refresh GETs gates:version; unchanged → false. Otherwise HGETALL gates, parse, replace the snapshot in one store.
func refresh(ctx context.Context) (bool, error) {
	raw, err := rdb.Get(ctx, "gates:version").Result()
	if err != nil && err != redis.Nil {
		return false, err
	}
	version, _ := strconv.Atoi(raw)
	current := snapshot.Load()
	if version == current.Version {
		return false, nil
	}
	fields, err := rdb.HGetAll(ctx, "gates").Result()
	if err != nil {
		return false, err
	}
	gates := make(map[string]Gate, len(fields))
	for name, body := range fields {
		var gate Gate
		if err := json.Unmarshal([]byte(body), &gate); err != nil {
			return false, fmt.Errorf("gate %s: %w", name, err)
		}
		gates[name] = gate
	}
	snapshot.Store(&Snapshot{Version: version, Gates: gates})
	return true, nil
}

// startLoader loads once now, then refreshes every interval in the background; a failed poll keeps the last snapshot.
func startLoader(ctx context.Context, interval time.Duration) error {
	if _, err := refresh(ctx); err != nil {
		return fmt.Errorf("initial load: %w", err)
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_, _ = refresh(ctx) // serve the snapshot we have
			}
		}
	}()
	return nil
}

func main() {
	ctx := context.Background()
	if err := startLoader(ctx, pollInterval); err != nil {
		panic(err)
	}
	select {}
}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest

import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

/** Feature gates on every app server: the config snapshot, its loader, and the pure decision over it. */
object Gates {
  val jedis = new JedisPooled("redis", 6379)
  val Buckets = 10000
  val PollIntervalSeconds = 10
  val Off = "OFF"

  case class Share(variant: String, pct: Int)
  case class Population(\`match\`: Map[String, String], mix: List[Share])
  case class Override(userId: String, variant: String, expiresAt: Long)
  /** A gate as step 1 publishes it. */
  case class Gate(name: String, seed: String, default: String, populations: List[Population], overrides: List[Override], version: Int)
  case class Snapshot(version: Int, gates: Map[String, Gate])

  implicit val shareFormat: RootJsonFormat[Share] = jsonFormat2(Share)
  implicit val populationFormat: RootJsonFormat[Population] = jsonFormat2(Population)
  implicit val overrideFormat: RootJsonFormat[Override] = jsonFormat(Override, "user_id", "variant", "expires_at")
  implicit val gateFormat: RootJsonFormat[Gate] = jsonFormat6(Gate)

  @volatile var snapshot: Snapshot = Snapshot(0, Map.empty)

  /** 0..9999, the same on every server. */
  def bucket(seed: String, userId: String): Int = {
    ??? // TODO: first 8 hex digits of SHA-256 of s"$seed:$userId" as a Long, % Buckets
  }

  /** The share whose cumulative edge is the first above the bucket. */
  def pick(mix: List[Share], b: Int): String = {
    ??? // TODO: walk mix in order; each share owns pct * (Buckets / 100) buckets
  }

  /** No I/O: unknown gate → OFF; unexpired override → its variant; first matching population → pick; else default. */
  def getVariant(name: String, attrs: Map[String, String]): String = {
    ??? // TODO
  }

  /** GET gates:version; unchanged → false. Otherwise HGETALL gates, parse, replace the snapshot in one assignment. */
  def refresh(): Boolean = {
    ??? // TODO
  }

  /** Load once now, then refresh every intervalSeconds in the background; a failed poll keeps the last snapshot. */
  def startLoader(intervalSeconds: Int = PollIntervalSeconds): Thread = {
    refresh()
    val loader = new Thread(() => {
      while (true) {
        Thread.sleep(intervalSeconds * 1000L)
        try refresh()
        catch { case _: Exception => () } // serve the snapshot we have
      }
    }, "gates-loader")
    loader.setDaemon(true)
    loader.start()
    loader
  }

  def main(args: Array[String]): Unit = {
    startLoader()
    Thread.currentThread().join()
  }
}
`,
      solution: `import java.security.MessageDigest

import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

/** Feature gates on every app server: the config snapshot, its loader, and the pure decision over it. */
object Gates {
  val jedis = new JedisPooled("redis", 6379)
  val Buckets = 10000
  val PollIntervalSeconds = 10
  val Off = "OFF"

  case class Share(variant: String, pct: Int)
  case class Population(\`match\`: Map[String, String], mix: List[Share])
  case class Override(userId: String, variant: String, expiresAt: Long)
  /** A gate as step 1 publishes it. */
  case class Gate(name: String, seed: String, default: String, populations: List[Population], overrides: List[Override], version: Int)
  case class Snapshot(version: Int, gates: Map[String, Gate])

  implicit val shareFormat: RootJsonFormat[Share] = jsonFormat2(Share)
  implicit val populationFormat: RootJsonFormat[Population] = jsonFormat2(Population)
  implicit val overrideFormat: RootJsonFormat[Override] = jsonFormat(Override, "user_id", "variant", "expires_at")
  implicit val gateFormat: RootJsonFormat[Gate] = jsonFormat6(Gate)

  @volatile var snapshot: Snapshot = Snapshot(0, Map.empty)

  /** 0..9999, the same on every server. */
  def bucket(seed: String, userId: String): Int = {
    val digest = MessageDigest.getInstance("SHA-256").digest(s"$seed:$userId".getBytes("UTF-8"))
    val hex = digest.take(4).map("%02x".format(_)).mkString
    (java.lang.Long.parseLong(hex, 16) % Buckets).toInt
  }

  /** The share whose cumulative edge is the first above the bucket. */
  def pick(mix: List[Share], b: Int): String = {
    var edge = 0
    for (share <- mix) {
      edge += share.pct * (Buckets / 100)
      if (b < edge) return share.variant
    }
    mix.last.variant
  }

  /** No I/O: unknown gate → OFF; unexpired override → its variant; first matching population → pick; else default. */
  def getVariant(name: String, attrs: Map[String, String]): String =
    snapshot.gates.get(name) match {
      case None => Off
      case Some(gate) =>
        val now = System.currentTimeMillis() / 1000
        val userId = attrs.getOrElse("user_id", "")
        gate.overrides.find(o => o.userId == userId && o.expiresAt > now) match {
          case Some(override) => override.variant
          case None =>
            gate.populations
              .find(p => p.\`match\`.forall { case (key, value) => attrs.get(key).contains(value) })
              .map(p => pick(p.mix, bucket(gate.seed, userId)))
              .getOrElse(gate.default)
        }
    }

  /** GET gates:version; unchanged → false. Otherwise HGETALL gates, parse, replace the snapshot in one assignment. */
  def refresh(): Boolean = {
    val version = Option(jedis.get("gates:version")).map(_.toInt).getOrElse(0)
    if (version == snapshot.version) return false
    val gates = jedis.hgetAll("gates").asScala.map { case (name, raw) => name -> raw.parseJson.convertTo[Gate] }.toMap
    snapshot = Snapshot(version, gates)
    true
  }

  /** Load once now, then refresh every intervalSeconds in the background; a failed poll keeps the last snapshot. */
  def startLoader(intervalSeconds: Int = PollIntervalSeconds): Thread = {
    refresh()
    val loader = new Thread(() => {
      while (true) {
        Thread.sleep(intervalSeconds * 1000L)
        try refresh()
        catch { case _: Exception => () } // serve the snapshot we have
      }
    }, "gates-loader")
    loader.setDaemon(true)
    loader.start()
    loader
  }

  def main(args: Array[String]): Unit = {
    startLoader()
    Thread.currentThread().join()
  }
}
`,
    },
    cpp: {
      starter: `// Feature gates on every app server: the config snapshot, its loader, and the pure decision over it.
#include <sw/redis++/redis++.h>

#include <atomic>
#include <chrono>
#include <ctime>
#include <map>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

#include "sha256.h"  // std::string sha256_hex(const std::string&)

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr int kBuckets = 10000;
constexpr std::chrono::seconds kPollInterval{10};
const std::string kOff = "OFF";

struct Share {
  std::string variant;
  int pct;
};

struct Population {
  std::map<std::string, std::string> match;
  std::vector<Share> mix;
};

struct Override {
  std::string user_id;
  std::string variant;
  long long expires_at;
};

// A gate as step 1 publishes it.
struct Gate {
  std::string name;
  std::string seed;
  std::string default_variant;
  std::vector<Population> populations;
  std::vector<Override> overrides;
  int version;
};

struct Snapshot {
  int version = 0;
  std::map<std::string, Gate> gates;
};

// Replaced whole: readers never see a half-loaded map.
std::shared_ptr<const Snapshot> snapshot = std::make_shared<const Snapshot>();

Gate parse_gate(const json& j);  // provided below

// 0..9999, the same on every server.
int bucket(const std::string& seed, const std::string& user_id) {
  // TODO: first 8 hex digits of sha256_hex(seed + ":" + user_id) as an integer, % kBuckets
  throw std::logic_error("not implemented");
}

// The share whose cumulative edge is the first above the bucket.
std::string pick(const std::vector<Share>& mix, int b) {
  // TODO: walk mix in order; each share owns pct * (kBuckets / 100) buckets
  throw std::logic_error("not implemented");
}

// No I/O: unknown gate → OFF; unexpired override → its variant; first matching population → pick; else default.
std::string get_variant(const std::string& name, const std::map<std::string, std::string>& attrs) {
  // TODO
  throw std::logic_error("not implemented");
}

// GET gates:version; unchanged → false. Otherwise HGETALL gates, parse, replace the snapshot in one store.
bool refresh() {
  // TODO
  throw std::logic_error("not implemented");
}

Gate parse_gate(const json& j) {
  Gate gate;
  gate.name = j.at("name");
  gate.seed = j.at("seed");
  gate.default_variant = j.value("default", kOff);
  gate.version = j.value("version", 0);
  for (const auto& p : j.at("populations")) {
    Population population;
    for (auto it = p.at("match").begin(); it != p.at("match").end(); ++it) population.match[it.key()] = it.value();
    for (const auto& s : p.at("mix")) population.mix.push_back({s.at("variant"), s.at("pct")});
    gate.populations.push_back(population);
  }
  for (const auto& o : j.value("overrides", json::array())) {
    gate.overrides.push_back({o.at("user_id"), o.at("variant"), o.at("expires_at")});
  }
  return gate;
}

// Load once now, then refresh every interval in the background; a failed poll keeps the last snapshot.
void start_loader(std::chrono::seconds interval = kPollInterval) {
  refresh();
  std::thread([interval] {
    for (;;) {
      std::this_thread::sleep_for(interval);
      try {
        refresh();
      } catch (const sw::redis::Error&) {
        // serve the snapshot we have
      }
    }
  }).detach();
}

int main() {
  start_loader();
  std::this_thread::sleep_for(std::chrono::hours(24 * 365));
}
`,
      solution: `// Feature gates on every app server: the config snapshot, its loader, and the pure decision over it.
#include <sw/redis++/redis++.h>

#include <atomic>
#include <chrono>
#include <ctime>
#include <map>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

#include "sha256.h"  // std::string sha256_hex(const std::string&)

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr int kBuckets = 10000;
constexpr std::chrono::seconds kPollInterval{10};
const std::string kOff = "OFF";

struct Share {
  std::string variant;
  int pct;
};

struct Population {
  std::map<std::string, std::string> match;
  std::vector<Share> mix;
};

struct Override {
  std::string user_id;
  std::string variant;
  long long expires_at;
};

// A gate as step 1 publishes it.
struct Gate {
  std::string name;
  std::string seed;
  std::string default_variant;
  std::vector<Population> populations;
  std::vector<Override> overrides;
  int version;
};

struct Snapshot {
  int version = 0;
  std::map<std::string, Gate> gates;
};

// Replaced whole: readers never see a half-loaded map.
std::shared_ptr<const Snapshot> snapshot = std::make_shared<const Snapshot>();

Gate parse_gate(const json& j);  // provided below

// 0..9999, the same on every server.
int bucket(const std::string& seed, const std::string& user_id) {
  const std::string hex = sha256_hex(seed + ":" + user_id).substr(0, 8);
  return static_cast<int>(std::stoul(hex, nullptr, 16) % kBuckets);
}

// The share whose cumulative edge is the first above the bucket.
std::string pick(const std::vector<Share>& mix, int b) {
  int edge = 0;
  for (const auto& share : mix) {
    edge += share.pct * (kBuckets / 100);
    if (b < edge) return share.variant;
  }
  return mix.back().variant;
}

// No I/O: unknown gate → OFF; unexpired override → its variant; first matching population → pick; else default.
std::string get_variant(const std::string& name, const std::map<std::string, std::string>& attrs) {
  const auto current = std::atomic_load(&snapshot);
  const auto found = current->gates.find(name);
  if (found == current->gates.end()) return kOff;
  const Gate& gate = found->second;
  const auto user = attrs.find("user_id");
  const std::string user_id = user == attrs.end() ? "" : user->second;
  const long long now = std::time(nullptr);
  for (const auto& override_ : gate.overrides) {
    if (override_.user_id == user_id && override_.expires_at > now) return override_.variant;
  }
  for (const auto& population : gate.populations) {
    bool all = true;
    for (const auto& [key, value] : population.match) {
      const auto attr = attrs.find(key);
      if (attr == attrs.end() || attr->second != value) {
        all = false;
        break;
      }
    }
    if (all) return pick(population.mix, bucket(gate.seed, user_id));
  }
  return gate.default_variant;
}

// GET gates:version; unchanged → false. Otherwise HGETALL gates, parse, replace the snapshot in one store.
bool refresh() {
  const auto raw = redis.get("gates:version");
  const int version = raw ? std::stoi(*raw) : 0;
  const auto current = std::atomic_load(&snapshot);
  if (version == current->version) return false;
  std::map<std::string, std::string> fields;
  redis.hgetall("gates", std::inserter(fields, fields.begin()));
  auto next = std::make_shared<Snapshot>();
  next->version = version;
  for (const auto& [name, body] : fields) next->gates[name] = parse_gate(json::parse(body));
  std::atomic_store(&snapshot, std::shared_ptr<const Snapshot>(next));
  return true;
}

Gate parse_gate(const json& j) {
  Gate gate;
  gate.name = j.at("name");
  gate.seed = j.at("seed");
  gate.default_variant = j.value("default", kOff);
  gate.version = j.value("version", 0);
  for (const auto& p : j.at("populations")) {
    Population population;
    for (auto it = p.at("match").begin(); it != p.at("match").end(); ++it) population.match[it.key()] = it.value();
    for (const auto& s : p.at("mix")) population.mix.push_back({s.at("variant"), s.at("pct")});
    gate.populations.push_back(population);
  }
  for (const auto& o : j.value("overrides", json::array())) {
    gate.overrides.push_back({o.at("user_id"), o.at("variant"), o.at("expires_at")});
  }
  return gate;
}

// Load once now, then refresh every interval in the background; a failed poll keeps the last snapshot.
void start_loader(std::chrono::seconds interval = kPollInterval) {
  refresh();
  std::thread([interval] {
    for (;;) {
      std::this_thread::sleep_for(interval);
      try {
        refresh();
      } catch (const sw::redis::Error&) {
        // serve the snapshot we have
      }
    }
  }).detach();
}

int main() {
  start_loader();
  std::this_thread::sleep_for(std::chrono::hours(24 * 365));
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json
import time

MIX = [{"variant": "RED_BUTTON", "pct": 33}, {"variant": "BLUE_BUTTON", "pct": 33}, {"variant": "CONTROL", "pct": 34}]


def gate(name, populations, seed=None, default="OFF", overrides=(), version=1):
    return {"name": name, "seed": seed or name, "default": default, "populations": populations, "overrides": list(overrides), "version": version}


def publish(ctx, gates, version):
    """What step 1 leaves behind: one field per gate in the hash, and the global version."""
    for g in gates:
        ctx.redis.hset("gates", g["name"], json.dumps(g))
    ctx.redis.set("gates:version", version)


def expected(seed, user_id, mix):
    """The spec, computed independently of the learner: sha256(seed:user)[:8] % 10000, cumulative edges."""
    b = int(hashlib.sha256(f"{seed}:{user_id}".encode()).hexdigest()[:8], 16) % 10000
    edge = 0
    for share in mix:
        edge += share["pct"] * 100
        if b < edge:
            return share["variant"]
    return mix[-1]["variant"]


def counting(ctx):
    """Every command any client in the runtime sends, by name — the learner's clients share ctx.redis's class."""
    calls = []
    cls = ctx.redis.__class__
    real = cls.execute_command

    def record(self, *args, **kw):
        calls.append(str(args[0]).upper())
        return real(self, *args, **kw)

    cls.execute_command = record
    return calls, lambda: setattr(cls, "execute_command", real)


def check_stateless_hash(ctx):
    publish(ctx, [gate("button_color", [{"match": {}, "mix": MIX}]), gate("button_copy", [{"match": {}, "mix": MIX}], seed="button_color"), gate("other", [{"match": {}, "mix": MIX}], seed="s2")], 1)
    m = ctx.load("gates")
    m.refresh()
    users = [f"u{i}" for i in range(40)]
    for u in users:
        want = expected("button_color", u, MIX)
        got = m.get_variant("button_color", {"user_id": u})
        assert got == want, f"get_variant('button_color', {u}) is {got!r}, expected {want!r}: bucket = int(sha256('button_color:{u}')[:8], 16) % 10000, then cumulative edges 3300 / 6600 / 10000"
    again = [m.get_variant("button_color", {"user_id": u}) for u in users]
    assert again == [expected("button_color", u, MIX) for u in users], "the same user must get the same variant on every call: the assignment is a hash, not a coin toss"
    shared = [m.get_variant("button_copy", {"user_id": u}) for u in users]
    assert shared == again, "two gates with the same seed must assign every user the same way (that is what a shared seed is for)"
    other = [m.get_variant("other", {"user_id": u}) for u in users]
    assert other != again, "a different seed must shuffle the assignment; 'other' (seed s2) assigned every user exactly like button_color"
    fresh = ctx.reload("gates")
    fresh.refresh()
    assert [fresh.get_variant("button_color", {"user_id": u}) for u in users] == again, "a second server loading the same snapshot must assign identically: nothing may be stored per user"


def check_fall_through(ctx):
    populations = [
        {"match": {"locale": "de"}, "mix": [{"variant": "RED_BUTTON", "pct": 100}]},
        {"match": {"plan": "pro"}, "mix": [{"variant": "BLUE_BUTTON", "pct": 100}]},
        {"match": {}, "mix": [{"variant": "CONTROL", "pct": 100}]},
    ]
    publish(ctx, [gate("button_color", populations), gate("narrow", populations[:2], default="FALLBACK")], 1)
    m = ctx.load("gates")
    m.refresh()
    assert m.get_variant("button_color", {"user_id": "ana", "locale": "de", "plan": "pro"}) == "RED_BUTTON", "a German pro user matches the first population (locale de) — the first match decides, not the most specific or the last"
    assert m.get_variant("button_color", {"user_id": "bo", "locale": "en", "plan": "pro"}) == "BLUE_BUTTON", "an English pro user falls through to the second population (plan pro)"
    assert m.get_variant("button_color", {"user_id": "cy", "locale": "en", "plan": "free"}) == "CONTROL", "a user matching nothing specific lands in the catch-all population ({} matches everyone)"
    assert m.get_variant("button_color", {"user_id": "dee"}) == "CONTROL", "a missing attribute does not match a rule on it; the user still reaches the catch-all"
    assert m.get_variant("narrow", {"user_id": "cy", "locale": "en", "plan": "free"}) == "FALLBACK", "when no population matches, the gate's own default is the answer"
    assert m.get_variant("ghost", {"user_id": "cy"}) == "OFF", "a gate the snapshot does not know answers OFF — a client on a newer build must not crash the server"


def check_monotone_rollout(ctx):
    users = [f"user-{i}" for i in range(2000)]
    publish(ctx, [gate("new_sidebar", [{"match": {}, "mix": [{"variant": "ON", "pct": 10}, {"variant": "OFF", "pct": 90}]}])], 1)
    m = ctx.load("gates")
    m.refresh()
    first = {u for u in users if m.get_variant("new_sidebar", {"user_id": u}) == "ON"}
    assert 140 <= len(first) <= 260, f"a 10% share should hold about 200 of 2000 users, it holds {len(first)}"
    publish(ctx, [gate("new_sidebar", [{"match": {}, "mix": [{"variant": "ON", "pct": 20}, {"variant": "OFF", "pct": 80}]}], version=2)], 2)
    assert m.refresh(), "a bumped gates:version must make refresh() load the new config"
    second = {u for u in users if m.get_variant("new_sidebar", {"user_id": u}) == "ON"}
    lost = first - second
    assert not lost, f"raising ON from 10% to 20% must keep everyone who already had it, but {len(lost)} users (e.g. {sorted(lost)[:3]}) fell back to OFF: shares are cumulative edges in mix order, not independent draws"
    assert 320 <= len(second) <= 480, f"a 20% share should hold about 400 of 2000 users, it holds {len(second)}"
    publish(ctx, [gate("new_sidebar", [{"match": {}, "mix": [{"variant": "ON", "pct": 10}, {"variant": "OFF", "pct": 90}]}], version=3)], 3)
    m.refresh()
    third = {u for u in users if m.get_variant("new_sidebar", {"user_id": u}) == "ON"}
    assert third == first, "rolling back to 10% must return exactly the original set of users"


def check_snapshot(ctx):
    m = ctx.load("gates")
    assert m.get_variant("button_color", {"user_id": "ana"}) == "OFF", "before the first refresh the snapshot is empty and every gate is OFF"
    publish(ctx, [gate("button_color", [{"match": {}, "mix": MIX}])], 7)
    calls, restore = counting(ctx)
    try:
        assert m.refresh() is True, "the first refresh after a publish must report a change"
        assert "HGETALL" in calls, f"a changed version must be followed by HGETALL gates; the refresh sent {calls}"
        assert m.snapshot.version == 7, f"the snapshot must carry the version it loaded (7), it says {m.snapshot.version}"
        del calls[:]
        assert m.refresh() is False, "an unchanged version must report no change"
        assert calls == ["GET"], f"an unchanged version costs exactly one GET gates:version, the refresh sent {calls}"
        del calls[:]
        for i in range(500):
            m.get_variant("button_color", {"user_id": f"u{i}"})
        assert calls == [], f"get_variant must not touch Redis: 500 decisions sent {len(calls)} commands ({sorted(set(calls))}); evaluate the in-memory snapshot"
    finally:
        restore()
    publish(ctx, [gate("button_color", [{"match": {}, "mix": MIX}]), gate("dark_mode", [{"match": {}, "mix": [{"variant": "ON", "pct": 100}]}])], 8)
    assert m.get_variant("dark_mode", {"user_id": "ana"}) == "OFF", "a gate published after the last refresh is not visible yet: the snapshot only moves when the loader runs"
    assert m.refresh() is True
    assert m.get_variant("dark_mode", {"user_id": "ana"}) == "ON", "after the refresh the new gate is live"
    assert m.snapshot.version == 8


def check_overrides(ctx):
    now = int(time.time())
    overrides = [
        {"user_id": "tomm", "variant": "RED_BUTTON", "expires_at": now + 3600},
        {"user_id": "old", "variant": "RED_BUTTON", "expires_at": now - 1},
    ]
    publish(ctx, [gate("button_color", [{"match": {"locale": "de"}, "mix": [{"variant": "CONTROL", "pct": 100}]}], overrides=overrides)], 1)
    m = ctx.load("gates")
    m.refresh()
    assert m.get_variant("button_color", {"user_id": "tomm", "locale": "de"}) == "RED_BUTTON", "an unexpired override must win over the population the user matches"
    assert m.get_variant("button_color", {"user_id": "tomm", "locale": "en"}) == "RED_BUTTON", "an override applies even when the user matches no population at all — that is how a Dropboxer tests a gate aimed at someone else"
    assert m.get_variant("button_color", {"user_id": "old", "locale": "de"}) == "CONTROL", "an expired override must be ignored"
    ctx.clock.advance(3601)
    assert m.get_variant("button_color", {"user_id": "tomm", "locale": "de"}) == "CONTROL", "once its expires_at has passed, the override stops applying without any reload"
`,
    typescript: `import {createHash} from 'node:crypto';

const MIX = [
  {variant: 'RED_BUTTON', pct: 33},
  {variant: 'BLUE_BUTTON', pct: 33},
  {variant: 'CONTROL', pct: 34},
];

type Share = {variant: string; pct: number};
type Population = {match: Record<string, string>; mix: Share[]};

function gate(
  name: string,
  populations: Population[],
  options: {seed?: string; default?: string; overrides?: unknown[]; version?: number} = {},
) {
  return {
    name,
    seed: options.seed ?? name,
    default: options.default ?? 'OFF',
    populations,
    overrides: options.overrides ?? [],
    version: options.version ?? 1,
  };
}

/** What step 1 leaves behind: one field per gate in the hash, and the global version. */
function publish(ctx, gates: ReturnType<typeof gate>[], version: number) {
  for (const g of gates) ctx.redis.hset('gates', g.name, JSON.stringify(g));
  ctx.redis.set('gates:version', version);
}

/** The spec, computed independently of the learner: sha256(seed:user)[:8] % 10000, cumulative edges. */
function expected(seed: string, userId: string, mix: Share[]): string {
  const b = parseInt(createHash('sha256').update(\`\${seed}:\${userId}\`).digest('hex').slice(0, 8), 16) % 10000;
  let edge = 0;
  for (const share of mix) {
    edge += share.pct * 100;
    if (b < edge) return share.variant;
  }
  return mix[mix.length - 1].variant;
}

const users = (n: number, prefix = 'u') => Array.from({length: n}, (_, i) => \`\${prefix}\${i}\`);

export async function check_stateless_hash(ctx) {
  publish(
    ctx,
    [
      gate('button_color', [{match: {}, mix: MIX}]),
      gate('button_copy', [{match: {}, mix: MIX}], {seed: 'button_color'}),
      gate('other', [{match: {}, mix: MIX}], {seed: 's2'}),
    ],
    1,
  );
  const m = ctx.load('gates');
  await m.refresh();
  const ids = users(40);
  for (const u of ids) {
    const want = expected('button_color', u, MIX);
    const got = m.getVariant('button_color', {user_id: u});
    assert.equal(got, want, \`getVariant('button_color', \${u}) is \${JSON.stringify(got)}, expected \${JSON.stringify(want)}: bucket = parseInt(sha256('button_color:\${u}').slice(0, 8), 16) % 10000, then cumulative edges 3300 / 6600 / 10000\`);
  }
  const again = ids.map(u => m.getVariant('button_color', {user_id: u}));
  assert.deepEqual(again, ids.map(u => expected('button_color', u, MIX)), 'the same user must get the same variant on every call: the assignment is a hash, not a coin toss');
  const shared = ids.map(u => m.getVariant('button_copy', {user_id: u}));
  assert.deepEqual(shared, again, 'two gates with the same seed must assign every user the same way (that is what a shared seed is for)');
  const other = ids.map(u => m.getVariant('other', {user_id: u}));
  assert.notDeepStrictEqual(other, again, "a different seed must shuffle the assignment; 'other' (seed s2) assigned every user exactly like button_color");
  const fresh = ctx.reload('gates');
  await fresh.refresh();
  assert.deepEqual(ids.map(u => fresh.getVariant('button_color', {user_id: u})), again, 'a second server loading the same snapshot must assign identically: nothing may be stored per user');
}

export async function check_fall_through(ctx) {
  const populations: Population[] = [
    {match: {locale: 'de'}, mix: [{variant: 'RED_BUTTON', pct: 100}]},
    {match: {plan: 'pro'}, mix: [{variant: 'BLUE_BUTTON', pct: 100}]},
    {match: {}, mix: [{variant: 'CONTROL', pct: 100}]},
  ];
  publish(ctx, [gate('button_color', populations), gate('narrow', populations.slice(0, 2), {default: 'FALLBACK'})], 1);
  const m = ctx.load('gates');
  await m.refresh();
  assert.equal(m.getVariant('button_color', {user_id: 'ana', locale: 'de', plan: 'pro'}), 'RED_BUTTON', 'a German pro user matches the first population (locale de) — the first match decides, not the most specific or the last');
  assert.equal(m.getVariant('button_color', {user_id: 'bo', locale: 'en', plan: 'pro'}), 'BLUE_BUTTON', 'an English pro user falls through to the second population (plan pro)');
  assert.equal(m.getVariant('button_color', {user_id: 'cy', locale: 'en', plan: 'free'}), 'CONTROL', 'a user matching nothing specific lands in the catch-all population ({} matches everyone)');
  assert.equal(m.getVariant('button_color', {user_id: 'dee'}), 'CONTROL', 'a missing attribute does not match a rule on it; the user still reaches the catch-all');
  assert.equal(m.getVariant('narrow', {user_id: 'cy', locale: 'en', plan: 'free'}), 'FALLBACK', "when no population matches, the gate's own default is the answer");
  assert.equal(m.getVariant('ghost', {user_id: 'cy'}), 'OFF', 'a gate the snapshot does not know answers OFF — a client on a newer build must not crash the server');
}

export async function check_monotone_rollout(ctx) {
  const ids = users(2000, 'user-');
  const mix = (on: number) => [{variant: 'ON', pct: on}, {variant: 'OFF', pct: 100 - on}];
  publish(ctx, [gate('new_sidebar', [{match: {}, mix: mix(10)}])], 1);
  const m = ctx.load('gates');
  await m.refresh();
  const first = new Set(ids.filter(u => m.getVariant('new_sidebar', {user_id: u}) === 'ON'));
  assert(140 <= first.size && first.size <= 260, \`a 10% share should hold about 200 of 2000 users, it holds \${first.size}\`);
  publish(ctx, [gate('new_sidebar', [{match: {}, mix: mix(20)}], {version: 2})], 2);
  assert.equal(await m.refresh(), true, 'a bumped gates:version must make refresh() load the new config');
  const second = new Set(ids.filter(u => m.getVariant('new_sidebar', {user_id: u}) === 'ON'));
  const lost = [...first].filter(u => !second.has(u));
  assert.equal(lost.length, 0, \`raising ON from 10% to 20% must keep everyone who already had it, but \${lost.length} users (e.g. \${lost.slice(0, 3).join(', ')}) fell back to OFF: shares are cumulative edges in mix order, not independent draws\`);
  assert(320 <= second.size && second.size <= 480, \`a 20% share should hold about 400 of 2000 users, it holds \${second.size}\`);
  publish(ctx, [gate('new_sidebar', [{match: {}, mix: mix(10)}], {version: 3})], 3);
  await m.refresh();
  const third = new Set(ids.filter(u => m.getVariant('new_sidebar', {user_id: u}) === 'ON'));
  assert.deepEqual([...third].sort(), [...first].sort(), 'rolling back to 10% must return exactly the original set of users');
}

export async function check_snapshot(ctx) {
  const m = ctx.load('gates');
  assert.equal(m.getVariant('button_color', {user_id: 'ana'}), 'OFF', 'before the first refresh the snapshot is empty and every gate is OFF');
  publish(ctx, [gate('button_color', [{match: {}, mix: MIX}])], 7);
  let before = ctx.redisRoundTrips().length;
  assert.equal(await m.refresh(), true, 'the first refresh after a publish must report a change');
  let sent = ctx.redisRoundTrips().slice(before).flat();
  assert(sent.includes('HGETALL'), \`a changed version must be followed by HGETALL gates; the refresh sent \${JSON.stringify(sent)}\`);
  assert.equal(m.snapshot.version, 7, \`the snapshot must carry the version it loaded (7), it says \${m.snapshot.version}\`);
  before = ctx.redisRoundTrips().length;
  assert.equal(await m.refresh(), false, 'an unchanged version must report no change');
  sent = ctx.redisRoundTrips().slice(before).flat();
  assert.deepEqual(sent, ['GET'], \`an unchanged version costs exactly one GET gates:version, the refresh sent \${JSON.stringify(sent)}\`);
  before = ctx.redisRoundTrips().length;
  for (let i = 0; i < 500; i++) m.getVariant('button_color', {user_id: \`u\${i}\`});
  sent = ctx.redisRoundTrips().slice(before).flat();
  assert.equal(sent.length, 0, \`getVariant must not touch Redis: 500 decisions sent \${sent.length} commands (\${JSON.stringify([...new Set(sent)])}); evaluate the in-memory snapshot\`);
  publish(ctx, [gate('button_color', [{match: {}, mix: MIX}]), gate('dark_mode', [{match: {}, mix: [{variant: 'ON', pct: 100}]}])], 8);
  assert.equal(m.getVariant('dark_mode', {user_id: 'ana'}), 'OFF', 'a gate published after the last refresh is not visible yet: the snapshot only moves when the loader runs');
  assert.equal(await m.refresh(), true);
  assert.equal(m.getVariant('dark_mode', {user_id: 'ana'}), 'ON', 'after the refresh the new gate is live');
  assert.equal(m.snapshot.version, 8);
}

export async function check_overrides(ctx) {
  const now = Math.floor(Date.now() / 1000);
  const overrides = [
    {user_id: 'tomm', variant: 'RED_BUTTON', expires_at: now + 3600},
    {user_id: 'old', variant: 'RED_BUTTON', expires_at: now - 1},
  ];
  publish(ctx, [gate('button_color', [{match: {locale: 'de'}, mix: [{variant: 'CONTROL', pct: 100}]}], {overrides})], 1);
  const m = ctx.load('gates');
  await m.refresh();
  assert.equal(m.getVariant('button_color', {user_id: 'tomm', locale: 'de'}), 'RED_BUTTON', 'an unexpired override must win over the population the user matches');
  assert.equal(m.getVariant('button_color', {user_id: 'tomm', locale: 'en'}), 'RED_BUTTON', 'an override applies even when the user matches no population at all — that is how a Dropboxer tests a gate aimed at someone else');
  assert.equal(m.getVariant('button_color', {user_id: 'old', locale: 'de'}), 'CONTROL', 'an expired override must be ignored');
  ctx.clock.advance(3601);
  assert.equal(m.getVariant('button_color', {user_id: 'tomm', locale: 'de'}), 'CONTROL', 'once its expires_at has passed, the override stops applying without any reload');
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"

	"leetbuild/harness"
)

type fixtureShare struct {
	Variant string \`json:"variant"\`
	Pct     int    \`json:"pct"\`
}

type fixturePopulation struct {
	Match map[string]string \`json:"match"\`
	Mix   []fixtureShare    \`json:"mix"\`
}

// fixtureGate is a gate as step 1 publishes it.
type fixtureGate struct {
	Name        string              \`json:"name"\`
	Seed        string              \`json:"seed"\`
	Default     string              \`json:"default"\`
	Populations []fixturePopulation \`json:"populations"\`
	Overrides   []map[string]any    \`json:"overrides"\`
	Version     int                 \`json:"version"\`
}

var threeWayMix = []fixtureShare{{"RED_BUTTON", 33}, {"BLUE_BUTTON", 33}, {"CONTROL", 34}}

// newFixtureGate has the defaults step 1 fills in: seed = name, default OFF, no overrides, version 1.
func newFixtureGate(name string, populations []fixturePopulation) fixtureGate {
	return fixtureGate{Name: name, Seed: name, Default: "OFF", Populations: populations, Overrides: []map[string]any{}, Version: 1}
}

func everyone(mix []fixtureShare) []fixturePopulation {
	return []fixturePopulation{{Match: map[string]string{}, Mix: mix}}
}

// publishGates leaves what step 1 leaves behind: one field per gate in the hash, and the global version.
func publishGates(ctx *harness.Ctx, version int, gates ...fixtureGate) {
	for _, g := range gates {
		encoded, _ := json.Marshal(g)
		ctx.Redis.Do("HSET", "gates", g.Name, string(encoded))
	}
	ctx.Redis.Set("gates:version", version)
}

// expectedVariant is the spec, computed independently of the learner: sha256(seed:user)[:8 hex] % 10000, cumulative edges.
func expectedVariant(seed, userID string, mix []fixtureShare) string {
	sum := sha256.Sum256([]byte(seed + ":" + userID))
	n, _ := strconv.ParseUint(fmt.Sprintf("%x", sum[:4]), 16, 64)
	b := int(n % 10000)
	edge := 0
	for _, share := range mix {
		edge += share.Pct * 100
		if b < edge {
			return share.Variant
		}
	}
	return mix[len(mix)-1].Variant
}

func userIDs(n int, prefix string) []string {
	ids := make([]string, n)
	for i := range ids {
		ids[i] = fmt.Sprintf("%s%d", prefix, i)
	}
	return ids
}

// refreshOK is refresh(ctx); an error fails the check.
func refreshOK(ctx *harness.Ctx) bool {
	changed, err := refresh(context.Background())
	ctx.NoError(err, "refresh")
	return changed
}

func variantsOf(gate string, ids []string) []string {
	out := make([]string, len(ids))
	for i, u := range ids {
		out[i] = getVariant(gate, map[string]string{"user_id": u})
	}
	return out
}

// commandsSince flattens the learner's Redis round trips after the first 'before'.
func commandsSince(ctx *harness.Ctx, before int) []string {
	sent := []string{}
	for _, trip := range ctx.Redis.RoundTrips()[before:] {
		sent = append(sent, trip...)
	}
	return sent
}

func CheckStatelessHash(ctx *harness.Ctx) {
	copyGate := newFixtureGate("button_copy", everyone(threeWayMix))
	copyGate.Seed = "button_color"
	otherGate := newFixtureGate("other", everyone(threeWayMix))
	otherGate.Seed = "s2"
	publishGates(ctx, 1, newFixtureGate("button_color", everyone(threeWayMix)), copyGate, otherGate)
	refreshOK(ctx)
	ids := userIDs(40, "u")
	var want []string
	for _, u := range ids {
		expected := expectedVariant("button_color", u, threeWayMix)
		want = append(want, expected)
		got := getVariant("button_color", map[string]string{"user_id": u})
		ctx.Assert(got == expected, "getVariant(%q, %s) is %q, expected %q: bucket = first 4 bytes of sha256(%q) as a big-endian integer %% 10000, then cumulative edges 3300 / 6600 / 10000", "button_color", u, got, expected, "button_color:"+u)
	}
	again := variantsOf("button_color", ids)
	ctx.Equal(again, want, "the same user must get the same variant on every call: the assignment is a hash, not a coin toss")
	ctx.Equal(variantsOf("button_copy", ids), again, "two gates with the same seed must assign every user the same way (that is what a shared seed is for)")
	ctx.Assert(fmt.Sprint(variantsOf("other", ids)) != fmt.Sprint(again), "a different seed must shuffle the assignment; %q (seed s2) assigned every user exactly like button_color", "other")
	snapshot.Store(&Snapshot{Gates: map[string]Gate{}}) // a second server: the snapshot starts empty
	refreshOK(ctx)
	ctx.Equal(variantsOf("button_color", ids), again, "a second server loading the same snapshot must assign identically: nothing may be stored per user")
}

func CheckFallThrough(ctx *harness.Ctx) {
	populations := []fixturePopulation{
		{Match: map[string]string{"locale": "de"}, Mix: []fixtureShare{{"RED_BUTTON", 100}}},
		{Match: map[string]string{"plan": "pro"}, Mix: []fixtureShare{{"BLUE_BUTTON", 100}}},
		{Match: map[string]string{}, Mix: []fixtureShare{{"CONTROL", 100}}},
	}
	narrow := newFixtureGate("narrow", populations[:2])
	narrow.Default = "FALLBACK"
	publishGates(ctx, 1, newFixtureGate("button_color", populations), narrow)
	refreshOK(ctx)
	ctx.Equal(getVariant("button_color", map[string]string{"user_id": "ana", "locale": "de", "plan": "pro"}), "RED_BUTTON", "a German pro user matches the first population (locale de) — the first match decides, not the most specific or the last")
	ctx.Equal(getVariant("button_color", map[string]string{"user_id": "bo", "locale": "en", "plan": "pro"}), "BLUE_BUTTON", "an English pro user falls through to the second population (plan pro)")
	ctx.Equal(getVariant("button_color", map[string]string{"user_id": "cy", "locale": "en", "plan": "free"}), "CONTROL", "a user matching nothing specific lands in the catch-all population ({} matches everyone)")
	ctx.Equal(getVariant("button_color", map[string]string{"user_id": "dee"}), "CONTROL", "a missing attribute does not match a rule on it; the user still reaches the catch-all")
	ctx.Equal(getVariant("narrow", map[string]string{"user_id": "cy", "locale": "en", "plan": "free"}), "FALLBACK", "when no population matches, the gate's own default is the answer")
	ctx.Equal(getVariant("ghost", map[string]string{"user_id": "cy"}), "OFF", "a gate the snapshot does not know answers OFF — a client on a newer build must not crash the server")
}

func CheckMonotoneRollout(ctx *harness.Ctx) {
	ids := userIDs(2000, "user-")
	rollout := func(on, version int) fixtureGate {
		g := newFixtureGate("new_sidebar", everyone([]fixtureShare{{"ON", on}, {"OFF", 100 - on}}))
		g.Version = version
		return g
	}
	holdersOfOn := func() map[string]bool {
		set := map[string]bool{}
		for _, u := range ids {
			if getVariant("new_sidebar", map[string]string{"user_id": u}) == "ON" {
				set[u] = true
			}
		}
		return set
	}
	publishGates(ctx, 1, rollout(10, 1))
	refreshOK(ctx)
	first := holdersOfOn()
	ctx.Assert(140 <= len(first) && len(first) <= 260, "a 10%% share should hold about 200 of 2000 users, it holds %d", len(first))
	publishGates(ctx, 2, rollout(20, 2))
	ctx.Equal(refreshOK(ctx), true, "a bumped gates:version must make refresh() load the new config")
	second := holdersOfOn()
	var lost []string
	for _, u := range ids {
		if first[u] && !second[u] {
			lost = append(lost, u)
		}
	}
	ctx.Assert(len(lost) == 0, "raising ON from 10%% to 20%% must keep everyone who already had it, but %d users (e.g. %q) fell back to OFF: shares are cumulative edges in mix order, not independent draws", len(lost), lost[:min(3, len(lost))])
	ctx.Assert(320 <= len(second) && len(second) <= 480, "a 20%% share should hold about 400 of 2000 users, it holds %d", len(second))
	publishGates(ctx, 3, rollout(10, 3))
	refreshOK(ctx)
	third := holdersOfOn()
	sortedKeys := func(set map[string]bool) []string {
		keys := []string{}
		for u := range set {
			keys = append(keys, u)
		}
		sort.Strings(keys)
		return keys
	}
	ctx.Equal(sortedKeys(third), sortedKeys(first), "rolling back to 10%% must return exactly the original set of users")
}

func CheckSnapshot(ctx *harness.Ctx) {
	ctx.Equal(getVariant("button_color", map[string]string{"user_id": "ana"}), "OFF", "before the first refresh the snapshot is empty and every gate is OFF")
	publishGates(ctx, 7, newFixtureGate("button_color", everyone(threeWayMix)))
	before := len(ctx.Redis.RoundTrips())
	ctx.Equal(refreshOK(ctx), true, "the first refresh after a publish must report a change")
	sent := commandsSince(ctx, before)
	hasHGetAll := false
	for _, cmd := range sent {
		hasHGetAll = hasHGetAll || cmd == "HGETALL"
	}
	ctx.Assert(hasHGetAll, "a changed version must be followed by HGETALL gates; the refresh sent %q", sent)
	ctx.Equal(snapshot.Load().Version, 7, "the snapshot must carry the version it loaded")
	before = len(ctx.Redis.RoundTrips())
	ctx.Equal(refreshOK(ctx), false, "an unchanged version must report no change")
	ctx.Equal(commandsSince(ctx, before), []string{"GET"}, "an unchanged version costs exactly one GET gates:version; the commands the refresh sent")
	before = len(ctx.Redis.RoundTrips())
	for i := range 500 {
		getVariant("button_color", map[string]string{"user_id": fmt.Sprintf("u%d", i)})
	}
	sent = commandsSince(ctx, before)
	ctx.Assert(len(sent) == 0, "getVariant must not touch Redis: 500 decisions sent %d commands (%q); evaluate the in-memory snapshot", len(sent), sent)
	publishGates(ctx, 8, newFixtureGate("button_color", everyone(threeWayMix)), newFixtureGate("dark_mode", everyone([]fixtureShare{{"ON", 100}})))
	ctx.Equal(getVariant("dark_mode", map[string]string{"user_id": "ana"}), "OFF", "a gate published after the last refresh is not visible yet: the snapshot only moves when the loader runs")
	ctx.Equal(refreshOK(ctx), true, "refresh after gates:version moved to 8")
	ctx.Equal(getVariant("dark_mode", map[string]string{"user_id": "ana"}), "ON", "after the refresh the new gate is live")
	ctx.Equal(snapshot.Load().Version, 8, "the snapshot's version after the second load")
}

func CheckOverrides(ctx *harness.Ctx) {
	now := ctx.Clock.Now() / 1000
	g := newFixtureGate("button_color", []fixturePopulation{{Match: map[string]string{"locale": "de"}, Mix: []fixtureShare{{"CONTROL", 100}}}})
	g.Overrides = []map[string]any{
		{"user_id": "tomm", "variant": "RED_BUTTON", "expires_at": now + 3600},
		{"user_id": "old", "variant": "RED_BUTTON", "expires_at": now - 1},
	}
	publishGates(ctx, 1, g)
	refreshOK(ctx)
	ctx.Equal(getVariant("button_color", map[string]string{"user_id": "tomm", "locale": "de"}), "RED_BUTTON", "an unexpired override must win over the population the user matches")
	ctx.Equal(getVariant("button_color", map[string]string{"user_id": "tomm", "locale": "en"}), "RED_BUTTON", "an override applies even when the user matches no population at all — that is how a Dropboxer tests a gate aimed at someone else")
	ctx.Equal(getVariant("button_color", map[string]string{"user_id": "old", "locale": "de"}), "CONTROL", "an expired override must be ignored")
	ctx.Clock.Advance(3601)
	ctx.Equal(getVariant("button_color", map[string]string{"user_id": "tomm", "locale": "de"}), "CONTROL", "once its expires_at has passed, the override stops applying without any reload")
}
`,
  },
  debrief: `The whole system rests on two decisions this file makes. First, assignment is a **hash**, not a record: nothing is written when a user is assigned, so a hundred servers agree without talking, a new server agrees with the old ones the moment it loads the snapshot, and two gates can be made to agree by sharing a seed. Walking the shares as cumulative edges in a fixed order is what makes a rollout monotone — 10% → 20% keeps the first 10% — which is why the UI shows shares as an ordered list and why a reordering is a reshuffle. Second, evaluation is a **pure function over a snapshot**: the loader pays one \`GET\` per poll for the fleet and one \`HGETALL\` per edit, and a request pays nothing, which is also why Redis being down for a minute is invisible to users. Real systems add a signed config bundle instead of a hash in Redis, a push (pub/sub or a config service) to cut the ten minutes to seconds, exposure logging (step 4), and a kill switch that is itself just a gate with one population and one share.`,
};
