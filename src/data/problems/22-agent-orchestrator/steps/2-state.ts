import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis run state with atomic transitions and leases',
  concept: 'redis',
  file: 'state',
  focus: ['worker', 'redis', 'api'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it reads the run document,
patches the state in the client and writes it back, so one worker advancing one run looks correct in
the demo. It hides a lost update, a missing lease, a missing expiry and an unbounded state
vocabulary. Review it like the owner of the worker pool, fix it, and prove the fix with the checks
below.

Implement the Redis run state machine that every worker step goes through:

- A run is in exactly one of **five** states: \`pending\`, \`running\`, \`waiting_tool\`, \`done\`,
  \`failed\`. A transition to any other state is refused, and so is a step out of a terminal state.
- The accepted transitions are \`pending → running|failed\`, \`running → waiting_tool|done|failed\`
  and \`waiting_tool → running|failed\`; \`done\` and \`failed\` are terminal.
- One step is **one atomic script** (\`EVAL\` / \`NewScript\`): it reads the lease, validates the
  transition and writes state, lease and TTL in a single server-side call. A client-side
  \`GET\`-then-\`SET\` lets a resumed run and its zombie twin both advance the same run.
- The executing worker holds a lease (\`run:{id}:lease\`, value = worker id). A live lease held by
  another worker is refused with status \`-1\`, so exactly one worker advances a run.
- The lease expires after **1800 s** from one constant, set when the lease is taken and refreshed on
  every accepted transition — a worker that keeps making progress keeps its run.
- A run whose lease expired is **recoverable**: the claim path reopens a non-terminal run as
  \`running\` under the new worker instead of leaving it stranded; a terminal run is never reopened.
- Key the run as \`run:{run_id}\` and move only the fields you touch: a single state change never
  rewrites the whole run document from a stale read.

**Failure mode the checks target.** The draft reads the run, mutates it and writes the whole document
back with a plain \`SET\`, so a resumed run and a zombie twin that both read the same state each write
their own step and one advance is silently lost. It never takes a lease, so it cannot tell the twin
from the owner; it never sets an expiry, so a worker that dies mid-step leaves the run in \`running\`
forever with no path back; and it stores whatever state string it is handed, so a typo invents a
sixth state and a finished run can be moved back to \`running\`.`,
  sequence: {
    participants: ['Worker', 'Run state', 'Run API'],
    messages: [
      {
        from: 'Worker',
        to: 'Run state',
        label: 'EVAL transition · KEYS[run:4831, run:4831:lease] · worker=w-7 · to=running',
        kind: 'sync',
      },
      {from: 'Run state', to: 'Worker', label: '1 · state=running, lease refreshed to 1800 s', kind: 'reply'},
      {
        from: 'Worker',
        to: 'Run state',
        label: 'EVAL transition · worker=w-9 (zombie twin, same run)',
        kind: 'sync',
      },
      {from: 'Run state', to: 'Worker', label: '-1 LEASE_HELD · w-7 still owns the run', kind: 'reply'},
      {from: 'Run API', to: 'Run state', label: 'EVAL recover · lease key gone after the crash', kind: 'async'},
      {from: 'Run state', to: 'Run API', label: '1 · run reopened as running for w-9', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'atomic-transition',
      title: 'Moves state with one atomic Redis script',
      detail:
        'The state write, the lease acquisition and the TTL refresh happen inside one server-side script (`EVAL` / `NewScript` / Lua `redis.call`), never as a client-side `GET`-then-`SET` sequence that two workers can interleave. The draft does exactly that client-side sequence.',
      match: {
        python: {all: [/TRANSITION_LUA/, /\.eval\(/, /redis\.call\('HSET'/, /redis\.call\('EXPIRE'/]},
        typescript: {all: [/TRANSITION_LUA/, /\.eval\(/, /redis\.call\('HSET'/, /redis\.call\('EXPIRE'/]},
        go: {all: [/transitionScript/, /\.Run\(/, /redis\.call\('HSET'/, /redis\.call\('EXPIRE'/]},
        scala: {all: [/TransitionLua/, /\.eval\(/, /redis\.call\('HSET'/, /redis\.call\('EXPIRE'/]},
        cpp: {all: [/kTransitionLua/, /\.eval</, /redis\.call\('HSET'/, /redis\.call\('EXPIRE'/]},
      },
    },
    {
      id: 'lease-guard',
      title: 'Refuses a second worker on a leased run',
      detail:
        'The script reads the lease and compares the owner against the calling worker, returning a refusal status (`-1` / `LEASE_HELD`) when another worker holds a live lease, so a resumed run and its zombie twin cannot both advance steps. The draft holds no lease at all, so both writers proceed.',
      match: {
        python: {all: [/TRANSITION_LUA/, /redis\.call\('GET', KEYS\[2\]\)/, /lease ~= ARGV\[1\]/, /LEASE_HELD/]},
        typescript: {all: [/TRANSITION_LUA/, /redis\.call\('GET', KEYS\[2\]\)/, /lease ~= ARGV\[1\]/, /LEASE_HELD/]},
        go: {all: [/transitionScript/, /redis\.call\('GET', KEYS\[2\]\)/, /lease ~= ARGV\[1\]/, /leaseHeld/]},
        scala: {all: [/TransitionLua/, /redis\.call\('GET', KEYS\[2\]\)/, /lease ~= ARGV\[1\]/, /LeaseHeld/]},
        cpp: {all: [/kTransitionLua/, /redis\.call\('GET', KEYS\[2\]\)/, /lease ~= ARGV\[1\]/, /kLeaseHeld/]},
      },
    },
    {
      id: 'ttl-refresh',
      title: 'Expires the lease after 30 minutes and refreshes it on progress',
      detail:
        'The lease key gets its expiry from one constant — **1800 s** (`30 * 60`) — written inside the same script when the lease is taken and `EXPIRE`d again on every accepted transition, so a worker that keeps making progress keeps its run. The draft never expires anything.',
      match: {
        python: {all: [/LEASE_TTL_S/, /1800/, /redis\.call\('EXPIRE'/, /redis\.call\('SET', KEYS\[2\]/]},
        typescript: {all: [/LEASE_TTL_S/, /1800/, /redis\.call\('EXPIRE'/, /redis\.call\('SET', KEYS\[2\]/]},
        go: {all: [/leaseTtlSeconds/, /1800/, /redis\.call\('EXPIRE'/, /redis\.call\('SET', KEYS\[2\]/]},
        scala: {all: [/LeaseTtlSeconds/, /1800/, /redis\.call\('EXPIRE'/, /redis\.call\('SET', KEYS\[2\]/]},
        cpp: {all: [/kLeaseTtlSeconds/, /1800/, /redis\.call\('EXPIRE'/, /redis\.call\('SET', KEYS\[2\]/]},
      },
    },
    {
      id: 'recover',
      title: 'Reopens a crashed run for recovery',
      detail:
        'Once the lease key is gone (`EXISTS` returns 0) a `recover`/claim path takes the non-terminal run over and reopens it as `running` under the new worker, instead of leaving it stranded in `waiting_tool`. The draft has no expiry and no claim path, so a dead worker’s run is stuck forever.',
      match: {
        python: {all: [/RECOVER_LUA/, /def recover\(/, /redis\.call\('EXISTS', KEYS\[2\]\)/]},
        typescript: {all: [/RECOVER_LUA/, /function recover\(/, /redis\.call\('EXISTS', KEYS\[2\]\)/]},
        go: {all: [/recoverScript/, /func recoverRun\(/, /redis\.call\('EXISTS', KEYS\[2\]\)/]},
        scala: {all: [/RecoverLua/, /def recover\(/, /redis\.call\('EXISTS', KEYS\[2\]\)/]},
        cpp: {all: [/kRecoverLua/, /recoverRun\(/, /redis\.call\('EXISTS', KEYS\[2\]\)/]},
      },
    },
    {
      id: 'states',
      title: 'Allows only the documented transitions',
      detail:
        'The five states `pending`, `running`, `waiting_tool`, `done` and `failed` are the only legal ones, and the transition table refuses a step it does not list — an unknown target or a step out of `done`/`failed` — with status `-3`. The draft stores any state string it is handed.',
      match: {
        python: {all: [/STATES/, /waiting_tool/, /pending:running/, /ILLEGAL_STATE/]},
        typescript: {all: [/STATES/, /waiting_tool/, /pending:running/, /ILLEGAL_STATE/]},
        go: {all: [/var states = map\[string\]bool/, /waiting_tool/, /pending:running/, /illegalState/]},
        scala: {all: [/States/, /waiting_tool/, /pending:running/, /IllegalState/]},
        cpp: {all: [/kStates/, /waiting_tool/, /pending:running/, /kIllegalState/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class RunStore:
    """Idempotency records for the start endpoint: (tenant, key) -> run document."""

    def get(self, tenant: str, key: str) -> dict | None:
        raw = r.get(f"idem:{tenant}:{key}")
        return json.loads(raw) if raw else None

    def put(self, tenant: str, key: str, run: dict) -> None:
        r.set(f"idem:{tenant}:{key}", json.dumps(run))


store = RunStore()


def run_key(run_id: str) -> str:
    return f"run:{run_id}"


def transition(run_id: str, worker_id: str, to_state: str) -> dict:
    # TODO: the draft reads the run, patches it in the client and writes the whole document back
    # with a plain SET, so two workers interleave; it never takes a lease, never sets an expiry, and
    # stores whatever state string it is handed. Review all of it.
    run = json.loads(r.get(run_key(run_id)) or "{}")
    run["state"] = to_state
    run["worker"] = worker_id
    run["steps_used"] = run.get("steps_used", 0) + 1
    r.set(run_key(run_id), json.dumps(run))
    return run
`,
      solution: `import json

import redis
from fastapi import FastAPI

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# 30 minutes: long enough for one slow tool call, short enough that a crashed worker's run comes
# back instead of sitting in "running" forever.
LEASE_TTL_S = 1800
STATES = frozenset({"pending", "running", "waiting_tool", "done", "failed"})

# What the transition script returns; the worker pool branches on these.
OK = 1
LEASE_HELD = -1
UNKNOWN_RUN = -2
ILLEGAL_STATE = -3

TRANSITION_LUA = """
local lease = redis.call('GET', KEYS[2])
if lease and lease ~= ARGV[1] then
  return -1
end
local state = redis.call('HGET', KEYS[1], 'state')
if not state then
  return -2
end
local allowed = {
  ['pending:running'] = true,
  ['pending:failed'] = true,
  ['running:waiting_tool'] = true,
  ['running:done'] = true,
  ['running:failed'] = true,
  ['waiting_tool:running'] = true,
  ['waiting_tool:failed'] = true,
}
if not allowed[state .. ':' .. ARGV[2]] then
  return -3
end
redis.call('HSET', KEYS[1], 'state', ARGV[2], 'worker', ARGV[1])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
return 1
"""

RECOVER_LUA = """
local state = redis.call('HGET', KEYS[1], 'state')
if not state then
  return -2
end
if state == 'done' or state == 'failed' then
  return -3
end
if redis.call('EXISTS', KEYS[2]) == 1 then
  return -1
end
redis.call('HSET', KEYS[1], 'state', 'running', 'worker', ARGV[1])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))
return 1
"""


class RunStore:
    """Idempotency records for the start endpoint: (tenant, key) -> run document."""

    def get(self, tenant: str, key: str) -> dict | None:
        raw = r.get(f"idem:{tenant}:{key}")
        return json.loads(raw) if raw else None

    def put(self, tenant: str, key: str, run: dict) -> None:
        r.set(f"idem:{tenant}:{key}", json.dumps(run))


store = RunStore()


def run_key(run_id: str) -> str:
    return f"run:{run_id}"


def lease_key(run_id: str) -> str:
    return f"run:{run_id}:lease"


def transition(run_id: str, worker_id: str, to_state: str) -> int:
    """Move one run a step forward under this worker's lease, atomically, refreshing the lease."""
    if to_state not in STATES:
        return ILLEGAL_STATE
    return int(
        r.eval(TRANSITION_LUA, 2, run_key(run_id), lease_key(run_id), worker_id, to_state, LEASE_TTL_S)
    )


def recover(run_id: str, worker_id: str) -> int:
    """Take over a run whose lease expired because its worker died mid-step."""
    return int(r.eval(RECOVER_LUA, 2, run_key(run_id), lease_key(run_id), worker_id, LEASE_TTL_S))
`,
    },
    typescript: {
      starter: `/** Run state: a model-generated draft that patches the run document from the client. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

interface Run {
  run_id: string;
  status: string;
  max_steps: number;
  steps_used: number;
  tools: string[];
}

/** Idempotency records for the start endpoint: (tenant, key) -> run document. */
class RunStore {
  async get(tenant: string, idemKey: string): Promise<Run | null> {
    const raw = await r.get(\`idem:\${tenant}:\${idemKey}\`);
    return raw === null ? null : (JSON.parse(raw) as Run);
  }

  async put(tenant: string, idemKey: string, run: Run): Promise<void> {
    await r.set(\`idem:\${tenant}:\${idemKey}\`, JSON.stringify(run));
  }
}

export const store = new RunStore();

function runKey(runId: string): string {
  return \`run:\${runId}\`;
}

export async function transition(runId: string, workerId: string, toState: string): Promise<Run> {
  // TODO: the draft reads the run, patches it in the client and writes the whole document back
  // with a plain SET, so two workers interleave; it never takes a lease, never sets an expiry, and
  // stores whatever state string it is handed. Review all of it.
  const raw = await r.get(runKey(runId));
  const run = (raw === null ? {} : JSON.parse(raw)) as Partial<Run>;
  run.status = toState;
  run.steps_used = (run.steps_used ?? 0) + 1;
  await r.set(runKey(runId), JSON.stringify(run));
  return run as Run;
}
`,
      solution: `/** Run state: one atomic script per transition under a worker lease, plus recovery. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

/** 30 minutes: long enough for one slow tool call, short enough that a crashed run comes back. */
export const LEASE_TTL_S = 1800;
export const STATES: Record<string, true> = {
  pending: true,
  running: true,
  waiting_tool: true,
  done: true,
  failed: true,
};

/** What the transition script returns; the worker pool branches on these. */
export const OK = 1;
export const LEASE_HELD = -1;
export const UNKNOWN_RUN = -2;
export const ILLEGAL_STATE = -3;

const TRANSITION_LUA = \`
local lease = redis.call('GET', KEYS[2])
if lease and lease ~= ARGV[1] then
  return -1
end
local state = redis.call('HGET', KEYS[1], 'state')
if not state then
  return -2
end
local allowed = {
  ['pending:running'] = true,
  ['pending:failed'] = true,
  ['running:waiting_tool'] = true,
  ['running:done'] = true,
  ['running:failed'] = true,
  ['waiting_tool:running'] = true,
  ['waiting_tool:failed'] = true,
}
if not allowed[state .. ':' .. ARGV[2]] then
  return -3
end
redis.call('HSET', KEYS[1], 'state', ARGV[2], 'worker', ARGV[1])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
return 1
\`;

const RECOVER_LUA = \`
local state = redis.call('HGET', KEYS[1], 'state')
if not state then
  return -2
end
if state == 'done' or state == 'failed' then
  return -3
end
if redis.call('EXISTS', KEYS[2]) == 1 then
  return -1
end
redis.call('HSET', KEYS[1], 'state', 'running', 'worker', ARGV[1])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))
return 1
\`;

interface Run {
  run_id: string;
  status: string;
  max_steps: number;
  steps_used: number;
  tools: string[];
}

/** Idempotency records for the start endpoint: (tenant, key) -> run document. */
class RunStore {
  async get(tenant: string, idemKey: string): Promise<Run | null> {
    const raw = await r.get(\`idem:\${tenant}:\${idemKey}\`);
    return raw === null ? null : (JSON.parse(raw) as Run);
  }

  async put(tenant: string, idemKey: string, run: Run): Promise<void> {
    await r.set(\`idem:\${tenant}:\${idemKey}\`, JSON.stringify(run));
  }
}

export const store = new RunStore();

function runKey(runId: string): string {
  return \`run:\${runId}\`;
}

function leaseKey(runId: string): string {
  return \`run:\${runId}:lease\`;
}

/** Move one run a step forward under this worker's lease, atomically, refreshing the lease. */
export async function transition(runId: string, workerId: string, toState: string): Promise<number> {
  if (STATES[toState] !== true) return ILLEGAL_STATE;
  return (await r.eval(TRANSITION_LUA, 2, runKey(runId), leaseKey(runId), workerId, toState, LEASE_TTL_S)) as number;
}

/** Take over a run whose lease expired because its worker died mid-step. */
export async function recover(runId: string, workerId: string): Promise<number> {
  return (await r.eval(RECOVER_LUA, 2, runKey(runId), leaseKey(runId), workerId, LEASE_TTL_S)) as number;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

type Run struct {
	RunID     string   \`json:"run_id"\`
	Status    string   \`json:"status"\`
	MaxSteps  int      \`json:"max_steps"\`
	StepsUsed int      \`json:"steps_used"\`
	Tools     []string \`json:"tools"\`
}

type RunStore struct{}

func (s *RunStore) Get(ctx context.Context, tenant, idemKey string) (*Run, error) {
	raw, err := rdb.Get(ctx, "idem:"+tenant+":"+idemKey).Bytes()
	if err != nil {
		return nil, nil
	}
	var run Run
	if err := json.Unmarshal(raw, &run); err != nil {
		return nil, err
	}
	return &run, nil
}

func (s *RunStore) Put(ctx context.Context, tenant, idemKey string, run *Run) error {
	raw, err := json.Marshal(run)
	if err != nil {
		return err
	}
	return rdb.Set(ctx, "idem:"+tenant+":"+idemKey, raw, 0).Err()
}

var store = &RunStore{}

func runKey(runID string) string {
	return "run:" + runID
}

func transition(ctx context.Context, runID, workerID, toState string) (*Run, error) {
	// TODO: the draft reads the run, patches it in the client and writes the whole document back
	// with a plain SET, so two workers interleave; it never takes a lease, never sets an expiry, and
	// stores whatever state string it is handed. Review all of it.
	raw, err := rdb.Get(ctx, runKey(runID)).Bytes()
	if err != nil {
		return nil, err
	}
	var run Run
	if err := json.Unmarshal(raw, &run); err != nil {
		return nil, err
	}
	run.Status = toState
	run.StepsUsed++
	patched, err := json.Marshal(run)
	if err != nil {
		return nil, err
	}
	if err := rdb.Set(ctx, runKey(runID), patched, 0).Err(); err != nil {
		return nil, err
	}
	return &run, nil
}

func main() {}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

// leaseTtlSeconds is the 30-minute lease: long enough for one slow tool call, short enough that a
// crashed worker's run is recovered instead of stranded.
const leaseTtlSeconds = 1800

// What the transition script returns; the worker pool branches on these.
const (
	ok           = 1
	leaseHeld    = -1
	unknownRun   = -2
	illegalState = -3
)

var states = map[string]bool{
	"pending":      true,
	"running":      true,
	"waiting_tool": true,
	"done":         true,
	"failed":       true,
}

var transitionScript = redis.NewScript(\`
local lease = redis.call('GET', KEYS[2])
if lease and lease ~= ARGV[1] then
  return -1
end
local state = redis.call('HGET', KEYS[1], 'state')
if not state then
  return -2
end
local allowed = {
  ['pending:running'] = true,
  ['pending:failed'] = true,
  ['running:waiting_tool'] = true,
  ['running:done'] = true,
  ['running:failed'] = true,
  ['waiting_tool:running'] = true,
  ['waiting_tool:failed'] = true,
}
if not allowed[state .. ':' .. ARGV[2]] then
  return -3
end
redis.call('HSET', KEYS[1], 'state', ARGV[2], 'worker', ARGV[1])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
return 1
\`)

var recoverScript = redis.NewScript(\`
local state = redis.call('HGET', KEYS[1], 'state')
if not state then
  return -2
end
if state == 'done' or state == 'failed' then
  return -3
end
if redis.call('EXISTS', KEYS[2]) == 1 then
  return -1
end
redis.call('HSET', KEYS[1], 'state', 'running', 'worker', ARGV[1])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))
return 1
\`)

var rdb *redis.Client

type Run struct {
	RunID     string   \`json:"run_id"\`
	Status    string   \`json:"status"\`
	MaxSteps  int      \`json:"max_steps"\`
	StepsUsed int      \`json:"steps_used"\`
	Tools     []string \`json:"tools"\`
}

type RunStore struct{}

func (s *RunStore) Get(ctx context.Context, tenant, idemKey string) (*Run, error) {
	raw, err := rdb.Get(ctx, "idem:"+tenant+":"+idemKey).Bytes()
	if err != nil {
		return nil, nil
	}
	var run Run
	if err := json.Unmarshal(raw, &run); err != nil {
		return nil, err
	}
	return &run, nil
}

func (s *RunStore) Put(ctx context.Context, tenant, idemKey string, run *Run) error {
	raw, err := json.Marshal(run)
	if err != nil {
		return err
	}
	return rdb.Set(ctx, "idem:"+tenant+":"+idemKey, raw, 0).Err()
}

var store = &RunStore{}

func runKey(runID string) string {
	return "run:" + runID
}

func leaseKey(runID string) string {
	return "run:" + runID + ":lease"
}

// transition moves one run a step forward under workerID's lease, atomically, and refreshes it.
func transition(ctx context.Context, runID, workerID, toState string) (int64, error) {
	if !states[toState] {
		return illegalState, nil
	}
	return transitionScript.
		Run(ctx, rdb, []string{runKey(runID), leaseKey(runID)}, workerID, toState, leaseTtlSeconds).
		Int64()
}

// recoverRun takes over a run whose lease expired because its worker died mid-step.
func recoverRun(ctx context.Context, runID, workerID string) (int64, error) {
	return recoverScript.Run(ctx, rdb, []string{runKey(runID), leaseKey(runID)}, workerID, leaseTtlSeconds).Int64()
}

func main() {}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object State {
  val jedis = new Jedis("redis", 6379)

  def idemKey(tenant: String, key: String): String = s"idem:$tenant:$key"

  /** The stored run document for (tenant, Idempotency-Key), as the API wrote it. */
  def get(tenant: String, key: String): Option[String] = Option(jedis.get(idemKey(tenant, key)))

  def put(tenant: String, key: String, run: String): Unit = jedis.set(idemKey(tenant, key), run)

  def runKey(runId: String): String = s"run:$runId"

  def transition(runId: String, workerId: String, toState: String): String = {
    // TODO: the draft reads the run, patches it in the client and writes the whole document back
    // with a plain SET, so two workers interleave; it never takes a lease, never sets an expiry, and
    // stores whatever state string it is handed. Review all of it.
    val run = Option(jedis.get(runKey(runId))).getOrElse("{}")
    val patched = s"""{"state":"$toState","worker":"$workerId","previous":$run}"""
    jedis.set(runKey(runId), patched)
    patched
  }
}
`,
      solution: `import redis.clients.jedis.Jedis

object State {
  // 30 minutes: long enough for one slow tool call, short enough that a crashed run comes back.
  val LeaseTtlSeconds = 1800L
  val States = Set("pending", "running", "waiting_tool", "done", "failed")

  // What the transition script returns; the worker pool branches on these.
  val Ok = 1L
  val LeaseHeld = -1L
  val UnknownRun = -2L
  val IllegalState = -3L

  val TransitionLua =
    """
      |local lease = redis.call('GET', KEYS[2])
      |if lease and lease ~= ARGV[1] then
      |  return -1
      |end
      |local state = redis.call('HGET', KEYS[1], 'state')
      |if not state then
      |  return -2
      |end
      |local allowed = {
      |  ['pending:running'] = true,
      |  ['pending:failed'] = true,
      |  ['running:waiting_tool'] = true,
      |  ['running:done'] = true,
      |  ['running:failed'] = true,
      |  ['waiting_tool:running'] = true,
      |  ['waiting_tool:failed'] = true,
      |}
      |if not allowed[state .. ':' .. ARGV[2]] then
      |  return -3
      |end
      |redis.call('HSET', KEYS[1], 'state', ARGV[2], 'worker', ARGV[1])
      |redis.call('SET', KEYS[2], ARGV[1])
      |redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
      |return 1
      |""".stripMargin

  val RecoverLua =
    """
      |local state = redis.call('HGET', KEYS[1], 'state')
      |if not state then
      |  return -2
      |end
      |if state == 'done' or state == 'failed' then
      |  return -3
      |end
      |if redis.call('EXISTS', KEYS[2]) == 1 then
      |  return -1
      |end
      |redis.call('HSET', KEYS[1], 'state', 'running', 'worker', ARGV[1])
      |redis.call('SET', KEYS[2], ARGV[1])
      |redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))
      |return 1
      |""".stripMargin

  val jedis = new Jedis("redis", 6379)

  def idemKey(tenant: String, key: String): String = s"idem:$tenant:$key"

  /** The stored run document for (tenant, Idempotency-Key), as the API wrote it. */
  def get(tenant: String, key: String): Option[String] = Option(jedis.get(idemKey(tenant, key)))

  def put(tenant: String, key: String, run: String): Unit = jedis.set(idemKey(tenant, key), run)

  def runKey(runId: String): String = s"run:$runId"

  def leaseKey(runId: String): String = s"run:$runId:lease"

  /** Moves one run a step forward under workerId's lease, atomically, and refreshes the lease. */
  def transition(runId: String, workerId: String, toState: String): Long = {
    if (!States.contains(toState)) return IllegalState
    jedis
      .eval(TransitionLua, 2, runKey(runId), leaseKey(runId), workerId, toState, LeaseTtlSeconds.toString)
      .asInstanceOf[java.lang.Long]
      .longValue()
  }

  /** Takes over a run whose lease expired because its worker died mid-step. */
  def recover(runId: String, workerId: String): Long =
    jedis
      .eval(RecoverLua, 2, runKey(runId), leaseKey(runId), workerId, LeaseTtlSeconds.toString)
      .asInstanceOf[java.lang.Long]
      .longValue()
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

struct RunStore {
  sw::redis::Redis& redis;

  /** The stored run document for (tenant, Idempotency-Key), as the API wrote it. */
  std::optional<std::string> get(const std::string& tenant, const std::string& idemKey) {
    return redis.get("idem:" + tenant + ":" + idemKey);
  }

  void put(const std::string& tenant, const std::string& idemKey, const std::string& run) {
    redis.set("idem:" + tenant + ":" + idemKey, run);
  }
};

std::string runKey(const std::string& runId) { return "run:" + runId; }

// TODO: the draft reads the run, patches it in the client and writes the whole document back with a
// plain SET, so two workers interleave; it never takes a lease, never sets an expiry, and stores
// whatever state string it is handed. Review all of it.
std::string transition(
    sw::redis::Redis& redis,
    const std::string& runId,
    const std::string& workerId,
    const std::string& toState) {
  const auto raw = redis.get(runKey(runId));
  const std::string run = raw ? *raw : "{}";
  const std::string patched =
      R"({"state":")" + toState + R"(","worker":")" + workerId + R"(","previous":)" + run + "}";
  redis.set(runKey(runId), patched);
  return patched;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <optional>
#include <string>
#include <vector>

// 30 minutes: long enough for one slow tool call, short enough that a crashed run comes back.
constexpr long long kLeaseTtlSeconds = 1800;
const std::vector<std::string> kStates = {"pending", "running", "waiting_tool", "done", "failed"};

// What the transition script returns; the worker pool branches on these.
constexpr long long kOk = 1;
constexpr long long kLeaseHeld = -1;
constexpr long long kUnknownRun = -2;
constexpr long long kIllegalState = -3;

const char* kTransitionLua = R"LUA(
local lease = redis.call('GET', KEYS[2])
if lease and lease ~= ARGV[1] then
  return -1
end
local state = redis.call('HGET', KEYS[1], 'state')
if not state then
  return -2
end
local allowed = {
  ['pending:running'] = true,
  ['pending:failed'] = true,
  ['running:waiting_tool'] = true,
  ['running:done'] = true,
  ['running:failed'] = true,
  ['waiting_tool:running'] = true,
  ['waiting_tool:failed'] = true,
}
if not allowed[state .. ':' .. ARGV[2]] then
  return -3
end
redis.call('HSET', KEYS[1], 'state', ARGV[2], 'worker', ARGV[1])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
return 1
)LUA";

const char* kRecoverLua = R"LUA(
local state = redis.call('HGET', KEYS[1], 'state')
if not state then
  return -2
end
if state == 'done' or state == 'failed' then
  return -3
end
if redis.call('EXISTS', KEYS[2]) == 1 then
  return -1
end
redis.call('HSET', KEYS[1], 'state', 'running', 'worker', ARGV[1])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))
return 1
)LUA";

struct RunStore {
  sw::redis::Redis& redis;

  /** The stored run document for (tenant, Idempotency-Key), as the API wrote it. */
  std::optional<std::string> get(const std::string& tenant, const std::string& idemKey) {
    return redis.get("idem:" + tenant + ":" + idemKey);
  }

  void put(const std::string& tenant, const std::string& idemKey, const std::string& run) {
    redis.set("idem:" + tenant + ":" + idemKey, run);
  }
};

std::string runKey(const std::string& runId) { return "run:" + runId; }
std::string leaseKey(const std::string& runId) { return "run:" + runId + ":lease"; }

/** Moves one run a step forward under workerId's lease, atomically, and refreshes the lease. */
long long transition(
    sw::redis::Redis& redis,
    const std::string& runId,
    const std::string& workerId,
    const std::string& toState) {
  if (std::find(kStates.begin(), kStates.end(), toState) == kStates.end()) return kIllegalState;
  return redis.eval<long long>(
      kTransitionLua,
      {runKey(runId), leaseKey(runId)},
      {workerId, toState, std::to_string(kLeaseTtlSeconds)});
}

/** Takes over a run whose lease expired because its worker died mid-step. */
long long recoverRun(sw::redis::Redis& redis, const std::string& runId, const std::string& workerId) {
  return redis.eval<long long>(
      kRecoverLua, {runKey(runId), leaseKey(runId)}, {workerId, std::to_string(kLeaseTtlSeconds)});
}
`,
    },
  },
  hints: [
    'One script has to do four things at once: `GET` the lease, `HGET` the state, validate the transition, then `HSET` the state and `EXPIRE` the lease. Split across two client round trips, another worker passes the same lease check between the read and the write.',
    'A lease without a TTL is a lock nobody releases: a worker that dies mid-step leaves the run `running` forever. Set the expiry from the same 1800 s constant every time the lease is written, not only when it is first taken, so a long step cannot silently outlive its lease.',
    'Recovery is the same script read from the other side: when `EXISTS` on the lease key is 0 the previous owner is gone, so a claim may move a non-terminal run to `running` under the recovering worker. Terminal states stay closed — `done` and `failed` are never reopened.',
  ],
  debrief: `The interviewer is testing atomicity and ownership on the one key every worker touches. The draft looks fine because a single worker on a single run is serial: nothing to race. The moment a worker retries a start, or a resumed run and its zombie twin both hold the same run id, the read-patch-write sequence loses one of the two advances — and because the draft never takes a lease it cannot even tell which writer owns the run. One Lua script fixes both halves: it reads the lease, validates the transition table and writes state plus a refreshed 1800 s expiry in a single step, and it returns a status the caller can distinguish (\`-1\` another owner, \`-2\` no run, \`-3\` illegal transition). The expiry is what makes the state machine recoverable rather than merely correct: a crashed worker's lease lapses, so the claim path can reopen the run instead of stranding it in a non-terminal state. Real orchestrators add a heartbeat on long tool calls, a fencing token so a stale worker's late write is rejected, and a redelivery-safe transition that carries the step sequence forward.`,
};
