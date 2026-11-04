/**
 * Hand-written support modules the workflow-engine steps import but no step builds: the `workflow`
 * package. `definitions` is the definition store (one Redis hash per published version) with the
 * graph's cycle test, `runs` the run records (created with their checkpoint), `blobs` the store
 * step outputs live in, `checkpoint` the run checkpoint of step 2 as later steps use it (`advance`,
 * the compare-and-swap, and `read`), `ledger` the effect ledger, `outbox` the rows a relay
 * republishes. The five languages keep the same keys, so a harness reads one layout whatever the
 * stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'workflow/__init__.py': '',
  'workflow/definitions.py': `"""
The definition store (provided): every published version of a workflow is a Redis hash
workflow:{name}:v{version} with name, version, steps (a JSON list of step names) and edges (a JSON
list of [from, to] pairs); workflow:{name}:latest holds the highest version published. A
definition is returned as {"name", "version", "steps", "edges"}.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def definition_key(name: str, version: int) -> str:
    return f"workflow:{name}:v{version}"


def has_cycle(steps: list[str], edges: list[list[str]]) -> bool:
    """Whether the edges between the steps form a cycle: some step never runs out of predecessors."""
    indegree = {step: 0 for step in steps}
    successors: dict[str, list[str]] = {step: [] for step in steps}
    for source, target in edges:
        if source in successors and target in indegree:
            successors[source].append(target)
            indegree[target] += 1
    ready = [step for step, count in indegree.items() if count == 0]
    seen = 0
    while ready:
        step = ready.pop()
        seen += 1
        for target in successors[step]:
            indegree[target] -= 1
            if indegree[target] == 0:
                ready.append(target)
    return seen < len(indegree)


def exists(name: str, version: int) -> bool:
    """Whether version of the workflow has been published."""
    return r.exists(definition_key(name, version)) == 1


def get(name: str, version: int) -> dict | None:
    """That version of the workflow, or None."""
    raw = r.hgetall(definition_key(name, version))
    if not raw:
        return None
    return {"name": raw["name"], "version": int(raw["version"]), "steps": json.loads(raw["steps"]), "edges": json.loads(raw["edges"])}


def latest(name: str) -> dict | None:
    """The highest version of the workflow published so far, or None."""
    version = r.get(f"workflow:{name}:latest")
    return get(name, int(version)) if version else None


def put(name: str, version: int, steps: list[str], edges: list[list[str]]) -> None:
    """Write that version of the workflow, replacing whatever it held; latest moves when the version is higher."""
    r.hset(definition_key(name, version), mapping={"name": name, "version": version, "steps": json.dumps(steps), "edges": json.dumps(edges)})
    current = r.get(f"workflow:{name}:latest")
    if current is None or int(current) < version:
        r.set(f"workflow:{name}:latest", version)
`,
  'workflow/runs.py': `"""
Runs (provided): run:{run_id} is a hash with run_id, tenant, workflow, definition_version,
pinned_steps (a JSON list), input (a JSON document), max_steps and started_at (unix seconds).
create also writes the run's checkpoint run:{run_id}:checkpoint: current_step the first pinned
step, completed "", output_ref "", updated_at the start. Run ids are run-1, run-2, … A run is
returned as a dict with pinned_steps a list and input a dict.
"""
import json
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def create(tenant: str, workflow: str, version: int, steps: list[str], input_doc: dict, max_steps: int) -> dict:
    """A new run of that workflow version with these pinned steps; returns the run."""
    run_id = f"run-{r.incr('run:seq')}"
    now = int(time.time())
    r.hset(
        f"run:{run_id}",
        mapping={
            "run_id": run_id,
            "tenant": tenant,
            "workflow": workflow,
            "definition_version": version,
            "pinned_steps": json.dumps(steps),
            "input": json.dumps(input_doc),
            "max_steps": max_steps,
            "started_at": now,
        },
    )
    r.hset(f"run:{run_id}:checkpoint", mapping={"current_step": steps[0] if steps else "", "completed": "", "output_ref": "", "updated_at": now})
    return get(run_id)


def get(run_id: str) -> dict | None:
    """The run, or None."""
    raw = r.hgetall(f"run:{run_id}")
    if not raw:
        return None
    return {
        "run_id": raw["run_id"],
        "tenant": raw["tenant"],
        "workflow": raw["workflow"],
        "definition_version": int(raw["definition_version"]),
        "pinned_steps": json.loads(raw["pinned_steps"]),
        "input": json.loads(raw["input"]),
        "max_steps": int(raw["max_steps"]),
        "started_at": int(raw["started_at"]),
    }
`,
  'workflow/blobs.py': `"""
The blob store (provided): blob:{n} holds one step output whole; put returns its reference, the
key itself ("blob:7").
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def put(data: str) -> str:
    """Store data; returns its reference."""
    ref = f"blob:{r.incr('blob:seq')}"
    r.set(ref, data)
    return ref


def get(ref: str) -> str | None:
    """The data stored under ref, or None."""
    return r.get(ref)
`,
  'workflow/checkpoint.py': `"""
The run checkpoint (provided; step 2 builds advance): run:{run_id}:checkpoint is a hash with
current_step ("" once the run finished), completed (the finished step names, comma-separated, in
order), output_ref (the blob of the last output) and updated_at (unix seconds). advance stores the
output in the blob store, then moves the run in one Lua script only if current_step still equals
from_step, and reports whether it did; a run that finishes (to_step "") expires RETENTION_S later.
read returns the hash ({} when the run has none).
"""
import redis

from workflow import blobs

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RETENTION_S = 7 * 24 * 3600

ADVANCE_LUA = """
local current = redis.call('HGET', KEYS[1], 'current_step')
if current ~= ARGV[1] then return 0 end
local completed = redis.call('HGET', KEYS[1], 'completed')
if not completed or completed == '' then completed = ARGV[1] else completed = completed .. ',' .. ARGV[1] end
redis.call('HSET', KEYS[1], 'current_step', ARGV[2], 'completed', completed, 'output_ref', ARGV[3], 'updated_at', ARGV[4])
if ARGV[2] == '' then redis.call('EXPIRE', KEYS[1], ARGV[5]) end
return 1
"""
advance_script = r.register_script(ADVANCE_LUA)


def checkpoint_key(run_id: str) -> str:
    return f"run:{run_id}:checkpoint"


def advance(run_id: str, from_step: str, to_step: str, output: str, now: int) -> bool:
    """Move the run from from_step to to_step ("" when from_step was the last); False when the run is not at from_step."""
    ref = blobs.put(output)
    return advance_script(keys=[checkpoint_key(run_id)], args=[from_step, to_step, ref, now, RETENTION_S]) == 1


def read(run_id: str) -> dict:
    """The checkpoint hash, {} when the run has none."""
    return r.hgetall(checkpoint_key(run_id))
`,
  'workflow/ledger.py': `"""
The effect ledger (provided): effect:{effect_id} holds the outcome recorded for one step's side
effect (for send_welcome, the message id). An effect id is "{run_id}:{step}".
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def done(effect_id: str) -> str | None:
    """The outcome recorded for the effect, or None when nothing was recorded."""
    return r.get(f"effect:{effect_id}")


def record(effect_id: str, outcome: str) -> None:
    """Record the effect's outcome."""
    r.set(f"effect:{effect_id}", outcome)


def incomplete(run_id: str, steps: list[str]) -> list[str]:
    """The steps of the run, in order, whose effect has no recorded outcome."""
    return [step for step in steps if r.exists(f"effect:{run_id}:{step}") == 0]
`,
  'workflow/outbox.py': `"""
The outbox (provided): the hash outbox maps an event id to a JSON row {"topic", "key", "payload"};
a relay republishes every row still there. insert writes the row, remove deletes it.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def insert(event_id: str, topic: str, key: str, payload: dict) -> None:
    """Keep the event for the relay until it is removed."""
    r.hset("outbox", event_id, json.dumps({"topic": topic, "key": key, "payload": payload}))


def remove(event_id: str) -> None:
    """The broker has the event: the relay can forget it."""
    r.hdel("outbox", event_id)
`,
};

export const supportModulesTs: Record<string, string> = {
  'workflow/definitions.ts': `/**
 * The definition store (provided): every published version of a workflow is a Redis hash
 * workflow:{name}:v{version} with name, version, steps (a JSON list of step names) and edges (a
 * JSON list of [from, to] pairs); workflow:{name}:latest holds the highest version published.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Definition {
  name: string;
  version: number;
  steps: string[];
  edges: string[][];
}

export const definitionKey = (name: string, version: number): string => \`workflow:\${name}:v\${version}\`;

/** Whether the edges between the steps form a cycle: some step never runs out of predecessors. */
export function hasCycle(steps: string[], edges: string[][]): boolean {
  const indegree = new Map<string, number>(steps.map(step => [step, 0]));
  const successors = new Map<string, string[]>(steps.map(step => [step, []]));
  for (const [source, target] of edges) {
    if (successors.has(source) && indegree.has(target)) {
      successors.get(source)!.push(target);
      indegree.set(target, indegree.get(target)! + 1);
    }
  }
  const ready = [...indegree].filter(([, count]) => count === 0).map(([step]) => step);
  let seen = 0;
  while (ready.length > 0) {
    const step = ready.pop()!;
    seen++;
    for (const target of successors.get(step)!) {
      indegree.set(target, indegree.get(target)! - 1);
      if (indegree.get(target) === 0) ready.push(target);
    }
  }
  return seen < indegree.size;
}

