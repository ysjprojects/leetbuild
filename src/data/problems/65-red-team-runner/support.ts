/**
 * Hand-written support modules the red-team steps import but no step builds: the `redteam` package.
 * `config` is the contract every step agrees on (the sandbox address, the topic, the budgets, the key
 * layout); `targets` is the target registry; `catalog` the probe-set catalog; `runs` the run store
 * (runs, idempotency keys, per-category probe outcomes); `evidence` the sealed evidence store;
 * `findings` the finding record; `outbox` the rows kept for the relay when the broker refuses a
 * produce; and `sandbox` the deterministic stand-in the checks serve over gRPC in place of the probe
 * sandbox and the target behind it.
 */
import {CPP_IDS_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'redteam/__init__.py': '',
  'redteam/config.py': `"""Addresses, topics, budgets and keys every step of redteamd agrees on."""
# The probe sandbox's gRPC address: a stand-in served by the checks (redteam.sandbox).
SANDBOX = "sandbox:9000"
# Findings, keyed by target id, for the review queue.
TOPIC = "redteam.finding"
# A target's hourly probe budget, and the part of it destructive categories may use.
PROBE_BUDGET = 200
DESTRUCTIVE_PROBE_BUDGET = 20
DESTRUCTIVE_CATEGORIES = frozenset({"data-exfil", "resource-exhaustion"})
# The budget window, and how long a claimed probe stays claimed.
WINDOW_S = 3600
DEDUPE_TTL_S = 86_400

# Keys in Redis. probe: a claimed (target, probe hash). budget: a hash of probes and destructive drawn
# in one window (window = unix seconds // WINDOW_S). kill: present while the target's kill switch is on.


def probe_key(target: str, probe_hash: str) -> str:
    return f"redteam:probe:{target}:{probe_hash}"


def budget_key(target: str, window: int) -> str:
    return f"redteam:budget:{target}:{window}"


def kill_key(target: str) -> str:
    return f"redteam:kill:{target}"
`,
  'redteam/targets.py': `"""The target registry (provided): the systems a run may probe, by name."""
PRODUCTION = "production"

TARGETS = {
    "checkout-shadow": {"name": "checkout-shadow", "endpoint": "checkout-shadow.sandbox.internal", "environment": "shadow"},
    "search-staging": {"name": "search-staging", "endpoint": "search-staging.sandbox.internal", "environment": "staging"},
    "payments-prod": {"name": "payments-prod", "endpoint": "payments.prod.internal", "environment": PRODUCTION},
}


def resolve(name: str) -> dict | None:
    """The registered target ({name, endpoint, environment}), None for a name nobody registered."""
    target = TARGETS.get(name)
    return dict(target) if target is not None else None
`,
  'redteam/catalog.py': `"""The probe-set catalog (provided): the categories a probe set covers and how many probes each."""
PROBE_SETS = {
    "baseline": [
        {"category": "prompt-injection", "probes": 4},
        {"category": "jailbreak", "probes": 3},
        {"category": "data-exfil", "probes": 3},
    ],
    "injection-only": [{"category": "prompt-injection", "probes": 6}],
}


def plan(name: str) -> list[dict] | None:
    """The probe set's plan ([{category, probes}]), None for a set the catalog does not have."""
    entries = PROBE_SETS.get(name)
    return [dict(entry) for entry in entries] if entries is not None else None
`,
  'redteam/runs.py': `"""The run store (provided): runs by id and by (tenant, Idempotency-Key), and each run's probe outcomes."""
import json

import redis

RUN_TTL_S = 7 * 86_400

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class RunStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The run this tenant started under idem_key, if any."""
        run_id = r.get(f"redteam:idem:{tenant}:{idem_key}")
        return self.by_id(run_id) if run_id else None

    def put(self, tenant: str, idem_key: str, run: dict) -> None:
        """Store the run under its id and under (tenant, idem_key); the row carries the tenant."""
        row = dict(run, tenant=tenant)
        r.set(f"redteam:run:{run['run_id']}", json.dumps(row), ex=RUN_TTL_S)
        r.set(f"redteam:idem:{tenant}:{idem_key}", run["run_id"], ex=RUN_TTL_S)

    def by_id(self, run_id: str) -> dict | None:
        """The run row (the run plus its tenant), None when there is none."""
        raw = r.get(f"redteam:run:{run_id}")
        return json.loads(raw) if raw else None

    def record_outcome(self, run_id: str, category: str, outcome: str) -> None:
        """Count one probe's outcome (blocked, succeeded, timeout, error) under its category."""
        r.hincrby(f"redteam:coverage:{run_id}", f"{category}:{outcome}", 1)

    def coverage(self, run_id: str) -> dict[str, dict[str, int]]:
        """The outcomes counted so far: {category: {outcome: n}}."""
        out: dict[str, dict[str, int]] = {}
        for field, n in r.hgetall(f"redteam:coverage:{run_id}").items():
            category, _, outcome = field.rpartition(":")
            out.setdefault(category, {})[outcome] = int(n)
        return out

    def finish(self, run_id: str, status: str, resume_at: str | None) -> None:
        """Close the run: complete, or aborted with the first probe that was not sent."""
        row = self.by_id(run_id)
        if row is None:
            return
        row["status"] = status
        row["resume_at"] = resume_at
        r.set(f"redteam:run:{run_id}", json.dumps(row), ex=RUN_TTL_S)


store = RunStore()
`,
  'redteam/evidence.py': `"""The evidence store (provided): sealed bundles a reviewer opens by reference. A sealed bundle never changes."""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

PREFIX = "evidence://"


def seal(target_id: str, probe_id: str, bundle: str) -> str:
    """Store the bundle once and return its reference, evidence://{target_id}/{probe_id}."""
    r.set(f"redteam:evidence:{target_id}:{probe_id}", bundle, nx=True)
    return f"{PREFIX}{target_id}/{probe_id}"


def get(ref: str) -> str | None:
    """The sealed bundle behind a reference, None when nothing was sealed there."""
    if not ref.startswith(PREFIX):
        return None
    target_id, _, probe_id = ref[len(PREFIX):].partition("/")
    return r.get(f"redteam:evidence:{target_id}:{probe_id}")
`,
  'redteam/findings.py': `"""The finding record (provided): what the runner hands to publish when a probe got through."""
from dataclasses import dataclass


@dataclass
class Finding:
    run_id: str
    target_id: str
    probe_id: str
    category: str
    severity: str
    # The transcript: the adversarial payload and what the target answered. It belongs in the evidence
    # store, not in a retained topic.
    evidence: str
`,
  'redteam/outbox.py': `"""The outbox (provided): events the broker refused, kept for the relay to republish."""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OUTBOX_KEY = "redteam:outbox"


class OutboxStore:
    def insert_outbox(self, event: dict) -> None:
        """Durably keep an event the broker refused."""
        r.rpush(OUTBOX_KEY, json.dumps(event))

    def rows(self) -> list[dict]:
        return [json.loads(row) for row in r.lrange(OUTBOX_KEY, 0, -1)]


outbox = OutboxStore()
`,
  'redteam/sandbox.py': `"""
The stand-in for the probe sandbox and the target behind it. The checks serve it over gRPC
(Sandbox.Probe at redteam.config.SANDBOX); the runner's code never calls it directly.

respond(payload) -> (blocked, output):
  a payload starting with "leak:" gets through (blocked False, the output says what leaked)
  anything else is refused by the target (blocked True)
"""


def respond(payload: str) -> tuple[bool, str]:
    if payload.startswith("leak:"):
        return False, "LEAKED " + payload[len("leak:"):].strip()
    return True, "I can't help with that."
`,
};

