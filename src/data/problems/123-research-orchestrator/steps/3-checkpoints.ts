import type {Step} from '@/lib/types';

export const checkpointsStep: Step = {
  id: 'checkpoints',
  title: 'Checkpoints: resume a crashed job, reserve tool calls atomically',
  concept: 'redis',
  file: 'checkpoints',
  focus: ['lead', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it records the plan, stores
each subagent's result as it lands and counts tool calls against the budget. In a demo on one
process it looks exactly like a checkpoint store. It hides three production flaws: the state lives
in process memory, the tool counter races, and the tool is called before the budget is charged.
Review it, fix it, and prove the fix.

Implement the lead agent's checkpoint store:

- The job record lives in Redis under \`research:{job_id}\` — a hash with \`status\`, the
  serialised \`plan\` and the \`budget\` — written with \`HSET\` when the job starts.
- Each subagent result is checkpointed as it arrives: \`HSET research:{job_id}:results {task_id}
  {findings}\`. The source's lesson is that agents are stateful and errors compound, so a lead that
  crashes must resume from where it was, not restart from the beginning.
- Both keys expire **24 hours** after their last write (\`CHECKPOINT_TTL_S = 86400\`): a finished
  or abandoned job must not live in Redis forever.
- \`resume(job_id)\` reads the job record and the results with \`HGETALL\` and returns the plan's
  **pending** tasks (those without a result) together with the results already in hand. A restarted
  lead calls it before fanning out, so completed subagents are never re-run.
- Tool calls are reserved against \`budget.max_tool_calls\` by **one atomic Lua script** on
  \`research:{job_id}:tools\` — \`INCRBY\`, compare, roll back when over, set the expiry on first
  write — and the reservation happens **before** the tool is called. A subagent that is over budget
  gets a \`BudgetExceeded\` error and the tool is never touched.

**Failure mode the checks target.** A process-local dictionary is lost on every crash, deploy and
scale-out, so the lead restarts from zero and pays for every subagent twice — the source calls
restarts expensive and frustrating for exactly this reason; a counter that is incremented in memory
by concurrent subagents overshoots the budget; and charging after the call means the budget is a
report, not a limit.`,
  sequence: {
    participants: ['Lead agent', 'Redis', 'Tools'],
    messages: [
      {from: 'Lead agent', to: 'Redis', label: 'HSET research:{job} status plan budget · EXPIRE 86400', kind: 'sync'},
      {
        from: 'Lead agent',
        to: 'Redis',
        label: 'EVAL reserve · KEYS[research:{job}:tools] · max_tool_calls',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Lead agent', label: 'used count / 0 when over budget', kind: 'reply'},
      {from: 'Lead agent', to: 'Tools', label: 'Call(...) only after the reservation', kind: 'sync'},
      {from: 'Tools', to: 'Lead agent', label: 'result', kind: 'reply'},
      {from: 'Lead agent', to: 'Redis', label: 'HSET research:{job}:results task_id findings', kind: 'sync'},
      {from: 'Lead agent', to: 'Lead agent', label: 'crash → restart', kind: 'sync'},
      {from: 'Lead agent', to: 'Redis', label: 'HGETALL research:{job} · HGETALL research:{job}:results', kind: 'sync'},
      {from: 'Redis', to: 'Lead agent', label: 'plan · results → pending tasks only', kind: 'reply'},
    ],
  },
  hints: [
    'Replace the dictionary with hashes: `HSET research:{job_id}` for the record, `HSET research:{job_id}:results task_id findings` for each result, and an `EXPIRE` of 86 400 s after each write. Everything the lead needs to continue must be readable by a process that did not start the job.',
    '`resume` is two `HGETALL`s and a filter: parse the plan from the record, read the results hash, and return the tasks whose id is not a field of it. The lead calls it before the fan-out and only runs what comes back.',
    'The budget is a Lua script, not an `if`: `INCRBY` the counter, compare the result against `ARGV[1]`, `DECRBY` and return 0 when it went over, `EXPIRE` when the TTL is unset. Call `reserve_tool_call` first and `call_tool` only when it returned a positive count.',
  ],
  checks: [
    {
      id: 'checkpoint-key',
      title: 'Stores the job record under research:{job_id}',
      detail:
        'The job record and each result are written to Redis hashes under `research:{job_id}` (and `research:{job_id}:results`) with `HSET`. The draft keeps both in a process-local dictionary that a restart empties.',
      match: {
        python: {all: [/research:\{job_id\}/, /\.hset\(/]},
        typescript: {all: [/research:\$\{jobId\}/, /\.hset\(/]},
        go: {all: [/research:%s/, /\.HSet\(/]},
        scala: {all: [/research:\$jobId/, /\.hset\(/]},
        cpp: {all: [/"research:"/, /\.hset\(/]},
      },
    },
    {
      id: 'ttl',
      title: 'Checkpoint keys expire after 24 hours',
      detail:
        'Every checkpoint write is followed by an `EXPIRE` of `CHECKPOINT_TTL_S = 86400`, so an abandoned or finished job leaves Redis. The draft has no expiry at all.',
      match: {
        python: {all: [/CHECKPOINT_TTL_S\s*=\s*86400/, /\.expire\(/]},
        typescript: {all: [/CHECKPOINT_TTL_S\s*=\s*86400/, /\.expire\(/]},
        go: {all: [/checkpointTTLS\s*=\s*86400/, /\.Expire\(/]},
        scala: {all: [/CheckpointTtlS\s*=\s*86400/, /\.expire\(/]},
        cpp: {all: [/kCheckpointTtlS\s*=\s*86400/, /\.expire\(/]},
      },
    },
    {
      id: 'resume',
      title: 'Resumes from the last checkpoint',
      detail:
        '`resume(job_id)` reads the record and the results with `HGETALL` and returns only the pending tasks. The draft’s `pending_tasks` reads the in-memory dictionary, which is empty after a restart, so the lead starts over.',
      match: {
        python: {all: [/def resume\(/, /\.hgetall\(/]},
        typescript: {all: [/function resume\(/, /\.hgetall\(/]},
        go: {all: [/func resume\(/, /\.HGetAll\(/]},
        scala: {all: [/def resume\(/, /\.hgetAll\(/]},
        cpp: {all: [/\bresume\(/, /\.hgetall\(/]},
      },
    },
    {
      id: 'atomic-reserve',
      title: 'Reserves tool calls with one atomic Lua script',
      detail:
        'The tool-call counter is incremented, compared and rolled back inside one `EVAL` (`INCRBY` … `DECRBY`). An in-memory `+= 1` from concurrent subagents overshoots the budget.',
      match: {
        python: {all: [/RESERVE_LUA/, /\.eval\(/, /INCRBY/], none: [/tool_calls"\]\s*\+=/]},
        typescript: {all: [/RESERVE_LUA/, /\.eval\(/, /INCRBY/], none: [/toolCalls\s*\+=/]},
        go: {all: [/(reserveScript|NewScript)/, /\.Run\(/, /INCRBY/], none: [/ToolCalls\+\+/]},
        scala: {all: [/ReserveLua/, /\.eval\(/, /INCRBY/], none: [/toolCalls\s*\+=/]},
        cpp: {all: [/kReserveLua/, /\.eval</, /INCRBY/], none: [/tool_calls\+\+/]},
      },
    },
    {
      id: 'reserve-first',
      title: 'Reserves before the tool is called',
      detail:
        'The reservation runs before `call_tool`; an over-budget subagent never reaches the tool. The draft calls the tool first and counts afterwards, so the budget cannot stop anything.',
      match: {
        python: {order: [/reserve_tool_call\(/, /call_tool\(/]},
        typescript: {order: [/reserveToolCall\(/, /callTool\(/]},
        go: {order: [/reserveToolCall\(/, /callTool\(/]},
        scala: {order: [/reserveToolCall\(/, /callTool\(/]},
        cpp: {order: [/reserveToolCall\(/, /callTool\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from tool_calls import call_tool


class BudgetExceeded(Exception):
    """The job has used every tool call its effort level allows."""


# TODO: this draft keeps every checkpoint in process memory, counts tool calls with a racy
# in-memory increment, and charges the budget after the tool has already run. Review all three.
JOBS: dict[str, dict] = {}


def start_job(job_id: str, plan: list[dict], budget: dict) -> None:
    JOBS[job_id] = {"status": "running", "plan": plan, "budget": budget, "results": {}, "tool_calls": 0}


def save_result(job_id: str, task_id: str, findings: str) -> None:
    JOBS[job_id]["results"][task_id] = findings


def pending_tasks(job_id: str) -> tuple[list[dict], dict[str, str]]:
    job = JOBS[job_id]
    pending = [task for task in job["plan"] if task["id"] not in job["results"]]
    return pending, job["results"]


def tool_call(job_id: str, name: str, args: dict) -> str:
    job = JOBS[job_id]
    result = call_tool(name, args)
    job["tool_calls"] += 1
    if job["tool_calls"] > job["budget"]["max_tool_calls"]:
        raise BudgetExceeded(job_id)
    return result
`,
      solution: `import json

import redis

from tool_calls import call_tool

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CHECKPOINT_TTL_S = 86400

RESERVE_LUA = """
local used = redis.call('INCRBY', KEYS[1], 1)
if used > tonumber(ARGV[1]) then
  redis.call('DECRBY', KEYS[1], 1)
  return 0
end
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return used
"""


class BudgetExceeded(Exception):
    """The job has used every tool call its effort level allows."""


def job_key(job_id: str) -> str:
    return f"research:{job_id}"


def start_job(job_id: str, plan: list[dict], budget: dict) -> None:
    key = job_key(job_id)
    r.hset(key, mapping={"status": "running", "plan": json.dumps(plan), "budget": json.dumps(budget)})
    r.expire(key, CHECKPOINT_TTL_S)


def save_result(job_id: str, task_id: str, findings: str) -> None:
    key = f"{job_key(job_id)}:results"
    r.hset(key, task_id, findings)
    r.expire(key, CHECKPOINT_TTL_S)


def resume(job_id: str) -> tuple[list[dict], dict[str, str]]:
    """The plan's tasks without a checkpointed result, and the results already in hand."""
    record = r.hgetall(job_key(job_id))
    if not record:
        raise KeyError(job_id)
    plan = json.loads(record["plan"])
    results = r.hgetall(f"{job_key(job_id)}:results")
    pending = [task for task in plan if task["id"] not in results]
    return pending, results


def reserve_tool_call(job_id: str, max_tool_calls: int) -> int:
    """The job's tool calls so far including this one, or 0 when the budget is spent."""
    used = r.eval(RESERVE_LUA, 1, f"{job_key(job_id)}:tools", max_tool_calls, CHECKPOINT_TTL_S)
    return int(used)


def tool_call(job_id: str, name: str, args: dict) -> str:
    budget = json.loads(r.hget(job_key(job_id), "budget"))
    if reserve_tool_call(job_id, budget["max_tool_calls"]) == 0:
        raise BudgetExceeded(job_id)
    return call_tool(name, args)
`,
    },
    typescript: {
      starter: `/** Checkpoints: a model-generated draft that keeps the job state in process memory. */
import {callTool} from './tool_calls';

export interface Task {
  id: string;
  objective: string;
}

export interface Budget {
  max_subagents: number;
  max_tool_calls: number;
  token_budget: number;
}

interface JobState {
  status: string;
  plan: Task[];
  budget: Budget;
  results: Record<string, string>;
  toolCalls: number;
}

export class BudgetExceeded extends Error {}

// TODO: this draft keeps every checkpoint in process memory, counts tool calls with a racy
// in-memory increment, and charges the budget after the tool has already run. Review all three.
const JOBS = new Map<string, JobState>();

export function startJob(jobId: string, plan: Task[], budget: Budget): void {
  JOBS.set(jobId, {status: 'running', plan, budget, results: {}, toolCalls: 0});
}

export function saveResult(jobId: string, taskId: string, findings: string): void {
  const job = JOBS.get(jobId);
  if (job !== undefined) job.results[taskId] = findings;
}

export function pendingTasks(jobId: string): {pending: Task[]; results: Record<string, string>} {
  const job = JOBS.get(jobId);
  if (job === undefined) throw new Error(\`unknown job \${jobId}\`);
  const pending = job.plan.filter(task => job.results[task.id] === undefined);
  return {pending, results: job.results};
}

export async function toolCall(jobId: string, name: string, args: Record<string, string>): Promise<string> {
  const job = JOBS.get(jobId);
  if (job === undefined) throw new Error(\`unknown job \${jobId}\`);
  const result = await callTool(name, args);
  job.toolCalls += 1;
  if (job.toolCalls > job.budget.max_tool_calls) throw new BudgetExceeded(jobId);
  return result;
}
`,
      solution: `/** Checkpoints: job state and results in Redis with a TTL; tool calls reserved atomically first. */
import {Redis} from 'ioredis';

import {callTool} from './tool_calls';

const r = new Redis('redis://redis:6379');

const CHECKPOINT_TTL_S = 86400;

const RESERVE_LUA = \`
local used = redis.call('INCRBY', KEYS[1], 1)
if used > tonumber(ARGV[1]) then
  redis.call('DECRBY', KEYS[1], 1)
  return 0
end
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return used
\`;

export interface Task {
  id: string;
  objective: string;
}

export interface Budget {
  max_subagents: number;
  max_tool_calls: number;
  token_budget: number;
}

export class BudgetExceeded extends Error {}

function jobKey(jobId: string): string {
  return \`research:\${jobId}\`;
}

export async function startJob(jobId: string, plan: Task[], budget: Budget): Promise<void> {
  const key = jobKey(jobId);
  await r.hset(key, {status: 'running', plan: JSON.stringify(plan), budget: JSON.stringify(budget)});
  await r.expire(key, CHECKPOINT_TTL_S);
}

export async function saveResult(jobId: string, taskId: string, findings: string): Promise<void> {
  const key = \`\${jobKey(jobId)}:results\`;
  await r.hset(key, taskId, findings);
  await r.expire(key, CHECKPOINT_TTL_S);
}

/** The plan's tasks without a checkpointed result, and the results already in hand. */
export async function resume(jobId: string): Promise<{pending: Task[]; results: Record<string, string>}> {
  const record = await r.hgetall(jobKey(jobId));
  if (record.plan === undefined) throw new Error(\`unknown job \${jobId}\`);
  const plan = JSON.parse(record.plan) as Task[];
  const results = await r.hgetall(\`\${jobKey(jobId)}:results\`);
  const pending = plan.filter(task => results[task.id] === undefined);
  return {pending, results};
}

/** The job's tool calls so far including this one, or 0 when the budget is spent. */
async function reserveToolCall(jobId: string, maxToolCalls: number): Promise<number> {
  const used = await r.eval(RESERVE_LUA, 1, \`\${jobKey(jobId)}:tools\`, maxToolCalls, CHECKPOINT_TTL_S);
  return Number(used);
}

export async function toolCall(jobId: string, name: string, args: Record<string, string>): Promise<string> {
  const raw = await r.hget(jobKey(jobId), 'budget');
  if (raw === null) throw new Error(\`unknown job \${jobId}\`);
  const budget = JSON.parse(raw) as Budget;
  if ((await reserveToolCall(jobId, budget.max_tool_calls)) === 0) throw new BudgetExceeded(jobId);
  return callTool(name, args);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"sync"
)

type Task struct {
	ID        string \`json:"id"\`
	Objective string \`json:"objective"\`
}

type Budget struct {
	MaxSubagents int \`json:"max_subagents"\`
	MaxToolCalls int \`json:"max_tool_calls"\`
	TokenBudget  int \`json:"token_budget"\`
}

type jobState struct {
	Status    string
	Plan      []Task
	Budget    Budget
	Results   map[string]string
	ToolCalls int
}

var ErrBudgetExceeded = errors.New("tool-call budget exceeded")

// TODO: this draft keeps every checkpoint in process memory, counts tool calls with a racy
// in-memory increment, and charges the budget after the tool has already run. Review all three.
var (
	jobs   = map[string]*jobState{}
	jobsMu sync.Mutex
)

func startJob(ctx context.Context, jobID string, plan []Task, budget Budget) error {
	jobsMu.Lock()
	defer jobsMu.Unlock()
	jobs[jobID] = &jobState{Status: "running", Plan: plan, Budget: budget, Results: map[string]string{}}
	return nil
}

func saveResult(ctx context.Context, jobID, taskID, findings string) error {
	jobsMu.Lock()
	defer jobsMu.Unlock()
	jobs[jobID].Results[taskID] = findings
	return nil
}

func pendingTasks(ctx context.Context, jobID string) ([]Task, map[string]string, error) {
	jobsMu.Lock()
	defer jobsMu.Unlock()
	job, ok := jobs[jobID]
	if !ok {
		return nil, nil, errors.New("unknown job")
	}
	var pending []Task
	for _, task := range job.Plan {
		if _, done := job.Results[task.ID]; !done {
			pending = append(pending, task)
		}
	}
	return pending, job.Results, nil
}

func toolCall(ctx context.Context, jobID, name string, args map[string]string) (string, error) {
	result, err := callTool(ctx, name, args)
	if err != nil {
		return "", err
	}
	job := jobs[jobID]
	job.ToolCalls++
	if job.ToolCalls > job.Budget.MaxToolCalls {
		return "", ErrBudgetExceeded
	}
	return result, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const checkpointTTLS = 86400

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var reserveScript = redis.NewScript(\`
local used = redis.call('INCRBY', KEYS[1], 1)
if used > tonumber(ARGV[1]) then
  redis.call('DECRBY', KEYS[1], 1)
  return 0
end
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return used
\`)

type Task struct {
	ID        string \`json:"id"\`
	Objective string \`json:"objective"\`
}

type Budget struct {
	MaxSubagents int \`json:"max_subagents"\`
	MaxToolCalls int \`json:"max_tool_calls"\`
	TokenBudget  int \`json:"token_budget"\`
}

var ErrBudgetExceeded = errors.New("tool-call budget exceeded")

func jobKey(jobID string) string {
	return fmt.Sprintf("research:%s", jobID)
}

func startJob(ctx context.Context, jobID string, plan []Task, budget Budget) error {
	planJSON, _ := json.Marshal(plan)
	budgetJSON, _ := json.Marshal(budget)
	key := jobKey(jobID)
	if err := rdb.HSet(ctx, key, "status", "running", "plan", planJSON, "budget", budgetJSON).Err(); err != nil {
		return err
	}
	return rdb.Expire(ctx, key, checkpointTTLS*time.Second).Err()
}

func saveResult(ctx context.Context, jobID, taskID, findings string) error {
	key := jobKey(jobID) + ":results"
	if err := rdb.HSet(ctx, key, taskID, findings).Err(); err != nil {
		return err
	}
	return rdb.Expire(ctx, key, checkpointTTLS*time.Second).Err()
}

// resume returns the plan's tasks without a checkpointed result, and the results already in hand.
func resume(ctx context.Context, jobID string) ([]Task, map[string]string, error) {
	record, err := rdb.HGetAll(ctx, jobKey(jobID)).Result()
	if err != nil {
		return nil, nil, err
	}
	planJSON, ok := record["plan"]
	if !ok {
		return nil, nil, errors.New("unknown job")
	}
	var plan []Task
	if err := json.Unmarshal([]byte(planJSON), &plan); err != nil {
		return nil, nil, err
	}
	results, err := rdb.HGetAll(ctx, jobKey(jobID)+":results").Result()
	if err != nil {
		return nil, nil, err
	}
	var pending []Task
	for _, task := range plan {
		if _, done := results[task.ID]; !done {
			pending = append(pending, task)
		}
	}
	return pending, results, nil
}

// reserveToolCall returns the job's tool calls so far including this one, or 0 when the budget is spent.
func reserveToolCall(ctx context.Context, jobID string, maxToolCalls int) (int64, error) {
	return reserveScript.Run(ctx, rdb, []string{jobKey(jobID) + ":tools"}, maxToolCalls, checkpointTTLS).Int64()
}

func toolCall(ctx context.Context, jobID, name string, args map[string]string) (string, error) {
	raw, err := rdb.HGet(ctx, jobKey(jobID), "budget").Result()
	if err != nil {
		return "", err
	}
	var budget Budget
	if err := json.Unmarshal([]byte(raw), &budget); err != nil {
		return "", err
	}
	used, err := reserveToolCall(ctx, jobID, budget.MaxToolCalls)
	if err != nil {
		return "", err
	}
	if used == 0 {
		return "", ErrBudgetExceeded
	}
	return callTool(ctx, name, args)
}
`,
    },
    scala: {
      starter: `import scala.collection.mutable

final case class Task(id: String, objective: String)
final case class Budget(maxSubagents: Int, maxToolCalls: Int, tokenBudget: Int)

final class BudgetExceeded(jobId: String) extends RuntimeException(s"tool-call budget exceeded for $jobId")

object Checkpoints {
  final class JobState(val plan: List[Task], val budget: Budget) {
    var status: String = "running"
    val results: mutable.Map[String, String] = mutable.Map.empty
    var toolCalls: Int = 0
  }

  // TODO: this draft keeps every checkpoint in process memory, counts tool calls with a racy
  // in-memory increment, and charges the budget after the tool has already run. Review all three.
  private val jobs = mutable.Map.empty[String, JobState]

  def startJob(jobId: String, plan: List[Task], budget: Budget): Unit =
    jobs(jobId) = new JobState(plan, budget)

  def saveResult(jobId: String, taskId: String, findings: String): Unit =
    jobs(jobId).results(taskId) = findings

  def pendingTasks(jobId: String): (List[Task], Map[String, String]) = {
    val job = jobs(jobId)
    (job.plan.filterNot(task => job.results.contains(task.id)), job.results.toMap)
  }

  def toolCall(jobId: String, name: String, args: Map[String, String]): String = {
    val job = jobs(jobId)
    val result = ToolCalls.callTool(name, args)
    job.toolCalls += 1
    if (job.toolCalls > job.budget.maxToolCalls) throw new BudgetExceeded(jobId)
    result
  }
}
`,
      solution: `import scala.jdk.CollectionConverters._

import redis.clients.jedis.Jedis
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class Task(id: String, objective: String)
final case class Budget(maxSubagents: Int, maxToolCalls: Int, tokenBudget: Int)

final class BudgetExceeded(jobId: String) extends RuntimeException(s"tool-call budget exceeded for $jobId")

object Checkpoints {
  implicit val taskFormat: RootJsonFormat[Task] = jsonFormat2(Task)
  implicit val budgetFormat: RootJsonFormat[Budget] = jsonFormat3(Budget)

  val CheckpointTtlS = 86400L
  val jedis = new Jedis("redis", 6379)

  val ReserveLua =
    """
      |local used = redis.call('INCRBY', KEYS[1], 1)
      |if used > tonumber(ARGV[1]) then
      |  redis.call('DECRBY', KEYS[1], 1)
      |  return 0
      |end
      |if redis.call('TTL', KEYS[1]) < 0 then
      |  redis.call('EXPIRE', KEYS[1], ARGV[2])
      |end
      |return used
      |""".stripMargin

  def jobKey(jobId: String): String = s"research:$jobId"

  def startJob(jobId: String, plan: List[Task], budget: Budget): Unit = {
    val key = jobKey(jobId)
    val fields = Map("status" -> "running", "plan" -> plan.toJson.compactPrint, "budget" -> budget.toJson.compactPrint)
    jedis.hset(key, fields.asJava)
    jedis.expire(key, CheckpointTtlS)
  }

  def saveResult(jobId: String, taskId: String, findings: String): Unit = {
    val key = s"\${jobKey(jobId)}:results"
    jedis.hset(key, taskId, findings)
    jedis.expire(key, CheckpointTtlS)
  }

  /** The plan's tasks without a checkpointed result, and the results already in hand. */
  def resume(jobId: String): (List[Task], Map[String, String]) = {
    val record = jedis.hgetAll(jobKey(jobId)).asScala
    val plan = record.getOrElse("plan", throw new NoSuchElementException(jobId)).parseJson.convertTo[List[Task]]
    val results = jedis.hgetAll(s"\${jobKey(jobId)}:results").asScala.toMap
    (plan.filterNot(task => results.contains(task.id)), results)
  }

  /** The job's tool calls so far including this one, or 0 when the budget is spent. */
  def reserveToolCall(jobId: String, maxToolCalls: Int): Long =
    jedis
      .eval(ReserveLua, 1, s"\${jobKey(jobId)}:tools", maxToolCalls.toString, CheckpointTtlS.toString)
      .asInstanceOf[Long]

  def toolCall(jobId: String, name: String, args: Map[String, String]): String = {
    val budget = jedis.hget(jobKey(jobId), "budget").parseJson.convertTo[Budget]
    if (reserveToolCall(jobId, budget.maxToolCalls) == 0L) throw new BudgetExceeded(jobId)
    ToolCalls.callTool(name, args)
  }
}
`,
    },
    cpp: {
      starter: `#include <map>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "tool_calls.h"

struct Task {
  std::string id;
  std::string objective;
};

struct Budget {
  int max_subagents;
  int max_tool_calls;
  int token_budget;
};

struct BudgetExceeded : std::runtime_error {
  explicit BudgetExceeded(const std::string& jobId) : std::runtime_error("tool-call budget exceeded for " + jobId) {}
};

struct JobState {
  std::string status;
  std::vector<Task> plan;
  Budget budget;
  std::map<std::string, std::string> results;
  int tool_calls = 0;
};

// TODO: this draft keeps every checkpoint in process memory, counts tool calls with a racy
// in-memory increment, and charges the budget after the tool has already run. Review all three.
std::map<std::string, JobState> jobs;
std::mutex jobsMutex;

void startJob(const std::string& jobId, const std::vector<Task>& plan, const Budget& budget) {
  std::lock_guard<std::mutex> lock(jobsMutex);
  jobs[jobId] = JobState{"running", plan, budget, {}, 0};
}

void saveResult(const std::string& jobId, const std::string& taskId, const std::string& findings) {
  std::lock_guard<std::mutex> lock(jobsMutex);
  jobs[jobId].results[taskId] = findings;
}

std::pair<std::vector<Task>, std::map<std::string, std::string>> pendingTasks(const std::string& jobId) {
  std::lock_guard<std::mutex> lock(jobsMutex);
  const auto& job = jobs.at(jobId);
  std::vector<Task> pending;
  for (const auto& task : job.plan) {
    if (job.results.count(task.id) == 0) pending.push_back(task);
  }
  return {pending, job.results};
}

std::string toolCall(const std::string& jobId, const std::string& name, const std::map<std::string, std::string>& args) {
  const auto result = callTool(name, args);
  auto& job = jobs.at(jobId);
  job.tool_calls++;
  if (job.tool_calls > job.budget.max_tool_calls) throw BudgetExceeded(jobId);
  return result;
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <map>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "tool_calls.h"

using json = nlohmann::json;

constexpr long long kCheckpointTtlS = 86400;

const char* kReserveLua = R"LUA(
local used = redis.call('INCRBY', KEYS[1], 1)
if used > tonumber(ARGV[1]) then
  redis.call('DECRBY', KEYS[1], 1)
  return 0
end
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return used
)LUA";

struct Task {
  std::string id;
  std::string objective;
};

struct Budget {
  int max_subagents;
  int max_tool_calls;
  int token_budget;
};

struct BudgetExceeded : std::runtime_error {
  explicit BudgetExceeded(const std::string& jobId) : std::runtime_error("tool-call budget exceeded for " + jobId) {}
};

sw::redis::Redis redis("tcp://redis:6379");

std::string jobKey(const std::string& jobId) { return "research:" + jobId; }

json planToJson(const std::vector<Task>& plan) {
  json out = json::array();
  for (const auto& task : plan) out.push_back({{"id", task.id}, {"objective", task.objective}});
  return out;
}

void startJob(const std::string& jobId, const std::vector<Task>& plan, const Budget& budget) {
  const auto key = jobKey(jobId);
  const json budgetJson = {
      {"max_subagents", budget.max_subagents},
      {"max_tool_calls", budget.max_tool_calls},
      {"token_budget", budget.token_budget},
  };
  const std::unordered_map<std::string, std::string> fields = {
      {"status", "running"}, {"plan", planToJson(plan).dump()}, {"budget", budgetJson.dump()}};
  redis.hset(key, fields.begin(), fields.end());
  redis.expire(key, std::chrono::seconds(kCheckpointTtlS));
}

void saveResult(const std::string& jobId, const std::string& taskId, const std::string& findings) {
  const auto key = jobKey(jobId) + ":results";
  redis.hset(key, taskId, findings);
  redis.expire(key, std::chrono::seconds(kCheckpointTtlS));
}

// The plan's tasks without a checkpointed result, and the results already in hand.
std::pair<std::vector<Task>, std::map<std::string, std::string>> resume(const std::string& jobId) {
  std::map<std::string, std::string> record;
  redis.hgetall(jobKey(jobId), std::inserter(record, record.begin()));
  if (record.count("plan") == 0) throw std::out_of_range("unknown job " + jobId);
  std::map<std::string, std::string> results;
  redis.hgetall(jobKey(jobId) + ":results", std::inserter(results, results.begin()));
  std::vector<Task> pending;
  for (const auto& item : json::parse(record.at("plan"))) {
    const Task task{item["id"].get<std::string>(), item["objective"].get<std::string>()};
    if (results.count(task.id) == 0) pending.push_back(task);
  }
  return {pending, results};
}

// The job's tool calls so far including this one, or 0 when the budget is spent.
long long reserveToolCall(const std::string& jobId, int maxToolCalls) {
  return redis.eval<long long>(
      kReserveLua, {jobKey(jobId) + ":tools"}, {std::to_string(maxToolCalls), std::to_string(kCheckpointTtlS)});
}

std::string toolCall(const std::string& jobId, const std::string& name, const std::map<std::string, std::string>& args) {
  const auto raw = redis.hget(jobKey(jobId), "budget");
  if (!raw) throw std::out_of_range("unknown job " + jobId);
  const json budget = json::parse(*raw);
  if (reserveToolCall(jobId, budget["max_tool_calls"].get<int>()) == 0) throw BudgetExceeded(jobId);
  return callTool(name, args);
}
`,
    },
  },
  debrief: `The interview question behind this step is durability for a long-running, stateful process. The source is explicit: agents run for a long time, maintain state across many tool calls, and when something fails you cannot restart from the beginning — restarts are expensive and users notice — so the system resumes from where the agent was. A dictionary in the worker's memory is the opposite of that: every crash, deploy and scale-out event empties it, and the lead pays for every subagent again. Hashes keyed by job id with a TTL make the state survive the process and die with the job. The tool counter is the second half: subagents run concurrently, so a budget that is read, compared and incremented in three steps is a race, and one that is charged after the call is a report. One Lua script that increments, compares and rolls back is both atomic and a limit. Real systems also checkpoint the lead's own plan and partial synthesis, version the checkpoint schema so a resumed job can be read by newer code, and hold a lease on the job so two workers never resume the same one.`,
};
