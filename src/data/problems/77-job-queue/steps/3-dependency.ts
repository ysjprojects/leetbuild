import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Worker calls with retry classification and a poison limit',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'client',
  focus: ['worker', 'effect', 'dlq', 'redis'],
  task: `## Task

**Starting point.** The starter is \`run_attempt(job_id, worker)\`, one attempt of a job this worker
claimed: it reads the job (\`store.get_job\`), takes \`attempts + 1\` as the attempt number and calls
\`JobRunner.Execute\` with no deadline. On an error it records the attempt (\`store.record_attempt\`),
buries the job once the number reaches \`MAX_ATTEMPTS\` (5) and otherwise schedules the retry for now
(\`queue.retry_later\`). On success it counts the attempt (\`store.begin_attempt\`), records it and acks.
It serves the demo and hides four flaws.

**Failure mode the checks target.** A payload the executor rejects is retried as if the executor
were down; a job that always fails never reaches the dead letter; retries hit an executor that is
still restarting; a hung executor holds the worker past its claim, so a second worker runs the job.

- Only \`UNAVAILABLE\`, \`DEADLINE_EXCEEDED\`, \`RESOURCE_EXHAUSTED\` and \`ABORTED\` are retryable;
  any other status buries the job at once with reason \`permanent_error\`.
- \`store.begin_attempt\` counts the attempt on the job record **before** the call; its return is the
  attempt number.
- Retry after \`BACKOFF_BASE_MS\` (1 000) doubled per attempt: 1 s, 2 s, 4 s, 8 s.
- \`Execute\` carries a deadline of \`EXECUTE_TIMEOUT_S\` (30 s), under the 60 s visibility timeout.`,
  sequence: {
    participants: ['Worker', 'Job store', 'JobRunner', 'Queue'],
    messages: [
      {from: 'Worker', to: 'Job store', label: 'begin_attempt(job_id) → attempt n', kind: 'sync'},
      {from: 'Worker', to: 'JobRunner', label: 'Execute(job, attempt n) · deadline 30 s', kind: 'sync'},
      {from: 'JobRunner', to: 'Worker', label: 'OK → record_attempt · ack', kind: 'reply'},
      {from: 'JobRunner', to: 'Worker', label: 'UNAVAILABLE · DEADLINE_EXCEEDED · … retryable', kind: 'reply'},
      {from: 'Worker', to: 'Queue', label: 'retry_later(job_id, now + 1 s · 2^(n-1))', kind: 'sync'},
      {from: 'JobRunner', to: 'Worker', label: 'INVALID_ARGUMENT · … permanent', kind: 'reply'},
      {from: 'Worker', to: 'Queue', label: 'bury(job_id, permanent_error | max_attempts_exceeded)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'execute-call',
      title: 'Runs the claimed job through JobRunner.Execute',
      detail:
        'With a healthy executor the attempt answers `completed`: one `Execute` call carries the job id, type, payload and attempt 1, the job is `completed` and out of `jobs:inflight`, and its history holds one successful attempt.',
      match: {
        python: {all: [/runner\.Execute\(/, /job_queue_pb2\.ExecuteRequest\(/]},
        typescript: {all: [/runner\.Execute\(/]},
        go: {all: [/runner\.Execute\(/, /pb\.ExecuteRequest\{/]},
        scala: {all: [/\.execute\(/, /ExecuteRequest\(/]},
        cpp: {all: [/runner->Execute\(/, /jobqueue::ExecuteRequest/]},
      },
    },
    {
      id: 'retry-classes',
      title: 'Retries only the retryable statuses; a permanent one buries at once',
      detail:
        '`INVALID_ARGUMENT` buries the job on its first attempt with `dead_reason = permanent_error` and puts it on `jobs:dead`; `UNAVAILABLE` schedules a retry. The starter retries every status alike.',
      match: {
        python: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /RESOURCE_EXHAUSTED/, /ABORTED/, /permanent_error/]},
        typescript: {
          all: [
            /status\.UNAVAILABLE/,
            /status\.DEADLINE_EXCEEDED/,
            /status\.RESOURCE_EXHAUSTED/,
            /status\.ABORTED/,
            /permanent_error/,
          ],
        },
        go: {
          all: [
            /codes\.Unavailable/,
            /codes\.DeadlineExceeded/,
            /codes\.ResourceExhausted/,
            /codes\.Aborted/,
            /permanent_error/,
          ],
        },
        scala: {
          all: [
            /Code\.UNAVAILABLE/,
            /Code\.DEADLINE_EXCEEDED/,
            /Code\.RESOURCE_EXHAUSTED/,
            /Code\.ABORTED/,
            /permanent_error/,
          ],
        },
        cpp: {
          all: [
            /StatusCode::UNAVAILABLE/,
            /StatusCode::DEADLINE_EXCEEDED/,
            /StatusCode::RESOURCE_EXHAUSTED/,
            /StatusCode::ABORTED/,
            /permanent_error/,
          ],
        },
      },
    },
    {
      id: 'attempts-durable',
      title: 'Counts the attempt before the call, so a poison job reaches the dead letter',
      detail:
        'Five `UNAVAILABLE` attempts end in `dead` with `max_attempts_exceeded`, the calls carry attempts 1 to 5, and the job record already holds the attempt when `Execute` arrives. The starter counts only attempts that succeeded, so a failing job is attempt 1 forever.',
      match: {
        python: {all: [/attempt\s*=\s*store\.begin_attempt\(/], order: [/store\.begin_attempt\(/, /runner\.Execute\(/]},
        typescript: {
          all: [/attempt\s*=\s*await store\.beginAttempt\(/],
          order: [/store\.beginAttempt\(/, /runner\.Execute\(/],
        },
        go: {
          all: [/attempt,\s*err\s*:?=\s*store\.BeginAttempt\(/],
          order: [/store\.BeginAttempt\(/, /runner\.Execute\(/],
        },
        scala: {all: [/attempt\s*=\s*Store\.beginAttempt\(/], order: [/Store\.beginAttempt\(/, /\.execute\(/]},
        cpp: {all: [/attempt\s*=\s*store::beginAttempt\(/], order: [/store::beginAttempt\(/, /runner->Execute\(/]},
      },
    },
    {
      id: 'backoff',
      title: 'Spaces retries 1 s, 2 s, 4 s apart',
      detail:
        'After attempts 1, 2 and 3 fail, the retry is due 1 000, 2 000 and 4 000 ms later (`next_retry_at_ms` and the `jobs:inflight` score). The starter schedules every retry for now.',
      match: {
        python: {all: [/BACKOFF_BASE_MS\s*(\*|<<)/]},
        typescript: {all: [/BACKOFF_BASE_MS\s*(\*|<<)/]},
        go: {all: [/backoffBaseMs\s*(\*|<<)/]},
        scala: {all: [/BackoffBaseMs\s*(\*|<<)/]},
        cpp: {all: [/kBackoffBaseMs\s*(\*|<<)/]},
      },
    },
    {
      id: 'call-deadline',
      title: 'Execute carries a deadline under the visibility timeout',
      detail:
        'With an executor that takes 120 s, the call carries a deadline of at most 30 s and the attempt answers `retry`. The starter waits as long as the executor takes, past the 60 s claim, while the reaper hands the job to another worker.',
      match: {
        python: {all: [/timeout\s*=\s*EXECUTE_TIMEOUT_S/]},
        typescript: {all: [/deadline:\s*Date\.now\(\)\s*\+\s*EXECUTE_TIMEOUT_S/]},
        go: {all: [/context\.WithTimeout\(\s*ctx,\s*executeTimeout\s*\)/]},
        scala: {all: [/withDeadlineAfter\(\s*ExecuteTimeoutS/]},
        cpp: {all: [/set_deadline\([^;]*kExecuteTimeout/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import time

import grpc

import job_queue_pb2
import job_queue_pb2_grpc
from jobs import queue, store  # queue.ack, retry_later, bury · store.get_job, begin_attempt, record_attempt

MAX_ATTEMPTS = 5

runner = job_queue_pb2_grpc.JobRunnerStub(grpc.insecure_channel("jobrunner:9000"))


def run_attempt(job_id: str, worker: str) -> str:
    """Run one attempt of a job this worker claimed: "completed", "retry" or "dead"."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    job = store.get_job(job_id)
    attempt = job["attempts"] + 1
    request = job_queue_pb2.ExecuteRequest(job_id=job_id, job_type=job["type"], payload=json.dumps(job["payload"]), attempt=attempt)
    try:
        runner.Execute(request)
    except grpc.RpcError as exc:
        store.record_attempt(job_id, attempt, f"{exc.code().name}: {exc.details()}")
        if attempt >= MAX_ATTEMPTS:
            queue.bury(job_id, "max_attempts_exceeded")
            return "dead"
        queue.retry_later(job_id, int(time.time() * 1000))
        return "retry"
    store.begin_attempt(job_id)
    store.record_attempt(job_id, attempt, "")
    queue.ack(job_id, worker)
    return "completed"
`,
      solution: `import json
import time

import grpc

import job_queue_pb2
import job_queue_pb2_grpc
from jobs import queue, store  # queue.ack, retry_later, bury · store.get_job, begin_attempt, record_attempt

MAX_ATTEMPTS = 5
BACKOFF_BASE_MS = 1000
EXECUTE_TIMEOUT_S = 30  # under the 60 s visibility timeout: the call ends before the claim does
# The executor may answer differently later; any other status says the job as written will not succeed.
RETRYABLE = {
    grpc.StatusCode.UNAVAILABLE,
    grpc.StatusCode.DEADLINE_EXCEEDED,
    grpc.StatusCode.RESOURCE_EXHAUSTED,
    grpc.StatusCode.ABORTED,
}

runner = job_queue_pb2_grpc.JobRunnerStub(grpc.insecure_channel("jobrunner:9000"))


def run_attempt(job_id: str, worker: str) -> str:
    """Run one attempt of a job this worker claimed: "completed", "retry" or "dead"."""
    job = store.get_job(job_id)
    # Counted on the job record before the call: a worker that dies mid-call has still used the attempt.
    attempt = store.begin_attempt(job_id)
    request = job_queue_pb2.ExecuteRequest(job_id=job_id, job_type=job["type"], payload=json.dumps(job["payload"]), attempt=attempt)
    try:
        runner.Execute(request, timeout=EXECUTE_TIMEOUT_S)
    except grpc.RpcError as exc:
        store.record_attempt(job_id, attempt, f"{exc.code().name}: {exc.details()}")
        if exc.code() not in RETRYABLE:
            queue.bury(job_id, "permanent_error")
            return "dead"
        if attempt >= MAX_ATTEMPTS:
            queue.bury(job_id, "max_attempts_exceeded")
            return "dead"
        queue.retry_later(job_id, int(time.time() * 1000) + BACKOFF_BASE_MS * 2 ** (attempt - 1))
        return "retry"
    store.record_attempt(job_id, attempt, "")
    queue.ack(job_id, worker)
    return "completed"
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import * as queue from 'jobs/queue'; // ack, retryLater, bury
import * as store from 'jobs/store'; // getJob, beginAttempt, recordAttempt

export const MAX_ATTEMPTS = 5;

interface ExecuteRequest {
  job_id: string;
  job_type: string;
  payload: string;
  attempt: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('job_queue.proto')) as unknown as {
  jobqueue: {JobRunner: grpc.ServiceClientConstructor};
};
const runner = new pkg.jobqueue.JobRunner('jobrunner:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Execute(request: ExecuteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{result: string}>;
};

/** Run one attempt of a job this worker claimed: "completed", "retry" or "dead". */
export async function runAttempt(jobId: string, worker: string): Promise<string> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const job = (await store.getJob(jobId)) as store.Job;
  const attempt = job.attempts + 1;
  try {
    await runner.Execute({job_id: jobId, job_type: job.type, payload: JSON.stringify(job.payload), attempt}, new grpc.Metadata(), {});
  } catch (e) {
    const {code, details} = e as grpc.ServiceError;
    await store.recordAttempt(jobId, attempt, \`\${grpc.status[code]}: \${details}\`);
    if (attempt >= MAX_ATTEMPTS) {
      await queue.bury(jobId, 'max_attempts_exceeded');
      return 'dead';
    }
    await queue.retryLater(jobId, Date.now());
    return 'retry';
  }
  await store.beginAttempt(jobId);
  await store.recordAttempt(jobId, attempt, '');
  await queue.ack(jobId, worker);
  return 'completed';
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import * as queue from 'jobs/queue'; // ack, retryLater, bury
import * as store from 'jobs/store'; // getJob, beginAttempt, recordAttempt

export const MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 1000;
export const EXECUTE_TIMEOUT_S = 30; // under the 60 s visibility timeout: the call ends before the claim does
// The executor may answer differently later; any other status says the job as written will not succeed.
const RETRYABLE = new Set<grpc.status>([
  grpc.status.UNAVAILABLE,
  grpc.status.DEADLINE_EXCEEDED,
  grpc.status.RESOURCE_EXHAUSTED,
  grpc.status.ABORTED,
]);

interface ExecuteRequest {
  job_id: string;
  job_type: string;
  payload: string;
  attempt: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('job_queue.proto')) as unknown as {
  jobqueue: {JobRunner: grpc.ServiceClientConstructor};
};
const runner = new pkg.jobqueue.JobRunner('jobrunner:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Execute(request: ExecuteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{result: string}>;
};

/** Run one attempt of a job this worker claimed: "completed", "retry" or "dead". */
export async function runAttempt(jobId: string, worker: string): Promise<string> {
  const job = (await store.getJob(jobId)) as store.Job;
  // Counted on the job record before the call: a worker that dies mid-call has still used the attempt.
  const attempt = await store.beginAttempt(jobId);
  try {
    await runner.Execute(
      {job_id: jobId, job_type: job.type, payload: JSON.stringify(job.payload), attempt},
      new grpc.Metadata(),
      {deadline: Date.now() + EXECUTE_TIMEOUT_S * 1000},
    );
  } catch (e) {
    const {code, details} = e as grpc.ServiceError;
    await store.recordAttempt(jobId, attempt, \`\${grpc.status[code]}: \${details}\`);
    if (!RETRYABLE.has(code)) {
      await queue.bury(jobId, 'permanent_error');
      return 'dead';
    }
    if (attempt >= MAX_ATTEMPTS) {
      await queue.bury(jobId, 'max_attempts_exceeded');
      return 'dead';
    }
    await queue.retryLater(jobId, Date.now() + BACKOFF_BASE_MS * 2 ** (attempt - 1));
    return 'retry';
  }
  await store.recordAttempt(jobId, attempt, '');
  await queue.ack(jobId, worker);
  return 'completed';
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "jobs/gen/job_queue"
	"jobs/queue" // queue.Ack, RetryLater, Bury
	"jobs/store" // store.GetJob, BeginAttempt, RecordAttempt
)

const maxAttempts = 5

var (
	runnerConn, _ = grpc.NewClient("jobrunner:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	runner        = pb.NewJobRunnerClient(runnerConn)
)

// runAttempt runs one attempt of a job this worker claimed: "completed", "retry" or "dead".
func runAttempt(ctx context.Context, jobID, worker string) (string, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	job := store.GetJob(ctx, jobID)
	if job == nil {
		return "", fmt.Errorf("no job %s", jobID)
	}
	attempt := job.Attempts + 1
	payload, _ := json.Marshal(job.Payload)
	_, err := runner.Execute(ctx, &pb.ExecuteRequest{JobId: jobID, JobType: job.Type, Payload: string(payload), Attempt: int32(attempt)})
	if err != nil {
		st := status.Convert(err)
		store.RecordAttempt(ctx, jobID, attempt, st.Code().String()+": "+st.Message())
		if attempt >= maxAttempts {
			return "dead", queue.Bury(ctx, jobID, "max_attempts_exceeded")
		}
		return "retry", queue.RetryLater(ctx, jobID, time.Now().UnixMilli())
	}
	store.BeginAttempt(ctx, jobID)
	store.RecordAttempt(ctx, jobID, attempt, "")
	_, err = queue.Ack(ctx, jobID, worker)
	return "completed", err
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "jobs/gen/job_queue"
	"jobs/queue" // queue.Ack, RetryLater, Bury
	"jobs/store" // store.GetJob, BeginAttempt, RecordAttempt
)

const (
	maxAttempts    = 5
	backoffBaseMs  = int64(1000)
	executeTimeout = 30 * time.Second // under the 60 s visibility timeout: the call ends before the claim does
)

// retryable: the executor may answer differently later; any other status says the job as written
// will not succeed.
var retryable = map[codes.Code]bool{
	codes.Unavailable:       true,
	codes.DeadlineExceeded:  true,
	codes.ResourceExhausted: true,
	codes.Aborted:           true,
}

var (
	runnerConn, _ = grpc.NewClient("jobrunner:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	runner        = pb.NewJobRunnerClient(runnerConn)
)

// runAttempt runs one attempt of a job this worker claimed: "completed", "retry" or "dead".
func runAttempt(ctx context.Context, jobID, worker string) (string, error) {
	job := store.GetJob(ctx, jobID)
	if job == nil {
		return "", fmt.Errorf("no job %s", jobID)
	}
	// Counted on the job record before the call: a worker that dies mid-call has still used the attempt.
	attempt, err := store.BeginAttempt(ctx, jobID)
	if err != nil {
		return "", err
	}
	payload, _ := json.Marshal(job.Payload)
	callCtx, cancel := context.WithTimeout(ctx, executeTimeout)
	defer cancel()
	_, err = runner.Execute(callCtx, &pb.ExecuteRequest{JobId: jobID, JobType: job.Type, Payload: string(payload), Attempt: int32(attempt)})
	if err != nil {
		st := status.Convert(err)
		store.RecordAttempt(ctx, jobID, attempt, st.Code().String()+": "+st.Message())
		if !retryable[st.Code()] {
			return "dead", queue.Bury(ctx, jobID, "permanent_error")
		}
		if attempt >= maxAttempts {
			return "dead", queue.Bury(ctx, jobID, "max_attempts_exceeded")
		}
		delay := backoffBaseMs << (attempt - 1)
		return "retry", queue.RetryLater(ctx, jobID, time.Now().UnixMilli()+delay)
	}
	store.RecordAttempt(ctx, jobID, attempt, "")
	_, err = queue.Ack(ctx, jobID, worker)
	return "completed", err
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import jobqueue.job_queue.{ExecuteRequest, JobRunnerGrpc}
import jobs.{Queue, Store} // Queue.ack, retryLater, bury · Store.getJob, beginAttempt, recordAttempt

object Client {
  val MaxAttempts = 5

  private val runner = JobRunnerGrpc.blockingStub(ManagedChannelBuilder.forAddress("jobrunner", 9000).usePlaintext().build())

  /** Run one attempt of a job this worker claimed: "completed", "retry" or "dead". */
  def runAttempt(jobId: String, worker: String): String = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val job = Store.getJob(jobId).getOrElse(throw new NoSuchElementException(s"no job $jobId"))
    val attempt = job.attempts + 1
    try runner.execute(ExecuteRequest(jobId, job.jobType, job.payload.compactPrint, attempt))
    catch {
      case e: StatusRuntimeException =>
        Store.recordAttempt(jobId, attempt, s"\${e.getStatus.getCode}: \${e.getStatus.getDescription}")
        if (attempt >= MaxAttempts) {
          Queue.bury(jobId, "max_attempts_exceeded")
          return "dead"
        }
        Queue.retryLater(jobId, System.currentTimeMillis)
        return "retry"
    }
    Store.beginAttempt(jobId)
    Store.recordAttempt(jobId, attempt, "")
    Queue.ack(jobId, worker)
    "completed"
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import jobqueue.job_queue.{ExecuteRequest, JobRunnerGrpc}
import jobs.{Queue, Store} // Queue.ack, retryLater, bury · Store.getJob, beginAttempt, recordAttempt

object Client {
  val MaxAttempts = 5
  val BackoffBaseMs = 1000L
  val ExecuteTimeoutS = 30L // under the 60 s visibility timeout: the call ends before the claim does
  // The executor may answer differently later; any other status says the job as written will not succeed.
  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED, Status.Code.RESOURCE_EXHAUSTED, Status.Code.ABORTED)

  private val runner = JobRunnerGrpc.blockingStub(ManagedChannelBuilder.forAddress("jobrunner", 9000).usePlaintext().build())

  /** Run one attempt of a job this worker claimed: "completed", "retry" or "dead". */
  def runAttempt(jobId: String, worker: String): String = {
    val job = Store.getJob(jobId).getOrElse(throw new NoSuchElementException(s"no job $jobId"))
    // Counted on the job record before the call: a worker that dies mid-call has still used the attempt.
    val attempt = Store.beginAttempt(jobId)
    try runner.withDeadlineAfter(ExecuteTimeoutS, TimeUnit.SECONDS).execute(ExecuteRequest(jobId, job.jobType, job.payload.compactPrint, attempt.toInt))
    catch {
      case e: StatusRuntimeException =>
        Store.recordAttempt(jobId, attempt, s"\${e.getStatus.getCode}: \${e.getStatus.getDescription}")
        if (!Retryable.contains(e.getStatus.getCode)) {
          Queue.bury(jobId, "permanent_error")
          return "dead"
        }
        if (attempt >= MaxAttempts) {
          Queue.bury(jobId, "max_attempts_exceeded")
          return "dead"
        }
        Queue.retryLater(jobId, System.currentTimeMillis + (BackoffBaseMs << (attempt - 1)))
        return "retry"
    }
    Store.recordAttempt(jobId, attempt, "")
    Queue.ack(jobId, worker)
    "completed"
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <stdexcept>
#include <string>

#include "job_queue.grpc.pb.h"
#include "jobs/queue.h"  // queue::ack, retryLater, bury
#include "jobs/store.h"  // store::getJob, beginAttempt, recordAttempt

constexpr long kMaxAttempts = 5;

auto runner = jobqueue::JobRunner::NewStub(grpc::CreateChannel("jobrunner:9000", grpc::InsecureChannelCredentials()));

// Run one attempt of a job this worker claimed: "completed", "retry" or "dead".
std::string runAttempt(const std::string& job_id, const std::string& worker) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto job = store::getJob(job_id);
  if (!job) throw std::out_of_range("no job " + job_id);
  const long attempt = job->attempts + 1;
  jobqueue::ExecuteRequest request;
  request.set_job_id(job_id);
  request.set_job_type(job->type);
  request.set_payload(job->payload.dump());
  request.set_attempt(static_cast<int>(attempt));
  grpc::ClientContext ctx;
  jobqueue::ExecuteReply reply;
  const grpc::Status status = runner->Execute(&ctx, request, &reply);
  if (!status.ok()) {
    store::recordAttempt(job_id, attempt, "code " + std::to_string(status.error_code()) + ": " + status.error_message());
    if (attempt >= kMaxAttempts) {
      queue::bury(job_id, "max_attempts_exceeded");
      return "dead";
    }
    queue::retryLater(job_id, store::nowMs());
    return "retry";
  }
  store::beginAttempt(job_id);
  store::recordAttempt(job_id, attempt, "");
  queue::ack(job_id, worker);
  return "completed";
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <set>
#include <stdexcept>
#include <string>

#include "job_queue.grpc.pb.h"
#include "jobs/queue.h"  // queue::ack, retryLater, bury
#include "jobs/store.h"  // store::getJob, beginAttempt, recordAttempt

constexpr long kMaxAttempts = 5;
constexpr long long kBackoffBaseMs = 1000;
constexpr std::chrono::seconds kExecuteTimeout{30};  // under the 60 s visibility timeout: the call ends before the claim does
// The executor may answer differently later; any other status says the job as written will not succeed.
const std::set<grpc::StatusCode> kRetryable = {grpc::StatusCode::UNAVAILABLE, grpc::StatusCode::DEADLINE_EXCEEDED,
                                               grpc::StatusCode::RESOURCE_EXHAUSTED, grpc::StatusCode::ABORTED};

auto runner = jobqueue::JobRunner::NewStub(grpc::CreateChannel("jobrunner:9000", grpc::InsecureChannelCredentials()));

// Run one attempt of a job this worker claimed: "completed", "retry" or "dead".
std::string runAttempt(const std::string& job_id, const std::string& worker) {
  const auto job = store::getJob(job_id);
  if (!job) throw std::out_of_range("no job " + job_id);
  // Counted on the job record before the call: a worker that dies mid-call has still used the attempt.
  const long attempt = store::beginAttempt(job_id);
  jobqueue::ExecuteRequest request;
  request.set_job_id(job_id);
  request.set_job_type(job->type);
  request.set_payload(job->payload.dump());
  request.set_attempt(static_cast<int>(attempt));
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kExecuteTimeout);
  jobqueue::ExecuteReply reply;
  const grpc::Status status = runner->Execute(&ctx, request, &reply);
  if (!status.ok()) {
    store::recordAttempt(job_id, attempt, "code " + std::to_string(status.error_code()) + ": " + status.error_message());
    if (kRetryable.count(status.error_code()) == 0) {
      queue::bury(job_id, "permanent_error");
      return "dead";
    }
    if (attempt >= kMaxAttempts) {
      queue::bury(job_id, "max_attempts_exceeded");
      return "dead";
    }
    queue::retryLater(job_id, store::nowMs() + (kBackoffBaseMs << (attempt - 1)));
    return "retry";
  }
  store::recordAttempt(job_id, attempt, "");
  queue::ack(job_id, worker);
  return "completed";
}
`,
    },
  },
  harness: {
    python: `import json
import time

import grpc

import job_queue_pb2
import job_queue_pb2_grpc
from jobs import queue, store

INVOICE = {"invoice_id": "inv-7", "amount_cents": 1200}


class Runner(job_queue_pb2_grpc.JobRunnerServicer):
    """Runs every job it is asked to; notes the attempt count the job record held when each call arrived."""

    def __init__(self):
        self.counted = []

    def Execute(self, request, context):
        self.counted.append(store.get_job(request.job_id)["attempts"])
        return job_queue_pb2.ExecuteReply(result="ok")


def _claimed(job_id):
    store.create_job(job_id, "t-1", "invoice.charge", INVOICE)
    assert queue.claim("w-1") == job_id, f"the harness could not claim {job_id}"


def _setup(ctx):
    runner = Runner()
    ctx.grpc.serve(job_queue_pb2_grpc.add_JobRunnerServicer_to_server, runner)
    _claimed("job-1")
    return ctx.load("client"), runner


def _reclaim(ctx, seconds=60):
    ctx.clock.advance(seconds)
    queue.return_expired()
    assert queue.claim("w-1") == "job-1", "the retried job must be claimable once its retry is due"


def check_execute_call(ctx):
    m, _ = _setup(ctx)
    outcome = m.run_attempt("job-1", "w-1")
    assert outcome == "completed", f"with a healthy executor the attempt returned {outcome!r}"
    calls = ctx.grpc.calls_to("Execute")
    assert len(calls) == 1, f"one attempt made {len(calls)} Execute calls"
    req = calls[0].request
    assert req.job_id == "job-1" and req.job_type == "invoice.charge" and req.attempt == 1, f"the Execute request is {req}"
    assert json.loads(req.payload) == INVOICE, f"the request carries payload {req.payload}"
    job = store.get_job("job-1")
    assert job["state"] == "completed", f"after a successful attempt the job is {job}"
    assert ctx.redis.zscore("jobs:inflight", "job-1") is None, "a completed job must leave jobs:inflight"
    history = store.attempt_history("job-1")
    assert [h["error"] for h in history] == [""], f"the history must hold one successful attempt, got {history}"


def check_retry_classes(ctx):
    m, _ = _setup(ctx)
    ctx.grpc.fail("Execute", grpc.StatusCode.INVALID_ARGUMENT, "template welcome-v9 does not exist", 1)
    outcome = m.run_attempt("job-1", "w-1")
    assert outcome == "dead", f"INVALID_ARGUMENT returned {outcome!r}: a job the executor rejects as written fails the same way on every retry, so bury it on the first attempt"
    job = store.get_job("job-1")
    assert job["state"] == "dead" and job["dead_reason"] == "permanent_error", f"the buried job is {job}, expected dead with dead_reason permanent_error"
    assert ctx.redis.lrange("jobs:dead", 0, -1) == ["job-1"], f"jobs:dead holds {ctx.redis.lrange('jobs:dead', 0, -1)}"
    _claimed("job-2")
    ctx.grpc.fail("Execute", grpc.StatusCode.UNAVAILABLE, "executor restarting", 1)
    outcome = m.run_attempt("job-2", "w-1")
    assert outcome == "retry" and store.get_job("job-2")["state"] == "retrying", f"UNAVAILABLE returned {outcome!r} with the job {store.get_job('job-2')}: an executor that is down may be up later, so schedule a retry"


def check_attempts_durable(ctx):
    m, runner = _setup(ctx)
    ctx.grpc.fail("Execute", grpc.StatusCode.UNAVAILABLE, "executor restarting", 5)
    outcomes = []
    while True:
        outcomes.append(m.run_attempt("job-1", "w-1"))
        if outcomes[-1] != "retry" or len(outcomes) == 6:
            break
        _reclaim(ctx)
    assert outcomes == ["retry"] * 4 + ["dead"], f"five UNAVAILABLE attempts returned {outcomes}: the fifth must bury the job (MAX_ATTEMPTS = 5), which needs a count that grows on every attempt"
    sent = [c.request.attempt for c in ctx.grpc.calls_to("Execute")]
    assert sent == [1, 2, 3, 4, 5], f"the Execute calls carried attempts {sent}, expected 1 to 5"
    job = store.get_job("job-1")
    assert job["attempts"] == 5 and job["dead_reason"] == "max_attempts_exceeded", f"the job is {job}, expected 5 attempts and dead_reason max_attempts_exceeded"
    assert len(store.attempt_history("job-1")) == 5, f"the history holds {store.attempt_history('job-1')}"
    _claimed("job-2")
    assert m.run_attempt("job-2", "w-1") == "completed"
    assert runner.counted == [1], f"when Execute arrived the job record held attempts {runner.counted}: count the attempt before the call, or a worker that dies mid-call gives the job a free attempt"


def check_backoff(ctx):
    m, _ = _setup(ctx)
    ctx.grpc.fail("Execute", grpc.StatusCode.UNAVAILABLE, "executor restarting", 3)
    for attempt, delay in ((1, 1000), (2, 2000), (3, 4000)):
        now = int(time.time() * 1000)
        outcome = m.run_attempt("job-1", "w-1")
        assert outcome == "retry", f"attempt {attempt} returned {outcome!r}"
        due = ctx.redis.zscore("jobs:inflight", "job-1")
        assert due == now + delay, f"after attempt {attempt} the retry is due {None if due is None else int(due) - now} ms from now, expected {delay} ms (BACKOFF_BASE_MS doubled per attempt): a retry at once hits an executor that is still down"
        assert store.get_job("job-1")["next_retry_at_ms"] == now + delay, f"next_retry_at_ms is {store.get_job('job-1')['next_retry_at_ms']}, expected {now + delay}"
        _reclaim(ctx, delay / 1000)


def check_call_deadline(ctx):
    m, _ = _setup(ctx)
    ctx.grpc.set_latency("Execute", 120.0)
    outcome = m.run_attempt("job-1", "w-1")
    calls = ctx.grpc.calls_to("Execute")
    assert calls, "no Execute call was made"
    assert calls[0].timeout is not None, "the Execute call carries no deadline: an executor that hangs holds the worker past the 60 s visibility timeout, and the reaper hands the job to a second worker"
    assert calls[0].timeout <= 30.5, f"the Execute call carries a {calls[0].timeout} s deadline, expected EXECUTE_TIMEOUT_S = 30, under the 60 s visibility timeout"
    assert outcome == "retry", f"a call that hit its deadline returned {outcome!r}: DEADLINE_EXCEEDED is retryable"
`,
    typescript: `const INVOICE = {invoice_id: 'inv-7', amount_cents: 1200};

async function claimed(queue, store, jobId: string): Promise<void> {
  await store.createJob(jobId, 't-1', 'invoice.charge', INVOICE);
  assert.equal(await queue.claim('w-1'), jobId, \`the harness could not claim \${jobId}\`);
}

/** The executor runs every job; counted notes the attempts the job record held when each call arrived. */
async function setup(ctx) {
  const pkg = ctx.proto('job_queue.proto');
  const counted: number[] = [];
  ctx.grpc.serve(pkg.jobqueue.JobRunner.service, {
    Execute(call, callback) {
      counted.push(Number(ctx.redis.hget(\`job:\${call.request.job_id}\`, 'attempts')));
      callback(null, {result: 'ok'});
    },
  });
  const queue = ctx.load('/support/jobs/queue.ts');
  const store = ctx.load('/support/jobs/store.ts');
  await claimed(queue, store, 'job-1');
  return {m: ctx.load('client'), queue, store, counted};
}

async function reclaim(ctx, queue, seconds = 60): Promise<void> {
  ctx.clock.advance(seconds);
  await queue.returnExpired();
  assert.equal(await queue.claim('w-1'), 'job-1', 'the retried job must be claimable once its retry is due');
}

export async function check_execute_call(ctx) {
  const {m, store} = await setup(ctx);
  const outcome = await m.runAttempt('job-1', 'w-1');
  assert.equal(outcome, 'completed', \`with a healthy executor the attempt returned \${outcome}\`);
  const calls = ctx.grpc.callsTo('Execute');
  assert.equal(calls.length, 1, \`one attempt made \${calls.length} Execute calls\`);
  const req = calls[0].request;
  assert(req.job_id === 'job-1' && req.job_type === 'invoice.charge' && Number(req.attempt) === 1, \`the Execute request is \${JSON.stringify(req)}\`);
  assert.deepEqual(JSON.parse(req.payload), INVOICE, \`the request carries payload \${req.payload}\`);
  assert.equal((await store.getJob('job-1')).state, 'completed', 'after a successful attempt the job must be completed');
  assert.equal(ctx.redis.zscore('jobs:inflight', 'job-1'), null, 'a completed job must leave jobs:inflight');
  const history = await store.attemptHistory('job-1');
  assert.deepEqual(history.map(h => h.error), [''], \`the history must hold one successful attempt, got \${JSON.stringify(history)}\`);
}

export async function check_retry_classes(ctx) {
  const {m, queue, store} = await setup(ctx);
  ctx.grpc.fail('Execute', ctx.grpc.status.INVALID_ARGUMENT, 'template welcome-v9 does not exist', 1);
  let outcome = await m.runAttempt('job-1', 'w-1');
  assert.equal(outcome, 'dead', \`INVALID_ARGUMENT returned \${outcome}: a job the executor rejects as written fails the same way on every retry, so bury it on the first attempt\`);
  const job = await store.getJob('job-1');
  assert(job.state === 'dead' && job.dead_reason === 'permanent_error', \`the buried job is \${JSON.stringify(job)}, expected dead with dead_reason permanent_error\`);
  assert.deepEqual(ctx.redis.lrange('jobs:dead', 0, -1), ['job-1'], 'jobs:dead must hold the buried job');
  await claimed(queue, store, 'job-2');
  ctx.grpc.fail('Execute', ctx.grpc.status.UNAVAILABLE, 'executor restarting', 1);
  outcome = await m.runAttempt('job-2', 'w-1');
  const second = await store.getJob('job-2');
  assert(outcome === 'retry' && second.state === 'retrying', \`UNAVAILABLE returned \${outcome} with the job \${JSON.stringify(second)}: an executor that is down may be up later, so schedule a retry\`);
}

export async function check_attempts_durable(ctx) {
  const {m, queue, store, counted} = await setup(ctx);
  ctx.grpc.fail('Execute', ctx.grpc.status.UNAVAILABLE, 'executor restarting', 5);
  const outcomes: string[] = [];
  for (;;) {
    outcomes.push(await m.runAttempt('job-1', 'w-1'));
    if (outcomes.at(-1) !== 'retry' || outcomes.length === 6) break;
    await reclaim(ctx, queue);
  }
  assert.deepEqual(outcomes, ['retry', 'retry', 'retry', 'retry', 'dead'], \`five UNAVAILABLE attempts returned \${JSON.stringify(outcomes)}: the fifth must bury the job (MAX_ATTEMPTS = 5), which needs a count that grows on every attempt\`);
  const sent = ctx.grpc.callsTo('Execute').map(c => Number(c.request.attempt));
  assert.deepEqual(sent, [1, 2, 3, 4, 5], \`the Execute calls carried attempts \${JSON.stringify(sent)}, expected 1 to 5\`);
  const job = await store.getJob('job-1');
  assert(job.attempts === 5 && job.dead_reason === 'max_attempts_exceeded', \`the job is \${JSON.stringify(job)}, expected 5 attempts and dead_reason max_attempts_exceeded\`);
  assert.equal((await store.attemptHistory('job-1')).length, 5, 'the history must hold five attempts');
  await claimed(queue, store, 'job-2');
  assert.equal(await m.runAttempt('job-2', 'w-1'), 'completed');
  assert.deepEqual(counted, [1], \`when Execute arrived the job record held attempts \${JSON.stringify(counted)}: count the attempt before the call, or a worker that dies mid-call gives the job a free attempt\`);
}

export async function check_backoff(ctx) {
  const {m, queue, store} = await setup(ctx);
  ctx.grpc.fail('Execute', ctx.grpc.status.UNAVAILABLE, 'executor restarting', 3);
  for (const [attempt, delay] of [[1, 1000], [2, 2000], [3, 4000]]) {
    const now = Date.now();
    const outcome = await m.runAttempt('job-1', 'w-1');
    assert.equal(outcome, 'retry', \`attempt \${attempt} returned \${outcome}\`);
    const due = Number(ctx.redis.zscore('jobs:inflight', 'job-1'));
    assert.equal(due, now + delay, \`after attempt \${attempt} the retry is due \${due - now} ms from now, expected \${delay} ms (BACKOFF_BASE_MS doubled per attempt): a retry at once hits an executor that is still down\`);
    assert.equal((await store.getJob('job-1')).next_retry_at_ms, now + delay, 'next_retry_at_ms must be the retry time');
    await reclaim(ctx, queue, delay / 1000);
  }
}

export async function check_call_deadline(ctx) {
  const {m} = await setup(ctx);
  ctx.grpc.setLatency('Execute', 120.0);
  const outcome = await m.runAttempt('job-1', 'w-1');
  const calls = ctx.grpc.callsTo('Execute');
  assert(calls.length > 0, 'no Execute call was made');
  assert(calls[0].timeout !== null, 'the Execute call carries no deadline: an executor that hangs holds the worker past the 60 s visibility timeout, and the reaper hands the job to a second worker');
  assert(calls[0].timeout <= 30.5, \`the Execute call carries a \${calls[0].timeout} s deadline, expected EXECUTE_TIMEOUT_S = 30, under the 60 s visibility timeout\`);
  assert.equal(outcome, 'retry', \`a call that hit its deadline returned \${outcome}: DEADLINE_EXCEEDED is retryable\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"time"

	"google.golang.org/grpc/codes"

	pb "jobs/gen/job_queue"
	"jobs/queue"
	"jobs/store"

	"leetbuild/harness"
)

var (
	clientBg      = context.Background()
	clientInvoice = map[string]any{"invoice_id": "inv-7", "amount_cents": 1200}
)

// runnerPeer runs every job; counted notes the attempts the job record held when each call arrived.
type runnerPeer struct {
	pb.UnimplementedJobRunnerServer
	counted []int
}

func (p *runnerPeer) Execute(_ context.Context, req *pb.ExecuteRequest) (*pb.ExecuteReply, error) {
	p.counted = append(p.counted, store.GetJob(clientBg, req.GetJobId()).Attempts)
	return &pb.ExecuteReply{Result: "ok"}, nil
}

func clientClaimed(ctx *harness.Ctx, jobID string) {
	ctx.NoError(store.CreateJob(clientBg, jobID, "t-1", "invoice.charge", clientInvoice), "CreateJob")
	got, err := queue.Claim(clientBg, "w-1")
	ctx.NoError(err, "Claim")
	ctx.Equal(got, jobID, "the harness's claim")
}

func clientSetup(ctx *harness.Ctx) *runnerPeer {
	peer := &runnerPeer{}
	pb.RegisterJobRunnerServer(ctx.GRPC.Server(""), peer)
	clientClaimed(ctx, "job-1")
	return peer
}

func clientRun(ctx *harness.Ctx, jobID string) string {
	outcome, err := runAttempt(clientBg, jobID, "w-1")
	ctx.NoError(err, "runAttempt(%s)", jobID)
	return outcome
}

func clientReclaim(ctx *harness.Ctx, seconds float64) {
	ctx.Clock.Advance(seconds)
	queue.ReturnExpired(clientBg)
	got, _ := queue.Claim(clientBg, "w-1")
	ctx.Equal(got, "job-1", "the retried job must be claimable once its retry is due; the claim")
}

func CheckExecuteCall(ctx *harness.Ctx) {
	clientSetup(ctx)
	ctx.Equal(clientRun(ctx, "job-1"), "completed", "with a healthy executor the attempt")
	calls := ctx.GRPC.CallsTo("Execute", "")
	ctx.Equal(len(calls), 1, "one attempt's Execute calls")
	req := calls[0].Request.(*pb.ExecuteRequest)
	ctx.Assert(req.GetJobId() == "job-1" && req.GetJobType() == "invoice.charge" && req.GetAttempt() == 1, "the Execute request is %v", req)
	var payload map[string]any
	json.Unmarshal([]byte(req.GetPayload()), &payload)
	ctx.Assert(payload["invoice_id"] == "inv-7" && payload["amount_cents"] == float64(1200), "the request carries payload %s", req.GetPayload())
	ctx.Equal(store.GetJob(clientBg, "job-1").State, "completed", "the job's state after a successful attempt")
	_, inflight := ctx.Redis.ZScore("jobs:inflight", "job-1")
	ctx.Assert(!inflight, "a completed job must leave jobs:inflight")
	history := store.AttemptHistory(clientBg, "job-1")
	ctx.Assert(len(history) == 1 && history[0].Error == "", "the history must hold one successful attempt, got %+v", history)
}

func CheckRetryClasses(ctx *harness.Ctx) {
	clientSetup(ctx)
	ctx.GRPC.Fail("Execute", codes.InvalidArgument, "template welcome-v9 does not exist", 1, "")
	outcome := clientRun(ctx, "job-1")
	ctx.Assert(outcome == "dead", "INVALID_ARGUMENT returned %q: a job the executor rejects as written fails the same way on every retry, so bury it on the first attempt", outcome)
	job := store.GetJob(clientBg, "job-1")
	ctx.Assert(job.State == "dead" && job.DeadReason == "permanent_error", "the buried job is %+v, expected dead with dead_reason permanent_error", job)
	ctx.Equal(ctx.Redis.LRange("jobs:dead", 0, -1), []string{"job-1"}, "jobs:dead")
	clientClaimed(ctx, "job-2")
	ctx.GRPC.Fail("Execute", codes.Unavailable, "executor restarting", 1, "")
	outcome = clientRun(ctx, "job-2")
	second := store.GetJob(clientBg, "job-2")
	ctx.Assert(outcome == "retry" && second.State == "retrying", "UNAVAILABLE returned %q with the job %+v: an executor that is down may be up later, so schedule a retry", outcome, second)
}

func CheckAttemptsDurable(ctx *harness.Ctx) {
	peer := clientSetup(ctx)
	ctx.GRPC.Fail("Execute", codes.Unavailable, "executor restarting", 5, "")
	outcomes := []string{}
	for {
		outcomes = append(outcomes, clientRun(ctx, "job-1"))
		if outcomes[len(outcomes)-1] != "retry" || len(outcomes) == 6 {
			break
		}
		clientReclaim(ctx, 60)
	}
	ctx.Equal(outcomes, []string{"retry", "retry", "retry", "retry", "dead"}, "five UNAVAILABLE attempts: the fifth must bury the job (maxAttempts = 5), which needs a count that grows on every attempt; the outcomes")
	sent := []int32{}
	for _, c := range ctx.GRPC.CallsTo("Execute", "") {
		sent = append(sent, c.Request.(*pb.ExecuteRequest).GetAttempt())
	}
	ctx.Equal(sent, []int32{1, 2, 3, 4, 5}, "the attempts the Execute calls carried")
	job := store.GetJob(clientBg, "job-1")
	ctx.Assert(job.Attempts == 5 && job.DeadReason == "max_attempts_exceeded", "the job is %+v, expected 5 attempts and dead_reason max_attempts_exceeded", job)
	ctx.Equal(len(store.AttemptHistory(clientBg, "job-1")), 5, "the attempts in the history")
	clientClaimed(ctx, "job-2")
	ctx.Equal(clientRun(ctx, "job-2"), "completed", "a healthy attempt")
	ctx.Equal(peer.counted, []int{1}, "when Execute arrived the job record must already count the attempt (counted after the call, a worker that dies mid-call gives the job a free attempt); the counts seen")
}

func CheckBackoff(ctx *harness.Ctx) {
	clientSetup(ctx)
	ctx.GRPC.Fail("Execute", codes.Unavailable, "executor restarting", 3, "")
	for i, delay := range []int64{1000, 2000, 4000} {
		now := ctx.Clock.Now()
		ctx.Equal(clientRun(ctx, "job-1"), "retry", "attempt %d", i+1)
		due, _ := ctx.Redis.ZScore("jobs:inflight", "job-1")
		ctx.Assert(int64(due) == now+delay, "after attempt %d the retry is due %d ms from now, expected %d ms (backoffBaseMs doubled per attempt): a retry at once hits an executor that is still down", i+1, int64(due)-now, delay)
		ctx.Equal(store.GetJob(clientBg, "job-1").NextRetryAtMs, now+delay, "next_retry_at_ms")
		clientReclaim(ctx, float64(delay)/1000)
	}
}

func CheckCallDeadline(ctx *harness.Ctx) {
	clientSetup(ctx)
	ctx.GRPC.SetLatency("Execute", 120.0, "")
	outcome := clientRun(ctx, "job-1")
	calls := ctx.GRPC.CallsTo("Execute", "")
	ctx.Assert(len(calls) > 0, "no Execute call was made")
	ctx.Assert(calls[0].HasDeadline(), "the Execute call carries no deadline: an executor that hangs holds the worker past the 60 s visibility timeout, and the reaper hands the job to a second worker")
	ctx.Assert(calls[0].Timeout <= 30500*time.Millisecond, "the Execute call carries a %v deadline, expected executeTimeout = 30 s, under the 60 s visibility timeout", calls[0].Timeout)
	ctx.Equal(outcome, "retry", "a call that hit its deadline (DEADLINE_EXCEEDED is retryable); the outcome")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "job_queue.grpc.pb.h"
#include "jobs/queue.h"
#include "jobs/store.h"

namespace {

// Runs every job; counted notes the attempts the job record held when each call arrived.
class RunnerPeer final : public jobqueue::JobRunner::Service {
 public:
  std::vector<long> counted;
  grpc::Status Execute(grpc::ServerContext*, const jobqueue::ExecuteRequest* req, jobqueue::ExecuteReply* out) override {
    counted.push_back(store::getJob(req->job_id())->attempts);
    out->set_result("ok");
    return grpc::Status::OK;
  }
};

void clientClaimed(harness::Ctx& ctx, const std::string& job_id) {
  store::createJob(job_id, "t-1", "invoice.charge", nlohmann::json{{"invoice_id", "inv-7"}, {"amount_cents", 1200}});
  ctx.Equal(queue::claim("w-1").value_or(""), job_id, "the harness's claim");
}

RunnerPeer& clientSetup(harness::Ctx& ctx) {
  static RunnerPeer* peer = nullptr;
  delete peer;
  peer = new RunnerPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  clientClaimed(ctx, "job-1");
  return *peer;
}

void clientReclaim(harness::Ctx& ctx, double seconds) {
  ctx.Clock.Advance(seconds);
  queue::returnExpired();
  ctx.Equal(queue::claim("w-1").value_or(""), "job-1", "the retried job must be claimable once its retry is due; the claim");
}

}  // namespace

void CheckExecuteCall(harness::Ctx& ctx) {
  clientSetup(ctx);
  ctx.Equal(runAttempt("job-1", "w-1"), "completed", "with a healthy executor the attempt");
  const auto calls = ctx.GRPC.CallsTo("Execute");
  ctx.Equal(calls.size(), 1, "one attempt's Execute calls");
  const auto req = calls[0].Request<jobqueue::ExecuteRequest>();
  ctx.Assert(req.job_id() == "job-1" && req.job_type() == "invoice.charge" && req.attempt() == 1, "the Execute request is %s %s attempt %d", req.job_id(), req.job_type(), req.attempt());
  const auto payload = nlohmann::json::parse(req.payload(), nullptr, false);
  ctx.Assert(payload == nlohmann::json{{"invoice_id", "inv-7"}, {"amount_cents", 1200}}, "the request carries payload %s", req.payload());
  ctx.Equal(store::getJob("job-1")->state, "completed", "the job's state after a successful attempt");
  ctx.Assert(!ctx.Redis.ZScore("jobs:inflight", "job-1"), "a completed job must leave jobs:inflight");
  const auto history = store::attemptHistory("job-1");
  ctx.Assert(history.size() == 1 && history[0].error.empty(), "the history must hold one successful attempt, got %d entries", history.size());
}

void CheckRetryClasses(harness::Ctx& ctx) {
  clientSetup(ctx);
  ctx.GRPC.Fail("Execute", grpc::StatusCode::INVALID_ARGUMENT, "template welcome-v9 does not exist", 1);
  std::string outcome = runAttempt("job-1", "w-1");
  ctx.Assert(outcome == "dead", "INVALID_ARGUMENT returned %q: a job the executor rejects as written fails the same way on every retry, so bury it on the first attempt", outcome);
  const auto job = store::getJob("job-1");
  ctx.Assert(job->state == "dead" && job->dead_reason == "permanent_error", "the buried job is %s with dead_reason %q, expected dead with permanent_error", job->state, job->dead_reason);
  ctx.Equal(ctx.Redis.LRange("jobs:dead", 0, -1), std::vector<std::string>{"job-1"}, "jobs:dead");
  clientClaimed(ctx, "job-2");
  ctx.GRPC.Fail("Execute", grpc::StatusCode::UNAVAILABLE, "executor restarting", 1);
  outcome = runAttempt("job-2", "w-1");
  const auto second = store::getJob("job-2");
  ctx.Assert(outcome == "retry" && second->state == "retrying", "UNAVAILABLE returned %q with the job %s: an executor that is down may be up later, so schedule a retry", outcome, second->state);
}

void CheckAttemptsDurable(harness::Ctx& ctx) {
  RunnerPeer& peer = clientSetup(ctx);
  ctx.GRPC.Fail("Execute", grpc::StatusCode::UNAVAILABLE, "executor restarting", 5);
  std::vector<std::string> outcomes;
  for (;;) {
    outcomes.push_back(runAttempt("job-1", "w-1"));
    if (outcomes.back() != "retry" || outcomes.size() == 6) break;
    clientReclaim(ctx, 60);
  }
  ctx.Equal(outcomes, std::vector<std::string>{"retry", "retry", "retry", "retry", "dead"},
            "five UNAVAILABLE attempts: the fifth must bury the job (kMaxAttempts = 5), which needs a count that grows on every attempt; the outcomes");
  std::vector<int> sent;
  for (const auto& c : ctx.GRPC.CallsTo("Execute")) sent.push_back(c.Request<jobqueue::ExecuteRequest>().attempt());
  ctx.Equal(sent, std::vector<int>{1, 2, 3, 4, 5}, "the attempts the Execute calls carried");
  const auto job = store::getJob("job-1");
  ctx.Assert(job->attempts == 5 && job->dead_reason == "max_attempts_exceeded", "the job has %d attempts and dead_reason %q, expected 5 and max_attempts_exceeded", job->attempts, job->dead_reason);
  ctx.Equal(store::attemptHistory("job-1").size(), 5, "the attempts in the history");
  clientClaimed(ctx, "job-2");
  ctx.Equal(runAttempt("job-2", "w-1"), "completed", "a healthy attempt");
  ctx.Equal(peer.counted, std::vector<long>{1}, "when Execute arrived the job record must already count the attempt (counted after the call, a worker that dies mid-call gives the job a free attempt); the counts seen");
}

void CheckBackoff(harness::Ctx& ctx) {
  clientSetup(ctx);
  ctx.GRPC.Fail("Execute", grpc::StatusCode::UNAVAILABLE, "executor restarting", 3);
  int attempt = 0;
  for (const long long delay : {1000LL, 2000LL, 4000LL}) {
    attempt++;
    const long long now = ctx.Clock.Now();
    ctx.Equal(runAttempt("job-1", "w-1"), "retry", "attempt %d", attempt);
    const long long due = static_cast<long long>(ctx.Redis.ZScore("jobs:inflight", "job-1").value_or(0));
    ctx.Assert(due == now + delay, "after attempt %d the retry is due %d ms from now, expected %d ms (kBackoffBaseMs doubled per attempt): a retry at once hits an executor that is still down", attempt, due - now, delay);
    ctx.Equal(store::getJob("job-1")->next_retry_at_ms, now + delay, "next_retry_at_ms");
    clientReclaim(ctx, static_cast<double>(delay) / 1000);
  }
}

void CheckCallDeadline(harness::Ctx& ctx) {
  clientSetup(ctx);
  ctx.GRPC.SetLatency("Execute", 120.0);
  const std::string outcome = runAttempt("job-1", "w-1");
  const auto calls = ctx.GRPC.CallsTo("Execute");
  ctx.Assert(!calls.empty(), "no Execute call was made");
  ctx.Assert(calls[0].HasDeadline(), "the Execute call carries no deadline: an executor that hangs holds the worker past the 60 s visibility timeout, and the reaper hands the job to a second worker");
  ctx.Assert(calls[0].TimeoutSeconds() <= 30.5, "the Execute call carries a %v s deadline, expected kExecuteTimeout = 30 s, under the 60 s visibility timeout", calls[0].TimeoutSeconds());
  ctx.Equal(outcome, "retry", "a call that hit its deadline (DEADLINE_EXCEEDED is retryable); the outcome");
}
`,
  },
  hints: [
    'Send a job whose template does not exist: the executor says INVALID_ARGUMENT and the job is retried anyway. Fail the executor five times: the job is never buried, and every retry is due at once.',
    'The attempt number is `attempts + 1`, but `attempts` only grows after a call that succeeded, so a failing job is attempt 1 forever. Every error takes the retry path, the retry time is now, and the call has no deadline.',
    'Call `attempt = store.begin_attempt(job_id)` before `Execute`, pass `timeout=EXECUTE_TIMEOUT_S`, bury with `permanent_error` when `exc.code()` is not in `RETRYABLE`, and retry at `now + BACKOFF_BASE_MS * 2 ** (attempt - 1)`.',
  ],
  debrief: `The status code is the executor telling the worker whether time can help: an executor that is down or overloaded may answer later, a payload it rejects will be rejected again, so only the first kind earns a retry and the second goes to the dead letter while someone can still fix it. The count lives on the job record and grows before the call because the attempt that kills a worker is exactly the one a local counter forgets. The deadline sits under the visibility timeout so the worker gives up before the reaper hands the job to someone else. Production workers add jitter to the backoff so a thousand jobs failed by one outage do not retry in the same second.`,
};