export const supportModulesTs: Record<string, string> = {
  'redteam/config.ts': `/** Addresses, topics, budgets and keys every step of redteamd agrees on. */
/** The probe sandbox's gRPC address: a stand-in served by the checks (redteam/sandbox). */
export const SANDBOX = 'sandbox:9000';
/** Findings, keyed by target id, for the review queue. */
export const TOPIC = 'redteam.finding';
/** A target's hourly probe budget, and the part of it destructive categories may use. */
export const PROBE_BUDGET = 200;
export const DESTRUCTIVE_PROBE_BUDGET = 20;
export const DESTRUCTIVE_CATEGORIES: Record<string, true> = {'data-exfil': true, 'resource-exhaustion': true};
/** The budget window, and how long a claimed probe stays claimed. */
export const WINDOW_S = 3600;
export const DEDUPE_TTL_S = 86_400;

// Keys in Redis. probe: a claimed (target, probe hash). budget: a hash of probes and destructive drawn
// in one window (window = unix seconds / WINDOW_S, floored). kill: present while the target's kill switch is on.
export const probeKey = (target: string, probeHash: string): string => \`redteam:probe:\${target}:\${probeHash}\`;
export const budgetKey = (target: string, window: number): string => \`redteam:budget:\${target}:\${window}\`;
export const killKey = (target: string): string => \`redteam:kill:\${target}\`;
`,
  'redteam/targets.ts': `/** The target registry (provided): the systems a run may probe, by name. */
export const PRODUCTION = 'production';

export interface Target {
  name: string;
  endpoint: string;
  environment: string;
}

const TARGETS: Record<string, Target> = {
  'checkout-shadow': {name: 'checkout-shadow', endpoint: 'checkout-shadow.sandbox.internal', environment: 'shadow'},
  'search-staging': {name: 'search-staging', endpoint: 'search-staging.sandbox.internal', environment: 'staging'},
  'payments-prod': {name: 'payments-prod', endpoint: 'payments.prod.internal', environment: PRODUCTION},
};

/** The registered target, null for a name nobody registered. */
export function resolve(name: string): Target | null {
  const target = Object.hasOwn(TARGETS, name) ? TARGETS[name] : undefined;
  return target === undefined ? null : {...target};
}
`,
  'redteam/catalog.ts': `/** The probe-set catalog (provided): the categories a probe set covers and how many probes each. */
export interface Planned {
  category: string;
  probes: number;
}

/** One probe as the runner sends it. */
export interface Probe {
  probe_id: string;
  category: string;
  payload: string;
}

const PROBE_SETS: Record<string, Planned[]> = {
  baseline: [
    {category: 'prompt-injection', probes: 4},
    {category: 'jailbreak', probes: 3},
    {category: 'data-exfil', probes: 3},
  ],
  'injection-only': [{category: 'prompt-injection', probes: 6}],
};

/** The probe set's plan, null for a set the catalog does not have. */
export function plan(name: string): Planned[] | null {
  const entries = Object.hasOwn(PROBE_SETS, name) ? PROBE_SETS[name] : undefined;
  return entries === undefined ? null : entries.map(entry => ({...entry}));
}
`,
  'redteam/runs.ts': `/** The run store (provided): runs by id and by (tenant, Idempotency-Key), and each run's probe outcomes. */
import Redis from 'ioredis';

import type {Planned} from 'redteam/catalog';

export const RUN_TTL_S = 7 * 86_400;

const redis = new Redis({host: 'redis', port: 6379});

export interface Run {
  run_id: string;
  status: string;
  target: string;
  endpoint: string;
  probe_set: string;
  plan: Planned[];
  probes: number;
  resume_at?: string | null;
}

/** A stored run: the run plus the tenant that started it. */
export interface RunRow extends Run {
  tenant: string;
}

export const store = {
  /** The run this tenant started under idemKey, if any. */
  async get(tenant: string, idemKey: string): Promise<RunRow | null> {
    const runId = await redis.get(\`redteam:idem:\${tenant}:\${idemKey}\`);
    return runId === null ? null : store.byId(runId);
  },

  /** Store the run under its id and under (tenant, idemKey); the row carries the tenant. */
  async put(tenant: string, idemKey: string, run: Run): Promise<void> {
    const row: RunRow = {...run, tenant};
    await redis.set(\`redteam:run:\${run.run_id}\`, JSON.stringify(row), 'EX', RUN_TTL_S);
    await redis.set(\`redteam:idem:\${tenant}:\${idemKey}\`, run.run_id, 'EX', RUN_TTL_S);
  },

  /** The run row, null when there is none. */
  async byId(runId: string): Promise<RunRow | null> {
    const raw = await redis.get(\`redteam:run:\${runId}\`);
    return raw === null ? null : (JSON.parse(raw) as RunRow);
  },

  /** Count one probe's outcome (blocked, succeeded, timeout, error) under its category. */
  async recordOutcome(runId: string, category: string, outcome: string): Promise<void> {
    await redis.hincrby(\`redteam:coverage:\${runId}\`, \`\${category}:\${outcome}\`, 1);
  },

  /** The outcomes counted so far: {category: {outcome: n}}. */
  async coverage(runId: string): Promise<Record<string, Record<string, number>>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [field, n] of Object.entries(await redis.hgetall(\`redteam:coverage:\${runId}\`))) {
      const at = field.lastIndexOf(':');
      const category = field.slice(0, at);
      out[category] = {...(out[category] ?? {}), [field.slice(at + 1)]: Number(n)};
    }
    return out;
  },

  /** Close the run: complete, or aborted with the first probe that was not sent. */
  async finish(runId: string, status: string, resumeAt: string | null): Promise<void> {
    const row = await store.byId(runId);
    if (row === null) return;
    await redis.set(\`redteam:run:\${runId}\`, JSON.stringify({...row, status, resume_at: resumeAt}), 'EX', RUN_TTL_S);
  },
};
`,
  'redteam/evidence.ts': `/** The evidence store (provided): sealed bundles a reviewer opens by reference. A sealed bundle never changes. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

const PREFIX = 'evidence://';

export const evidence = {
  /** Store the bundle once and return its reference, evidence://{targetId}/{probeId}. */
  async seal(targetId: string, probeId: string, bundle: string): Promise<string> {
    await redis.set(\`redteam:evidence:\${targetId}:\${probeId}\`, bundle, 'NX');
    return \`\${PREFIX}\${targetId}/\${probeId}\`;
  },

  /** The sealed bundle behind a reference, null when nothing was sealed there. */
  async get(ref: string): Promise<string | null> {
    if (!ref.startsWith(PREFIX)) return null;
    const rest = ref.slice(PREFIX.length);
    const at = rest.indexOf('/');
    return redis.get(\`redteam:evidence:\${rest.slice(0, at)}:\${rest.slice(at + 1)}\`);
  },
};
`,
  'redteam/findings.ts': `/** The finding record (provided): what the runner hands to publish when a probe got through. */
export interface Finding {
  run_id: string;
  target_id: string;
  probe_id: string;
  category: string;
  severity: string;
  /** The transcript: the adversarial payload and what the target answered. It belongs in the evidence store, not in a retained topic. */
  evidence: string;
}
`,
  'redteam/outbox.ts': `/** The outbox (provided): events the broker refused, kept for the relay to republish. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const OUTBOX_KEY = 'redteam:outbox';

export const outbox = {
  /** Durably keep an event the broker refused. */
  async insertOutbox(event: Record<string, unknown>): Promise<void> {
    await redis.rpush(OUTBOX_KEY, JSON.stringify(event));
  },

  async rows(): Promise<Record<string, unknown>[]> {
    return (await redis.lrange(OUTBOX_KEY, 0, -1)).map(row => JSON.parse(row) as Record<string, unknown>);
  },
};
`,
  'redteam/sandbox.ts': `/**
 * The stand-in for the probe sandbox and the target behind it. The checks serve it over gRPC
 * (Sandbox.Probe at redteam/config's SANDBOX); the runner's code never calls it directly.
 *
 * respond(payload) → {blocked, output}:
 *   a payload starting with "leak:" gets through (blocked false, the output says what leaked)
 *   anything else is refused by the target (blocked true)
 */
export function respond(payload: string): {blocked: boolean; output: string} {
  if (payload.startsWith('leak:')) return {blocked: false, output: \`LEAKED \${payload.slice('leak:'.length).trim()}\`};
  return {blocked: true, output: "I can't help with that."};
}
`,
};

