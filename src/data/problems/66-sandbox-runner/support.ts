/**
 * Hand-written support modules the sandbox-runner steps import but no step builds: the `sandbox`
 * package's job store (`sandbox.jobs`). Every job is a Redis hash job:{id}; the submitted code and
 * the output sit beside it; an Idempotency-Key maps to the job it created; the outbox holds the
 * events the broker did not take. `digest` is the SHA-256 every step compares. The five languages
 * keep the same keys, so a harness reads one layout whatever the stack.
 */
import {CPP_DIGEST_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'sandbox/__init__.py': '',
  'sandbox/jobs.py': `"""
The job store (provided). job:{id} is a hash with job_id, tenant, profile (the one the submit
asked for), needs (comma-separated), status (queued, running or finished), used_profile (the
isolation the container reported), exit_code, cpu_ms, mem_mb, code_digest and output_digest (an
unset field is ""). job:{id}:code holds the submitted code, job:{id}:output the job's output,
idem:{tenant}:{key} the job a submit's Idempotency-Key created, and the list outbox the events the
broker did not take, as JSON {topic, key, payload}. A job is returned as a dict: an unset field is
None, needs a list. digest(text) is the SHA-256 of the text's UTF-8 bytes, in hex.
"""
import hashlib
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _job(raw: dict) -> dict | None:
    if not raw:
        return None

    def number(name: str) -> int | None:
        return int(raw[name]) if raw.get(name, "") != "" else None

    return {
        "job_id": raw["job_id"],
        "tenant": raw["tenant"],
        "profile": raw["profile"],
        "needs": [n for n in raw.get("needs", "").split(",") if n],
        "status": raw["status"],
        "used_profile": raw.get("used_profile") or None,
        "exit_code": number("exit_code"),
        "cpu_ms": number("cpu_ms"),
        "mem_mb": number("mem_mb"),
        "code_digest": raw["code_digest"],
        "output_digest": raw.get("output_digest") or None,
    }


def get(job_id: str) -> dict | None:
    """The job, or None."""
    return _job(r.hgetall(f"job:{job_id}"))


def create(tenant: str, profile: str, needs: list[str], code: str) -> dict:
    """A new queued job holding the code; returns it."""
    job_id = f"j-{r.incr('job:seq')}"
    r.set(f"job:{job_id}:code", code)
    r.hset(
        f"job:{job_id}",
        mapping={
            "job_id": job_id, "tenant": tenant, "profile": profile, "needs": ",".join(needs), "status": "queued",
            "used_profile": "", "exit_code": "", "cpu_ms": "", "mem_mb": "", "code_digest": digest(code), "output_digest": "",
        },
    )
    return get(job_id)


def lookup(tenant: str, key: str) -> str | None:
    """The job id the tenant's Idempotency-Key created, if any."""
    return r.get(f"idem:{tenant}:{key}")


def remember(tenant: str, key: str, job_id: str) -> None:
    """Record the job the tenant's Idempotency-Key created, for its replays."""
    r.set(f"idem:{tenant}:{key}", job_id)


def mark_running(job_id: str, used_profile: str) -> None:
    """The container started: the job runs under used_profile."""
    r.hset(f"job:{job_id}", mapping={"status": "running", "used_profile": used_profile})


def put_result(job_id: str, exit_code: int, output: str, cpu_ms: int, mem_mb: int) -> None:
    """The job finished: store its output, the output's digest, its exit code and usage."""
    r.set(f"job:{job_id}:output", output)
    r.hset(
        f"job:{job_id}",
        mapping={"status": "finished", "exit_code": exit_code, "cpu_ms": cpu_ms, "mem_mb": mem_mb, "output_digest": digest(output)},
    )


def read_output(job_id: str) -> str | None:
    """The stored output of the job, or None."""
    return r.get(f"job:{job_id}:output")


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """An event the broker did not take: the relay produces it later."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
};

export const supportModulesTs: Record<string, string> = {
  'sandbox/jobs.ts': `/**
 * The job store (provided). job:{id} is a hash with job_id, tenant, profile (the one the submit
 * asked for), needs (comma-separated), status (queued, running or finished), used_profile (the
 * isolation the container reported), exit_code, cpu_ms, mem_mb, code_digest and output_digest (an
 * unset field is ""). job:{id}:code holds the submitted code, job:{id}:output the job's output,
 * idem:{tenant}:{key} the job a submit's Idempotency-Key created, and the list outbox the events
 * the broker did not take, as JSON {topic, key, payload}. A Job has an unset field as null.
 * digest(text) is the SHA-256 of the text's UTF-8 bytes, in hex.
 */
import {createHash} from 'node:crypto';

import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Job {
  job_id: string;
  tenant: string;
  profile: string;
  needs: string[];
  status: string;
  used_profile: string | null;
  exit_code: number | null;
  cpu_ms: number | null;
  mem_mb: number | null;
  code_digest: string;
  output_digest: string | null;
}

export const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function job(raw: Record<string, string>): Job | null {
  if (Object.keys(raw).length === 0) return null;
  const text = (name: string): string | null => (raw[name] === undefined || raw[name] === '' ? null : raw[name]);
  const number = (name: string): number | null => (text(name) === null ? null : Number(text(name)));
  return {
    job_id: raw.job_id,
    tenant: raw.tenant,
    profile: raw.profile,
    needs: (raw.needs ?? '').split(',').filter(n => n !== ''),
    status: raw.status,
    used_profile: text('used_profile'),
    exit_code: number('exit_code'),
    cpu_ms: number('cpu_ms'),
    mem_mb: number('mem_mb'),
    code_digest: raw.code_digest,
    output_digest: text('output_digest'),
  };
}

/** The job, or null. */
export async function get(jobId: string): Promise<Job | null> {
  return job(await redis.hgetall(\`job:\${jobId}\`));
}

/** A new queued job holding the code; returns it. */
export async function create(tenant: string, profile: string, needs: string[], code: string): Promise<Job> {
  const jobId = \`j-\${await redis.incr('job:seq')}\`;
  await redis.set(\`job:\${jobId}:code\`, code);
  await redis.hset(\`job:\${jobId}\`, {
    job_id: jobId,
    tenant,
    profile,
    needs: needs.join(','),
    status: 'queued',
    used_profile: '',
    exit_code: '',
    cpu_ms: '',
    mem_mb: '',
    code_digest: digest(code),
    output_digest: '',
  });
  return (await get(jobId)) as Job;
}

/** The job id the tenant's Idempotency-Key created, or null. */
export async function lookup(tenant: string, key: string): Promise<string | null> {
  return redis.get(\`idem:\${tenant}:\${key}\`);
}

/** Record the job the tenant's Idempotency-Key created, for its replays. */
export async function remember(tenant: string, key: string, jobId: string): Promise<void> {
  await redis.set(\`idem:\${tenant}:\${key}\`, jobId);
}

/** The container started: the job runs under usedProfile. */
export async function markRunning(jobId: string, usedProfile: string): Promise<void> {
  await redis.hset(\`job:\${jobId}\`, {status: 'running', used_profile: usedProfile});
}

/** The job finished: store its output, the output's digest, its exit code and usage. */
export async function putResult(jobId: string, exitCode: number, output: string, cpuMs: number, memMb: number): Promise<void> {
  await redis.set(\`job:\${jobId}:output\`, output);
  await redis.hset(\`job:\${jobId}\`, {
    status: 'finished',
    exit_code: String(exitCode),
    cpu_ms: String(cpuMs),
    mem_mb: String(memMb),
    output_digest: digest(output),
  });
}

/** The stored output of the job, or null. */
export async function readOutput(jobId: string): Promise<string | null> {
  return redis.get(\`job:\${jobId}:output\`);
}

/** An event the broker did not take: the relay produces it later. */
export async function insertOutbox(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'sandbox/jobs/jobs.go': `// Package jobs is the job store (provided). job:{id} is a hash with job_id, tenant, profile (the
// one the submit asked for), needs (comma-separated), status (queued, running or finished),
// used_profile (the isolation the container reported), exit_code, cpu_ms, mem_mb, code_digest and
// output_digest (an unset field is ""). job:{id}:code holds the submitted code, job:{id}:output
// the job's output, idem:{tenant}:{key} the job a submit's Idempotency-Key created, and the list
// outbox the events the broker did not take, as JSON {topic, key, payload}. A Job has an unset
// number as 0 and an unset text as "". Digest(text) is the SHA-256 of the text, in hex.
package jobs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Job is one submitted job.
type Job struct {
	JobID        string   \`json:"job_id"\`
	Tenant       string   \`json:"tenant"\`
	Profile      string   \`json:"profile"\`
	Needs        []string \`json:"needs"\`
	Status       string   \`json:"status"\`
	UsedProfile  string   \`json:"used_profile"\`
	ExitCode     int      \`json:"exit_code"\`
	CPUMs        int      \`json:"cpu_ms"\`
	MemMB        int      \`json:"mem_mb"\`
	CodeDigest   string   \`json:"code_digest"\`
	OutputDigest string   \`json:"output_digest"\`
}

// Digest is the SHA-256 of the text, in hex.
func Digest(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func number(raw map[string]string, name string) int {
	n, _ := strconv.Atoi(raw[name])
	return n
}

// Get is the job, or nil.
func Get(ctx context.Context, jobID string) *Job {
	raw := rdb.HGetAll(ctx, "job:"+jobID).Val()
	if len(raw) == 0 {
		return nil
	}
	needs := []string{}
	for _, n := range strings.Split(raw["needs"], ",") {
		if n != "" {
			needs = append(needs, n)
		}
	}
	return &Job{
		JobID: raw["job_id"], Tenant: raw["tenant"], Profile: raw["profile"], Needs: needs, Status: raw["status"],
		UsedProfile: raw["used_profile"], ExitCode: number(raw, "exit_code"), CPUMs: number(raw, "cpu_ms"), MemMB: number(raw, "mem_mb"),
		CodeDigest: raw["code_digest"], OutputDigest: raw["output_digest"],
	}
}

// Create makes a new queued job holding the code and returns it.
func Create(ctx context.Context, tenant, profile string, needs []string, code string) *Job {
	jobID := fmt.Sprintf("j-%d", rdb.Incr(ctx, "job:seq").Val())
	rdb.Set(ctx, "job:"+jobID+":code", code, 0)
	rdb.HSet(ctx, "job:"+jobID, map[string]any{
		"job_id": jobID, "tenant": tenant, "profile": profile, "needs": strings.Join(needs, ","), "status": "queued",
		"used_profile": "", "exit_code": "", "cpu_ms": "", "mem_mb": "", "code_digest": Digest(code), "output_digest": "",
	})
	return Get(ctx, jobID)
}

// Lookup is the job id the tenant's Idempotency-Key created, or "".
func Lookup(ctx context.Context, tenant, key string) string {
	return rdb.Get(ctx, "idem:"+tenant+":"+key).Val()
}

// Remember records the job the tenant's Idempotency-Key created, for its replays.
func Remember(ctx context.Context, tenant, key, jobID string) {
	rdb.Set(ctx, "idem:"+tenant+":"+key, jobID, 0)
}

// MarkRunning records that the container started: the job runs under usedProfile.
func MarkRunning(ctx context.Context, jobID, usedProfile string) {
	rdb.HSet(ctx, "job:"+jobID, map[string]any{"status": "running", "used_profile": usedProfile})
}

// PutResult records that the job finished: its output, the output's digest, its exit code and usage.
func PutResult(ctx context.Context, jobID string, exitCode int, output string, cpuMs, memMB int) {
	rdb.Set(ctx, "job:"+jobID+":output", output, 0)
	rdb.HSet(ctx, "job:"+jobID, map[string]any{
		"status": "finished", "exit_code": strconv.Itoa(exitCode), "cpu_ms": strconv.Itoa(cpuMs), "mem_mb": strconv.Itoa(memMB), "output_digest": Digest(output),
	})
}

// ReadOutput is the stored output of the job, and whether there is one.
func ReadOutput(ctx context.Context, jobID string) (string, bool) {
	output, err := rdb.Get(ctx, "job:"+jobID+":output").Result()
	return output, err == nil
}

// InsertOutbox records an event the broker did not take: the relay produces it later.
func InsertOutbox(ctx context.Context, topic, key string, payload map[string]any) error {
	row, err := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, "outbox", string(row)).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'sandbox/sha256.h': CPP_DIGEST_H,
  'sandbox/jobs.h': `// The job store (provided). job:{id} is a hash with job_id, tenant, profile (the one the submit
// asked for), needs (comma-separated), status (queued, running or finished), used_profile (the
// isolation the container reported), exit_code, cpu_ms, mem_mb, code_digest and output_digest (an
// unset field is ""). job:{id}:code holds the submitted code, job:{id}:output the job's output,
// idem:{tenant}:{key} the job a submit's Idempotency-Key created, and the list outbox the events
// the broker did not take, as JSON {topic, key, payload}. A Job has an unset number as 0 and an
// unset text as "". digest(text) is the SHA-256 of the text, in hex.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

#include "sha256.h"

namespace jobs {

struct Job {
  std::string job_id;
  std::string tenant;
  std::string profile;
  std::vector<std::string> needs;
  std::string status;
  std::string used_profile;
  long exit_code = 0;
  long cpu_ms = 0;
  long mem_mb = 0;
  std::string code_digest;
  std::string output_digest;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string digest(const std::string& text) { return sha256_hex(text); }

// The job, or none.
inline std::optional<Job> get(const std::string& job_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("job:" + job_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  const auto number = [&text](const char* name) { return text(name).empty() ? 0L : std::stol(text(name)); };
  Job job;
  job.job_id = text("job_id");
  job.tenant = text("tenant");
  job.profile = text("profile");
  std::stringstream needs(text("needs"));
  for (std::string need; std::getline(needs, need, ',');) {
    if (!need.empty()) job.needs.push_back(need);
  }
  job.status = text("status");
  job.used_profile = text("used_profile");
  job.exit_code = number("exit_code");
  job.cpu_ms = number("cpu_ms");
  job.mem_mb = number("mem_mb");
  job.code_digest = text("code_digest");
  job.output_digest = text("output_digest");
  return job;
}

// A new queued job holding the code; returns it.
inline Job create(const std::string& tenant, const std::string& profile, const std::vector<std::string>& needs, const std::string& code) {
  const std::string job_id = "j-" + std::to_string(redis().incr("job:seq"));
  std::string joined;
  for (const std::string& need : needs) joined += (joined.empty() ? "" : ",") + need;
  redis().set("job:" + job_id + ":code", code);
  redis().hset("job:" + job_id, {{"job_id", job_id}, {"tenant", tenant}, {"profile", profile}, {"needs", joined}, {"status", "queued"},
                                 {"used_profile", ""}, {"exit_code", ""}, {"cpu_ms", ""}, {"mem_mb", ""}, {"code_digest", digest(code)},
                                 {"output_digest", ""}});
  return *get(job_id);
}

// The job id the tenant's Idempotency-Key created, if any.
inline std::optional<std::string> lookup(const std::string& tenant, const std::string& key) { return redis().get("idem:" + tenant + ":" + key); }

// Record the job the tenant's Idempotency-Key created, for its replays.
inline void remember(const std::string& tenant, const std::string& key, const std::string& job_id) {
  redis().set("idem:" + tenant + ":" + key, job_id);
}

// The container started: the job runs under used_profile.
inline void markRunning(const std::string& job_id, const std::string& used_profile) {
  redis().hset("job:" + job_id, {{"status", "running"}, {"used_profile", used_profile}});
}

// The job finished: store its output, the output's digest, its exit code and usage.
inline void putResult(const std::string& job_id, long exit_code, const std::string& output, long cpu_ms, long mem_mb) {
  redis().set("job:" + job_id + ":output", output);
  redis().hset("job:" + job_id, {{"status", "finished"}, {"exit_code", std::to_string(exit_code)}, {"cpu_ms", std::to_string(cpu_ms)},
                                 {"mem_mb", std::to_string(mem_mb)}, {"output_digest", digest(output)}});
}

// The stored output of the job, if any.
inline std::optional<std::string> readOutput(const std::string& job_id) { return redis().get("job:" + job_id + ":output"); }

// An event the broker did not take: the relay produces it later.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace jobs
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('sandbox', 'Jobs')]: `package sandbox

import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The job store (provided). job:{id} is a hash with job_id, tenant, profile (the one the submit
 * asked for), needs (comma-separated), status (queued, running or finished), used_profile (the
 * isolation the container reported), exit_code, cpu_ms, mem_mb, code_digest and output_digest (an
 * unset field is ""). job:{id}:code holds the submitted code, job:{id}:output the job's output,
 * idem:{tenant}:{key} the job a submit's Idempotency-Key created, and the list outbox the events
 * the broker did not take, as JSON {topic, key, payload}. A Job has its unset fields as None.
 * digest(text) is the SHA-256 of the text's UTF-8 bytes, in hex.
 */
object Jobs {
  final case class Job(
      jobId: String,
      tenant: String,
      profile: String,
      needs: Seq[String],
      status: String,
      usedProfile: Option[String],
      exitCode: Option[Long],
      cpuMs: Option[Long],
      memMb: Option[Long],
      codeDigest: String,
      outputDigest: Option[String],
  )

  val jedis = new JedisPooled("redis", 6379)

  def digest(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes(UTF_8)).map(b => f"\${b & 0xff}%02x").mkString

  /** The job, if it exists. */
  def get(jobId: String): Option[Job] = {
    val raw = jedis.hgetAll(s"job:$jobId").asScala.toMap
    if (raw.isEmpty) None
    else {
      def text(name: String): Option[String] = raw.get(name).filter(_.nonEmpty)
      Some(
        Job(raw("job_id"), raw("tenant"), raw("profile"), raw.getOrElse("needs", "").split(",").toSeq.filter(_.nonEmpty), raw("status"),
          text("used_profile"), text("exit_code").map(_.toLong), text("cpu_ms").map(_.toLong), text("mem_mb").map(_.toLong),
          raw("code_digest"), text("output_digest")))
    }
  }

  /** A new queued job holding the code; returns it. */
  def create(tenant: String, profile: String, needs: Seq[String], code: String): Job = {
    val jobId = s"j-\${jedis.incr("job:seq")}"
    jedis.set(s"job:$jobId:code", code)
    jedis.hset(
      s"job:$jobId",
      Map(
        "job_id" -> jobId, "tenant" -> tenant, "profile" -> profile, "needs" -> needs.mkString(","), "status" -> "queued",
        "used_profile" -> "", "exit_code" -> "", "cpu_ms" -> "", "mem_mb" -> "", "code_digest" -> digest(code), "output_digest" -> "",
      ).asJava,
    )
    get(jobId).get
  }

  /** The job id the tenant's Idempotency-Key created, if any. */
  def lookup(tenant: String, key: String): Option[String] = Option(jedis.get(s"idem:$tenant:$key"))

  /** Record the job the tenant's Idempotency-Key created, for its replays. */
  def remember(tenant: String, key: String, jobId: String): Unit = jedis.set(s"idem:$tenant:$key", jobId)

  /** The container started: the job runs under usedProfile. */
  def markRunning(jobId: String, usedProfile: String): Unit =
    jedis.hset(s"job:$jobId", Map("status" -> "running", "used_profile" -> usedProfile).asJava)

  /** The job finished: store its output, the output's digest, its exit code and usage. */
  def putResult(jobId: String, exitCode: Long, output: String, cpuMs: Long, memMb: Long): Unit = {
    jedis.set(s"job:$jobId:output", output)
    jedis.hset(
      s"job:$jobId",
      Map("status" -> "finished", "exit_code" -> exitCode.toString, "cpu_ms" -> cpuMs.toString, "mem_mb" -> memMb.toString,
        "output_digest" -> digest(output)).asJava,
    )
  }

  /** The stored output of the job, if any. */
  def readOutput(jobId: String): Option[String] = Option(jedis.get(s"job:$jobId:output"))

  /** An event the broker did not take: the relay produces it later. */
  def insertOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
};
