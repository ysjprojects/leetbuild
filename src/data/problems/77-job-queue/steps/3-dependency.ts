import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Worker calls with retry classification and a poison limit',
  concept: 'grpc',
  file: 'client',
  focus: ['worker', 'effect', 'dlq', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the worker's execution path:
it calls the executor over gRPC, retries the failure and eventually dead-letters the job. It
compiles, it serves the demo, and it hides every flaw that decides whether a poison pill ever dies.
Review it like the on-call engineer for the queue, fix it, and prove the fix with the checks below.

Implement the execution half of \`jobqd\`: one claimed job is driven through the
\`jobrunner.JobRunner\` \`Execute\` RPC until it succeeds, is dead-lettered, or has spent its
attempts.

- Only the **retryable** statuses earn another attempt: \`UNAVAILABLE\`, \`DEADLINE_EXCEEDED\`,
  \`RESOURCE_EXHAUSTED\` and \`ABORTED\`. A permanent status — \`INVALID_ARGUMENT\`,
  \`FAILED_PRECONDITION\`, \`PERMISSION_DENIED\`, \`NOT_FOUND\` — is decided once and dead-lettered on
  the spot. The draft retries every error, so a payload the executor will reject forever is retried
  forever.
- Attempts are bounded by \`MAX_ATTEMPTS = 5\` and spaced by exponential backoff:
  \`BACKOFF_BASE_MS = 1000\` doubling per attempt, capped at \`BACKOFF_CAP_MS = 30000\`, with the
  moment the next attempt is due written to \`next_retry_at\`.
- The attempt count is **durable**: every attempt is a row in \`job_attempts\`, written **before**
  the call, and the count is read back from the store when the worker picks the job up — a restart
  resumes from the stored count, never from zero.
- The call carries the claim's visibility timeout as its deadline (\`VISIBILITY_TIMEOUT_S = 60\`): a
  call that outlives its claim can be re-claimed by another worker while it is still running.
- When the attempts are spent, the job moves to \`job_dead_letter\` with a \`reason\` and **every**
  attempt's error, not just the last one. The draft buries the job with a single string and loses the
  history an operator needs to fix the payload.

**Failure mode the checks target.** The draft looks right because the demo's executor fails once and
then succeeds. Two flaws hide underneath. Retrying a permanent error is an unbounded loop against an
executor that has already rejected the payload: the worker slot never comes back, the job never
dead-letters, and nothing pages anyone. Counting attempts in a local variable is the second: every
worker restart resets the count to zero, so the fifth attempt is never reached and a poison pill
lives exactly as long as the worker fleet keeps restarting. The dead-letter write without the
history is the quiet one — one error string instead of the attempts that led to it is precisely the
evidence missing when somebody has to fix the payload.`,
  sequence: {
    participants: ['Worker pool', 'Executor service', 'Job store', 'Dead-letter'],
    messages: [
      {
        from: 'Worker pool',
        to: 'Executor service',
        label: 'JobRunner.Execute · deadline = the claim’s visibility timeout',
        kind: 'sync',
      },
      {from: 'Executor service', to: 'Worker pool', label: 'ABORTED · retryable', kind: 'reply'},
      {
        from: 'Worker pool',
        to: 'Job store',
        label: 'begin_attempt → job_attempts, then finish_attempt(attempt, error, next_retry_at)',
        kind: 'async',
      },
      {
        from: 'Worker pool',
        to: 'Executor service',
        label: 'retry after 1 s, 2 s, 4 s … capped at 30 s',
        kind: 'sync',
      },
      {from: 'Executor service', to: 'Worker pool', label: 'INVALID_ARGUMENT · permanent', kind: 'reply'},
      {
        from: 'Worker pool',
        to: 'Job store',
        label: 'attempts(job_id) on resume — the stored count, never zero',
        kind: 'sync',
      },
      {
        from: 'Worker pool',
        to: 'Dead-letter',
        label: 'move(job_id, reason, every attempt’s error)',
        kind: 'async',
      },
      {from: 'Job store', to: 'Worker pool', label: 'attempt rows · errors so far', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'execute-call',
      title: 'Drives the claimed job through JobRunner.Execute',
      detail:
        'The worker client dials `jobrunner.JobRunner` and issues `Execute` for the claimed job — the one part of the shape the draft gets right. The deadline, the retry classification and the durable attempt count are what the rest of the checks review.',
      match: {
        python: {all: [/JobRunner/, /\.Execute\(/]},
        typescript: {all: [/JobRunner/, /\.Execute\(/]},
        go: {all: [/JobRunner/, /\.Execute\(/]},
        scala: {all: [/JobRunner/, /\.execute\(/]},
        cpp: {all: [/JobRunner/, /->Execute\(/]},
      },
    },
    {
      id: 'retryable-statuses',
      title: 'Retries only the retryable statuses; permanent errors bury on the spot',
      detail:
        'A retryable set separates `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `RESOURCE_EXHAUSTED` and `ABORTED` from the permanent codes `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `PERMISSION_DENIED`, `NOT_FOUND`, and a permanent status dead-letters on the first attempt. The draft catches every error the same way and retries it, so a payload the executor rejects forever is retried forever.',
      match: {
        python: {
          all: [
            /RETRYABLE_STATUSES\s*=/,
            /StatusCode\.UNAVAILABLE/,
            /StatusCode\.DEADLINE_EXCEEDED/,
            /StatusCode\.RESOURCE_EXHAUSTED/,
            /StatusCode\.ABORTED/,
            /PERMANENT_STATUSES\s*=/,
            /StatusCode\.INVALID_ARGUMENT/,
          ],
        },
        typescript: {
          all: [
            /const RETRYABLE_STATUSES\b/,
            /status\.UNAVAILABLE/,
            /status\.DEADLINE_EXCEEDED/,
            /status\.RESOURCE_EXHAUSTED/,
            /status\.ABORTED/,
            /const PERMANENT_STATUSES\b/,
            /status\.INVALID_ARGUMENT/,
          ],
        },
        go: {
          all: [
            /retryableStatuses\s*=/,
            /codes\.Unavailable/,
            /codes\.DeadlineExceeded/,
            /codes\.ResourceExhausted/,
            /codes\.Aborted/,
            /permanentStatuses\s*=/,
            /codes\.InvalidArgument/,
          ],
        },
        scala: {
          all: [
            /RetryableStatuses\s*=/,
            /Status\.Code\.UNAVAILABLE/,
            /Status\.Code\.DEADLINE_EXCEEDED/,
            /Status\.Code\.RESOURCE_EXHAUSTED/,
            /Status\.Code\.ABORTED/,
            /PermanentStatuses\s*=/,
            /Status\.Code\.INVALID_ARGUMENT/,
          ],
        },
        cpp: {
          all: [
            /kRetryableStatuses\s*=/,
            /grpc::StatusCode::UNAVAILABLE/,
            /grpc::StatusCode::DEADLINE_EXCEEDED/,
            /grpc::StatusCode::RESOURCE_EXHAUSTED/,
            /grpc::StatusCode::ABORTED/,
            /kPermanentStatuses\s*=/,
            /grpc::StatusCode::INVALID_ARGUMENT/,
          ],
        },
      },
    },
    {
      id: 'backoff-schedule',
      title: 'Backs off exponentially from 1 s to a 30 s cap, recorded as next_retry_at',
      detail:
        'The delay is `BACKOFF_BASE_MS = 1000` doubling per attempt and capped at `BACKOFF_CAP_MS = 30000`, and the moment the next attempt is due is written to `next_retry_at` so the schedule survives the crash too. The draft re-calls immediately and records no retry time.',
      match: {
        python: {
          all: [
            /BACKOFF_BASE_MS\s*=\s*1000/,
            /BACKOFF_CAP_MS\s*=\s*30000/,
            /2\s*\*\*\s*\(attempt\s*-\s*1\)/,
            /next_retry_at/,
          ],
        },
        typescript: {
          all: [
            /BACKOFF_BASE_MS\s*=\s*1000/,
            /BACKOFF_CAP_MS\s*=\s*30000/,
            /2\s*\*\*\s*\(attempt\s*-\s*1\)/,
            /nextRetryAt/,
          ],
        },
        go: {
          all: [/backoffBaseMs\s*=\s*1000/, /backoffCapMs\s*=\s*30000/, /1\s*<<\s*\(attempt\s*-\s*1\)/, /nextRetryAt/],
        },
        scala: {
          all: [/BackoffBaseMs\s*=\s*1000/, /BackoffCapMs\s*=\s*30000/, /1L\s*<<\s*\(attempt\s*-\s*1\)/, /nextRetryAt/],
        },
        cpp: {
          all: [
            /kBackoffBaseMs\s*=\s*1000/,
            /kBackoffCapMs\s*=\s*30000/,
            /1LL\s*<<\s*\(attempt\s*-\s*1\)/,
            /next_retry_at/,
          ],
        },
      },
    },
    {
      id: 'attempt-durable',
      title: 'The attempt row is written before the call; a restart resumes the count',
      detail:
        '`MAX_ATTEMPTS = 5` bounds the job, and each attempt is a row in `job_attempts` written before the call (`begin_attempt`) with the count read back from the store on entry (`attempts`). The draft keeps the count in a local variable and writes the row after the call, so a worker restart resets the count to zero and the fifth attempt is never reached.',
      match: {
        python: {
          all: [/MAX_ATTEMPTS\s*=\s*5/, /store\.begin_attempt\(/, /store\.attempts\(/],
          order: [/store\.begin_attempt\(/, /runner\.Execute\(/],
          none: [/while\s+True/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*5/, /store\.beginAttempt\(/, /store\.attempts\(/],
          order: [/store\.beginAttempt\(/, /runner\.Execute\(/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        go: {
          all: [/maxAttempts\s*=\s*5/, /store\.BeginAttempt\(/, /store\.Attempts\(/],
          order: [/store\.BeginAttempt\(/, /\.Execute\(/],
          none: [/for\s*\{/],
        },
        scala: {
          all: [/MaxAttempts\s*=\s*5/, /store\.beginAttempt\(/, /store\.attempts\(/],
          order: [/store\.beginAttempt\(/, /\.execute\(/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [/kMaxAttempts\s*=\s*5/, /store->beginAttempt\(/, /store->attempts\(/],
          order: [/store->beginAttempt\(/, /->Execute\(/],
          none: [/while\s*\(\s*true\s*\)/],
        },
      },
    },
    {
      id: 'dead-letter-history',
      title: 'Attempt 5 dead-letters with the reason and every attempt’s error',
      detail:
        'When the attempts are spent the job moves to `job_dead_letter` with `max_attempts_exceeded` and the history of every attempt’s error, not just the last one. The draft’s dead letter carries a single `last_error` string, so the attempts that led there are lost.',
      match: {
        python: {
          all: [/dlq\.move\(/, /history/, /max_attempts_exceeded/],
          order: [/history\.append\(/, /dlq\.move\(/],
          none: [/dlq\.move\([^)]*last_error/],
        },
        typescript: {
          all: [/dlq\.move\(/, /history/, /max_attempts_exceeded/],
          order: [/history\.push\(/, /dlq\.move\(/],
          none: [/dlq\.move\([^)]*lastError/],
        },
        go: {
          all: [/dlq\.Move\(/, /history/, /max_attempts_exceeded/],
          order: [/history\s*=\s*append\(history/, /dlq\.Move\(/],
          none: [/dlq\.Move\([^)]*lastErr/],
        },
        scala: {
          all: [/dlq\.move\(/, /history/, /max_attempts_exceeded/],
          order: [/history\s*\+=/, /dlq\.move\(/],
          none: [/dlq\.move\([^)]*lastError/],
        },
        cpp: {
          all: [/dlq->move\(/, /history/, /max_attempts_exceeded/],
          order: [/history\.push_back\(/, /dlq->move\(/],
          none: [/dlq->move\([^)]*last_error/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Run a claimed job over gRPC: a model-generated draft that retries every failure forever."""
import logging

import grpc

import jobrunner_pb2
import jobrunner_pb2_grpc

logger = logging.getLogger("jobqd")

channel = grpc.insecure_channel("workers:50051")
runner = jobrunner_pb2_grpc.JobRunnerStub(channel)


class JobStore:
    def append_attempt(self, job_id: str, attempt: int, error: str) -> None:
        """Append one row to job_attempts."""
        raise NotImplementedError


class DeadLetterQueue:
    def move(self, job_id: str, reason: str, last_error: str) -> None:
        """Move the job to job_dead_letter with the last error string."""
        raise NotImplementedError


store = JobStore()
dlq = DeadLetterQueue()


def execute_job(job: dict) -> str:
    # TODO: this draft retries every error in an unbounded loop, counts attempts in a local variable
    # so a worker restart forgets them, and dead-letters with only the last error string.
    attempts = 0
    last_error = ""
    while True:
        attempts += 1
        request = jobrunner_pb2.ExecuteRequest(job_id=job["job_id"], type=job["type"], payload=job["payload"])
        try:
            runner.Execute(request)
            return "completed"
        except grpc.RpcError as exc:
            last_error = f"{exc.code().name}: {exc.details()}"
            store.append_attempt(job["job_id"], attempts, last_error)
            logger.info("attempt failed job_id=%s attempts=%d", job["job_id"], attempts)
            if attempts >= 3:
                dlq.move(job["job_id"], "too_many_attempts", last_error)
                return "dead_lettered"
`,
      solution: `"""Run one claimed job over gRPC: retry only what is retryable, bury poison pills with their history."""
import logging
import time

import grpc

import jobrunner_pb2
import jobrunner_pb2_grpc

logger = logging.getLogger("jobqd")

VISIBILITY_TIMEOUT_S = 60
MAX_ATTEMPTS = 5
BACKOFF_BASE_MS = 1000
BACKOFF_CAP_MS = 30000

RETRYABLE_STATUSES = {
    grpc.StatusCode.UNAVAILABLE,
    grpc.StatusCode.DEADLINE_EXCEEDED,
    grpc.StatusCode.RESOURCE_EXHAUSTED,
    grpc.StatusCode.ABORTED,
}
PERMANENT_STATUSES = {
    grpc.StatusCode.INVALID_ARGUMENT,
    grpc.StatusCode.FAILED_PRECONDITION,
    grpc.StatusCode.PERMISSION_DENIED,
    grpc.StatusCode.NOT_FOUND,
}

channel = grpc.insecure_channel("workers:50051")
runner = jobrunner_pb2_grpc.JobRunnerStub(channel)


class JobStore:
    """job_attempts: one row per attempt, written before the call so a crash still counts it."""

    def begin_attempt(self, job_id: str, attempt: int) -> None:
        raise NotImplementedError

    def finish_attempt(self, job_id: str, attempt: int, error: str, next_retry_at: int | None) -> None:
        raise NotImplementedError

    def attempts(self, job_id: str) -> list[dict]:
        """The rows the store already holds: a restart resumes from this count, never from zero."""
        raise NotImplementedError


class DeadLetterQueue:
    """job_dead_letter: the job, a reason, and every attempt's error."""

    def move(self, job_id: str, reason: str, history: list[dict]) -> None:
        raise NotImplementedError


store = JobStore()
dlq = DeadLetterQueue()


def backoff_ms(attempt: int) -> int:
    """1 s, 2 s, 4 s … doubling per attempt, capped at 30 s."""
    return min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS)


def execute_job(job: dict) -> str:
    """Run one claimed job: only the retryable statuses earn another attempt."""
    job_id = job["job_id"]
    history = list(store.attempts(job_id))
    attempt = len(history)
    while attempt < MAX_ATTEMPTS:
        attempt += 1
        store.begin_attempt(job_id, attempt)
        request = jobrunner_pb2.ExecuteRequest(job_id=job_id, type=job["type"], payload=job["payload"])
        try:
            runner.Execute(request, timeout=VISIBILITY_TIMEOUT_S)
        except grpc.RpcError as exc:
            error = f"{exc.code().name}: {exc.details()}"
            history.append({"attempt": attempt, "error": error})
            if exc.code() in PERMANENT_STATUSES or exc.code() not in RETRYABLE_STATUSES:
                # A permanent error never earns another attempt: dead-letter it on the spot.
                store.finish_attempt(job_id, attempt, error, None)
                dlq.move(job_id, "permanent_error", history)
                logger.info("dead-lettered job_id=%s status=%s", job_id, exc.code().name)
                return "dead_lettered"
            last = attempt >= MAX_ATTEMPTS
            next_retry_at = None if last else int(time.time() * 1000) + backoff_ms(attempt)
            store.finish_attempt(job_id, attempt, error, next_retry_at)
            if last:
                dlq.move(job_id, "max_attempts_exceeded", history)
                logger.info("dead-lettered job_id=%s attempts=%d", job_id, attempt)
                return "dead_lettered"
            logger.info("retrying job_id=%s attempt=%d next_retry_at=%d", job_id, attempt, next_retry_at)
            time.sleep(backoff_ms(attempt) / 1000)
        else:
            store.finish_attempt(job_id, attempt, "", None)
            return "completed"
    dlq.move(job_id, "max_attempts_exceeded", history)
    return "dead_lettered"
`,
    },
    typescript: {
      starter: `/** Run a claimed job over gRPC: a model-generated draft that retries every failure forever. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const log = {info: (fields: Record<string, unknown>): void => console.log(JSON.stringify(fields))};

interface RunnerClient {
  Execute(
    request: {job_id: string; type: string; payload: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): void;
}

const {jobrunner} = grpc.loadPackageDefinition(protoLoader.loadSync('jobrunner.proto')) as unknown as {
  jobrunner: {JobRunner: new (target: string, credentials: grpc.ChannelCredentials) => RunnerClient};
};
const runner = new jobrunner.JobRunner('workers:50051', grpc.credentials.createInsecure());

class JobStore {
  appendAttempt(jobId: string, attempt: number, error: string): void {
    throw new Error('provided by the platform');
  }
}

class DeadLetterQueue {
  move(jobId: string, reason: string, lastError: string): void {
    throw new Error('provided by the platform');
  }
}

const store = new JobStore();
const dlq = new DeadLetterQueue();

export async function executeJob(job: {job_id: string; type: string; payload: string}): Promise<string> {
  // TODO: this draft retries every error in an unbounded loop, counts attempts in a local variable
  // so a worker restart forgets them, and dead-letters with only the last error string.
  let attempts = 0;
  let lastError = '';
  for (;;) {
    attempts += 1;
    try {
      const {promise, resolve, reject} = Promise.withResolvers<void>();
      runner.Execute(
        {job_id: job.job_id, type: job.type, payload: job.payload},
        new grpc.Metadata(),
        {},
        error => (error === null ? resolve() : reject(error)),
      );
      await promise;
      return 'completed';
    } catch (error) {
      lastError = (error as grpc.ServiceError).details;
      store.appendAttempt(job.job_id, attempts, lastError);
      log.info({job_id: job.job_id, attempts, error: lastError});
      if (attempts >= 3) {
        dlq.move(job.job_id, 'too_many_attempts', lastError);
        return 'dead_lettered';
      }
    }
  }
}
`,
      solution: `/** Run one claimed job over gRPC: retry only the retryable statuses, bury poison pills with history. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const log = {info: (fields: Record<string, unknown>): void => console.log(JSON.stringify(fields))};

export const VISIBILITY_TIMEOUT_S = 60;
export const MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 30000;

export const RETRYABLE_STATUSES: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
  [grpc.status.RESOURCE_EXHAUSTED]: true,
  [grpc.status.ABORTED]: true,
};
export const PERMANENT_STATUSES: Record<number, true> = {
  [grpc.status.INVALID_ARGUMENT]: true,
  [grpc.status.FAILED_PRECONDITION]: true,
  [grpc.status.PERMISSION_DENIED]: true,
  [grpc.status.NOT_FOUND]: true,
};

export interface AttemptRow {
  attempt: number;
  error: string;
}

interface RunnerClient {
  Execute(
    request: {job_id: string; type: string; payload: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): void;
}

const {jobrunner} = grpc.loadPackageDefinition(protoLoader.loadSync('jobrunner.proto')) as unknown as {
  jobrunner: {JobRunner: new (target: string, credentials: grpc.ChannelCredentials) => RunnerClient};
};
const runner = new jobrunner.JobRunner('workers:50051', grpc.credentials.createInsecure());

class JobStore {
  /** job_attempts: a row per attempt, written before the call so a crash still counts it. */
  beginAttempt(jobId: string, attempt: number): void {
    throw new Error('provided by the platform');
  }

  finishAttempt(jobId: string, attempt: number, error: string, nextRetryAt: number | null): void {
    throw new Error('provided by the platform');
  }

  /** The rows the store already holds: a restart resumes from this count, never from zero. */
  attempts(jobId: string): AttemptRow[] {
    throw new Error('provided by the platform');
  }
}

class DeadLetterQueue {
  move(jobId: string, reason: string, history: AttemptRow[]): void {
    throw new Error('provided by the platform');
  }
}

const store = new JobStore();
const dlq = new DeadLetterQueue();

export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
}

export async function executeJob(job: {job_id: string; type: string; payload: string}): Promise<string> {
  const jobId = job.job_id;
  const history: AttemptRow[] = [...store.attempts(jobId)];
  let attempt = history.length;
  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    store.beginAttempt(jobId, attempt);
    try {
      const {promise, resolve, reject} = Promise.withResolvers<void>();
      runner.Execute(
        {job_id: jobId, type: job.type, payload: job.payload},
        new grpc.Metadata(),
        {deadline: Date.now() + VISIBILITY_TIMEOUT_S * 1_000},
        error => (error === null ? resolve() : reject(error)),
      );
      await promise;
      store.finishAttempt(jobId, attempt, '', null);
      return 'completed';
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      const message = serviceError.code + ': ' + serviceError.details;
      history.push({attempt, error: message});
      if (PERMANENT_STATUSES[serviceError.code] === true || RETRYABLE_STATUSES[serviceError.code] !== true) {
        // A permanent error never earns another attempt: dead-letter it on the spot.
        store.finishAttempt(jobId, attempt, message, null);
        dlq.move(jobId, 'permanent_error', history);
        log.info({job_id: jobId, code: serviceError.code});
        return 'dead_lettered';
      }
      const last = attempt >= MAX_ATTEMPTS;
      const nextRetryAt = last ? null : Date.now() + backoffMs(attempt);
      store.finishAttempt(jobId, attempt, message, nextRetryAt);
      if (last) {
        dlq.move(jobId, 'max_attempts_exceeded', history);
        log.info({job_id: jobId, attempts: attempt});
        return 'dead_lettered';
      }
      log.info({job_id: jobId, attempt, next_retry_at: nextRetryAt});
      const {promise: retry, resolve: resume} = Promise.withResolvers<void>();
      setTimeout(resume, backoffMs(attempt));
      await retry;
    }
  }
  dlq.move(jobId, 'max_attempts_exceeded', history);
  return 'dead_lettered';
}
`,
    },
    go: {
      starter: `package client

import (
	"context"
	"log"

	jobrunnerpb "jobqd/jobrunnerpb"
)

type AttemptRow struct {
	Attempt int
	Error   string
}

type Job struct {
	ID      string
	Type    string
	Payload string
}

// JobStore and DeadLetterQueue are the platform's; this step only calls them.
type JobStore struct{}

func (s *JobStore) AppendAttempt(ctx context.Context, jobID string, attempt int, message string) error {
	return nil
}

type DeadLetterQueue struct{}

func (q *DeadLetterQueue) Move(ctx context.Context, jobID, reason, lastError string) error {
	return nil
}

var (
	store = &JobStore{}
	dlq   = &DeadLetterQueue{}
)

// ExecuteJob drives one claimed job through the executor.
func ExecuteJob(ctx context.Context, runner jobrunnerpb.JobRunnerClient, job Job) (string, error) {
	// TODO: this draft retries every error in an unbounded loop, counts attempts in a local variable
	// so a worker restart forgets them, and dead-letters with only the last error string.
	attempts := 0
	lastError := ""
	for {
		attempts++
		_, err := runner.Execute(ctx, &jobrunnerpb.ExecuteRequest{JobId: job.ID, Type: job.Type, Payload: job.Payload})
		if err == nil {
			return "completed", nil
		}
		lastError = err.Error()
		if err := store.AppendAttempt(ctx, job.ID, attempts, lastError); err != nil {
			return "", err
		}
		log.Printf("attempt failed job_id=%s attempts=%d", job.ID, attempts)
		if attempts >= 3 {
			if err := dlq.Move(ctx, job.ID, "too_many_attempts", lastError); err != nil {
				return "", err
			}
			return "dead_lettered", nil
		}
	}
}
`,
      solution: `package client

import (
	"context"
	"fmt"
	"log"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	jobrunnerpb "jobqd/jobrunnerpb"
)

const (
	visibilityTimeoutS = 60
	maxAttempts        = 5
	backoffBaseMs      = 1000
	backoffCapMs       = 30000
)

var retryableStatuses = map[codes.Code]bool{
	codes.Unavailable:       true,
	codes.DeadlineExceeded:  true,
	codes.ResourceExhausted: true,
	codes.Aborted:           true,
}

var permanentStatuses = map[codes.Code]bool{
	codes.InvalidArgument:    true,
	codes.FailedPrecondition: true,
	codes.PermissionDenied:   true,
	codes.NotFound:           true,
}

type AttemptRow struct {
	Attempt int
	Error   string
}

type Job struct {
	ID      string
	Type    string
	Payload string
}

// JobStore and DeadLetterQueue are the platform's; this step only calls them.
type JobStore struct{}

// BeginAttempt inserts the row before the call, so a crash mid-call still counts the attempt.
func (s *JobStore) BeginAttempt(ctx context.Context, jobID string, attempt int) error { return nil }

func (s *JobStore) FinishAttempt(ctx context.Context, jobID string, attempt int, message string, nextRetryAt int64) error {
	return nil
}

// Attempts returns what job_attempts already holds: a restart resumes here, never from zero.
func (s *JobStore) Attempts(ctx context.Context, jobID string) ([]AttemptRow, error) { return nil, nil }

type DeadLetterQueue struct{}

func (q *DeadLetterQueue) Move(ctx context.Context, jobID, reason string, history []AttemptRow) error {
	return nil
}

var (
	store = &JobStore{}
	dlq   = &DeadLetterQueue{}
)

// backoffMs doubles the delay from 1 s per attempt and stops at the 30 s cap.
func backoffMs(attempt int) time.Duration {
	delay := backoffBaseMs * (1 << (attempt - 1))
	if delay > backoffCapMs {
		delay = backoffCapMs
	}
	return time.Duration(delay) * time.Millisecond
}

// ExecuteJob runs one claimed job: only the retryable statuses earn another attempt.
func ExecuteJob(ctx context.Context, runner jobrunnerpb.JobRunnerClient, job Job) (string, error) {
	history, err := store.Attempts(ctx, job.ID)
	if err != nil {
		return "", err
	}
	attempt := len(history)
	for attempt < maxAttempts {
		attempt++
		if err := store.BeginAttempt(ctx, job.ID, attempt); err != nil {
			return "", err
		}
		callCtx, cancel := context.WithTimeout(ctx, visibilityTimeoutS*time.Second)
		_, err := runner.Execute(callCtx, &jobrunnerpb.ExecuteRequest{JobId: job.ID, Type: job.Type, Payload: job.Payload})
		cancel()
		if err == nil {
			if err := store.FinishAttempt(ctx, job.ID, attempt, "", 0); err != nil {
				return "", err
			}
			return "completed", nil
		}
		code := status.Code(err)
		message := fmt.Sprintf("%s: %v", code, err)
		history = append(history, AttemptRow{Attempt: attempt, Error: message})
		if permanentStatuses[code] || !retryableStatuses[code] {
			// A permanent error never earns another attempt: dead-letter it on the spot.
			if err := store.FinishAttempt(ctx, job.ID, attempt, message, 0); err != nil {
				return "", err
			}
			if err := dlq.Move(ctx, job.ID, "permanent_error", history); err != nil {
				return "", err
			}
			log.Printf("dead-lettered job_id=%s status=%s", job.ID, code)
			return "dead_lettered", nil
		}
		last := attempt >= maxAttempts
		var nextRetryAt int64
		if !last {
			nextRetryAt = time.Now().Add(backoffMs(attempt)).UnixMilli()
		}
		if err := store.FinishAttempt(ctx, job.ID, attempt, message, nextRetryAt); err != nil {
			return "", err
		}
		if last {
			if err := dlq.Move(ctx, job.ID, "max_attempts_exceeded", history); err != nil {
				return "", err
			}
			log.Printf("dead-lettered job_id=%s attempts=%d", job.ID, attempt)
			return "dead_lettered", nil
		}
		log.Printf("retrying job_id=%s attempt=%d next_retry_at=%d", job.ID, attempt, nextRetryAt)
		time.Sleep(backoffMs(attempt))
	}
	if err := dlq.Move(ctx, job.ID, "max_attempts_exceeded", history); err != nil {
		return "", err
	}
	return "dead_lettered", nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

object JobRunnerClient {
  final case class Job(job_id: String, kind: String, payload: String)

  val runner = JobRunnerGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("workers", 50051).usePlaintext().build()
  )

  // JobStore and DeadLetterQueue are the platform's; this step only calls them.
  class JobStore {
    def appendAttempt(jobId: String, attempt: Int, error: String): Unit = ???
  }

  class DeadLetterQueue {
    def move(jobId: String, reason: String, lastError: String): Unit = ???
  }

  val store = new JobStore
  val dlq = new DeadLetterQueue

  // TODO: this draft retries every error in an unbounded loop, counts attempts in a local variable
  // so a worker restart forgets them, and dead-letters with only the last error string.
  def executeJob(job: Job): String = {
    var attempts = 0
    var lastError = ""
    while (true) {
      attempts += 1
      val request = ExecuteRequest(job_id = job.job_id, kind = job.kind, payload = job.payload)
      try {
        runner.execute(request)
        return "completed"
      } catch {
        case exc: StatusRuntimeException =>
          lastError = exc.getStatus.getCode.toString
          store.appendAttempt(job.job_id, attempts, lastError)
          println("attempt failed job_id=" + job.job_id + " attempts=" + attempts)
          if (attempts >= 3) {
            dlq.move(job.job_id, "too_many_attempts", lastError)
            return "dead_lettered"
          }
      }
    }
    "dead_lettered"
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

object JobRunnerClient {
  val VisibilityTimeoutS = 60
  val MaxAttempts = 5
  val BackoffBaseMs = 1000L
  val BackoffCapMs = 30000L

  val RetryableStatuses = Set(
    Status.Code.UNAVAILABLE,
    Status.Code.DEADLINE_EXCEEDED,
    Status.Code.RESOURCE_EXHAUSTED,
    Status.Code.ABORTED,
  )
  val PermanentStatuses = Set(
    Status.Code.INVALID_ARGUMENT,
    Status.Code.FAILED_PRECONDITION,
    Status.Code.PERMISSION_DENIED,
    Status.Code.NOT_FOUND,
  )

  final case class Job(job_id: String, kind: String, payload: String)
  final case class AttemptRow(attempt: Int, error: String)

  val runner = JobRunnerGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("workers", 50051).usePlaintext().build()
  )

  // JobStore and DeadLetterQueue are the platform's; this step only calls them.
  class JobStore {
    /** job_attempts: the row goes in before the call, so a crash mid-call still counts it. */
    def beginAttempt(jobId: String, attempt: Int): Unit = ???

    def finishAttempt(jobId: String, attempt: Int, error: String, nextRetryAt: Option[Long]): Unit = ???

    /** What the store already holds: a restart resumes from this count, never from zero. */
    def attempts(jobId: String): Seq[AttemptRow] = ???
  }

  class DeadLetterQueue {
    def move(jobId: String, reason: String, history: Seq[AttemptRow]): Unit = ???
  }

  val store = new JobStore
  val dlq = new DeadLetterQueue

  /** 1 s, 2 s, 4 s … doubling per attempt, capped at 30 s. */
  def backoffMs(attempt: Int): Long =
    math.min(BackoffBaseMs * (1L << (attempt - 1)), BackoffCapMs)

  def executeJob(job: Job): String = {
    val history = scala.collection.mutable.ArrayBuffer.from(store.attempts(job.job_id))
    var attempt = history.length
    while (attempt < MaxAttempts) {
      attempt += 1
      store.beginAttempt(job.job_id, attempt)
      val request = ExecuteRequest(job_id = job.job_id, kind = job.kind, payload = job.payload)
      try {
        runner.withDeadlineAfter(VisibilityTimeoutS, TimeUnit.SECONDS).execute(request)
        store.finishAttempt(job.job_id, attempt, "", None)
        return "completed"
      } catch {
        case exc: StatusRuntimeException =>
          val message = exc.getStatus.getCode.toString + ": " + exc.getStatus.getDescription
          history += AttemptRow(attempt, message)
          if (PermanentStatuses.contains(exc.getStatus.getCode) || !RetryableStatuses.contains(exc.getStatus.getCode)) {
            // A permanent error never earns another attempt: dead-letter it on the spot.
            store.finishAttempt(job.job_id, attempt, message, None)
            dlq.move(job.job_id, "permanent_error", history.toSeq)
            return "dead_lettered"
          }
          val last = attempt >= MaxAttempts
          val nextRetryAt = if (last) None else Some(System.currentTimeMillis() + backoffMs(attempt))
          store.finishAttempt(job.job_id, attempt, message, nextRetryAt)
          if (last) {
            dlq.move(job.job_id, "max_attempts_exceeded", history.toSeq)
            return "dead_lettered"
          }
          Thread.sleep(backoffMs(attempt))
      }
    }
    dlq.move(job.job_id, "max_attempts_exceeded", history.toSeq)
    "dead_lettered"
  }
}
`,
    },
    cpp: {
      starter: `#include <string>

#include "jobrunner.grpc.pb.h"

struct Job {
  std::string job_id;
  std::string type;
  std::string payload;
};

// JobStore and DeadLetterQueue are the platform's; this step only calls them.
class JobStore {
 public:
  void appendAttempt(const std::string& job_id, int attempt, const std::string& error) {}
};

class DeadLetterQueue {
 public:
  void move(const std::string& job_id, const std::string& reason, const std::string& last_error) {}
};

// TODO: this draft retries every error in an unbounded loop, counts attempts in a local variable so
// a worker restart forgets them, and dead-letters with only the last error string.
std::string executeJob(jobrunner::JobRunner::Stub* runner, JobStore* store, DeadLetterQueue* dlq, const Job& job) {
  int attempts = 0;
  std::string last_error;
  while (true) {
    attempts += 1;
    grpc::ClientContext ctx;
    jobrunner::ExecuteRequest request;
    request.set_job_id(job.job_id);
    request.set_type(job.type);
    request.set_payload(job.payload);
    jobrunner::ExecuteResponse reply;
    const grpc::Status call = runner->Execute(&ctx, request, &reply);
    if (call.ok()) return "completed";
    last_error = call.error_message();
    store->appendAttempt(job.job_id, attempts, last_error);
    if (attempts >= 3) {
      dlq->move(job.job_id, "too_many_attempts", last_error);
      return "dead_lettered";
    }
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "jobrunner.grpc.pb.h"

#include <algorithm>
#include <chrono>
#include <iostream>
#include <optional>
#include <string>
#include <thread>
#include <vector>

constexpr int kVisibilityTimeoutS = 60;
constexpr int kMaxAttempts = 5;
constexpr long long kBackoffBaseMs = 1000;
constexpr long long kBackoffCapMs = 30000;

const std::vector<grpc::StatusCode> kRetryableStatuses = {
    grpc::StatusCode::UNAVAILABLE,
    grpc::StatusCode::DEADLINE_EXCEEDED,
    grpc::StatusCode::RESOURCE_EXHAUSTED,
    grpc::StatusCode::ABORTED,
};
const std::vector<grpc::StatusCode> kPermanentStatuses = {
    grpc::StatusCode::INVALID_ARGUMENT,
    grpc::StatusCode::FAILED_PRECONDITION,
    grpc::StatusCode::PERMISSION_DENIED,
    grpc::StatusCode::NOT_FOUND,
};

struct Job {
  std::string job_id;
  std::string type;
  std::string payload;
};

struct AttemptRow {
  int attempt = 0;
  std::string error;
};

// JobStore and DeadLetterQueue are the platform's; this step only calls them.
class JobStore {
 public:
  // job_attempts: the row goes in before the call, so a crash mid-call still counts it.
  void beginAttempt(const std::string& job_id, int attempt) {}

  void finishAttempt(const std::string& job_id, int attempt, const std::string& error,
                     const std::optional<long long>& next_retry_at) {}

  // What the store already holds: a restart resumes from this count, never from zero.
  std::vector<AttemptRow> attempts(const std::string& job_id) { return {}; }
};

class DeadLetterQueue {
 public:
  void move(const std::string& job_id, const std::string& reason, const std::vector<AttemptRow>& history) {}
};

bool contains(const std::vector<grpc::StatusCode>& codes, grpc::StatusCode code) {
  return std::find(codes.begin(), codes.end(), code) != codes.end();
}

// 1 s, 2 s, 4 s … doubling per attempt, capped at 30 s.
long long backoffMs(int attempt) {
  const long long delay = kBackoffBaseMs * (1LL << (attempt - 1));
  return std::min(delay, kBackoffCapMs);
}

std::string executeJob(jobrunner::JobRunner::Stub* runner, JobStore* store, DeadLetterQueue* dlq, const Job& job) {
  std::vector<AttemptRow> history = store->attempts(job.job_id);
  int attempt = static_cast<int>(history.size());
  while (attempt < kMaxAttempts) {
    attempt += 1;
    store->beginAttempt(job.job_id, attempt);
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kVisibilityTimeoutS));
    jobrunner::ExecuteRequest request;
    request.set_job_id(job.job_id);
    request.set_type(job.type);
    request.set_payload(job.payload);
    jobrunner::ExecuteResponse reply;
    const grpc::Status call = runner->Execute(&ctx, request, &reply);
    if (call.ok()) {
      store->finishAttempt(job.job_id, attempt, "", std::nullopt);
      return "completed";
    }
    const std::string message = call.error_message();
    history.push_back(AttemptRow{attempt, message});
    if (contains(kPermanentStatuses, call.error_code()) || !contains(kRetryableStatuses, call.error_code())) {
      // A permanent error never earns another attempt: dead-letter it on the spot.
      store->finishAttempt(job.job_id, attempt, message, std::nullopt);
      dlq->move(job.job_id, "permanent_error", history);
      std::cerr << "dead-lettered job_id=" << job.job_id << " code=" << call.error_code() << "\\n";
      return "dead_lettered";
    }
    const bool last = attempt >= kMaxAttempts;
    std::optional<long long> next_retry_at;
    if (!last) {
      const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::system_clock::now().time_since_epoch())
                           .count();
      next_retry_at = now + backoffMs(attempt);
    }
    store->finishAttempt(job.job_id, attempt, message, next_retry_at);
    if (last) {
      dlq->move(job.job_id, "max_attempts_exceeded", history);
      std::cerr << "dead-lettered job_id=" << job.job_id << " attempts=" << attempt << "\\n";
      return "dead_lettered";
    }
    std::cerr << "retrying job_id=" << job.job_id << " attempt=" << attempt << " next_retry_at="
              << next_retry_at.value_or(0) << "\\n";
    std::this_thread::sleep_for(std::chrono::milliseconds(backoffMs(attempt)));
  }
  dlq->move(job.job_id, "max_attempts_exceeded", history);
  return "dead_lettered";
}
`,
    },
  },
  hints: [
    'Retryability is a property of the status, not of “it threw”: classify with a `RETRYABLE_STATUSES` set (`exc.code()`, `err.code`, `status.Code(err)`, `exc.getStatus.getCode`, `call.error_code()`), and send anything permanent straight to the dead-letter queue. The draft’s handler treats every failure the same, so an `INVALID_ARGUMENT` on a malformed payload spins forever.',
    'The attempt count has to outlive the process: write the attempt row to `job_attempts` **before** the call and read the count back when the worker picks the job up, so `MAX_ATTEMPTS = 5` bounds the total across restarts instead of within one run. The draft’s local `attempts += 1` is back to zero after every deploy — that is the difference between a poison pill dying at five and living forever.',
    'Backoff is `BACKOFF_BASE_MS * 2 ** (attempt - 1)` capped at `BACKOFF_CAP_MS`, written as `next_retry_at` so the schedule survives a crash too, and the dead-letter record carries the whole history list — every attempt’s error — beside the `reason`. The draft re-calls immediately and passes one `last_error` string.',
  ],
  debrief: `The interviewer is asking one question under three names: which failures are worth another attempt, how many attempts is too many, and what does the next engineer inherit when the job finally dies. Classification is the first answer — a status set that separates \`UNAVAILABLE\` from \`INVALID_ARGUMENT\` — because retrying a permanent error turns one bad payload into an unbounded loop against an executor that has already decided, and no amount of waiting changes its mind. The durable attempt count is the second: the count lives in \`job_attempts\` and is written before the call, so a worker that restarts mid-attempt resumes at three instead of one and the poison pill actually reaches five. The dead-letter record is the third, and the one most teams skip: a job that moves to \`job_dead_letter\` carrying every attempt's error is a ticket somebody can act on; one carrying the last string alone is a shrug. The draft deserves to be believed because the demo's only failure is transient and the worker never restarts. Real workers add jitter to the backoff so a deploy does not synchronise the whole fleet into one retry storm, a heartbeat that extends the claim so an attempt can never outlive its visibility timeout, a replay path that re-runs dead letters with the side effect made idempotent, and an alert on the dead-letter rate — because a queue that buries jobs quietly is a queue that loses them quietly.`,
};