/** The Go twins: the same \`redteam\` packages, imported as redteam/config, redteam/targets, redteam/catalog, redteam/runs, … */
export const supportModulesGo: Record<string, string> = {
  'redteam/config/config.go': `// Package config holds the addresses, topics, budgets and keys every step of redteamd agrees on.
package config

import "strconv"

const (
	// Sandbox is the probe sandbox's gRPC address: a stand-in served by the checks (redteam/sandbox).
	Sandbox = "sandbox:9000"
	// Topic carries findings, keyed by target id, for the review queue.
	Topic = "redteam.finding"
	// ProbeBudget is a target's hourly probe budget; DestructiveProbeBudget the part of it
	// destructive categories may use.
	ProbeBudget            = 200
	DestructiveProbeBudget = 20
	// WindowSeconds is the budget window; DedupeTTLSeconds how long a claimed probe stays claimed.
	WindowSeconds    = 3600
	DedupeTTLSeconds = 86_400
)

// DestructiveCategories are the categories that draw from DestructiveProbeBudget as well.
var DestructiveCategories = map[string]bool{"data-exfil": true, "resource-exhaustion": true}

// Keys in Redis. probe: a claimed (target, probe hash). budget: a hash of probes and destructive drawn
// in one window (window = unix seconds / WindowSeconds). kill: present while the target's kill switch is on.

func ProbeKey(target, probeHash string) string { return "redteam:probe:" + target + ":" + probeHash }
func BudgetKey(target string, window int64) string {
	return "redteam:budget:" + target + ":" + strconv.FormatInt(window, 10)
}
func KillKey(target string) string { return "redteam:kill:" + target }
`,
  'redteam/targets/targets.go': `// Package targets is the target registry (provided): the systems a run may probe, by name.
package targets

const Production = "production"

// Target is one registered system.
type Target struct {
	Name        string
	Endpoint    string
	Environment string
}

var registry = map[string]Target{
	"checkout-shadow": {Name: "checkout-shadow", Endpoint: "checkout-shadow.sandbox.internal", Environment: "shadow"},
	"search-staging":  {Name: "search-staging", Endpoint: "search-staging.sandbox.internal", Environment: "staging"},
	"payments-prod":   {Name: "payments-prod", Endpoint: "payments.prod.internal", Environment: Production},
}

// Resolve is the registered target; ok is false for a name nobody registered.
func Resolve(name string) (Target, bool) {
	target, ok := registry[name]
	return target, ok
}
`,
  'redteam/catalog/catalog.go': `// Package catalog is the probe-set catalog (provided): the categories a probe set covers and how
// many probes each.
package catalog

// Planned is one category of a probe set.
type Planned struct {
	Category string \`json:"category"\`
	Probes   int    \`json:"probes"\`
}

// Probe is one probe as the runner sends it.
type Probe struct {
	ProbeID  string
	Category string
	Payload  string
}

var probeSets = map[string][]Planned{
	"baseline":       {{Category: "prompt-injection", Probes: 4}, {Category: "jailbreak", Probes: 3}, {Category: "data-exfil", Probes: 3}},
	"injection-only": {{Category: "prompt-injection", Probes: 6}},
}

// Plan is the probe set's plan; nil for a set the catalog does not have.
func Plan(name string) []Planned {
	entries, ok := probeSets[name]
	if !ok {
		return nil
	}
	return append([]Planned{}, entries...)
}
`,
  'redteam/runs/runs.go': `// Package runs is the run store (provided): runs by id and by (tenant, Idempotency-Key), and each
// run's probe outcomes.
package runs

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"redteam/catalog"
)

const RunTTL = 7 * 24 * time.Hour

// Run is a red-team run as the API answers it.
type Run struct {
	RunID    string            \`json:"run_id"\`
	Status   string            \`json:"status"\`
	Target   string            \`json:"target"\`
	Endpoint string            \`json:"endpoint"\`
	ProbeSet string            \`json:"probe_set"\`
	Plan     []catalog.Planned \`json:"plan"\`
	Probes   int               \`json:"probes"\`
	// ResumeAt is set when the run is aborted: the first probe that was not sent.
	ResumeAt string \`json:"resume_at,omitempty"\`
	// Tenant is set on the stored row: the tenant that started the run.
	Tenant string \`json:"tenant,omitempty"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Get is the run tenant started under idemKey; nil when there is none.
func Get(ctx context.Context, tenant, idemKey string) (*Run, error) {
	runID, err := rdb.Get(ctx, "redteam:idem:"+tenant+":"+idemKey).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return ByID(ctx, runID)
}

// Put stores the run under its id and under (tenant, idemKey); the row carries the tenant.
func Put(ctx context.Context, tenant, idemKey string, run Run) error {
	run.Tenant = tenant
	if err := save(ctx, run); err != nil {
		return err
	}
	return rdb.Set(ctx, "redteam:idem:"+tenant+":"+idemKey, run.RunID, RunTTL).Err()
}

// ByID is the run row; nil when there is none.
func ByID(ctx context.Context, runID string) (*Run, error) {
	raw, err := rdb.Get(ctx, "redteam:run:"+runID).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var run Run
	if err := json.Unmarshal(raw, &run); err != nil {
		return nil, err
	}
	return &run, nil
}

// RecordOutcome counts one probe's outcome (blocked, succeeded, timeout, error) under its category.
func RecordOutcome(ctx context.Context, runID, category, outcome string) error {
	return rdb.HIncrBy(ctx, "redteam:coverage:"+runID, category+":"+outcome, 1).Err()
}

// Coverage is the outcomes counted so far: category → outcome → n.
func Coverage(ctx context.Context, runID string) (map[string]map[string]int, error) {
	fields, err := rdb.HGetAll(ctx, "redteam:coverage:"+runID).Result()
	if err != nil {
		return nil, err
	}
	out := map[string]map[string]int{}
	for field, raw := range fields {
		at := strings.LastIndex(field, ":")
		category := field[:at]
		n, _ := strconv.Atoi(raw)
		if out[category] == nil {
			out[category] = map[string]int{}
		}
		out[category][field[at+1:]] = n
	}
	return out, nil
}

// Finish closes the run: complete, or aborted with the first probe that was not sent.
func Finish(ctx context.Context, runID, status, resumeAt string) error {
	run, err := ByID(ctx, runID)
	if err != nil || run == nil {
		return err
	}
	run.Status = status
	run.ResumeAt = resumeAt
	return save(ctx, *run)
}

func save(ctx context.Context, run Run) error {
	doc, err := json.Marshal(run)
	if err != nil {
		return err
	}
	return rdb.Set(ctx, "redteam:run:"+run.RunID, doc, RunTTL).Err()
}
`,
  'redteam/evidence/evidence.go': `// Package evidence is the evidence store (provided): sealed bundles a reviewer opens by reference.
// A sealed bundle never changes.
package evidence

import (
	"context"
	"errors"
	"strings"

	"github.com/redis/go-redis/v9"
)

const prefix = "evidence://"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Seal stores the bundle once and returns its reference, evidence://{targetID}/{probeID}.
func Seal(ctx context.Context, targetID, probeID, bundle string) (string, error) {
	if err := rdb.SetNX(ctx, "redteam:evidence:"+targetID+":"+probeID, bundle, 0).Err(); err != nil {
		return "", err
	}
	return prefix + targetID + "/" + probeID, nil
}

// Get is the sealed bundle behind a reference; "" when nothing was sealed there.
func Get(ctx context.Context, ref string) (string, error) {
	if !strings.HasPrefix(ref, prefix) {
		return "", nil
	}
	rest := strings.TrimPrefix(ref, prefix)
	at := strings.Index(rest, "/")
	if at < 0 {
		return "", nil
	}
	bundle, err := rdb.Get(ctx, "redteam:evidence:"+rest[:at]+":"+rest[at+1:]).Result()
	if errors.Is(err, redis.Nil) {
		return "", nil
	}
	return bundle, err
}
`,
  'redteam/findings/findings.go': `// Package findings holds the finding record (provided): what the runner hands to publish when a
// probe got through.
package findings

// Finding is one probe that got through. Evidence is the transcript (the adversarial payload and what
// the target answered): it belongs in the evidence store, not in a retained topic.
type Finding struct {
	RunID    string
	TargetID string
	ProbeID  string
	Category string
	Severity string
	Evidence string
}
`,
  'redteam/outbox/outbox.go': `// Package outbox keeps the events the broker refused (provided), for the relay to republish.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

const Key = "redteam:outbox"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Insert durably keeps an event the broker refused (the event's JSON).
func Insert(ctx context.Context, event []byte) error {
	return rdb.RPush(ctx, Key, event).Err()
}

// Rows are the kept events, decoded, oldest first.
func Rows(ctx context.Context) ([]map[string]any, error) {
	raw, err := rdb.LRange(ctx, Key, 0, -1).Result()
	if err != nil {
		return nil, err
	}
	rows := make([]map[string]any, 0, len(raw))
	for _, r := range raw {
		var row map[string]any
		if err := json.Unmarshal([]byte(r), &row); err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}
`,
  'redteam/sandbox/sandbox.go': `// Package sandbox is the stand-in for the probe sandbox and the target behind it. The checks serve
// it over gRPC (Sandbox.Probe at config.Sandbox); the runner's code never calls it directly.
//
// Respond(payload) → (blocked, output):
//
//	a payload starting with "leak:" gets through (false, the output says what leaked)
//	anything else is refused by the target (true)
package sandbox

import "strings"

func Respond(payload string) (blocked bool, output string) {
	if strings.HasPrefix(payload, "leak:") {
		return false, "LEAKED " + strings.TrimSpace(strings.TrimPrefix(payload, "leak:"))
	}
	return true, "I can't help with that."
}
`,
};

