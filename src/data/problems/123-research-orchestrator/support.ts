/**
 * Hand-written support modules the research-orchestrator steps import but no step builds: the
 * `research` package's job store (`research.jobs`). A research job is the Redis hash
 * research:{job_id} (tenant, effort, query, status, the budget and the service version that started
 * it); research:idem:{tenant}:{key} maps a client's Idempotency-Key to the job it started;
 * research:queue is the list the lead agent workers take job ids from. The plan's unit, a Task, and
 * the Budget live here too, so every step and every language share one shape. The five languages
 * keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'research/__init__.py': '',
  'research/jobs.py': `"""
The job store (provided). A research job is the Redis hash research:{job_id} with tenant, effort,
query, status, the budget (max_subagents, max_tool_calls, token_budget) and version, the service
version that started it; research:idem:{tenant}:{key} holds the job a client's Idempotency-Key
started; research:queue is the list the lead agent workers take job ids from. Keys expire
JOB_TTL_S after they are written. A job is returned as a dict (job_id, tenant, effort, status,
budget, version) with the budget as a dict of ints; the query stays in Redis for the lead agent.

A task of a plan is a dict: id, objective, output_format, tools (a list of tool names), boundaries.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SERVICE_VERSION = "2.3.0"
JOB_TTL_S = 86400
BUDGET_FIELDS = ("max_subagents", "max_tool_calls", "token_budget")


def job_key(job_id: str) -> str:
    return f"research:{job_id}"


def _idem_key(tenant: str, key: str) -> str:
    return f"research:idem:{tenant}:{key}"


def create_job(tenant: str, query: str, effort: str, budget: dict) -> dict:
    """Store a new queued job with this budget, pinned to SERVICE_VERSION; returns the job."""
    job_id = f"job-{r.incr('research:seq')}"
    fields = {"tenant": tenant, "effort": effort, "query": query, "status": "queued", "version": SERVICE_VERSION}
    fields.update({name: int(budget[name]) for name in BUDGET_FIELDS})
    r.hset(job_key(job_id), mapping=fields)
    r.expire(job_key(job_id), JOB_TTL_S)
    return get_job(job_id)


def get_job(job_id: str) -> dict | None:
    """The job with this id, or None."""
    raw = r.hgetall(job_key(job_id))
    if not raw:
        return None
    return {
        "job_id": job_id,
        "tenant": raw["tenant"],
        "effort": raw["effort"],
        "status": raw["status"],
        "budget": {name: int(raw[name]) for name in BUDGET_FIELDS},
        "version": raw["version"],
    }


def job_for_key(tenant: str, key: str) -> str | None:
    """The id of the job the tenant's Idempotency-Key started, if any."""
    return r.get(_idem_key(tenant, key))


def remember_key(tenant: str, key: str, job_id: str) -> str:
    """Record that the tenant's Idempotency-Key started job_id, unless a concurrent request recorded
    its own job first (SET NX); returns the job the key belongs to."""
    if r.set(_idem_key(tenant, key), job_id, nx=True, ex=JOB_TTL_S):
        return job_id
    return r.get(_idem_key(tenant, key))


def enqueue(job_id: str) -> None:
    """Hand the job to the lead agent workers; returns at once."""
    r.rpush("research:queue", job_id)
`,
};

export const supportModulesTs: Record<string, string> = {
  'research/jobs.ts': `/**
 * The job store (provided). A research job is the Redis hash research:{job_id} with tenant, effort,
 * query, status, the budget (max_subagents, max_tool_calls, token_budget) and version, the service
 * version that started it; research:idem:{tenant}:{key} holds the job a client's Idempotency-Key
 * started; research:queue is the list the lead agent workers take job ids from. Keys expire
 * JOB_TTL_S after they are written. The query stays in Redis for the lead agent.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const SERVICE_VERSION = '2.3.0';
export const JOB_TTL_S = 86400;

export interface Budget {
  max_subagents: number;
  max_tool_calls: number;
  token_budget: number;
}

export interface Job {
  job_id: string;
  tenant: string;
  effort: string;
  status: string;
  budget: Budget;
  version: string;
}

/** One task of a plan: what a subagent is asked to find, in what shape, with which tools, where to stop. */
export interface Task {
  id: string;
  objective: string;
  output_format: string;
  tools: string[];
  boundaries: string;
}