/** Whether version of the workflow has been published. */
export async function exists(name: string, version: number): Promise<boolean> {
  return (await redis.exists(definitionKey(name, version))) === 1;
}

/** That version of the workflow, or null. */
export async function get(name: string, version: number): Promise<Definition | null> {
  const raw = await redis.hgetall(definitionKey(name, version));
  if (Object.keys(raw).length === 0) return null;
  return {name: raw.name, version: Number(raw.version), steps: JSON.parse(raw.steps), edges: JSON.parse(raw.edges)};
}

/** The highest version of the workflow published so far, or null. */
export async function latest(name: string): Promise<Definition | null> {
  const version = await redis.get(\`workflow:\${name}:latest\`);
  return version === null ? null : get(name, Number(version));
}

/** Write that version of the workflow, replacing whatever it held; latest moves when the version is higher. */
export async function put(name: string, version: number, steps: string[], edges: string[][]): Promise<void> {
  await redis.hset(definitionKey(name, version), {name, version: String(version), steps: JSON.stringify(steps), edges: JSON.stringify(edges)});
  const current = await redis.get(\`workflow:\${name}:latest\`);
  if (current === null || Number(current) < version) await redis.set(\`workflow:\${name}:latest\`, String(version));
}
`,
  'workflow/runs.ts': `/**
 * Runs (provided): run:{run_id} is a hash with run_id, tenant, workflow, definition_version,
 * pinned_steps (a JSON list), input (a JSON document), max_steps and started_at (unix seconds).
 * create also writes the run's checkpoint run:{run_id}:checkpoint: current_step the first pinned
 * step, completed "", output_ref "", updated_at the start. Run ids are run-1, run-2, …
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Run {
  run_id: string;
  tenant: string;
  workflow: string;
  definition_version: number;
  pinned_steps: string[];
  input: Record<string, unknown>;
  max_steps: number;
  started_at: number;
}

/** A new run of that workflow version with these pinned steps; returns the run. */
export async function create(
  tenant: string,
  workflow: string,
  version: number,
  steps: string[],
  input: Record<string, unknown>,
  maxSteps: number,
): Promise<Run> {
  const runId = \`run-\${await redis.incr('run:seq')}\`;
  const now = String(Math.floor(Date.now() / 1000));
  await redis.hset(\`run:\${runId}\`, {
    run_id: runId,
    tenant,
    workflow,
    definition_version: String(version),
    pinned_steps: JSON.stringify(steps),
    input: JSON.stringify(input),
    max_steps: String(maxSteps),
    started_at: now,
  });
  await redis.hset(\`run:\${runId}:checkpoint\`, {current_step: steps[0] ?? '', completed: '', output_ref: '', updated_at: now});
  return (await get(runId)) as Run;
}

/** The run, or null. */
export async function get(runId: string): Promise<Run | null> {
  const raw = await redis.hgetall(\`run:\${runId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {
    run_id: raw.run_id,
    tenant: raw.tenant,
    workflow: raw.workflow,
    definition_version: Number(raw.definition_version),
    pinned_steps: JSON.parse(raw.pinned_steps),
    input: JSON.parse(raw.input),
    max_steps: Number(raw.max_steps),
    started_at: Number(raw.started_at),
  };
}
`,
  'workflow/blobs.ts': `/** The blob store (provided): blob:{n} holds one step output whole; put returns its reference, the key itself ("blob:7"). */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** Store data; returns its reference. */
export async function put(data: string): Promise<string> {
  const ref = \`blob:\${await redis.incr('blob:seq')}\`;
  await redis.set(ref, data);
  return ref;
}

/** The data stored under ref, or null. */
export async function get(ref: string): Promise<string | null> {
  return redis.get(ref);
}
`,
  'workflow/checkpoint.ts': `/**
 * The run checkpoint (provided; step 2 builds advance): run:{run_id}:checkpoint is a hash with
 * current_step ("" once the run finished), completed (the finished step names, comma-separated, in
 * order), output_ref (the blob of the last output) and updated_at (unix seconds). advance stores the
 * output in the blob store, then moves the run in one Lua script only if current_step still equals
 * fromStep, and reports whether it did; a run that finishes (toStep "") expires RETENTION_S later.
 * read returns the hash ({} when the run has none).
 */
import Redis from 'ioredis';

import * as blobs from './blobs';

const redis = new Redis({host: 'redis', port: 6379});

export const RETENTION_S = 7 * 24 * 3600;

export const ADVANCE_LUA = \`
local current = redis.call('HGET', KEYS[1], 'current_step')
if current ~= ARGV[1] then return 0 end
local completed = redis.call('HGET', KEYS[1], 'completed')
if not completed or completed == '' then completed = ARGV[1] else completed = completed .. ',' .. ARGV[1] end
redis.call('HSET', KEYS[1], 'current_step', ARGV[2], 'completed', completed, 'output_ref', ARGV[3], 'updated_at', ARGV[4])
if ARGV[2] == '' then redis.call('EXPIRE', KEYS[1], ARGV[5]) end
return 1
\`;

export const checkpointKey = (runId: string): string => \`run:\${runId}:checkpoint\`;

/** Move the run from fromStep to toStep ("" when fromStep was the last); false when the run is not at fromStep. */
export async function advance(runId: string, fromStep: string, toStep: string, output: string, now: number): Promise<boolean> {
  const ref = await blobs.put(output);
  const moved = await redis.eval(ADVANCE_LUA, 1, checkpointKey(runId), fromStep, toStep, ref, String(now), String(RETENTION_S));
  return moved === 1;
}

/** The checkpoint hash, {} when the run has none. */
export async function read(runId: string): Promise<Record<string, string>> {
  return redis.hgetall(checkpointKey(runId));
}
`,
  'workflow/ledger.ts': `/**
 * The effect ledger (provided): effect:{effect_id} holds the outcome recorded for one step's side
 * effect (for send_welcome, the message id). An effect id is "{run_id}:{step}".
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** The outcome recorded for the effect, or null when nothing was recorded. */
export async function done(effectId: string): Promise<string | null> {
  return redis.get(\`effect:\${effectId}\`);
}

/** Record the effect's outcome. */
export async function record(effectId: string, outcome: string): Promise<void> {
  await redis.set(\`effect:\${effectId}\`, outcome);
}

/** The steps of the run, in order, whose effect has no recorded outcome. */
export async function incomplete(runId: string, steps: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const step of steps) if ((await redis.exists(\`effect:\${runId}:\${step}\`)) === 0) out.push(step);
  return out;
}
`,
  'workflow/outbox.ts': `/**
 * The outbox (provided): the hash outbox maps an event id to a JSON row {"topic", "key", "payload"};
 * a relay republishes every row still there. insert writes the row, remove deletes it.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** Keep the event for the relay until it is removed. */
export async function insert(eventId: string, topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.hset('outbox', eventId, JSON.stringify({topic, key, payload}));
}

/** The broker has the event: the relay can forget it. */
export async function remove(eventId: string): Promise<void> {
  await redis.hdel('outbox', eventId);
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'workflow/definitions/definitions.go': `// Package definitions is the definition store (provided): every published version of a workflow
// is a Redis hash workflow:{name}:v{version} with name, version, steps (a JSON list of step names)
// and edges (a JSON list of [from, to] pairs); workflow:{name}:latest holds the highest version
// published.
package definitions

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Definition is one published version of a workflow.
type Definition struct {
	Name    string     \`json:"name"\`
	Version int        \`json:"version"\`
	Steps   []string   \`json:"steps"\`
	Edges   [][]string \`json:"edges"\`
}

// Key is the hash of that version of the workflow.
func Key(name string, version int) string {
	return fmt.Sprintf("workflow:%s:v%d", name, version)
}

// HasCycle reports whether the edges between the steps form a cycle: some step never runs out of
// predecessors.
func HasCycle(steps []string, edges [][]string) bool {
	indegree := map[string]int{}
	successors := map[string][]string{}
	for _, step := range steps {
		indegree[step] = 0
	}
	for _, edge := range edges {
		if len(edge) != 2 {
			continue
		}
		_, knownSource := indegree[edge[0]]
		_, knownTarget := indegree[edge[1]]
		if knownSource && knownTarget {
			successors[edge[0]] = append(successors[edge[0]], edge[1])
			indegree[edge[1]]++
		}
	}
	var ready []string
	for step, count := range indegree {
		if count == 0 {
			ready = append(ready, step)
		}
	}
	seen := 0
	for len(ready) > 0 {
		step := ready[len(ready)-1]
		ready = ready[:len(ready)-1]
		seen++
		for _, target := range successors[step] {
			indegree[target]--
			if indegree[target] == 0 {
				ready = append(ready, target)
			}
		}
	}
	return seen < len(indegree)
}

// Exists reports whether that version of the workflow has been published.
func Exists(ctx context.Context, name string, version int) bool {
	return rdb.Exists(ctx, Key(name, version)).Val() == 1
}

// Get is that version of the workflow, or nil.
func Get(ctx context.Context, name string, version int) *Definition {
	raw := rdb.HGetAll(ctx, Key(name, version)).Val()
	if len(raw) == 0 {
		return nil
	}
	d := &Definition{Name: raw["name"]}
	d.Version, _ = strconv.Atoi(raw["version"])
	json.Unmarshal([]byte(raw["steps"]), &d.Steps)
	json.Unmarshal([]byte(raw["edges"]), &d.Edges)
	return d
}

// Latest is the highest version of the workflow published so far, or nil.
func Latest(ctx context.Context, name string) *Definition {
	version, err := strconv.Atoi(rdb.Get(ctx, "workflow:"+name+":latest").Val())
	if err != nil {
		return nil
	}
	return Get(ctx, name, version)
}

// Put writes that version of the workflow, replacing whatever it held; latest moves when the
// version is higher.
func Put(ctx context.Context, name string, version int, steps []string, edges [][]string) {
	if edges == nil {
		edges = [][]string{}
	}
	stepsJSON, _ := json.Marshal(steps)
	edgesJSON, _ := json.Marshal(edges)
	rdb.HSet(ctx, Key(name, version), map[string]any{"name": name, "version": strconv.Itoa(version), "steps": string(stepsJSON), "edges": string(edgesJSON)})
	current, err := strconv.Atoi(rdb.Get(ctx, "workflow:"+name+":latest").Val())
	if err != nil || current < version {
		rdb.Set(ctx, "workflow:"+name+":latest", strconv.Itoa(version), 0)
	}
}
`,
  'workflow/runs/runs.go': `// Package runs is the run store (provided): run:{run_id} is a hash with run_id, tenant, workflow,
// definition_version, pinned_steps (a JSON list), input (a JSON document), max_steps and
// started_at (unix seconds). Create also writes the run's checkpoint run:{run_id}:checkpoint:
// current_step the first pinned step, completed "", output_ref "", updated_at the start. Run ids
// are run-1, run-2, …
package runs

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Run is one run of a pinned workflow version.
type Run struct {
	RunID             string         \`json:"run_id"\`
	Tenant            string         \`json:"tenant"\`
	Workflow          string         \`json:"workflow"\`
	DefinitionVersion int            \`json:"definition_version"\`
	PinnedSteps       []string       \`json:"pinned_steps"\`
	Input             map[string]any \`json:"input"\`
	MaxSteps          int            \`json:"max_steps"\`
	StartedAt         int64          \`json:"started_at"\`
}

// Create makes a new run of that workflow version with these pinned steps and returns it.
func Create(ctx context.Context, tenant, workflow string, version int, steps []string, input map[string]any, maxSteps int) *Run {
	runID := fmt.Sprintf("run-%d", rdb.Incr(ctx, "run:seq").Val())
	now := strconv.FormatInt(time.Now().Unix(), 10)
	if input == nil {
		input = map[string]any{}
	}
	stepsJSON, _ := json.Marshal(steps)
	inputJSON, _ := json.Marshal(input)
	rdb.HSet(ctx, "run:"+runID, map[string]any{
		"run_id": runID, "tenant": tenant, "workflow": workflow, "definition_version": strconv.Itoa(version),
		"pinned_steps": string(stepsJSON), "input": string(inputJSON), "max_steps": strconv.Itoa(maxSteps), "started_at": now,
	})
	first := ""
	if len(steps) > 0 {
		first = steps[0]
	}
	rdb.HSet(ctx, "run:"+runID+":checkpoint", map[string]any{"current_step": first, "completed": "", "output_ref": "", "updated_at": now})
	return Get(ctx, runID)
}

// Get is the run, or nil.
func Get(ctx context.Context, runID string) *Run {
	raw := rdb.HGetAll(ctx, "run:"+runID).Val()
	if len(raw) == 0 {
		return nil
	}
	run := &Run{RunID: raw["run_id"], Tenant: raw["tenant"], Workflow: raw["workflow"]}
	run.DefinitionVersion, _ = strconv.Atoi(raw["definition_version"])
	run.MaxSteps, _ = strconv.Atoi(raw["max_steps"])
	run.StartedAt, _ = strconv.ParseInt(raw["started_at"], 10, 64)
	json.Unmarshal([]byte(raw["pinned_steps"]), &run.PinnedSteps)
	json.Unmarshal([]byte(raw["input"]), &run.Input)
	return run
}
`,
  'workflow/blobs/blobs.go': `// Package blobs is the blob store (provided): blob:{n} holds one step output whole; Put returns its
// reference, the key itself ("blob:7").
package blobs

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Put stores data and returns its reference.
func Put(ctx context.Context, data string) (string, error) {
	n, err := rdb.Incr(ctx, "blob:seq").Result()
	if err != nil {
		return "", err
	}
	ref := fmt.Sprintf("blob:%d", n)
	return ref, rdb.Set(ctx, ref, data, 0).Err()
}

// Get is the data stored under ref; ok is false when there is none.
func Get(ctx context.Context, ref string) (data string, ok bool) {
	data, err := rdb.Get(ctx, ref).Result()
	return data, err == nil
}
`,
  'workflow/checkpoint/checkpoint.go': `// Package checkpoint is the run checkpoint (provided; step 2 builds advance):
// run:{run_id}:checkpoint is a hash with current_step ("" once the run finished), completed (the
// finished step names, comma-separated, in order), output_ref (the blob of the last output) and
// updated_at (unix seconds). Advance stores the output in the blob store, then moves the run in one
// Lua script only if current_step still equals fromStep, and reports whether it did; a run that
// finishes (toStep "") expires RetentionSeconds later. Read returns the hash (empty when the run has
// none).
package checkpoint

import (
	"context"

	"github.com/redis/go-redis/v9"

	"workflow/blobs"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// RetentionSeconds is how long a finished run's checkpoint stays.
const RetentionSeconds = 7 * 24 * 3600

// AdvanceScript moves the run from ARGV[1] to ARGV[2] only if current_step is still ARGV[1].
var AdvanceScript = redis.NewScript(\`
local current = redis.call('HGET', KEYS[1], 'current_step')
if current ~= ARGV[1] then return 0 end
local completed = redis.call('HGET', KEYS[1], 'completed')
if not completed or completed == '' then completed = ARGV[1] else completed = completed .. ',' .. ARGV[1] end
redis.call('HSET', KEYS[1], 'current_step', ARGV[2], 'completed', completed, 'output_ref', ARGV[3], 'updated_at', ARGV[4])
if ARGV[2] == '' then redis.call('EXPIRE', KEYS[1], ARGV[5]) end
return 1
\`)

// Key is the checkpoint hash of the run.
func Key(runID string) string { return "run:" + runID + ":checkpoint" }

// Advance moves the run from fromStep to toStep ("" when fromStep was the last); false when the run
// is not at fromStep.
func Advance(ctx context.Context, runID, fromStep, toStep, output string, now int64) (bool, error) {
	ref, err := blobs.Put(ctx, output)
	if err != nil {
		return false, err
	}
	moved, err := AdvanceScript.Run(ctx, rdb, []string{Key(runID)}, fromStep, toStep, ref, now, RetentionSeconds).Int()
	return moved == 1, err
}

// Read is the checkpoint hash, empty when the run has none.
func Read(ctx context.Context, runID string) map[string]string {
	return rdb.HGetAll(ctx, Key(runID)).Val()
}
`,
  'workflow/ledger/ledger.go': `// Package ledger is the effect ledger (provided): effect:{effect_id} holds the outcome recorded for
// one step's side effect (for send_welcome, the message id). An effect id is "{run_id}:{step}".
package ledger

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Done is the outcome recorded for the effect; ok is false when nothing was recorded.
func Done(ctx context.Context, effectID string) (outcome string, ok bool) {
	outcome, err := rdb.Get(ctx, "effect:"+effectID).Result()
	return outcome, err == nil
}

// Record records the effect's outcome.
func Record(ctx context.Context, effectID, outcome string) error {
	return rdb.Set(ctx, "effect:"+effectID, outcome, 0).Err()
}

// Incomplete is the steps of the run, in order, whose effect has no recorded outcome.
func Incomplete(ctx context.Context, runID string, steps []string) []string {
	out := []string{}
	for _, step := range steps {
		if rdb.Exists(ctx, "effect:"+runID+":"+step).Val() == 0 {
			out = append(out, step)
		}
	}
	return out
}
`,
  'workflow/outbox/outbox.go': `// Package outbox is the outbox (provided): the hash outbox maps an event id to a JSON row
// {"topic", "key", "payload"}; a relay republishes every row still there. Insert writes the row,
// Remove deletes it.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Insert keeps the event for the relay until it is removed.
func Insert(ctx context.Context, eventID, topic, key string, payload map[string]any) error {
	row, _ := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	return rdb.HSet(ctx, "outbox", eventID, string(row)).Err()
}

// Remove forgets the event: the broker has it.
func Remove(ctx context.Context, eventID string) error {
	return rdb.HDel(ctx, "outbox", eventID).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'workflow/definitions.h': `// The definition store (provided): every published version of a workflow is a Redis hash
// workflow:{name}:v{version} with name, version, steps (a JSON list of step names) and edges (a JSON
// list of [from, to] pairs); workflow:{name}:latest holds the highest version published.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace definitions {

struct Definition {
  std::string name;
  long version = 0;
  std::vector<std::string> steps;
  std::vector<std::vector<std::string>> edges;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string key(const std::string& name, long version) { return "workflow:" + name + ":v" + std::to_string(version); }

// Whether the edges between the steps form a cycle: some step never runs out of predecessors.
inline bool hasCycle(const std::vector<std::string>& steps, const std::vector<std::vector<std::string>>& edges) {
  std::map<std::string, int> indegree;
  std::map<std::string, std::vector<std::string>> successors;
  for (const auto& step : steps) indegree[step] = 0;
  for (const auto& edge : edges) {
    if (edge.size() != 2 || indegree.count(edge[0]) == 0 || indegree.count(edge[1]) == 0) continue;
    successors[edge[0]].push_back(edge[1]);
    indegree[edge[1]]++;
  }
  std::vector<std::string> ready;
  for (const auto& [step, n] : indegree) {
    if (n == 0) ready.push_back(step);
  }
  size_t seen = 0;
  while (!ready.empty()) {
    const std::string step = ready.back();
    ready.pop_back();
    seen++;
    for (const auto& target : successors[step]) {
      if (--indegree[target] == 0) ready.push_back(target);
    }
  }
  return seen < indegree.size();
}

// Whether that version of the workflow has been published.
inline bool exists(const std::string& name, long version) { return definitions::redis().exists(definitions::key(name, version)) == 1; }

// That version of the workflow, or none.
inline std::optional<Definition> get(const std::string& name, long version) {
  const std::unordered_map<std::string, std::string> raw = definitions::redis().hgetall(definitions::key(name, version));
  if (raw.empty()) return std::nullopt;
  Definition d;
  d.name = raw.at("name");
  d.version = std::stol(raw.at("version"));
  d.steps = nlohmann::json::parse(raw.at("steps")).get<std::vector<std::string>>();
  d.edges = nlohmann::json::parse(raw.at("edges")).get<std::vector<std::vector<std::string>>>();
  return d;
}

// The highest version of the workflow published so far, or none.
inline std::optional<Definition> latest(const std::string& name) {
  const auto version = definitions::redis().get("workflow:" + name + ":latest");
  if (!version) return std::nullopt;
  return definitions::get(name, std::stol(*version));
}

// Write that version of the workflow, replacing whatever it held; latest moves when the version is higher.
inline void put(const std::string& name, long version, const std::vector<std::string>& steps, const std::vector<std::vector<std::string>>& edges) {
  const nlohmann::json edgesJson = edges.empty() ? nlohmann::json::array() : nlohmann::json(edges);
  definitions::redis().hset(definitions::key(name, version), {{"name", name}, {"version", std::to_string(version)},
                                                             {"steps", nlohmann::json(steps).dump()}, {"edges", edgesJson.dump()}});
  const auto current = definitions::redis().get("workflow:" + name + ":latest");
  if (!current || std::stol(*current) < version) definitions::redis().set("workflow:" + name + ":latest", std::to_string(version));
}

}  // namespace definitions
`,
  'workflow/runs.h': `// Runs (provided): run:{run_id} is a hash with run_id, tenant, workflow, definition_version,
// pinned_steps (a JSON list), input (a JSON document), max_steps and started_at (unix seconds).
// create also writes the run's checkpoint run:{run_id}:checkpoint: current_step the first pinned
// step, completed "", output_ref "", updated_at the start. Run ids are run-1, run-2, …
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace runs {

struct Run {
  std::string run_id;
  std::string tenant;
  std::string workflow;
  long definition_version = 0;
  std::vector<std::string> pinned_steps;
  nlohmann::json input;
  long max_steps = 0;
  long long started_at = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The run, or none.
inline std::optional<Run> get(const std::string& run_id) {
  const std::unordered_map<std::string, std::string> raw = runs::redis().hgetall("run:" + run_id);
  if (raw.empty()) return std::nullopt;
  Run run;
  run.run_id = raw.at("run_id");
  run.tenant = raw.at("tenant");
  run.workflow = raw.at("workflow");
  run.definition_version = std::stol(raw.at("definition_version"));
  run.pinned_steps = nlohmann::json::parse(raw.at("pinned_steps")).get<std::vector<std::string>>();
  run.input = nlohmann::json::parse(raw.at("input"));
  run.max_steps = std::stol(raw.at("max_steps"));
  run.started_at = std::stoll(raw.at("started_at"));
  return run;
}

// A new run of that workflow version with these pinned steps; returns the run.
inline Run create(const std::string& tenant, const std::string& workflow, long version, const std::vector<std::string>& steps,
                  const nlohmann::json& input, long max_steps) {
  const std::string run_id = "run-" + std::to_string(runs::redis().incr("run:seq"));
  const std::string now =
      std::to_string(std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count());
  runs::redis().hset("run:" + run_id, {{"run_id", run_id},
                                       {"tenant", tenant},
                                       {"workflow", workflow},
                                       {"definition_version", std::to_string(version)},
                                       {"pinned_steps", nlohmann::json(steps).dump()},
                                       {"input", input.is_null() ? std::string("{}") : input.dump()},
                                       {"max_steps", std::to_string(max_steps)},
                                       {"started_at", now}});
  runs::redis().hset("run:" + run_id + ":checkpoint",
                     {{"current_step", steps.empty() ? std::string() : steps.front()}, {"completed", ""}, {"output_ref", ""}, {"updated_at", now}});
  return *runs::get(run_id);
}

}  // namespace runs
`,
  'workflow/blobs.h': `// The blob store (provided): blob:{n} holds one step output whole; put returns its reference, the
// key itself ("blob:7").
#pragma once

#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

namespace blobs {

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Store data; returns its reference.
inline std::string put(const std::string& data) {
  const std::string ref = "blob:" + std::to_string(blobs::redis().incr("blob:seq"));
  blobs::redis().set(ref, data);
  return ref;
}

// The data stored under ref, or none.
inline std::optional<std::string> get(const std::string& ref) {
  const auto data = blobs::redis().get(ref);
  if (!data) return std::nullopt;
  return *data;
}

}  // namespace blobs
`,
  'workflow/checkpoint.h': `// The run checkpoint (provided; step 2 builds advance): run:{run_id}:checkpoint is a hash with
// current_step ("" once the run finished), completed (the finished step names, comma-separated, in
// order), output_ref (the blob of the last output) and updated_at (unix seconds). advance stores the
// output in the blob store, then moves the run in one Lua script only if current_step still equals
// from_step, and reports whether it did; a run that finishes (to_step "") expires
// kRetentionSeconds later. read returns the hash (empty when the run has none).
#pragma once

#include <sw/redis++/redis++.h>

#include <string>
#include <unordered_map>

#include "workflow/blobs.h"

namespace checkpoint {

constexpr long kRetentionSeconds = 7 * 24 * 3600;

inline const std::string kAdvanceLua = R"lua(
local current = redis.call('HGET', KEYS[1], 'current_step')
if current ~= ARGV[1] then return 0 end
local completed = redis.call('HGET', KEYS[1], 'completed')
if not completed or completed == '' then completed = ARGV[1] else completed = completed .. ',' .. ARGV[1] end
redis.call('HSET', KEYS[1], 'current_step', ARGV[2], 'completed', completed, 'output_ref', ARGV[3], 'updated_at', ARGV[4])
if ARGV[2] == '' then redis.call('EXPIRE', KEYS[1], ARGV[5]) end
return 1
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string key(const std::string& run_id) { return "run:" + run_id + ":checkpoint"; }

// Move the run from from_step to to_step ("" when from_step was the last); false when the run is not at from_step.
inline bool advance(const std::string& run_id, const std::string& from_step, const std::string& to_step, const std::string& output, long long now) {
  const std::string ref = blobs::put(output);
  return checkpoint::redis().eval<long long>(kAdvanceLua, {checkpoint::key(run_id)},
                                             {from_step, to_step, ref, std::to_string(now), std::to_string(kRetentionSeconds)}) == 1;
}

// The checkpoint hash, empty when the run has none.
inline std::unordered_map<std::string, std::string> read(const std::string& run_id) {
  return checkpoint::redis().hgetall(checkpoint::key(run_id));
}

}  // namespace checkpoint
`,
  'workflow/ledger.h': `// The effect ledger (provided): effect:{effect_id} holds the outcome recorded for one step's side
// effect (for send_welcome, the message id). An effect id is "{run_id}:{step}".
#pragma once

#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <vector>

namespace ledger {

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The outcome recorded for the effect, or none when nothing was recorded.
inline std::optional<std::string> done(const std::string& effect_id) {
  const auto outcome = ledger::redis().get("effect:" + effect_id);
  if (!outcome) return std::nullopt;
  return *outcome;
}

// Record the effect's outcome.
inline void record(const std::string& effect_id, const std::string& outcome) { ledger::redis().set("effect:" + effect_id, outcome); }

// The steps of the run, in order, whose effect has no recorded outcome.
inline std::vector<std::string> incomplete(const std::string& run_id, const std::vector<std::string>& steps) {
  std::vector<std::string> out;
  for (const auto& step : steps) {
    if (ledger::redis().exists("effect:" + run_id + ":" + step) == 0) out.push_back(step);
  }
  return out;
}

}  // namespace ledger
`,
  'workflow/outbox.h': `// The outbox (provided): the hash outbox maps an event id to a JSON row {"topic", "key", "payload"};
// a relay republishes every row still there. insert writes the row, remove deletes it.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

namespace outbox {

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Keep the event for the relay until it is removed.
inline void insert(const std::string& event_id, const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  outbox::redis().hset("outbox", event_id, nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

// The broker has the event: the relay can forget it.
inline void remove(const std::string& event_id) { outbox::redis().hdel("outbox", event_id); }

}  // namespace outbox
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('workflow', 'Definitions')]: `package workflow

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

/**
 * The definition store (provided): every published version of a workflow is a Redis hash
 * workflow:{name}:v{version} with name, version, steps (a JSON list of step names) and edges (a
 * JSON list of [from, to] pairs); workflow:{name}:latest holds the highest version published.
 */
object Definitions {
  final case class Definition(name: String, version: Long, steps: Seq[String], edges: Seq[Seq[String]])

  val jedis = new JedisPooled("redis", 6379)

  def key(name: String, version: Long): String = s"workflow:$name:v$version"

  /** Whether the edges between the steps form a cycle: some step never runs out of predecessors. */
  def hasCycle(steps: Seq[String], edges: Seq[Seq[String]]): Boolean = {
    val indegree = scala.collection.mutable.Map.from(steps.map(_ -> 0))
    val successors = scala.collection.mutable.Map.from(steps.map(_ -> List.empty[String]))
    edges.foreach {
      case Seq(source, target) if indegree.contains(source) && indegree.contains(target) =>
        successors(source) = target :: successors(source)
        indegree(target) += 1
      case _ =>
    }
    var ready = indegree.collect { case (step, 0) => step }.toList
    var seen = 0
    while (ready.nonEmpty) {
      val step = ready.head
      ready = ready.tail
      seen += 1
      successors(step).foreach { target =>
        indegree(target) -= 1
        if (indegree(target) == 0) ready = target :: ready
      }
    }
    seen < indegree.size
  }

  /** Whether that version of the workflow has been published. */
  def exists(name: String, version: Long): Boolean = jedis.exists(key(name, version))

  /** That version of the workflow, if published. */
  def get(name: String, version: Long): Option[Definition] = {
    val raw = jedis.hgetAll(key(name, version)).asScala
    if (raw.isEmpty) None
    else Some(Definition(raw("name"), raw("version").toLong, raw("steps").parseJson.convertTo[Seq[String]], raw("edges").parseJson.convertTo[Seq[Seq[String]]]))
  }

  /** The highest version of the workflow published so far. */
  def latest(name: String): Option[Definition] = Option(jedis.get(s"workflow:$name:latest")).flatMap(version => get(name, version.toLong))

  /** Write that version of the workflow, replacing whatever it held; latest moves when the version is higher. */
  def put(name: String, version: Long, steps: Seq[String], edges: Seq[Seq[String]]): Unit = {
    jedis.hset(key(name, version), Map("name" -> name, "version" -> version.toString, "steps" -> steps.toJson.compactPrint, "edges" -> edges.toJson.compactPrint).asJava)
    if (Option(jedis.get(s"workflow:$name:latest")).forall(_.toLong < version)) jedis.set(s"workflow:$name:latest", version.toString)
  }
}
`,
  [scalaPath('workflow', 'Runs')]: `package workflow

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

/**
 * Runs (provided): run:{run_id} is a hash with run_id, tenant, workflow, definition_version,
 * pinned_steps (a JSON list), input (a JSON document), max_steps and started_at (unix seconds).
 * create also writes the run's checkpoint run:{run_id}:checkpoint: current_step the first pinned
 * step, completed "", output_ref "", updated_at the start. Run ids are run-1, run-2, …
 */
object Runs {
  final case class Run(runId: String, tenant: String, workflow: String, definitionVersion: Long, pinnedSteps: Seq[String], input: JsObject, maxSteps: Int, startedAt: Long)

  val jedis = new JedisPooled("redis", 6379)

  /** A new run of that workflow version with these pinned steps; returns the run. */
  def create(tenant: String, workflow: String, version: Long, steps: Seq[String], input: JsObject, maxSteps: Int): Run = {
    val runId = s"run-\${jedis.incr("run:seq")}"
    val now = (System.currentTimeMillis() / 1000).toString
    jedis.hset(
      s"run:$runId",
      Map(
        "run_id" -> runId, "tenant" -> tenant, "workflow" -> workflow, "definition_version" -> version.toString,
        "pinned_steps" -> steps.toJson.compactPrint, "input" -> input.compactPrint, "max_steps" -> maxSteps.toString, "started_at" -> now
      ).asJava
    )
    jedis.hset(s"run:$runId:checkpoint", Map("current_step" -> steps.headOption.getOrElse(""), "completed" -> "", "output_ref" -> "", "updated_at" -> now).asJava)
    get(runId).get
  }

  /** The run, if it exists. */
  def get(runId: String): Option[Run] = {
    val raw = jedis.hgetAll(s"run:$runId").asScala
    if (raw.isEmpty) None
    else
      Some(Run(raw("run_id"), raw("tenant"), raw("workflow"), raw("definition_version").toLong, raw("pinned_steps").parseJson.convertTo[Seq[String]],
        raw("input").parseJson.asJsObject, raw("max_steps").toInt, raw("started_at").toLong))
  }
}
`,
  [scalaPath('workflow', 'Blobs')]: `package workflow

import redis.clients.jedis.JedisPooled

/** The blob store (provided): blob:{n} holds one step output whole; put returns its reference, the key itself ("blob:7"). */
object Blobs {
  val jedis = new JedisPooled("redis", 6379)

  /** Store data; returns its reference. */
  def put(data: String): String = {
    val ref = s"blob:\${jedis.incr("blob:seq")}"
    jedis.set(ref, data)
    ref
  }

  /** The data stored under ref, if any. */
  def get(ref: String): Option[String] = Option(jedis.get(ref))
}
`,
  [scalaPath('workflow', 'Checkpoint')]: `package workflow

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The run checkpoint (provided; step 2 builds advance): run:{run_id}:checkpoint is a hash with
 * current_step ("" once the run finished), completed (the finished step names, comma-separated, in
 * order), output_ref (the blob of the last output) and updated_at (unix seconds). advance stores
 * the output in the blob store, then moves the run in one Lua script only if current_step still
 * equals fromStep, and reports whether it did; a run that finishes (toStep "") expires
 * RetentionSeconds later. read returns the hash (empty when the run has none).
 */
object Checkpoint {
  val jedis = new JedisPooled("redis", 6379)

  val RetentionSeconds: Long = 7L * 24 * 3600

  val AdvanceLua: String =
    """local current = redis.call('HGET', KEYS[1], 'current_step')
      |if current ~= ARGV[1] then return 0 end
      |local completed = redis.call('HGET', KEYS[1], 'completed')
      |if not completed or completed == '' then completed = ARGV[1] else completed = completed .. ',' .. ARGV[1] end
      |redis.call('HSET', KEYS[1], 'current_step', ARGV[2], 'completed', completed, 'output_ref', ARGV[3], 'updated_at', ARGV[4])
      |if ARGV[2] == '' then redis.call('EXPIRE', KEYS[1], ARGV[5]) end
      |return 1
      |""".stripMargin

  def key(runId: String): String = s"run:$runId:checkpoint"

  /** Move the run from fromStep to toStep ("" when fromStep was the last); false when the run is not at fromStep. */
  def advance(runId: String, fromStep: String, toStep: String, output: String, now: Long): Boolean = {
    val ref = Blobs.put(output)
    val args = List(fromStep, toStep, ref, now.toString, RetentionSeconds.toString).asJava
    jedis.eval(AdvanceLua, List(key(runId)).asJava, args).asInstanceOf[java.lang.Long] == 1L
  }

  /** The checkpoint hash, empty when the run has none. */
  def read(runId: String): Map[String, String] = jedis.hgetAll(key(runId)).asScala.toMap
}
`,
  [scalaPath('workflow', 'Ledger')]: `package workflow

import redis.clients.jedis.JedisPooled

/**
 * The effect ledger (provided): effect:{effect_id} holds the outcome recorded for one step's side
 * effect (for send_welcome, the message id). An effect id is "{run_id}:{step}".
 */
object Ledger {
  val jedis = new JedisPooled("redis", 6379)

  /** The outcome recorded for the effect, if any. */
  def done(effectId: String): Option[String] = Option(jedis.get(s"effect:$effectId"))

  /** Record the effect's outcome. */
  def record(effectId: String, outcome: String): Unit = jedis.set(s"effect:$effectId", outcome)

  /** The steps of the run, in order, whose effect has no recorded outcome. */
  def incomplete(runId: String, steps: Seq[String]): Seq[String] = steps.filterNot(step => jedis.exists(s"effect:$runId:$step"))
}
`,
  [scalaPath('workflow', 'Outbox')]: `package workflow

import redis.clients.jedis.JedisPooled
import spray.json._

/**
 * The outbox (provided): the hash outbox maps an event id to a JSON row {"topic", "key", "payload"};
 * a relay republishes every row still there. insert writes the row, remove deletes it.
 */
object Outbox {
  val jedis = new JedisPooled("redis", 6379)

  /** Keep the event for the relay until it is removed. */
  def insert(eventId: String, topic: String, key: String, payload: JsObject): Unit =
    jedis.hset("outbox", eventId, JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)

  /** The broker has the event: the relay can forget it. */
  def remove(eventId: String): Unit = jedis.hdel("outbox", eventId)
}
`,
};