/** The C++ twins as headers (redteam/*.h), plus ids.h (UUIDs). */
export const supportModulesCpp: Record<string, string> = {
  'ids.h': CPP_IDS_H,
  'redteam/config.h': `// Addresses, topics, budgets and keys every step of redteamd agrees on.
#pragma once

#include <set>
#include <string>

#include <sw/redis++/redis++.h>

namespace config {

// The probe sandbox's gRPC address: a stand-in served by the checks (redteam/sandbox.h).
inline constexpr const char* kSandbox = "sandbox:9000";
// Findings, keyed by target id, for the review queue.
inline constexpr const char* kTopic = "redteam.finding";
// A target's hourly probe budget, and the part of it destructive categories may use.
inline constexpr long long kProbeBudget = 200;
inline constexpr long long kDestructiveProbeBudget = 20;
inline const std::set<std::string> kDestructiveCategories = {"data-exfil", "resource-exhaustion"};
// The budget window, and how long a claimed probe stays claimed.
inline constexpr long long kWindowSeconds = 3600;
inline constexpr long long kDedupeTtlSeconds = 86400;

// Keys in Redis. probe: a claimed (target, probe hash). budget: a hash of probes and destructive drawn
// in one window (window = unix seconds / kWindowSeconds). kill: present while the target's kill switch is on.
inline std::string probe_key(const std::string& target, const std::string& probe_hash) {
  return "redteam:probe:" + target + ":" + probe_hash;
}
inline std::string budget_key(const std::string& target, long long window) {
  return "redteam:budget:" + target + ":" + std::to_string(window);
}
inline std::string kill_key(const std::string& target) { return "redteam:kill:" + target; }

// The one Redis connection the provided modules share.
inline sw::redis::Redis& redis() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

}  // namespace config
`,
  'redteam/targets.h': `// The target registry (provided): the systems a run may probe, by name.
#pragma once

#include <map>
#include <optional>
#include <string>

namespace targets {

inline constexpr const char* kProduction = "production";

struct Target {
  std::string name;
  std::string endpoint;
  std::string environment;
};

inline const std::map<std::string, Target>& registry() {
  static const std::map<std::string, Target> targets = {
      {"checkout-shadow", {"checkout-shadow", "checkout-shadow.sandbox.internal", "shadow"}},
      {"search-staging", {"search-staging", "search-staging.sandbox.internal", "staging"}},
      {"payments-prod", {"payments-prod", "payments.prod.internal", kProduction}},
  };
  return targets;
}

// The registered target, nullopt for a name nobody registered.
inline std::optional<Target> resolve(const std::string& name) {
  const auto it = registry().find(name);
  if (it == registry().end()) return std::nullopt;
  return it->second;
}

}  // namespace targets
`,
  'redteam/catalog.h': `// The probe-set catalog (provided): the categories a probe set covers and how many probes each.
#pragma once

#include <map>
#include <optional>
#include <string>

#include <nlohmann/json.hpp>

namespace catalog {

// One probe as the runner sends it.
struct Probe {
  std::string probe_id;
  std::string category;
  std::string payload;
};

// The probe set's plan ([{category, probes}]), nullopt for a set the catalog does not have.
inline std::optional<nlohmann::json> plan(const std::string& name) {
  static const std::map<std::string, nlohmann::json> sets = {
      {"baseline", nlohmann::json::array({{{"category", "prompt-injection"}, {"probes", 4}},
                                          {{"category", "jailbreak"}, {"probes", 3}},
                                          {{"category", "data-exfil"}, {"probes", 3}}})},
      {"injection-only", nlohmann::json::array({{{"category", "prompt-injection"}, {"probes", 6}}})},
  };
  const auto it = sets.find(name);
  if (it == sets.end()) return std::nullopt;
  return it->second;
}

}  // namespace catalog
`,
  'redteam/runs.h': `// The run store (provided): runs by id and by (tenant, Idempotency-Key), and each run's probe outcomes.
#pragma once

#include <iterator>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>

#include <nlohmann/json.hpp>

#include "redteam/config.h"

namespace runs {

inline constexpr long long kRunTtlSeconds = 7 * 86400;

// The run row (the run plus its tenant), nullopt when there is none.
inline std::optional<nlohmann::json> by_id(const std::string& run_id) {
  const auto raw = config::redis().get("redteam:run:" + run_id);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// The run this tenant started under idem_key, if any.
inline std::optional<nlohmann::json> get(const std::string& tenant, const std::string& idem_key) {
  const auto run_id = config::redis().get("redteam:idem:" + tenant + ":" + idem_key);
  if (!run_id) return std::nullopt;
  return by_id(*run_id);
}

// Store the run under its id and under (tenant, idem_key); the row carries the tenant.
inline void put(const std::string& tenant, const std::string& idem_key, const nlohmann::json& run) {
  nlohmann::json row = run;
  row["tenant"] = tenant;
  const std::string run_id = run.at("run_id").get<std::string>();
  config::redis().set("redteam:run:" + run_id, row.dump(), kRunTtlSeconds);
  config::redis().set("redteam:idem:" + tenant + ":" + idem_key, run_id, kRunTtlSeconds);
}

// Count one probe's outcome (blocked, succeeded, timeout, error) under its category.
inline void record_outcome(const std::string& run_id, const std::string& category, const std::string& outcome) {
  config::redis().hincrby("redteam:coverage:" + run_id, category + ":" + outcome, 1);
}

// The outcomes counted so far: category -> outcome -> n.
inline std::map<std::string, std::map<std::string, long long>> coverage(const std::string& run_id) {
  std::unordered_map<std::string, std::string> fields;
  config::redis().hgetall("redteam:coverage:" + run_id, std::inserter(fields, fields.begin()));
  std::map<std::string, std::map<std::string, long long>> out;
  for (const auto& [field, n] : fields) {
    const auto at = field.rfind(':');
    out[field.substr(0, at)][field.substr(at + 1)] = std::stoll(n);
  }
  return out;
}

// Close the run: complete, or aborted with the first probe that was not sent ("" for none).
inline void finish(const std::string& run_id, const std::string& status, const std::string& resume_at) {
  auto row = by_id(run_id);
  if (!row) return;
  (*row)["status"] = status;
  (*row)["resume_at"] = resume_at.empty() ? nlohmann::json(nullptr) : nlohmann::json(resume_at);
  config::redis().set("redteam:run:" + run_id, row->dump(), kRunTtlSeconds);
}

}  // namespace runs
`,
  'redteam/evidence.h': `// The evidence store (provided): sealed bundles a reviewer opens by reference. A sealed bundle never changes.
#pragma once

#include <optional>
#include <string>

#include "redteam/config.h"

namespace evidence {

inline constexpr const char* kPrefix = "evidence://";

// Store the bundle once and return its reference, evidence://{target_id}/{probe_id}.
inline std::string seal(const std::string& target_id, const std::string& probe_id, const std::string& bundle) {
  config::redis().set("redteam:evidence:" + target_id + ":" + probe_id, bundle, std::chrono::milliseconds(0),
                      sw::redis::UpdateType::NOT_EXIST);
  return std::string(kPrefix) + target_id + "/" + probe_id;
}

// The sealed bundle behind a reference, nullopt when nothing was sealed there.
inline std::optional<std::string> get(const std::string& ref) {
  const std::string prefix = kPrefix;
  if (ref.rfind(prefix, 0) != 0) return std::nullopt;
  const std::string rest = ref.substr(prefix.size());
  const auto at = rest.find('/');
  if (at == std::string::npos) return std::nullopt;
  const auto bundle = config::redis().get("redteam:evidence:" + rest.substr(0, at) + ":" + rest.substr(at + 1));
  if (!bundle) return std::nullopt;
  return *bundle;
}

}  // namespace evidence
`,
  'redteam/findings.h': `// The finding record (provided): what the runner hands to publish when a probe got through.
#pragma once

#include <string>

namespace findings {

// One probe that got through. evidence is the transcript (the adversarial payload and what the
// target answered): it belongs in the evidence store, not in a retained topic.
struct Finding {
  std::string run_id;
  std::string target_id;
  std::string probe_id;
  std::string category;
  std::string severity;
  std::string evidence;
};

}  // namespace findings
`,
  'redteam/outbox.h': `// The outbox (provided): events the broker refused, kept for the relay to republish.
#pragma once

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "redteam/config.h"

namespace outbox {

inline constexpr const char* kKey = "redteam:outbox";

// Durably keep an event the broker refused (its JSON).
inline void insert_outbox(const std::string& event_json) { config::redis().rpush(kKey, event_json); }

// The kept events, decoded, oldest first.
inline std::vector<nlohmann::json> rows() {
  std::vector<std::string> raw;
  config::redis().lrange(kKey, 0, -1, std::back_inserter(raw));
  std::vector<nlohmann::json> out;
  for (const auto& row : raw) out.push_back(nlohmann::json::parse(row));
  return out;
}

}  // namespace outbox
`,
  'redteam/sandbox.h': `// The stand-in for the probe sandbox and the target behind it. The checks serve it over gRPC
// (Sandbox.Probe at config::kSandbox); the runner's code never calls it directly.
//
// respond(payload) -> {blocked, output}:
//   a payload starting with "leak:" gets through (blocked false, the output says what leaked)
//   anything else is refused by the target (blocked true)
#pragma once

#include <string>

namespace sandbox {

struct Answer {
  bool blocked = true;
  std::string output;
};

inline Answer respond(const std::string& payload) {
  if (payload.rfind("leak:", 0) == 0) {
    std::string rest = payload.substr(5);
    const size_t start = rest.find_first_not_of(" \\t");
    return {false, "LEAKED " + (start == std::string::npos ? std::string() : rest.substr(start))};
  }
  return {true, "I can't help with that."};
}

}  // namespace sandbox
`,
};