export const jobKey = (jobId: string): string => \`research:\${jobId}\`;
const idemKey = (tenant: string, key: string): string => \`research:idem:\${tenant}:\${key}\`;

/** Store a new queued job with this budget, pinned to SERVICE_VERSION; returns the job. */
export async function createJob(tenant: string, query: string, effort: string, budget: Budget): Promise<Job> {
  const jobId = \`job-\${await redis.incr('research:seq')}\`;
  await redis.hset(jobKey(jobId), {
    tenant,
    effort,
    query,
    status: 'queued',
    version: SERVICE_VERSION,
    max_subagents: String(budget.max_subagents),
    max_tool_calls: String(budget.max_tool_calls),
    token_budget: String(budget.token_budget),
  });
  await redis.expire(jobKey(jobId), JOB_TTL_S);
  return (await getJob(jobId)) as Job;
}

/** The job with this id, or null. */
export async function getJob(jobId: string): Promise<Job | null> {
  const raw = await redis.hgetall(jobKey(jobId));
  if (Object.keys(raw).length === 0) return null;
  return {
    job_id: jobId,
    tenant: raw.tenant,
    effort: raw.effort,
    status: raw.status,
    budget: {max_subagents: Number(raw.max_subagents), max_tool_calls: Number(raw.max_tool_calls), token_budget: Number(raw.token_budget)},
    version: raw.version,
  };
}

/** The id of the job the tenant's Idempotency-Key started, if any. */
export async function jobForKey(tenant: string, key: string): Promise<string | null> {
  return redis.get(idemKey(tenant, key));
}

/** Record that the tenant's Idempotency-Key started jobId, unless a concurrent request recorded its own job first (SET NX); returns the job the key belongs to. */
export async function rememberKey(tenant: string, key: string, jobId: string): Promise<string> {
  if ((await redis.set(idemKey(tenant, key), jobId, 'EX', JOB_TTL_S, 'NX')) === 'OK') return jobId;
  return (await redis.get(idemKey(tenant, key))) as string;
}

/** Hand the job to the lead agent workers; returns at once. */
export async function enqueue(jobId: string): Promise<void> {
  await redis.rpush('research:queue', jobId);
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'research/jobs/jobs.go': `// Package jobs is the job store (provided). A research job is the Redis hash research:{job_id}
// with tenant, effort, query, status, the budget (max_subagents, max_tool_calls, token_budget) and
// version, the service version that started it; research:idem:{tenant}:{key} holds the job a
// client's Idempotency-Key started; research:queue is the list the lead agent workers take job
// ids from. Keys expire after JobTTL. The query stays in Redis for the lead agent.
package jobs

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// ServiceVersion is the version of the code running in this process.
const ServiceVersion = "2.3.0"

