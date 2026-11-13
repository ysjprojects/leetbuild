import type {Step} from '@/lib/types';

export const checkpointsStep: Step = {
  id: 'checkpoints',
  title: 'Checkpoints in Redis: resume a crashed lead, reserve tool calls atomically',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'checkpoints',
  focus: ['lead', 'redis'],
  task: `## Task

**Starting point.** The starter is the lead agent's checkpoint store. \`start_job(job_id, plan)\`
keeps the plan in the process-local \`PLANS\` and sets \`status\` on \`research:{job_id}\`;
\`save_result(job_id, task_id, findings)\` reads the JSON object at \`research:{job_id}:results\`,
adds the result and writes it back; \`resume(job_id)\` returns the plan's tasks without a result and
the results in hand; \`reserve_tool_call(job_id, max_tool_calls)\` reads \`research:{job_id}:tools\`,
compares, then \`INCR\`s. On one process it serves the demo, and it hides 4 flaws.

**Failure mode the checks target.** A lead restarted by a deploy finds no plan and pays for every
subagent again; two subagents finishing together lose one result; checkpoints of abandoned jobs stay
in Redis forever; two concurrent tool calls on the last unit of budget both get it.

- The plan is the JSON field \`plan\` of \`research:{job_id}\` (\`HSET\`), next to \`status\` \`running\`,
  so any process can \`resume\`; a checkpoint write that fails reaches the caller.
- A result is one field of the hash \`research:{job_id}:results\`: \`HSET … {task_id} {findings}\`;
  \`resume\` reads it with \`HGETALL\`.
- Every write refreshes a **24 h** expiry (\`CHECKPOINT_TTL_S\` = 86400) on the key it wrote.
- \`reserve_tool_call\` is **one Lua script** (\`RESERVE_LUA\`): \`INCR\`, refresh the expiry,
  \`DECR\` and refuse when over \`max_tool_calls\`; it returns whether the call may go ahead.`,
  sequence: {
    participants: ['Lead agent', 'Redis', 'Restarted lead'],
    messages: [
      {
        from: 'Lead agent',
        to: 'Redis',
        label: 'HSET research:{job} status running plan [...] · EXPIRE 86400',
        kind: 'sync',
      },
      {from: 'Lead agent', to: 'Redis', label: 'HSET research:{job}:results t-1 findings · EXPIRE 86400', kind: 'sync'},
      {from: 'Lead agent', to: 'Redis', label: 'EVALSHA reserve research:{job}:tools max ttl', kind: 'sync'},
      {from: 'Redis', to: 'Lead agent', label: '1 go ahead · 0 budget spent', kind: 'reply'},
      {from: 'Lead agent', to: 'Lead agent', label: 'crash, deploy', kind: 'sync'},
      {from: 'Restarted lead', to: 'Redis', label: 'HGET plan · HGETALL results', kind: 'sync'},
      {from: 'Redis', to: 'Restarted lead', label: 'pending t-2, t-3 · t-1 in hand', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'resume',
      title: 'Another process resumes the job from Redis',
      detail:
        '`start_job` writes the plan and `status` `running` into `research:{job_id}`, and a write that fails reaches the caller; `resume` reads the plan back from there, so a lead restarted on another process gets the pending tasks and the results in hand.',
      match: {
        python: {all: [/["']plan["']/, /json\.loads\(/], none: [/\bPLANS\b/]},
        typescript: {all: [/['"]plan['"]|\bplan:/, /JSON\.parse\(/], none: [/\bplans\b/]},
        go: {all: [/"plan"/, /json\.Unmarshal\(/], none: [/\bplans\b/]},
        scala: {all: [/"plan"/, /parseJson/], none: [/\bplans\b/]},
        cpp: {all: [/"plan"/, /json::parse\(/], none: [/\bplans\b/]},
      },
    },
    {
      id: 'concurrent-results',
      title: 'Two results saved at once both survive',
      detail:
        'Each result is its own field of `research:{job_id}:results` (`HSET`), read back with `HGETALL`; a read-modify-write of one JSON value loses whichever result was written second.',
      match: {
        python: {all: [/\.hgetall\(/], none: [/results\[task_id\]\s*=/]},
        typescript: {all: [/\.hgetall\(/], none: [/results\[taskId\]\s*=/]},
        go: {all: [/\.HGetAll\(/], none: [/results\[taskID\]\s*=/]},
        scala: {all: [/\.hgetAll\(/], none: [/results\s*\+\s*\(\s*taskId/]},
        cpp: {all: [/\.hgetall\(/], none: [/results\[task_id\]\s*=/]},
      },
    },
    {
      id: 'ttl',
      title: 'Checkpoint keys expire 24 hours after their last write',
      detail:
        'Every write refreshes `EXPIRE … CHECKPOINT_TTL_S` (86400) on the key it wrote: the job hash, the results hash and the tool-call counter.',
      match: {
        python: {all: [/CHECKPOINT_TTL_S\s*=\s*86400\b/, /\.expire\(/, /EXPIRE/]},
        typescript: {all: [/CHECKPOINT_TTL_S\s*=\s*86_?400\b/, /\.expire\(/, /EXPIRE/]},
        go: {all: [/checkpointTTL\s*=\s*(24\s*\*\s*time\.Hour|86400)/, /\.Expire\(/, /EXPIRE/]},
        scala: {all: [/CheckpointTtlS\s*=\s*86400L?\b/, /\.expire\(/, /EXPIRE/]},
        cpp: {all: [/kCheckpointTtlS\s*=\s*86400\b/, /\.expire\(/, /EXPIRE/]},
      },
    },
    {
      id: 'atomic-reserve',
      title: 'Reserves a tool call in one Lua script',
      detail:
        'The counter is incremented, compared and rolled back inside one script (`INCR` … `DECR`); a read, a compare and an `INCR` from two subagents both grant the last unit of budget.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /INCR/, /DECR/], none: [/used\s*>=\s*max_tool_calls/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /INCR/, /DECR/], none: [/used\s*>=\s*maxToolCalls/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /INCR/, /DECR/], none: [/used\s*>=\s*maxToolCalls/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /INCR/, /DECR/], none: [/used\s*>=\s*maxToolCalls/]},
        cpp: {all: [/redis\.eval(sha)?</, /INCR/, /DECR/], none: [/used\s*>=\s*max_tool_calls/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

from research import jobs  # job_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

PLANS: dict[str, list[dict]] = {}


def start_job(job_id: str, plan: list[dict]) -> None:
    """Record the job's plan (tasks: id, objective, output_format, tools, boundaries) and mark it running."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    PLANS[job_id] = plan
    r.hset(jobs.job_key(job_id), "status", "running")


def save_result(job_id: str, task_id: str, findings: str) -> None:
    """Checkpoint one subagent's findings as it arrives."""
    key = f"{jobs.job_key(job_id)}:results"
    results = json.loads(r.get(key) or "{}")
    results[task_id] = findings
    r.set(key, json.dumps(results))


def resume(job_id: str) -> tuple[list[dict], dict[str, str]]:
    """The plan's tasks without a result, and the results in hand."""
    results = json.loads(r.get(f"{jobs.job_key(job_id)}:results") or "{}")
    pending = [task for task in PLANS.get(job_id, []) if task["id"] not in results]
    return pending, results


def reserve_tool_call(job_id: str, max_tool_calls: int) -> bool:
    """Whether the job may make one more tool call; counts it when it may."""
    key = f"{jobs.job_key(job_id)}:tools"
    used = int(r.get(key) or 0)
    if used >= max_tool_calls:
        return False
    r.incr(key)
    return True
`,
      solution: `import json

import redis

from research import jobs  # job_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CHECKPOINT_TTL_S = 86400

# Count, compare and roll back in one step: no other client runs between the INCR and the DECR.
RESERVE_LUA = """
local used = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
if used > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
"""
reserve = r.register_script(RESERVE_LUA)


def start_job(job_id: str, plan: list[dict]) -> None:
    """Record the job's plan (tasks: id, objective, output_format, tools, boundaries) and mark it running."""
    key = jobs.job_key(job_id)
    r.hset(key, mapping={"status": "running", "plan": json.dumps(plan)})
    r.expire(key, CHECKPOINT_TTL_S)


def save_result(job_id: str, task_id: str, findings: str) -> None:
    """Checkpoint one subagent's findings as it arrives."""
    key = f"{jobs.job_key(job_id)}:results"
    r.hset(key, task_id, findings)  # one field per task: two subagents never overwrite each other
    r.expire(key, CHECKPOINT_TTL_S)


def resume(job_id: str) -> tuple[list[dict], dict[str, str]]:
    """The plan's tasks without a result, and the results in hand."""
    raw = r.hget(jobs.job_key(job_id), "plan")
    plan = json.loads(raw) if raw else []
    results = r.hgetall(f"{jobs.job_key(job_id)}:results")
    pending = [task for task in plan if task["id"] not in results]
    return pending, results


def reserve_tool_call(job_id: str, max_tool_calls: int) -> bool:
    """Whether the job may make one more tool call; counts it when it may."""
    return reserve(keys=[f"{jobs.job_key(job_id)}:tools"], args=[max_tool_calls, CHECKPOINT_TTL_S]) == 1
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {jobKey, type Task} from 'research/jobs';

const redis = new Redis({host: 'redis', port: 6379});

const plans = new Map<string, Task[]>();

/** Record the job's plan and mark it running. */
export async function startJob(jobId: string, plan: Task[]): Promise<void> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  plans.set(jobId, plan);
  await redis.hset(jobKey(jobId), 'status', 'running');
}

/** Checkpoint one subagent's findings as it arrives. */
export async function saveResult(jobId: string, taskId: string, findings: string): Promise<void> {
  const key = \`\${jobKey(jobId)}:results\`;
  const results = JSON.parse((await redis.get(key)) ?? '{}') as Record<string, string>;
  results[taskId] = findings;
  await redis.set(key, JSON.stringify(results));
}

/** The plan's tasks without a result, and the results in hand. */
export async function resume(jobId: string): Promise<{pending: Task[]; results: Record<string, string>}> {
  const results = JSON.parse((await redis.get(\`\${jobKey(jobId)}:results\`)) ?? '{}') as Record<string, string>;
  const pending = (plans.get(jobId) ?? []).filter(task => !(task.id in results));
  return {pending, results};
}

/** Whether the job may make one more tool call; counts it when it may. */
export async function reserveToolCall(jobId: string, maxToolCalls: number): Promise<boolean> {
  const key = \`\${jobKey(jobId)}:tools\`;
  const used = Number((await redis.get(key)) ?? 0);
  if (used >= maxToolCalls) return false;
  await redis.incr(key);
  return true;
}
`,
      solution: `import Redis from 'ioredis';

import {jobKey, type Task} from 'research/jobs';

export const CHECKPOINT_TTL_S = 86400;

// Count, compare and roll back in one step: no other client runs between the INCR and the DECR.
export const RESERVE_LUA = \`
local used = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
if used > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
\`;

interface CheckpointRedis extends Redis {
  reserve(key: string, maxToolCalls: number, ttl: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as CheckpointRedis;
redis.defineCommand('reserve', {numberOfKeys: 1, lua: RESERVE_LUA});

/** Record the job's plan and mark it running. */
export async function startJob(jobId: string, plan: Task[]): Promise<void> {
  await redis.hset(jobKey(jobId), {status: 'running', plan: JSON.stringify(plan)});
  await redis.expire(jobKey(jobId), CHECKPOINT_TTL_S);
}

/** Checkpoint one subagent's findings as it arrives. */
export async function saveResult(jobId: string, taskId: string, findings: string): Promise<void> {
  const key = \`\${jobKey(jobId)}:results\`;
  await redis.hset(key, taskId, findings); // one field per task: two subagents never overwrite each other
  await redis.expire(key, CHECKPOINT_TTL_S);
}

/** The plan's tasks without a result, and the results in hand. */
export async function resume(jobId: string): Promise<{pending: Task[]; results: Record<string, string>}> {
  const raw = await redis.hget(jobKey(jobId), 'plan');
  const plan = raw === null ? [] : (JSON.parse(raw) as Task[]);
  const results = await redis.hgetall(\`\${jobKey(jobId)}:results\`);
  return {pending: plan.filter(task => !(task.id in results)), results};
}

/** Whether the job may make one more tool call; counts it when it may. */
export async function reserveToolCall(jobId: string, maxToolCalls: number): Promise<boolean> {
  return (await redis.reserve(\`\${jobKey(jobId)}:tools\`, maxToolCalls, CHECKPOINT_TTL_S)) === 1;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/redis/go-redis/v9"

	"research/jobs" // jobs.JobKey, jobs.Task
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var plans = map[string][]jobs.Task{}

// startJob records the job's plan and marks it running.
func startJob(ctx context.Context, jobID string, plan []jobs.Task) error {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	plans[jobID] = plan
	return rdb.HSet(ctx, jobs.JobKey(jobID), "status", "running").Err()
}

// saveResult checkpoints one subagent's findings as it arrives.
func saveResult(ctx context.Context, jobID, taskID, findings string) error {
	key := jobs.JobKey(jobID) + ":results"
	results := map[string]string{}
	if raw, err := rdb.Get(ctx, key).Result(); err == nil {
		json.Unmarshal([]byte(raw), &results)
	}
	results[taskID] = findings
	data, _ := json.Marshal(results)
	return rdb.Set(ctx, key, data, 0).Err()
}

// resume returns the plan's tasks without a result, and the results in hand.
func resume(ctx context.Context, jobID string) ([]jobs.Task, map[string]string, error) {
	results := map[string]string{}
	if raw, err := rdb.Get(ctx, jobs.JobKey(jobID)+":results").Result(); err == nil {
		json.Unmarshal([]byte(raw), &results)
	}
	var pending []jobs.Task
	for _, task := range plans[jobID] {
		if _, done := results[task.ID]; !done {
			pending = append(pending, task)
		}
	}
	return pending, results, nil
}

// reserveToolCall reports whether the job may make one more tool call, and counts it when it may.
func reserveToolCall(ctx context.Context, jobID string, maxToolCalls int) (bool, error) {
	key := jobs.JobKey(jobID) + ":tools"
	used, _ := strconv.Atoi(rdb.Get(ctx, key).Val())
	if used >= maxToolCalls {
		return false, nil
	}
	return true, rdb.Incr(ctx, key).Err()
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"

	"research/jobs" // jobs.JobKey, jobs.Task
)

const checkpointTTL = 24 * time.Hour

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// reserveScript counts, compares and rolls back in one step: no other client runs between the INCR and the DECR.
var reserveScript = redis.NewScript(\`
local used = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
if used > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
\`)

// startJob records the job's plan and marks it running.
func startJob(ctx context.Context, jobID string, plan []jobs.Task) error {
	data, _ := json.Marshal(plan)
	if err := rdb.HSet(ctx, jobs.JobKey(jobID), "status", "running", "plan", string(data)).Err(); err != nil {
		return err
	}
	return rdb.Expire(ctx, jobs.JobKey(jobID), checkpointTTL).Err()
}

// saveResult checkpoints one subagent's findings as it arrives.
func saveResult(ctx context.Context, jobID, taskID, findings string) error {
	key := jobs.JobKey(jobID) + ":results"
	// One field per task: two subagents never overwrite each other.
	if err := rdb.HSet(ctx, key, taskID, findings).Err(); err != nil {
		return err
	}
	return rdb.Expire(ctx, key, checkpointTTL).Err()
}

// resume returns the plan's tasks without a result, and the results in hand.
func resume(ctx context.Context, jobID string) ([]jobs.Task, map[string]string, error) {
	var plan []jobs.Task
	raw, err := rdb.HGet(ctx, jobs.JobKey(jobID), "plan").Result()
	if err != nil && err != redis.Nil {
		return nil, nil, err
	}
	if raw != "" {
		if err := json.Unmarshal([]byte(raw), &plan); err != nil {
			return nil, nil, err
		}
	}
	results, err := rdb.HGetAll(ctx, jobs.JobKey(jobID)+":results").Result()
	if err != nil {
		return nil, nil, err
	}
	var pending []jobs.Task
	for _, task := range plan {
		if _, done := results[task.ID]; !done {
			pending = append(pending, task)
		}
	}
	return pending, results, nil
}

// reserveToolCall reports whether the job may make one more tool call, and counts it when it may.
func reserveToolCall(ctx context.Context, jobID string, maxToolCalls int) (bool, error) {
	granted, err := reserveScript.Run(ctx, rdb, []string{jobs.JobKey(jobID) + ":tools"}, maxToolCalls, int(checkpointTTL.Seconds())).Int()
	return granted == 1, err
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.collection.concurrent.TrieMap

import research.Jobs // Jobs.jobKey, Jobs.Task

object Checkpoints {
  private val jedis = new JedisPooled("redis", 6379)
  private val plans = TrieMap.empty[String, Seq[Jobs.Task]]

  /** Record the job's plan and mark it running. */
  def startJob(jobId: String, plan: Seq[Jobs.Task]): Unit = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    plans(jobId) = plan
    jedis.hset(Jobs.jobKey(jobId), "status", "running")
  }

  private def readResults(key: String): Map[String, String] =
    Option(jedis.get(key)).map(_.parseJson.convertTo[Map[String, String]]).getOrElse(Map.empty)

  /** Checkpoint one subagent's findings as it arrives. */
  def saveResult(jobId: String, taskId: String, findings: String): Unit = {
    val key = s"\${Jobs.jobKey(jobId)}:results"
    val results = readResults(key)
    jedis.set(key, (results + (taskId -> findings)).toJson.compactPrint)
  }

  /** The plan's tasks without a result, and the results in hand. */
  def resume(jobId: String): (Seq[Jobs.Task], Map[String, String]) = {
    val results = readResults(s"\${Jobs.jobKey(jobId)}:results")
    (plans.getOrElse(jobId, Seq.empty).filterNot(task => results.contains(task.id)), results)
  }

  /** Whether the job may make one more tool call; counts it when it may. */
  def reserveToolCall(jobId: String, maxToolCalls: Int): Boolean = {
    val key = s"\${Jobs.jobKey(jobId)}:tools"
    val used = Option(jedis.get(key)).map(_.toInt).getOrElse(0)
    if (used >= maxToolCalls) false
    else {
      jedis.incr(key)
      true
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

import research.Jobs // Jobs.jobKey, Jobs.Task

object Checkpoints {
  val CheckpointTtlS = 86400L

  // Count, compare and roll back in one step: no other client runs between the INCR and the DECR.
  val ReserveLua: String =
    """local used = redis.call('INCR', KEYS[1])
      |redis.call('EXPIRE', KEYS[1], ARGV[2])
      |if used > tonumber(ARGV[1]) then
      |  redis.call('DECR', KEYS[1])
      |  return 0
      |end
      |return 1
      |""".stripMargin

  private val jedis = new JedisPooled("redis", 6379)
  private implicit val taskFormat: RootJsonFormat[Jobs.Task] =
    jsonFormat(Jobs.Task.apply, "id", "objective", "output_format", "tools", "boundaries")

  /** Record the job's plan and mark it running. */
  def startJob(jobId: String, plan: Seq[Jobs.Task]): Unit = {
    jedis.hset(Jobs.jobKey(jobId), Map("status" -> "running", "plan" -> plan.toJson.compactPrint).asJava)
    jedis.expire(Jobs.jobKey(jobId), CheckpointTtlS)
  }

  /** Checkpoint one subagent's findings as it arrives. */
  def saveResult(jobId: String, taskId: String, findings: String): Unit = {
    val key = s"\${Jobs.jobKey(jobId)}:results"
    jedis.hset(key, taskId, findings) // one field per task: two subagents never overwrite each other
    jedis.expire(key, CheckpointTtlS)
  }

  /** The plan's tasks without a result, and the results in hand. */
  def resume(jobId: String): (Seq[Jobs.Task], Map[String, String]) = {
    val plan = Option(jedis.hget(Jobs.jobKey(jobId), "plan")).map(_.parseJson.convertTo[Seq[Jobs.Task]]).getOrElse(Seq.empty)
    val results = jedis.hgetAll(s"\${Jobs.jobKey(jobId)}:results").asScala.toMap
    (plan.filterNot(task => results.contains(task.id)), results)
  }

  /** Whether the job may make one more tool call; counts it when it may. */
  def reserveToolCall(jobId: String, maxToolCalls: Int): Boolean = {
    val args = List(maxToolCalls.toString, CheckpointTtlS.toString).asJava
    jedis.eval(ReserveLua, List(s"\${Jobs.jobKey(jobId)}:tools").asJava, args).asInstanceOf[java.lang.Long] == 1L
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <string>
#include <vector>

#include "research/jobs.h"  // jobs::jobKey, jobs::Task

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

std::map<std::string, std::vector<jobs::Task>> plans;

// The plan's tasks without a result, and the results in hand.
struct Resumed {
  std::vector<jobs::Task> pending;
  std::map<std::string, std::string> results;
};

// Record the job's plan and mark it running.
void startJob(const std::string& job_id, const std::vector<jobs::Task>& plan) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  plans[job_id] = plan;
  redis.hset(jobs::jobKey(job_id), "status", "running");
}

// Checkpoint one subagent's findings as it arrives.
void saveResult(const std::string& job_id, const std::string& task_id, const std::string& findings) {
  const std::string key = jobs::jobKey(job_id) + ":results";
  json results = json::parse(redis.get(key).value_or("{}"));
  results[task_id] = findings;
  redis.set(key, results.dump());
}

Resumed resume(const std::string& job_id) {
  Resumed out;
  out.results = json::parse(redis.get(jobs::jobKey(job_id) + ":results").value_or("{}")).get<std::map<std::string, std::string>>();
  for (const jobs::Task& task : plans[job_id]) {
    if (!out.results.count(task.id)) out.pending.push_back(task);
  }
  return out;
}

// Whether the job may make one more tool call; counts it when it may.
bool reserveToolCall(const std::string& job_id, long max_tool_calls) {
  const std::string key = jobs::jobKey(job_id) + ":tools";
  const auto raw = redis.get(key);
  const long used = raw ? std::stol(*raw) : 0;
  if (used >= max_tool_calls) return false;
  redis.incr(key);
  return true;
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <map>
#include <string>
#include <vector>

#include "research/jobs.h"  // jobs::jobKey, jobs::Task

using json = nlohmann::json;

constexpr long kCheckpointTtlS = 86400;

// Count, compare and roll back in one step: no other client runs between the INCR and the DECR.
const std::string kReserveLua = R"lua(
local used = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
if used > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
)lua";

sw::redis::Redis redis("tcp://redis:6379");

// The plan's tasks without a result, and the results in hand.
struct Resumed {
  std::vector<jobs::Task> pending;
  std::map<std::string, std::string> results;
};

// Record the job's plan and mark it running.
void startJob(const std::string& job_id, const std::vector<jobs::Task>& plan) {
  redis.hset(jobs::jobKey(job_id), "status", "running", "plan", json(plan).dump());
  redis.expire(jobs::jobKey(job_id), kCheckpointTtlS);
}

// Checkpoint one subagent's findings as it arrives.
void saveResult(const std::string& job_id, const std::string& task_id, const std::string& findings) {
  const std::string key = jobs::jobKey(job_id) + ":results";
  redis.hset(key, task_id, findings);  // one field per task: two subagents never overwrite each other
  redis.expire(key, kCheckpointTtlS);
}

Resumed resume(const std::string& job_id) {
  Resumed out;
  const auto raw = redis.hget(jobs::jobKey(job_id), "plan");
  const std::vector<jobs::Task> plan = raw ? json::parse(*raw).get<std::vector<jobs::Task>>() : std::vector<jobs::Task>{};
  redis.hgetall(jobs::jobKey(job_id) + ":results", std::inserter(out.results, out.results.end()));
  for (const jobs::Task& task : plan) {
    if (!out.results.count(task.id)) out.pending.push_back(task);
  }
  return out;
}

// Whether the job may make one more tool call; counts it when it may.
bool reserveToolCall(const std::string& job_id, long max_tool_calls) {
  return redis.eval<long long>(kReserveLua, {jobs::jobKey(job_id) + ":tools"}, {std::to_string(max_tool_calls), std::to_string(kCheckpointTtlS)}) == 1;
}
`,
    },
  },
  harness: {
    python: `import json

PLAN = [
    {"id": f"t-{i}", "objective": f"Find the board members of bank {i}", "output_format": "one line per member", "tools": ["search", "fetch"], "boundaries": "annual reports from 2024 on"}
    for i in (1, 2, 3)
]


def _settled(probe, what):
    assert probe.fired, f"nothing touched {what}"
    if probe.error is not None:
        raise probe.error
    return probe.result


def check_resume(ctx):
    m = ctx.load("checkpoints")
    m.start_job("job-1", PLAN)
    raw = ctx.redis.hget("research:job-1", "plan")
    assert raw is not None and json.loads(raw) == PLAN, f"after start_job the field plan of research:job-1 is {raw!r}: a plan kept in this process is gone when the lead restarts. Write it into research:{{job_id}}"
    status = ctx.redis.hget("research:job-1", "status")
    assert status == "running", f"after start_job the field status of research:job-1 is {status!r}, expected running"
    # research:job-9 holds a string, so saving its plan fails (WRONGTYPE): the lead must hear about it.
    ctx.redis.set("research:job-9", "not a hash")
    try:
        m.start_job("job-9", PLAN)
    except Exception:
        pass
    else:
        raise AssertionError("start_job returned although writing research:job-9 failed (WRONGTYPE): a checkpoint write that fails must reach the caller, or the lead believes a plan is saved that is not")
    # The lead that started job-7 crashed after t-1 came back; a restarted process resumes it.
    ctx.redis.hset("research:job-7", mapping={"status": "running", "plan": json.dumps(PLAN)})
    m.save_result("job-7", "t-1", "chair: A. Jones")
    m = ctx.load("checkpoints")
    pending, results = m.resume("job-7")
    assert [t["id"] for t in pending] == ["t-2", "t-3"], f"a restarted lead resuming job-7 got the pending tasks {[t['id'] for t in pending]}, expected t-2 and t-3"
    assert pending == PLAN[1:], f"resume must answer the pending tasks whole, got {pending}"
    assert results == {"t-1": "chair: A. Jones"}, f"resume answered the results {results}, expected t-1's"


def check_concurrent_results(ctx):
    m = ctx.load("checkpoints")
    m.start_job("job-1", PLAN)
    # t-2's subagent finishes while t-1's result is being written.
    rival = ctx.redis_after("research:job-1:results", lambda: m.save_result("job-1", "t-2", "CFO: B. Smith"))
    m.save_result("job-1", "t-1", "chair: A. Jones")
    _settled(rival, "research:job-1:results")
    pending, results = m.resume("job-1")
    assert results == {"t-1": "chair: A. Jones", "t-2": "CFO: B. Smith"}, f"two results saved at the same time left {results}: one overwrote the other. Store each result as its own field of the hash"
    assert [t["id"] for t in pending] == ["t-3"], f"resume answered the pending tasks {[t['id'] for t in pending]}, expected t-3"
    assert ctx.redis.type("research:job-1:results") == "hash", f"research:job-1:results is a {ctx.redis.type('research:job-1:results')}, expected a hash with one field per task"


def check_ttl(ctx):
    m = ctx.load("checkpoints")
    m.start_job("job-1", PLAN)
    m.save_result("job-1", "t-1", "chair: A. Jones")
    assert m.reserve_tool_call("job-1", 10), "the first tool call of a budget of 10 must be granted"
    for key in ("research:job-1", "research:job-1:results", "research:job-1:tools"):
        ttl = ctx.redis.ttl(key)
        assert 86000 < ttl <= 86400, f"{key} has a TTL of {ttl}: every checkpoint key must expire CHECKPOINT_TTL_S = 86400 s after its last write"
    # The counter's expiry is part of the reservation: written in a second command, a crash in between leaves a counter that never expires.
    seen = ctx.redis_after("research:job-2:tools", lambda: ctx.redis.ttl("research:job-2:tools"))
    m.reserve_tool_call("job-2", 10)
    ttl = _settled(seen, "research:job-2:tools")
    assert 86000 < ttl <= 86400, f"right after the reservation's first command touched research:job-2:tools its TTL was {ttl}: refresh the expiry inside RESERVE_LUA, in the same step as the INCR"
    ctx.clock.advance(3600)
    m.save_result("job-1", "t-2", "CFO: B. Smith")
    m.reserve_tool_call("job-1", 10)
    for key in ("research:job-1:results", "research:job-1:tools"):
        ttl = ctx.redis.ttl(key)
        assert ttl > 86000, f"an hour later {key} was written again but its TTL is {ttl}: each write refreshes the expiry"


def check_atomic_reserve(ctx):
    m = ctx.load("checkpoints")
    granted = [m.reserve_tool_call("job-1", 3) for _ in range(4)]
    assert granted == [True, True, True, False], f"four reservations on a budget of 3 answered {granted}"
    assert ctx.redis.get("research:job-1:tools") == "3", f"research:job-1:tools is {ctx.redis.get('research:job-1:tools')!r} after a refused reservation, expected 3"
    # job-2 has used 9 of its 10 tool calls; two subagents ask for the last one at the same time.
    ctx.redis.set("research:job-2:tools", 9)
    rival = ctx.redis_after("research:job-2:tools", lambda: m.reserve_tool_call("job-2", 10))
    mine = m.reserve_tool_call("job-2", 10)
    theirs = _settled(rival, "research:job-2:tools")
    grants = [mine, theirs].count(True)
    assert grants == 1, f"two concurrent reservations for the last tool call of the budget were both granted ({mine}, {theirs}): count and compare in one Lua script"
    assert ctx.redis.get("research:job-2:tools") == "10", f"research:job-2:tools is {ctx.redis.get('research:job-2:tools')!r}, expected 10"
    # job-3 has spent its 10 tool calls: a refused reservation must never leave the counter over budget, even for a moment.
    ctx.redis.set("research:job-3:tools", 10)
    seen = ctx.redis_after("research:job-3:tools", lambda: ctx.redis.get("research:job-3:tools"))
    assert not m.reserve_tool_call("job-3", 10), "a reservation on a spent budget of 10 was granted"
    used = _settled(seen, "research:job-3:tools")
    assert used == "10", f"right after the refused reservation's first command research:job-3:tools read {used!r}: a subagent reading it then sees the budget overspent. Count, compare and roll back in one Lua script"
`,
    typescript: `const PLAN = [1, 2, 3].map(i => ({
  id: \`t-\${i}\`,
  objective: \`Find the board members of bank \${i}\`,
  output_format: 'one line per member',
  tools: ['search', 'fetch'],
  boundaries: 'annual reports from 2024 on',
}));

async function settled(probe, what: string) {
  assert(probe.fired, \`nothing touched \${what}\`);
  if (probe.error !== undefined) throw probe.error;
  return await probe.result;
}

export async function check_resume(ctx) {
  let m = ctx.load('checkpoints');
  await m.startJob('job-1', PLAN);
  const raw = ctx.redis.hget('research:job-1', 'plan');
  assert(raw !== null && JSON.stringify(JSON.parse(raw)) === JSON.stringify(PLAN), \`after startJob the field plan of research:job-1 is \${JSON.stringify(raw)}: a plan kept in this process is gone when the lead restarts. Write it into research:{jobId}\`);
  const status = ctx.redis.hget('research:job-1', 'status');
  assert.equal(status, 'running', \`after startJob the field status of research:job-1 is \${JSON.stringify(status)}, expected running\`);
  // research:job-9 holds a string, so saving its plan fails (WRONGTYPE): the lead must hear about it.
  ctx.redis.set('research:job-9', 'not a hash');
  let failed = false;
  try {
    await m.startJob('job-9', PLAN);
  } catch {
    failed = true;
  }
  assert(failed, 'startJob resolved although writing research:job-9 failed (WRONGTYPE): await every checkpoint write, so a failure reaches the caller instead of a lead that believes a plan is saved');
  // The lead that started job-7 crashed after t-1 came back; a restarted process resumes it.
  ctx.redis.hset('research:job-7', {status: 'running', plan: JSON.stringify(PLAN)});
  await m.saveResult('job-7', 't-1', 'chair: A. Jones');
  m = ctx.load('checkpoints');
  const {pending, results} = await m.resume('job-7');
  assert.deepStrictEqual(pending.map(t => t.id), ['t-2', 't-3'], \`a restarted lead resuming job-7 got the pending tasks \${JSON.stringify(pending.map(t => t.id))}, expected t-2 and t-3\`);
  assert.deepStrictEqual(pending, PLAN.slice(1), 'resume must answer the pending tasks whole');
  assert.deepStrictEqual({...results}, {'t-1': 'chair: A. Jones'}, \`resume answered the results \${JSON.stringify(results)}, expected t-1's\`);
}

export async function check_concurrent_results(ctx) {
  const m = ctx.load('checkpoints');
  await m.startJob('job-1', PLAN);
  // t-2's subagent finishes while t-1's result is being written.
  const rival = ctx.redisAfter('research:job-1:results', () => m.saveResult('job-1', 't-2', 'CFO: B. Smith'));
  await m.saveResult('job-1', 't-1', 'chair: A. Jones');
  await settled(rival, 'research:job-1:results');
  const {pending, results} = await m.resume('job-1');
  assert.deepStrictEqual({...results}, {'t-1': 'chair: A. Jones', 't-2': 'CFO: B. Smith'}, \`two results saved at the same time left \${JSON.stringify(results)}: one overwrote the other. Store each result as its own field of the hash\`);
  assert.deepStrictEqual(pending.map(t => t.id), ['t-3'], \`resume answered the pending tasks \${JSON.stringify(pending.map(t => t.id))}, expected t-3\`);
  assert.equal(ctx.redis.type('research:job-1:results'), 'hash', 'research:job-1:results must be a hash with one field per task');
}

export async function check_ttl(ctx) {
  const m = ctx.load('checkpoints');
  await m.startJob('job-1', PLAN);
  await m.saveResult('job-1', 't-1', 'chair: A. Jones');
  assert(await m.reserveToolCall('job-1', 10), 'the first tool call of a budget of 10 must be granted');
  for (const key of ['research:job-1', 'research:job-1:results', 'research:job-1:tools']) {
    const ttl = ctx.redis.ttl(key);
    assert(86000 < ttl && ttl <= 86400, \`\${key} has a TTL of \${ttl}: every checkpoint key must expire CHECKPOINT_TTL_S = 86400 s after its last write\`);
  }
  // The counter's expiry is part of the reservation: written in a second command, a crash in between leaves a counter that never expires.
  const seen = ctx.redisAfter('research:job-2:tools', () => ctx.redis.ttl('research:job-2:tools'));
  await m.reserveToolCall('job-2', 10);
  const ttl = await settled(seen, 'research:job-2:tools');
  assert(86000 < ttl && ttl <= 86400, \`right after the reservation's first command touched research:job-2:tools its TTL was \${ttl}: refresh the expiry inside RESERVE_LUA, in the same step as the INCR\`);
  ctx.clock.advance(3600);
  await m.saveResult('job-1', 't-2', 'CFO: B. Smith');
  await m.reserveToolCall('job-1', 10);
  for (const key of ['research:job-1:results', 'research:job-1:tools']) {
    const ttl = ctx.redis.ttl(key);
    assert(ttl > 86000, \`an hour later \${key} was written again but its TTL is \${ttl}: each write refreshes the expiry\`);
  }
}

export async function check_atomic_reserve(ctx) {
  const m = ctx.load('checkpoints');
  const granted: boolean[] = [];
  for (let i = 0; i < 4; i++) granted.push(await m.reserveToolCall('job-1', 3));
  assert.deepStrictEqual(granted, [true, true, true, false], \`four reservations on a budget of 3 answered \${JSON.stringify(granted)}\`);
  assert.equal(ctx.redis.get('research:job-1:tools'), '3', 'research:job-1:tools after a refused reservation');
  // job-2 has used 9 of its 10 tool calls; two subagents ask for the last one at the same time.
  ctx.redis.set('research:job-2:tools', '9');
  const rival = ctx.redisAfter('research:job-2:tools', () => m.reserveToolCall('job-2', 10));
  const mine = await m.reserveToolCall('job-2', 10);
  const theirs = await settled(rival, 'research:job-2:tools');
  assert.equal([mine, theirs].filter(Boolean).length, 1, \`two concurrent reservations for the last tool call of the budget were both granted (\${mine}, \${theirs}): count and compare in one Lua script\`);
  assert.equal(ctx.redis.get('research:job-2:tools'), '10', 'research:job-2:tools after the race');
  // job-3 has spent its 10 tool calls: a refused reservation must never leave the counter over budget, even for a moment.
  ctx.redis.set('research:job-3:tools', '10');
  const seen = ctx.redisAfter('research:job-3:tools', () => ctx.redis.get('research:job-3:tools'));
  assert.equal(await m.reserveToolCall('job-3', 10), false, 'a reservation on a spent budget of 10 must be refused');
  const used = await settled(seen, 'research:job-3:tools');
  assert.equal(used, '10', \`right after the refused reservation's first command research:job-3:tools read \${JSON.stringify(used)}: a subagent reading it then sees the budget overspent. Count, compare and roll back in one Lua script\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"research/jobs"

	"leetbuild/harness"
)

var cpBg = context.Background()

func cpPlan() []jobs.Task {
	var plan []jobs.Task
	for i := 1; i <= 3; i++ {
		plan = append(plan, jobs.Task{ID: fmt.Sprintf("t-%d", i), Objective: fmt.Sprintf("Find the board members of bank %d", i),
			OutputFormat: "one line per member", Tools: []string{"search", "fetch"}, Boundaries: "annual reports from 2024 on"})
	}
	return plan
}

func ids(tasks []jobs.Task) []string {
	out := []string{}
	for _, t := range tasks {
		out = append(out, t.ID)
	}
	return out
}

func mustResume(ctx *harness.Ctx, jobID string) ([]jobs.Task, map[string]string) {
	pending, results, err := resume(cpBg, jobID)
	ctx.NoError(err, "resume(%s) failed", jobID)
	return pending, results
}

func mustReserve(ctx *harness.Ctx, jobID string, max int) bool {
	granted, err := reserveToolCall(cpBg, jobID, max)
	ctx.NoError(err, "reserveToolCall(%s) failed", jobID)
	return granted
}

func CheckResume(ctx *harness.Ctx) {
	plan := cpPlan()
	ctx.NoError(startJob(cpBg, "job-1", plan), "startJob failed")
	raw, _ := ctx.Redis.HGet("research:job-1", "plan")
	var stored []jobs.Task
	json.Unmarshal([]byte(raw), &stored)
	ctx.Equal(stored, plan, "after startJob the field plan of research:job-1 (%q): a plan kept in this process is gone when the lead restarts. Write it into research:{job_id}", raw)
	status, _ := ctx.Redis.HGet("research:job-1", "status")
	ctx.Equal(status, "running", "after startJob the field status of research:job-1")
	// research:job-9 holds a string, so saving its plan fails (WRONGTYPE): the lead must hear about it.
	ctx.Redis.Set("research:job-9", "not a hash")
	ctx.Assert(startJob(cpBg, "job-9", plan) != nil, "startJob returned no error although writing research:job-9 failed (WRONGTYPE): a checkpoint write that fails must reach the caller, or the lead believes a plan is saved that is not")
	// The lead that started job-7 crashed after t-1 came back; a restarted process resumes it.
	data, _ := json.Marshal(plan)
	ctx.Redis.Do("HSET", "research:job-7", "status", "running", "plan", string(data))
	ctx.NoError(saveResult(cpBg, "job-7", "t-1", "chair: A. Jones"), "saveResult failed")
	pending, results := mustResume(ctx, "job-7")
	ctx.Equal(ids(pending), []string{"t-2", "t-3"}, "a restarted lead resuming job-7; the pending tasks")
	ctx.Equal(pending, plan[1:], "resume must answer the pending tasks whole")
	ctx.Equal(results, map[string]string{"t-1": "chair: A. Jones"}, "resume's results")
}

func CheckConcurrentResults(ctx *harness.Ctx) {
	ctx.NoError(startJob(cpBg, "job-1", cpPlan()), "startJob failed")
	// t-2's subagent finishes while t-1's result is being written.
	rival := ctx.Redis.After("research:job-1:results", func() any { return saveResult(cpBg, "job-1", "t-2", "CFO: B. Smith") })
	ctx.NoError(saveResult(cpBg, "job-1", "t-1", "chair: A. Jones"), "saveResult failed")
	ctx.Assert(rival.Fired, "nothing touched research:job-1:results")
	pending, results := mustResume(ctx, "job-1")
	ctx.Equal(results, map[string]string{"t-1": "chair: A. Jones", "t-2": "CFO: B. Smith"}, "two results saved at the same time must both survive (one overwrote the other: store each result as its own field of the hash); the results")
	ctx.Equal(ids(pending), []string{"t-3"}, "the pending tasks")
	ctx.Equal(ctx.Redis.Type("research:job-1:results"), "hash", "research:job-1:results must be a hash with one field per task; its type")
}

func CheckTtl(ctx *harness.Ctx) {
	ctx.NoError(startJob(cpBg, "job-1", cpPlan()), "startJob failed")
	ctx.NoError(saveResult(cpBg, "job-1", "t-1", "chair: A. Jones"), "saveResult failed")
	ctx.Assert(mustReserve(ctx, "job-1", 10), "the first tool call of a budget of 10 must be granted")
	for _, key := range []string{"research:job-1", "research:job-1:results", "research:job-1:tools"} {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(86000 < ttl && ttl <= 86400, "%s has a TTL of %d: every checkpoint key must expire checkpointTTL = 24 h after its last write", key, ttl)
	}
	// The counter's expiry is part of the reservation: written in a second command, a crash in between leaves a counter that never expires.
	var ttl int64
	seen := ctx.Redis.After("research:job-2:tools", func() any {
		ttl = ctx.Redis.TTL("research:job-2:tools")
		return nil
	})
	mustReserve(ctx, "job-2", 10)
	ctx.Assert(seen.Fired, "nothing touched research:job-2:tools")
	ctx.Assert(86000 < ttl && ttl <= 86400, "right after the reservation's first command touched research:job-2:tools its TTL was %d: refresh the expiry inside the reservation script, in the same step as the INCR", ttl)
	ctx.Clock.Advance(3600)
	ctx.NoError(saveResult(cpBg, "job-1", "t-2", "CFO: B. Smith"), "saveResult failed")
	mustReserve(ctx, "job-1", 10)
	for _, key := range []string{"research:job-1:results", "research:job-1:tools"} {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(ttl > 86000, "an hour later %s was written again but its TTL is %d: each write refreshes the expiry", key, ttl)
	}
}

func CheckAtomicReserve(ctx *harness.Ctx) {
	var granted []bool
	for i := 0; i < 4; i++ {
		granted = append(granted, mustReserve(ctx, "job-1", 3))
	}
	ctx.Equal(granted, []bool{true, true, true, false}, "four reservations on a budget of 3")
	used, _ := ctx.Redis.Get("research:job-1:tools")
	ctx.Equal(used, "3", "research:job-1:tools after a refused reservation")
	// job-2 has used 9 of its 10 tool calls; two subagents ask for the last one at the same time.
	ctx.Redis.Set("research:job-2:tools", "9")
	rival := ctx.Redis.After("research:job-2:tools", func() any {
		granted, _ := reserveToolCall(cpBg, "job-2", 10)
		return granted
	})
	mine := mustReserve(ctx, "job-2", 10)
	ctx.Assert(rival.Fired, "nothing touched research:job-2:tools")
	theirs, _ := rival.Result.(bool)
	ctx.Assert(!(mine && theirs), "two concurrent reservations for the last tool call of the budget were both granted: count and compare in one Lua script")
	ctx.Assert(mine || theirs, "neither of two reservations for the last tool call was granted")
	used, _ = ctx.Redis.Get("research:job-2:tools")
	ctx.Equal(used, "10", "research:job-2:tools after the race")
	// job-3 has spent its 10 tool calls: a refused reservation must never leave the counter over budget, even for a moment.
	ctx.Redis.Set("research:job-3:tools", "10")
	var seenUsed string
	seen := ctx.Redis.After("research:job-3:tools", func() any {
		seenUsed, _ = ctx.Redis.Get("research:job-3:tools")
		return nil
	})
	ctx.Assert(!mustReserve(ctx, "job-3", 10), "a reservation on a spent budget of 10 was granted")
	ctx.Assert(seen.Fired, "nothing touched research:job-3:tools")
	ctx.Equal(seenUsed, "10", "a subagent reading the counter must never see the budget overspent (count, compare and roll back in one Lua script); research:job-3:tools right after the refused reservation's first command")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <vector>

#include "research/jobs.h"

namespace {

std::vector<jobs::Task> cpPlan() {
  std::vector<jobs::Task> plan;
  for (int i = 1; i <= 3; i++) {
    plan.push_back({"t-" + std::to_string(i), "Find the board members of bank " + std::to_string(i), "one line per member", {"search", "fetch"}, "annual reports from 2024 on"});
  }
  return plan;
}

std::vector<std::string> ids(const std::vector<jobs::Task>& tasks) {
  std::vector<std::string> out;
  for (const auto& t : tasks) out.push_back(t.id);
  return out;
}

}  // namespace

void CheckResume(harness::Ctx& ctx) {
  const auto plan = cpPlan();
  startJob("job-1", plan);
  const auto raw = ctx.Redis.HGet("research:job-1", "plan");
  ctx.Assert(raw && nlohmann::json::parse(*raw, nullptr, false) == nlohmann::json(plan),
             "after startJob the field plan of research:job-1 is %q: a plan kept in this process is gone when the lead restarts. Write it into research:{job_id}", raw.value_or("(none)"));
  ctx.Equal(ctx.Redis.HGet("research:job-1", "status"), std::optional<std::string>("running"), "after startJob the field status of research:job-1");
  // research:job-9 holds a string, so saving its plan fails (WRONGTYPE): the lead must hear about it.
  ctx.Redis.Set("research:job-9", "not a hash");
  bool failed = false;
  try {
    startJob("job-9", plan);
  } catch (const std::exception&) {
    failed = true;
  }
  ctx.Assert(failed, "startJob returned although writing research:job-9 failed (WRONGTYPE): a checkpoint write that fails must reach the caller, or the lead believes a plan is saved that is not");
  // The lead that started job-7 crashed after t-1 came back; a restarted process resumes it.
  ctx.Redis.Do("HSET", "research:job-7", "status", "running", "plan", nlohmann::json(plan).dump());
  saveResult("job-7", "t-1", "chair: A. Jones");
  const Resumed r = resume("job-7");
  ctx.Equal(ids(r.pending), {"t-2", "t-3"}, "a restarted lead resuming job-7; the pending tasks");
  ctx.Assert(nlohmann::json(r.pending) == nlohmann::json(std::vector<jobs::Task>(plan.begin() + 1, plan.end())), "resume must answer the pending tasks whole");
  ctx.Equal(r.results, std::map<std::string, std::string>{{"t-1", "chair: A. Jones"}}, "resume's results");
}

void CheckConcurrentResults(harness::Ctx& ctx) {
  startJob("job-1", cpPlan());
  // t-2's subagent finishes while t-1's result is being written.
  bool fired = false;
  ctx.Redis.After("research:job-1:results", [&fired] {
    fired = true;
    saveResult("job-1", "t-2", "CFO: B. Smith");
  });
  saveResult("job-1", "t-1", "chair: A. Jones");
  ctx.Assert(fired, "nothing touched research:job-1:results");
  const Resumed r = resume("job-1");
  ctx.Equal(r.results, std::map<std::string, std::string>{{"t-1", "chair: A. Jones"}, {"t-2", "CFO: B. Smith"}},
            "two results saved at the same time must both survive (one overwrote the other: store each result as its own field of the hash); the results");
  ctx.Equal(ids(r.pending), {"t-3"}, "the pending tasks");
  ctx.Equal(ctx.Redis.Type("research:job-1:results"), "hash", "research:job-1:results must be a hash with one field per task; its type");
}

void CheckTtl(harness::Ctx& ctx) {
  startJob("job-1", cpPlan());
  saveResult("job-1", "t-1", "chair: A. Jones");
  ctx.Assert(reserveToolCall("job-1", 10), "the first tool call of a budget of 10 must be granted");
  for (const std::string key : {"research:job-1", "research:job-1:results", "research:job-1:tools"}) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(86000 < ttl && ttl <= 86400, "%s has a TTL of %d: every checkpoint key must expire kCheckpointTtlS = 86400 s after its last write", key, ttl);
  }
  // The counter's expiry is part of the reservation: written in a second command, a crash in between leaves a counter that never expires.
  bool fired = false;
  long long seen_ttl = 0;
  ctx.Redis.After("research:job-2:tools", [&ctx, &fired, &seen_ttl] {
    fired = true;
    seen_ttl = ctx.Redis.TTL("research:job-2:tools");
  });
  reserveToolCall("job-2", 10);
  ctx.Assert(fired, "nothing touched research:job-2:tools");
  ctx.Assert(86000 < seen_ttl && seen_ttl <= 86400,
             "right after the reservation's first command touched research:job-2:tools its TTL was %d: refresh the expiry inside kReserveLua, in the same step as the INCR", seen_ttl);
  ctx.Clock.Advance(3600);
  saveResult("job-1", "t-2", "CFO: B. Smith");
  reserveToolCall("job-1", 10);
  for (const std::string key : {"research:job-1:results", "research:job-1:tools"}) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(ttl > 86000, "an hour later %s was written again but its TTL is %d: each write refreshes the expiry", key, ttl);
  }
}

void CheckAtomicReserve(harness::Ctx& ctx) {
  std::vector<bool> granted;
  for (int i = 0; i < 4; i++) granted.push_back(reserveToolCall("job-1", 3));
  ctx.Equal(granted, std::vector<bool>{true, true, true, false}, "four reservations on a budget of 3");
  ctx.Equal(ctx.Redis.Get("research:job-1:tools"), std::optional<std::string>("3"), "research:job-1:tools after a refused reservation");
  // job-2 has used 9 of its 10 tool calls; two subagents ask for the last one at the same time.
  ctx.Redis.Set("research:job-2:tools", "9");
  bool fired = false;
  bool theirs = false;
  ctx.Redis.After("research:job-2:tools", [&fired, &theirs] {
    fired = true;
    theirs = reserveToolCall("job-2", 10);
  });
  const bool mine = reserveToolCall("job-2", 10);
  ctx.Assert(fired, "nothing touched research:job-2:tools");
  ctx.Assert(!(mine && theirs), "two concurrent reservations for the last tool call of the budget were both granted: count and compare in one Lua script");
  ctx.Assert(mine || theirs, "neither of two reservations for the last tool call was granted");
  ctx.Equal(ctx.Redis.Get("research:job-2:tools"), std::optional<std::string>("10"), "research:job-2:tools after the race");
  // job-3 has spent its 10 tool calls: a refused reservation must never leave the counter over budget, even for a moment.
  ctx.Redis.Set("research:job-3:tools", "10");
  bool seen = false;
  std::optional<std::string> used;
  ctx.Redis.After("research:job-3:tools", [&ctx, &seen, &used] {
    seen = true;
    used = ctx.Redis.Get("research:job-3:tools");
  });
  ctx.Assert(!reserveToolCall("job-3", 10), "a reservation on a spent budget of 10 was granted");
  ctx.Assert(seen, "nothing touched research:job-3:tools");
  ctx.Equal(used, std::optional<std::string>("10"),
            "a subagent reading the counter must never see the budget overspent (count, compare and roll back in one Lua script); research:job-3:tools right after the refused reservation's first command");
}
`,
  },
  hints: [
    'Restart the lead in the middle of a job: it finds no plan and runs every subagent again. Two subagents that finish together leave one result, and a job abandoned last month still has keys in Redis.',
    'The plan lives in a dictionary of one process; the results are one JSON value read, changed and written back, so the second writer overwrites the first; nothing sets an expiry; the reservation reads, compares and then increments in three round trips.',
    'HSET `plan` (JSON) into `research:{job_id}`; HSET each result into `research:{job_id}:results` and read it with HGETALL; EXPIRE every key you write to 86400; run `RESERVE_LUA` (INCR, EXPIRE, DECR and 0 when over) for every reservation.',
  ],
  debrief: `A checkpoint is only a checkpoint if a different process can read it, which is why the plan and the results move into Redis and the dictionary goes. A hash with one field per task makes saving a result a single command, so two subagents finishing in the same millisecond cannot overwrite each other the way a read-modify-write of one JSON value does. The expiry refreshed on every write bounds what an abandoned job costs. The Lua script is the budget's lock: count, compare and roll back happen with no other client in between, so the last tool call is granted once. Production orchestrators also record which subagent attempt produced a result, so a resumed lead can tell a late reply from a retried one.`,
};
