import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis job leases with hard wall-clock limits',
  concept: 'redis',
  file: 'state',
  focus: ['runner', 'redis', 'container'],
  task: `## Task

**Starting point.** The starter’s \`run_job\` records \`time.monotonic()\` in a process-local
\`jobs\` dict, calls \`containers.Start(job_id)\`, reads output chunks until the stream ends or
\`DEFAULT_TIMEOUT_S\` of local clock has elapsed, then \`finish\` calls \`store.put_result\`
unconditionally. It compiles and hides five flaws.

**Failure mode the checks target.** The clock lives in the runner process. A restart forgets every
running job, the loop exits at the timeout without killing the container, and a result that arrives
after the deadline is published as the job’s result.

Make the lease in Redis the authority for how long a job may run:

- Every job holds \`lease:{job_id}\` (\`LEASE_PREFIX\`), set atomically with the hard maximum
  runtime as its TTL (\`MAX_RUNTIME_S\`, \`ex=MAX_RUNTIME_S\`).
- The remaining budget is read from Redis on every check (\`lease_ttl(job_id)\`, which wraps
  \`TTL\`); no monotonic arithmetic in the runner decides the deadline.
- When the TTL reaches zero the runner calls \`containers.Kill(job_id)\` and reports no result.
- \`finish\` re-reads the lease before \`store.put_result\` and discards a late write.
- On start-up \`recover_leases\` scans the \`lease:\` keys with \`scan_iter\`, kills the jobs whose
  lease already lapsed and resumes the rest.`,
  sequence: {
    participants: ['Runner', 'Redis', 'Container service'],
    messages: [
      {from: 'Runner', to: 'Redis', label: 'SET lease:{job} NX EX MAX_RUNTIME_S', kind: 'sync'},
      {from: 'Redis', to: 'Runner', label: 'OK / lease held by another runner', kind: 'reply'},
      {from: 'Runner', to: 'Container service', label: 'Start(job, image, profile)', kind: 'sync'},
      {from: 'Runner', to: 'Redis', label: 'TTL lease:{job} on every tick', kind: 'sync'},
      {from: 'Redis', to: 'Runner', label: 'seconds left / -2 when lapsed', kind: 'reply'},
      {from: 'Runner', to: 'Container service', label: 'Kill(job) at the lease deadline', kind: 'sync'},
      {from: 'Runner', to: 'Runner', label: 'finish() re-checks the lease; a late write is discarded', kind: 'sync'},
    ],
  },
  hints: [
    'Restart the runner while a job is running: the container keeps going on the node, nothing kills it at 300 s, and when it eventually exits its result still lands in the store.',
    'The deadline is `time.monotonic() - started` against a constant in a process-local dict, so it dies with the process; the loop only stops reading, it does not kill, and `finish` writes whatever arrives.',
    '`r.set(LEASE_PREFIX + job_id, runner, nx=True, ex=MAX_RUNTIME_S)`; check `lease_ttl(job_id)` each tick and before `put_result`, `containers.Kill` at zero; `recover_leases` via `scan_iter("lease:*")`.',
  ],
  checks: [
    {
      id: 'lease-ttl',
      title: 'Holds the hard runtime as the lease TTL',
      detail:
        'The lease key is written atomically with the hard maximum runtime as its expiry (`EX MAX_RUNTIME_S` / `SetNX` with a duration / `setex` / `ex = MAX_RUNTIME_S`). The starter keeps the timeout in a local constant and never writes a lease, so nothing in Redis expires the job.',
      match: {
        python: {all: [/LEASE_PREFIX/, /MAX_RUNTIME_S/, /set\([^;\n]*ex\s*=\s*MAX_RUNTIME_S/]},
        typescript: {all: [/LEASE_PREFIX/, /MAX_RUNTIME_S/, /set\([^;\n]*['"]EX['"]/]},
        go: {all: [/leasePrefix/, /maxRuntimeSeconds/, /SetNX\(ctx,[^;\n]*time\.Duration\(maxRuntimeSeconds\)/]},
        scala: {all: [/LeasePrefix/, /MaxRuntimeSeconds/, /setex\([^;\n]*MaxRuntimeSeconds/]},
        cpp: {all: [/kLeasePrefix/, /kMaxRuntimeSeconds/, /set\([^;\n]*chrono::seconds/]},
      },
    },
    {
      id: 'redis-authority',
      title: 'Reads the deadline from Redis, not from process memory',
      detail:
        'Every check asks Redis for the remaining `TTL`, and no monotonic or wall-clock arithmetic in the runner decides the deadline. The starter measures `time.monotonic() - started`, which a restart forgets.',
      match: {
        python: {all: [/LEASE_PREFIX/, /\.ttl\(/], none: [/monotonic\(/]},
        typescript: {all: [/LEASE_PREFIX/, /\.ttl\(/], none: [/Date\.now\(\)\s*-/, /performance\.now\(/]},
        go: {all: [/leasePrefix/, /\.TTL\(/], none: [/time\.Since\(started\)/]},
        scala: {all: [/LeasePrefix/, /\.ttl\(/], none: [/System\.nanoTime\(\)\s*-/]},
        cpp: {all: [/kLeasePrefix/, /ttl\(/], none: [/steady_clock::now\(\)\s*-/]},
      },
    },
    {
      id: 'kill-at-deadline',
      title: 'Kills the container when the lease lapses',
      detail:
        'When `lease_ttl(job_id)` reaches zero the runner kills the container; the kill is guarded by the lease check, not by a local timer. The starter never calls `Kill`, so an over-running container survives until the node does not.',
      match: {
        python: {all: [/lease_ttl\(/, /containers\.Kill\(/], order: [/lease_ttl\(job_id\)/, /containers\.Kill\(/]},
        typescript: {all: [/leaseTtl\(/, /containers\.Kill\(/], order: [/leaseTtl\(jobId\)/, /containers\.Kill\(/]},
        go: {all: [/leaseTTL\(/, /Kill\(/], order: [/leaseTTL\(ctx, jobID\)/, /containers\.Kill\(/]},
        scala: {all: [/leaseTtl\(/, /\.kill\(/], order: [/leaseTtl\(jobId\)/, /containers\.kill\(/]},
        cpp: {all: [/leaseTtl\(/, /Kill\(/], order: [/leaseTtl\(jobId\)/, /containers->Kill\(/]},
      },
    },
    {
      id: 'late-writes',
      title: 'Discards a result written after the lease lapsed',
      detail:
        '`finish` re-reads the lease and returns without writing when it is gone, so a late write can never appear as the job’s result. The starter writes the result unconditionally, which is how a killed job shows up as successful.',
      match: {
        python: {all: [/def finish/, /store\.put_result\(/], order: [/lease_ttl\(job_id\)/, /store\.put_result\(/]},
        typescript: {
          all: [/async function finish/, /store\.putResult\(/],
          order: [/leaseTtl\(jobId\)/, /store\.putResult\(/],
        },
        go: {all: [/func finish\(/, /PutResult\(/], order: [/leaseTTL\(ctx, jobID\)/, /store\.PutResult\(/]},
        scala: {all: [/def finish/, /putResult\(/], order: [/leaseTtl\(jobId\)/, /store\.putResult\(/]},
        cpp: {all: [/void finish\(/, /putResult\(/], order: [/leaseTtl\(jobId\)/, /store\.putResult\(/]},
      },
    },
    {
      id: 'restart-safe',
      title: 'Recovers its jobs from Redis on start-up',
      detail:
        '`recover_leases` scans the `lease:` keys, kills the ones whose lease already lapsed and resumes the rest — the runner’s state lives in Redis, so a restart cannot forget a running job. The starter keeps `jobs` in a process-local dictionary.',
      match: {
        python: {all: [/def recover_leases/, /LEASE_PREFIX/, /scan_iter\(/]},
        typescript: {all: [/async function recoverLeases/, /LEASE_PREFIX/, /r\.scan\(/]},
        go: {all: [/func recoverLeases\(/, /leasePrefix/, /\.Scan\(/]},
        scala: {all: [/def recoverLeases/, /LeasePrefix/, /jedis\.keys\(/]},
        cpp: {all: [/recoverLeases/, /kLeasePrefix/, /scan_match\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

DEFAULT_TIMEOUT_S = 300
jobs: dict[str, dict] = {}


class ResultStore:
    def put_result(self, job_id: str, result: dict) -> None:
        """Publish the job's result."""
        raise NotImplementedError


store = ResultStore()


def run_job(job_id: str) -> None:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    started = time.monotonic()
    jobs[job_id] = {"started": started}
    stream = containers.Start(job_id)
    output = []
    while time.monotonic() - started < DEFAULT_TIMEOUT_S:
        chunk = stream.read()
        if chunk is None:
            break
        output.append(chunk)
    finish(job_id, {"exit_code": stream.exit_code, "usage": stream.usage, "output": b"".join(output)})


def finish(job_id: str, result: dict) -> None:
    store.put_result(job_id, result)
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LEASE_PREFIX = "lease:"
MAX_RUNTIME_S = 300


class ResultStore:
    def put_result(self, job_id: str, result: dict) -> None:
        """Publish the job's result."""
        raise NotImplementedError


store = ResultStore()


def lease_key(job_id: str) -> str:
    return f"{LEASE_PREFIX}{job_id}"


def acquire_lease(job_id: str) -> bool:
    # The lease carries the hard wall-clock limit; nothing local decides when the job must die.
    return bool(r.set(lease_key(job_id), job_id, nx=True, ex=MAX_RUNTIME_S))


def lease_ttl(job_id: str) -> int:
    # Read from Redis on every check: the expiry is authoritative and survives a runner restart.
    return r.ttl(lease_key(job_id))


def recover_leases() -> list[str]:
    recovered = []
    for key in r.scan_iter(match=f"{LEASE_PREFIX}*"):
        job_id = key[len(LEASE_PREFIX) :]
        if lease_ttl(job_id) <= 0:
            containers.Kill(job_id)
            continue
        recovered.append(job_id)
    return recovered


def run_job(job_id: str) -> None:
    if not acquire_lease(job_id):
        return
    stream = containers.Start(job_id)
    output = []
    while lease_ttl(job_id) > 0:
        chunk = stream.read()
        if chunk is None:
            break
        output.append(chunk)
    if lease_ttl(job_id) <= 0:
        containers.Kill(job_id)
        return
    finish(job_id, {"exit_code": stream.exit_code, "usage": stream.usage, "output": b"".join(output)})


def finish(job_id: str, result: dict) -> None:
    if lease_ttl(job_id) <= 0:
        return  # late write: the lease lapsed while the job ran, so the result is discarded
    store.put_result(job_id, result)
`,
    },
    typescript: {
      starter: `/** The runner loop: starts a container, reads its output, stores the result. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const DEFAULT_TIMEOUT_MS = 300_000;
const jobs: Record<string, {startedAt: number}> = {};

interface JobResult {
  exitCode: number;
  usage: {cpuMs: number; memMb: number};
  output: Buffer;
}

async function runJob(jobId: string): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const startedAt = Date.now();
  jobs[jobId] = {startedAt};
  const stream = await containers.Start(jobId);
  const chunks: Buffer[] = [];
  while (Date.now() - startedAt < DEFAULT_TIMEOUT_MS) {
    const chunk = await stream.read();
    if (chunk === null) break;
    chunks.push(chunk);
  }
  await finish(jobId, {exitCode: stream.exitCode, usage: stream.usage, output: Buffer.concat(chunks)});
}

async function finish(jobId: string, result: JobResult): Promise<void> {
  await store.putResult(jobId, result);
}

void r;
`,
      solution: `/** The runner loop: the Redis lease is the authority for how long a job may run. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const LEASE_PREFIX = 'lease:';
const MAX_RUNTIME_S = 300;

interface JobResult {
  exitCode: number;
  usage: {cpuMs: number; memMb: number};
  output: Buffer;
}

async function acquireLease(jobId: string): Promise<boolean> {
  // The lease carries the hard wall-clock limit; nothing local decides when the job must die.
  const reply = await r.set(\`\${LEASE_PREFIX}\${jobId}\`, jobId, 'EX', MAX_RUNTIME_S, 'NX');
  return reply === 'OK';
}

async function leaseTtl(jobId: string): Promise<number> {
  // Read from Redis on every check: the expiry is authoritative and survives a runner restart.
  return r.ttl(\`\${LEASE_PREFIX}\${jobId}\`);
}

async function recoverLeases(): Promise<string[]> {
  const recovered: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await r.scan(cursor, 'MATCH', \`\${LEASE_PREFIX}*\`, 'COUNT', 100);
    cursor = next;
    for (const key of keys) {
      const jobId = key.slice(LEASE_PREFIX.length);
      if ((await leaseTtl(jobId)) <= 0) await containers.Kill(jobId);
      else recovered.push(jobId);
    }
  } while (cursor !== '0');
  return recovered;
}

async function runJob(jobId: string): Promise<void> {
  if (!(await acquireLease(jobId))) return;
  const stream = await containers.Start(jobId);
  const chunks: Buffer[] = [];
  while ((await leaseTtl(jobId)) > 0) {
    const chunk = await stream.read();
    if (chunk === null) break;
    chunks.push(chunk);
  }
  if ((await leaseTtl(jobId)) <= 0) {
    await containers.Kill(jobId);
    return;
  }
  await finish(jobId, {exitCode: stream.exitCode, usage: stream.usage, output: Buffer.concat(chunks)});
}

async function finish(jobId: string, result: JobResult): Promise<void> {
  if ((await leaseTtl(jobId)) <= 0) return; // late write: the lease lapsed, the result is discarded
  await store.putResult(jobId, result);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"
)

const defaultTimeoutSeconds = 300

var jobs = map[string]time.Time{}

func runJob(ctx context.Context, jobID string) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	started := time.Now()
	jobs[jobID] = started
	stream, _ := containers.Start(ctx, jobID)
	var output []byte
	for time.Since(started) < defaultTimeoutSeconds*time.Second {
		chunk, err := stream.Read()
		if err != nil {
			break
		}
		output = append(output, chunk...)
	}
	finish(ctx, jobID, map[string]any{"exit_code": stream.ExitCode, "output": output})
}

func finish(ctx context.Context, jobID string, result map[string]any) {
	_ = store.PutResult(ctx, jobID, result)
}

func main() {}
`,
      solution: `package main

import (
	"context"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	leasePrefix       = "lease:"
	maxRuntimeSeconds = 300
)

var rdb *redis.Client

type ResultStore struct{}

func (s *ResultStore) PutResult(ctx context.Context, jobID string, result map[string]any) error {
	return nil
}

var store = &ResultStore{}

func acquireLease(ctx context.Context, jobID string) bool {
	// The lease carries the hard wall-clock limit; nothing local decides when the job must die.
	ok, err := rdb.SetNX(ctx, leasePrefix+jobID, jobID, time.Duration(maxRuntimeSeconds)*time.Second).Result()
	return err == nil && ok
}

func leaseTTL(ctx context.Context, jobID string) time.Duration {
	// Read from Redis on every check: the expiry is authoritative and survives a runner restart.
	ttl, _ := rdb.TTL(ctx, leasePrefix+jobID).Result()
	return ttl
}

func recoverLeases(ctx context.Context) []string {
	var recovered []string
	iter := rdb.Scan(ctx, 0, leasePrefix+"*", 100).Iterator()
	for iter.Next(ctx) {
		jobID := strings.TrimPrefix(iter.Val(), leasePrefix)
		if leaseTTL(ctx, jobID) <= 0 {
			containers.Kill(ctx, jobID)
			continue
		}
		recovered = append(recovered, jobID)
	}
	return recovered
}

func runJob(ctx context.Context, jobID string) {
	if !acquireLease(ctx, jobID) {
		return
	}
	stream, _ := containers.Start(ctx, jobID)
	var output []byte
	for leaseTTL(ctx, jobID) > 0 {
		chunk, err := stream.Read()
		if err != nil {
			break
		}
		output = append(output, chunk...)
	}
	if leaseTTL(ctx, jobID) <= 0 {
		containers.Kill(ctx, jobID)
		return
	}
	finish(ctx, jobID, map[string]any{"exit_code": stream.ExitCode, "output": output})
}

func finish(ctx context.Context, jobID string, result map[string]any) {
	if leaseTTL(ctx, jobID) <= 0 {
		return
	}
	_ = store.PutResult(ctx, jobID, result)
}

func main() {}
`,
    },
    scala: {
      starter: `import java.util.concurrent.ConcurrentHashMap

object Runner {
  val DefaultTimeoutMillis = 300000L
  val jobs = new ConcurrentHashMap[String, java.lang.Long]()

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  def runJob(jobId: String): Unit = {
    val started = System.nanoTime()
    jobs.put(jobId, started)
    val stream = containers.start(jobId)
    val output = new StringBuilder
    while ((System.nanoTime() - started) / 1000000 < DefaultTimeoutMillis) {
      stream.read() match {
        case Some(chunk) => output.append(chunk)
        case None => return
      }
    }
    finish(jobId, Map("exit_code" -> stream.exitCode, "output" -> output.toString))
  }

  def finish(jobId: String, result: Map[String, Any]): Unit = {
    store.putResult(jobId, result)
  }
}
`,
      solution: `import redis.clients.jedis.Jedis

import scala.jdk.CollectionConverters._

object Runner {
  val LeasePrefix = "lease:"
  val MaxRuntimeSeconds = 300L

  val jedis = new Jedis("redis", 6379)

  def acquireLease(jobId: String): Boolean = {
    // The lease carries the hard wall-clock limit; nothing local decides when the job must die.
    jedis.setex(LeasePrefix + jobId, MaxRuntimeSeconds, jobId) == "OK"
  }

  def leaseTtl(jobId: String): Long = {
    // Read from Redis on every check: the expiry is authoritative and survives a runner restart.
    jedis.ttl(LeasePrefix + jobId)
  }

  def recoverLeases(): List[String] = {
    jedis.keys(LeasePrefix + "*").asScala.toList.flatMap { key =>
      val jobId = key.substring(LeasePrefix.length)
      if (leaseTtl(jobId) <= 0) {
        containers.kill(jobId)
        None
      } else {
        Some(jobId)
      }
    }
  }

  def runJob(jobId: String): Unit = {
    if (!acquireLease(jobId)) return
    val stream = containers.start(jobId)
    val output = new StringBuilder
    while (leaseTtl(jobId) > 0) {
      stream.read() match {
        case Some(chunk) => output.append(chunk)
        case None => ()
          // the container closed its stream: stop reading, the lease check below decides the outcome
      }
    }
    if (leaseTtl(jobId) <= 0) {
      containers.kill(jobId)
      return
    }
    finish(jobId, Map("exit_code" -> stream.exitCode, "output" -> output.toString))
  }

  def finish(jobId: String, result: Map[String, Any]): Unit = {
    if (leaseTtl(jobId) <= 0) return // late write: the lease lapsed, the result is discarded
    store.putResult(jobId, result)
  }
}
`,
    },
    cpp: {
      starter: `#include <chrono>
#include <memory>
#include <string>
#include <unordered_map>

constexpr long long kDefaultTimeoutSeconds = 300;

std::unordered_map<std::string, std::chrono::steady_clock::time_point> jobs;

void finish(const std::string& jobId, const nlohmann::json& result) {
  store.putResult(jobId, result);
}

void runJob(const std::string& jobId) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const auto started = std::chrono::steady_clock::now();
  jobs[jobId] = started;
  auto stream = containers->Start(jobId);
  std::string output;
  while (std::chrono::duration_cast<std::chrono::seconds>(std::chrono::steady_clock::now() - started).count() <
         kDefaultTimeoutSeconds) {
    const auto chunk = stream->Read();
    if (chunk.empty()) break;
    output += chunk;
  }
  finish(jobId, nlohmann::json{{"exit_code", stream->ExitCode()}, {"output", output}});
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <memory>
#include <string>
#include <vector>

const std::string kLeasePrefix = "lease:";
constexpr long long kMaxRuntimeSeconds = 300;

struct ResultStore {
  void putResult(const std::string& jobId, const nlohmann::json& result);
};

ResultStore store;

std::unique_ptr<sw::redis::Redis> redis;

bool acquireLease(const std::string& jobId) {
  // The lease carries the hard wall-clock limit; nothing local decides when the job must die.
  return redis->set(kLeasePrefix + jobId, jobId, std::chrono::seconds(kMaxRuntimeSeconds), sw::redis::UpdateType::NOT_EXIST);
}

long long leaseTtl(const std::string& jobId) {
  // Read from Redis on every check: the expiry is authoritative and survives a runner restart.
  return redis->ttl(kLeasePrefix + jobId);
}

std::vector<std::string> recoverLeases() {
  std::vector<std::string> recovered;
  for (auto it = redis->scan_match(kLeasePrefix + "*"); it; ++it) {
    const auto jobId = it->substr(kLeasePrefix.size());
    if (leaseTtl(jobId) <= 0) {
      containers->Kill(jobId);
      continue;
    }
    recovered.push_back(jobId);
  }
  return recovered;
}

void finish(const std::string& jobId, const nlohmann::json& result) {
  if (leaseTtl(jobId) <= 0) return;  // late write: the lease lapsed, the result is discarded
  store.putResult(jobId, result);
}

void runJob(const std::string& jobId) {
  if (!acquireLease(jobId)) return;
  auto stream = containers->Start(jobId);
  std::string output;
  while (leaseTtl(jobId) > 0) {
    const auto chunk = stream->Read();
    if (chunk.empty()) break;
    output += chunk;
  }
  if (leaseTtl(jobId) <= 0) {
    containers->Kill(jobId);
    return;
  }
  finish(jobId, nlohmann::json{{"exit_code", stream->ExitCode()}, {"output", output}});
}
`,
    },
  },
  debrief: `A runner that times its jobs with a local clock is correct until the process restarts; then the
containers keep going because nobody owns the clock. A Redis key with a TTL is both the lock that
makes one runner own a job and the hard limit that ends it, readable by any process. The lease only
says when, so the kill still has to be called, and before the result is written, or a job that
overran reappears in the history as a success. Recovery closes the loop: on start-up the runner
asks Redis what exists, kills what expired, and adopts the rest. Production runners renew the lease
with a heartbeat for long jobs and run a per-node reaper that outlives a runner crash.`,
};