// JobTTL is how long a job's keys live after they are written.
const JobTTL = 24 * time.Hour

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Budget is what one job may spend.
type Budget struct {
	MaxSubagents int \`json:"max_subagents"\`
	MaxToolCalls int \`json:"max_tool_calls"\`
	TokenBudget  int \`json:"token_budget"\`
}

// Job is a research job as the store keeps it.
type Job struct {
	JobID   string \`json:"job_id"\`
	Tenant  string \`json:"tenant"\`
	Effort  string \`json:"effort"\`
	Status  string \`json:"status"\`
	Budget  Budget \`json:"budget"\`
	Version string \`json:"version"\`
}

// Task is one task of a plan: what a subagent is asked to find, in what shape, with which tools,
// and where to stop.
type Task struct {
	ID           string   \`json:"id"\`
	Objective    string   \`json:"objective"\`
	OutputFormat string   \`json:"output_format"\`
	Tools        []string \`json:"tools"\`
	Boundaries   string   \`json:"boundaries"\`
}

// JobKey is the hash of a job.
func JobKey(jobID string) string { return "research:" + jobID }

func idemKey(tenant, key string) string { return "research:idem:" + tenant + ":" + key }

// CreateJob stores a new queued job with this budget, pinned to ServiceVersion, and returns it.
func CreateJob(ctx context.Context, tenant, query, effort string, budget Budget) Job {
	jobID := fmt.Sprintf("job-%d", rdb.Incr(ctx, "research:seq").Val())
	rdb.HSet(ctx, JobKey(jobID), map[string]any{
		"tenant": tenant, "effort": effort, "query": query, "status": "queued", "version": ServiceVersion,
		"max_subagents": strconv.Itoa(budget.MaxSubagents), "max_tool_calls": strconv.Itoa(budget.MaxToolCalls),
		"token_budget": strconv.Itoa(budget.TokenBudget),
	})
	rdb.Expire(ctx, JobKey(jobID), JobTTL)
	return *GetJob(ctx, jobID)
}

// GetJob is the job with this id, or nil.
func GetJob(ctx context.Context, jobID string) *Job {
	raw := rdb.HGetAll(ctx, JobKey(jobID)).Val()
	if len(raw) == 0 {
		return nil
	}
	number := func(name string) int {
		n, _ := strconv.Atoi(raw[name])
		return n
	}
	return &Job{
		JobID: jobID, Tenant: raw["tenant"], Effort: raw["effort"], Status: raw["status"], Version: raw["version"],
		Budget: Budget{MaxSubagents: number("max_subagents"), MaxToolCalls: number("max_tool_calls"), TokenBudget: number("token_budget")},
	}
}

// JobForKey is the id of the job the tenant's Idempotency-Key started, or "".
func JobForKey(ctx context.Context, tenant, key string) string {
	return rdb.Get(ctx, idemKey(tenant, key)).Val()
}

// RememberKey records that the tenant's Idempotency-Key started jobID, unless a concurrent request
// recorded its own job first (SET NX); it returns the job the key belongs to.
func RememberKey(ctx context.Context, tenant, key, jobID string) string {
	if rdb.SetNX(ctx, idemKey(tenant, key), jobID, JobTTL).Val() {
		return jobID
	}
	return rdb.Get(ctx, idemKey(tenant, key)).Val()
}

// Enqueue hands the job to the lead agent workers and returns at once.
func Enqueue(ctx context.Context, jobID string) {
	rdb.RPush(ctx, "research:queue", jobID)
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'research/jobs.h': `// The job store (provided). A research job is the Redis hash research:{job_id} with tenant,
// effort, query, status, the budget (max_subagents, max_tool_calls, token_budget) and version, the
// service version that started it; research:idem:{tenant}:{key} holds the job a client's
// Idempotency-Key started; research:queue is the list the lead agent workers take job ids from.
// Keys expire kJobTtlS after they are written. The query stays in Redis for the lead agent.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace jobs {

inline const std::string kServiceVersion = "2.3.0";
constexpr long kJobTtlS = 86400;

// What one job may spend.
struct Budget {
  long max_subagents = 0;
  long max_tool_calls = 0;
  long token_budget = 0;
};

// A research job as the store keeps it.
struct Job {
  std::string job_id;
  std::string tenant;
  std::string effort;
  std::string status;
  Budget budget;
  std::string version;
};

// One task of a plan: what a subagent is asked to find, in what shape, with which tools, and where to stop.
struct Task {
  std::string id;
  std::string objective;
  std::string output_format;
  std::vector<std::string> tools;
  std::string boundaries;
};

NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE(Budget, max_subagents, max_tool_calls, token_budget)
NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE(Job, job_id, tenant, effort, status, budget, version)
NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE(Task, id, objective, output_format, tools, boundaries)

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string jobKey(const std::string& job_id) { return "research:" + job_id; }

inline std::string idemKey(const std::string& tenant, const std::string& key) { return "research:idem:" + tenant + ":" + key; }

// The job with this id, or none.
inline std::optional<Job> getJob(const std::string& job_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(jobKey(job_id));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  const auto number = [&text](const char* name) { return text(name).empty() ? 0L : std::stol(text(name)); };
  Job job;
  job.job_id = job_id;
  job.tenant = text("tenant");
  job.effort = text("effort");
  job.status = text("status");
  job.budget = Budget{number("max_subagents"), number("max_tool_calls"), number("token_budget")};
  job.version = text("version");
  return job;
}

// Store a new queued job with this budget, pinned to kServiceVersion; returns the job.
inline Job createJob(const std::string& tenant, const std::string& query, const std::string& effort, const Budget& budget) {
  const std::string job_id = "job-" + std::to_string(redis().incr("research:seq"));
  const std::unordered_map<std::string, std::string> fields = {
      {"tenant", tenant}, {"effort", effort}, {"query", query}, {"status", "queued"}, {"version", kServiceVersion},
      {"max_subagents", std::to_string(budget.max_subagents)}, {"max_tool_calls", std::to_string(budget.max_tool_calls)},
      {"token_budget", std::to_string(budget.token_budget)}};
  redis().hset(jobKey(job_id), fields.begin(), fields.end());
  redis().expire(jobKey(job_id), kJobTtlS);
  return *getJob(job_id);
}

// The id of the job the tenant's Idempotency-Key started, if any.
inline std::optional<std::string> jobForKey(const std::string& tenant, const std::string& key) {
  return redis().get(idemKey(tenant, key));
}

// Record that the tenant's Idempotency-Key started job_id, unless a concurrent request recorded its
// own job first (SET NX); returns the job the key belongs to.
inline std::string rememberKey(const std::string& tenant, const std::string& key, const std::string& job_id) {
  if (redis().set(idemKey(tenant, key), job_id, std::chrono::seconds(kJobTtlS), sw::redis::UpdateType::NOT_EXIST)) return job_id;
  return redis().get(idemKey(tenant, key)).value_or(job_id);
}

// Hand the job to the lead agent workers; returns at once.
inline void enqueue(const std::string& job_id) { redis().rpush("research:queue", job_id); }

}  // namespace jobs
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('research', 'Jobs')]: `package research

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

/**
 * The job store (provided). A research job is the Redis hash research:{job_id} with tenant, effort,
 * query, status, the budget (max_subagents, max_tool_calls, token_budget) and version, the service
 * version that started it; research:idem:{tenant}:{key} holds the job a client's Idempotency-Key
 * started; research:queue is the list the lead agent workers take job ids from. Keys expire
 * JobTtlS after they are written. The query stays in Redis for the lead agent.
 */
object Jobs {
  val ServiceVersion = "2.3.0"
  val JobTtlS = 86400L

  /** What one job may spend. */
  final case class Budget(maxSubagents: Int, maxToolCalls: Int, tokenBudget: Long)

  /** A research job as the store keeps it. */
  final case class Job(jobId: String, tenant: String, effort: String, status: String, budget: Budget, version: String)

  /** One task of a plan: what a subagent is asked to find, in what shape, with which tools, and where to stop. */
  final case class Task(id: String, objective: String, outputFormat: String, tools: Seq[String], boundaries: String)

  val jedis = new JedisPooled("redis", 6379)

  def jobKey(jobId: String): String = s"research:$jobId"
  private def idemKey(tenant: String, key: String): String = s"research:idem:$tenant:$key"

  /** Store a new queued job with this budget, pinned to ServiceVersion; returns the job. */
  def createJob(tenant: String, query: String, effort: String, budget: Budget): Job = {
    val jobId = s"job-\${jedis.incr("research:seq")}"
    val fields = Map(
      "tenant" -> tenant, "effort" -> effort, "query" -> query, "status" -> "queued", "version" -> ServiceVersion,
      "max_subagents" -> budget.maxSubagents.toString, "max_tool_calls" -> budget.maxToolCalls.toString,
      "token_budget" -> budget.tokenBudget.toString)
    jedis.hset(jobKey(jobId), fields.asJava)
    jedis.expire(jobKey(jobId), JobTtlS)
    getJob(jobId).get
  }

  /** The job with this id, if it exists. */
  def getJob(jobId: String): Option[Job] = {
    val raw = jedis.hgetAll(jobKey(jobId)).asScala.toMap
    if (raw.isEmpty) None
    else Some(Job(jobId, raw("tenant"), raw("effort"), raw("status"),
      Budget(raw("max_subagents").toInt, raw("max_tool_calls").toInt, raw("token_budget").toLong), raw("version")))
  }

  /** The id of the job the tenant's Idempotency-Key started, if any. */
  def jobForKey(tenant: String, key: String): Option[String] = Option(jedis.get(idemKey(tenant, key)))

  /** Record that the tenant's Idempotency-Key started jobId, unless a concurrent request recorded its own job first (SET NX); returns the job the key belongs to. */
  def rememberKey(tenant: String, key: String, jobId: String): String =
    if (jedis.set(idemKey(tenant, key), jobId, SetParams.setParams().nx().ex(JobTtlS)) != null) jobId
    else jedis.get(idemKey(tenant, key))

  /** Hand the job to the lead agent workers; returns at once. */
  def enqueue(jobId: String): Unit = jedis.rpush("research:queue", jobId)
}
`,
};