/** The Scala twins: the same \`redteam\` objects, compiled with the steps by \`yarn check:scala\`. */
export const supportModulesScala: Record<string, string> = {
  [scalaPath('redteam', 'Config')]: `package redteam

/** Addresses, topics, budgets and keys every step of redteamd agrees on. */
object Config {
  /** The probe sandbox's gRPC address: a stand-in served by the checks. */
  val Sandbox = "sandbox:9000"
  /** Findings, keyed by target id, for the review queue. */
  val Topic = "redteam.finding"
  /** A target's hourly probe budget, and the part of it destructive categories may use. */
  val ProbeBudget = 200L
  val DestructiveProbeBudget = 20L
  val DestructiveCategories: Set[String] = Set("data-exfil", "resource-exhaustion")
  /** The budget window, and how long a claimed probe stays claimed. */
  val WindowSeconds = 3600L
  val DedupeTtlSeconds = 86400L

  // Keys in Redis. probe: a claimed (target, probe hash). budget: a hash of probes and destructive drawn
  // in one window (window = unix seconds / WindowSeconds). kill: present while the target's kill switch is on.
  def probeKey(target: String, probeHash: String): String = s"redteam:probe:$target:$probeHash"
  def budgetKey(target: String, window: Long): String = s"redteam:budget:$target:$window"
  def killKey(target: String): String = s"redteam:kill:$target"
}
`,
  [scalaPath('redteam', 'Targets')]: `package redteam

/** One registered system. */
final case class Target(name: String, endpoint: String, environment: String)

/** The target registry (provided): the systems a run may probe, by name. */
object Targets {
  val Production = "production"

  private val registry = Map(
    "checkout-shadow" -> Target("checkout-shadow", "checkout-shadow.sandbox.internal", "shadow"),
    "search-staging" -> Target("search-staging", "search-staging.sandbox.internal", "staging"),
    "payments-prod" -> Target("payments-prod", "payments.prod.internal", Production)
  )

  /** The registered target, None for a name nobody registered. */
  def resolve(name: String): Option[Target] = registry.get(name)
}
`,
  [scalaPath('redteam', 'Catalog')]: `package redteam

/** One category of a probe set. */
final case class Planned(category: String, probes: Int)

/** One probe as the runner sends it. */
final case class Probe(probe_id: String, category: String, payload: String)

/** The probe-set catalog (provided): the categories a probe set covers and how many probes each. */
object Catalog {
  private val probeSets = Map(
    "baseline" -> List(Planned("prompt-injection", 4), Planned("jailbreak", 3), Planned("data-exfil", 3)),
    "injection-only" -> List(Planned("prompt-injection", 6))
  )

  /** The probe set's plan, None for a set the catalog does not have. */
  def plan(name: String): Option[List[Planned]] = probeSets.get(name)
}
`,
  [scalaPath('redteam', 'Runs')]: `package redteam

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

/** A red-team run as the API answers it. */
final case class Run(
    run_id: String,
    status: String,
    target: String,
    endpoint: String,
    probe_set: String,
    plan: List[Planned],
    probes: Int
)

/** A stored run: the run, the tenant that started it, and where an aborted run stopped. */
final case class RunRow(run: Run, tenant: String, resume_at: Option[String])

/** The run store (provided): runs by id and by (tenant, Idempotency-Key), and each run's probe outcomes. */
object Runs {
  val RunTtlSeconds: Long = 7L * 86400
  private val jedis = new JedisPooled("redis", 6379)

  private def encode(row: RunRow): String = ujson.write(
    ujson.Obj(
      "run_id" -> row.run.run_id,
      "status" -> row.run.status,
      "target" -> row.run.target,
      "endpoint" -> row.run.endpoint,
      "probe_set" -> row.run.probe_set,
      "plan" -> ujson.Arr.from(row.run.plan.map(p => ujson.Obj("category" -> p.category, "probes" -> p.probes))),
      "probes" -> row.run.probes,
      "tenant" -> row.tenant,
      "resume_at" -> row.resume_at.map(ujson.Str(_)).getOrElse(ujson.Null)
    )
  )

  private def decode(raw: String): RunRow = {
    val j = ujson.read(raw)
    val plan = j("plan").arr.toList.map(p => Planned(p("category").str, p("probes").num.toInt))
    val run = Run(j("run_id").str, j("status").str, j("target").str, j("endpoint").str, j("probe_set").str, plan, j("probes").num.toInt)
    RunRow(run, j("tenant").str, j.obj.get("resume_at").flatMap(_.strOpt))
  }

  private def save(row: RunRow): Unit = {
    jedis.set(s"redteam:run:\${row.run.run_id}", encode(row), SetParams.setParams().ex(RunTtlSeconds))
    ()
  }

  /** The run this tenant started under idemKey, if any. */
  def get(tenant: String, idemKey: String): Option[RunRow] =
    Option(jedis.get(s"redteam:idem:$tenant:$idemKey")).flatMap(byId)

  /** Store the run under its id and under (tenant, idemKey); the row carries the tenant. */
  def put(tenant: String, idemKey: String, run: Run): Unit = {
    save(RunRow(run, tenant, None))
    jedis.set(s"redteam:idem:$tenant:$idemKey", run.run_id, SetParams.setParams().ex(RunTtlSeconds))
    ()
  }

  /** The run row, None when there is none. */
  def byId(runId: String): Option[RunRow] = Option(jedis.get(s"redteam:run:$runId")).map(decode)

  /** Count one probe's outcome (blocked, succeeded, timeout, error) under its category. */
  def recordOutcome(runId: String, category: String, outcome: String): Unit = {
    jedis.hincrBy(s"redteam:coverage:$runId", s"$category:$outcome", 1)
    ()
  }

  /** The outcomes counted so far: category -> outcome -> n. */
  def coverage(runId: String): Map[String, Map[String, Int]] =
    jedis.hgetAll(s"redteam:coverage:$runId").asScala.toList
      .map { case (field, n) =>
        val at = field.lastIndexOf(':')
        (field.substring(0, at), field.substring(at + 1), n.toInt)
      }
      .groupBy(_._1)
      .map { case (category, rows) => category -> rows.map(r => r._2 -> r._3).toMap }

  /** Close the run: complete, or aborted with the first probe that was not sent. */
  def finish(runId: String, status: String, resumeAt: Option[String]): Unit =
    byId(runId).foreach(row => save(RunRow(row.run.copy(status = status), row.tenant, resumeAt)))
}
`,
  [scalaPath('redteam', 'Evidence')]: `package redteam

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

/** The evidence store (provided): sealed bundles a reviewer opens by reference. A sealed bundle never changes. */
object Evidence {
  val Prefix = "evidence://"
  private val jedis = new JedisPooled("redis", 6379)

  /** Store the bundle once and return its reference, evidence://{targetId}/{probeId}. */
  def seal(targetId: String, probeId: String, bundle: String): String = {
    jedis.set(s"redteam:evidence:$targetId:$probeId", bundle, SetParams.setParams().nx())
    s"$Prefix$targetId/$probeId"
  }

  /** The sealed bundle behind a reference, None when nothing was sealed there. */
  def get(ref: String): Option[String] =
    if (!ref.startsWith(Prefix)) None
    else {
      val rest = ref.substring(Prefix.length)
      val at = rest.indexOf('/')
      if (at < 0) None else Option(jedis.get(s"redteam:evidence:\${rest.substring(0, at)}:\${rest.substring(at + 1)}"))
    }
}
`,
  [scalaPath('redteam', 'Finding')]: `package redteam

/**
 * The finding record (provided): what the runner hands to publish when a probe got through. evidence
 * is the transcript (the adversarial payload and what the target answered): it belongs in the
 * evidence store, not in a retained topic.
 */
final case class Finding(
    run_id: String,
    target_id: String,
    probe_id: String,
    category: String,
    severity: String,
    evidence: String
)
`,
  [scalaPath('redteam', 'Outbox')]: `package redteam

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** The outbox (provided): events the broker refused, kept for the relay to republish. */
object Outbox {
  val Key = "redteam:outbox"
  private val jedis = new JedisPooled("redis", 6379)

  /** Durably keep an event the broker refused (its JSON). */
  def insertOutbox(eventJson: String): Unit = {
    jedis.rpush(Key, eventJson)
    ()
  }

  /** The kept events, decoded, oldest first. */
  def rows(): List[ujson.Value] = jedis.lrange(Key, 0, -1).asScala.toList.map(ujson.read(_))
}
`,
};
