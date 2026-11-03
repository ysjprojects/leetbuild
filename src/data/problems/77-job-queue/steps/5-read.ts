import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/jobs/{id}: state a support engineer can trust',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis', 'store', 'dlq'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/jobs/{id}\`: it reads the \`jobs\` row by id alone,
answers **404** when there is none, and otherwise echoes the row's type, state, attempt counter and
\`next_retry_at_ms\`. It compiles, answers correctly for a live job in a healthy demo, and hides four
flaws.

**Failure mode the checks target.** A job stranded in a crashed worker's claim is reported
\`queued\` forever, so nobody retries it. The dashboard shows a retry time that already passed. A
buried job has no reason and no history. And any authenticated caller reads any tenant's job by
guessing an id.

- The tenant comes from \`X-Tenant-Id\` (**401** when absent) and the job is resolved scoped to it:
  another tenant's job id and an unknown id both answer **404**, not **403**.
- \`state\` is reconciled against \`jobs:inflight\`: a job still in that set whose deadline (the
  member's score, in ms) is past is \`stalled\` with \`claim_age_ms\`, not the row's \`queued\`. A
  live claim keeps the queue's state from \`jobs:job:{job_id}\`.
- \`attempt_history\` is read from \`job_attempts\` as an ordered list (\`ORDER BY attempt_no\`),
  oldest first, with each attempt's error class, message and timings.
- \`next_retry_at\` is compared against the clock; a stored time already past is replaced by a
  recomputed backoff (\`BACKOFF_BASE_MS = 1000\` doubling per attempt, capped at
  \`BACKOFF_CAP_MS = 30000\`) plus \`retry_overdue: true\`. A job past \`MAX_ATTEMPTS\` gets
  \`next_retry_at: null\`.
- \`dead_letter_reason\` is surfaced from \`job_dead_letter\`; a live job answers \`null\`.
- Log the read with the job id, the tenant and the reconciled state.`,
  sequence: {
    participants: ['Client', 'Job API', 'Redis', 'job store', 'Dead-letter store'],
    messages: [
      {from: 'Client', to: 'Job API', label: 'GET /v1/jobs/{id} · X-Tenant-Id', kind: 'sync'},
      {
        from: 'Job API',
        to: 'job store',
        label: 'SELECT tenant, state, attempts, next_retry_at_ms FROM jobs WHERE id = $1',
        kind: 'sync',
      },
      {from: 'job store', to: 'Job API', label: 'job row / no row → 404, never 403', kind: 'reply'},
      {
        from: 'Job API',
        to: 'Redis',
        label: 'ZSCORE jobs:inflight {id} · HGETALL jobs:job:{id}',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Job API', label: 'claim deadline in ms · state · worker', kind: 'reply'},
      {
        from: 'Job API',
        to: 'job store',
        label: 'SELECT attempt_no, error_class FROM job_attempts WHERE job_id = $1 ORDER BY attempt_no',
        kind: 'sync',
      },
      {
        from: 'Job API',
        to: 'Dead-letter store',
        label: 'SELECT reason FROM job_dead_letter WHERE job_id = $1',
        kind: 'sync',
      },
      {
        from: 'Job API',
        to: 'Client',
        label: '200 {state: stalled, claim_age_ms, next_retry_at, retry_overdue, attempt_history, dead_letter_reason}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'status-route',
      title: 'Serves GET /v1/jobs/{id}',
      detail:
        'Register the status read on `GET /v1/jobs/{id}` with the job id taken from the path — the read side of the submission route.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/jobs\/\{job_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/jobs\/:jobId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/jobs\/\{jobID\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"jobs"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/jobs\//]},
      },
    },
    {
      id: 'stalled-inflight',
      title: 'A stranded in-flight claim reads as stalled with its claim age',
      detail:
        'The state is reconciled against `jobs:inflight` before it is reported: an entry whose score (the claim deadline in ms) is already past is `stalled` with `claim_age_ms`, never the row’s `queued`. The starter returns the stored state verbatim, so a job stranded in a crashed worker’s claim looks queued forever.',
      match: {
        python: {
          all: [/jobs:inflight/, /['"]stalled['"]/, /claim_age_ms/, /now_ms\(\)/],
          order: [/jobs:inflight/, /['"]stalled['"]/],
        },
        typescript: {
          all: [/jobs:inflight/, /['"]stalled['"]/, /claim_age_ms/, /nowMs\(\)/],
          order: [/jobs:inflight/, /['"]stalled['"]/],
        },
        go: {
          all: [/jobs:inflight/, /"stalled"/, /claim_age_ms/, /nowMS\(\)/],
          order: [/jobs:inflight/, /"stalled"/],
        },
        scala: {
          all: [/jobs:inflight/, /"stalled"/, /claim_age_ms/, /nowMs\(\)/],
          order: [/jobs:inflight/, /"stalled"/],
        },
        cpp: {
          all: [/jobs:inflight/, /"stalled"/, /claim_age_ms/, /nowMs\(\)/],
          order: [/jobs:inflight/, /"stalled"/],
        },
      },
    },
    {
      id: 'retry-overdue',
      title: 'next_retry_at is checked against the clock, or flagged retry_overdue',
      detail:
        'The stored retry time is compared with `now`: a time still ahead of the clock is reported as it is, a time in the past is replaced by a recomputed backoff (`BACKOFF_BASE_MS` doubling per attempt, capped at `BACKOFF_CAP_MS`) and flagged `retry_overdue: true`. The starter copies `next_retry_at` out of the row without ever looking at the clock, so the dashboard can show a retry that already passed.',
      match: {
        python: {
          all: [/BACKOFF_BASE_MS/, /BACKOFF_CAP_MS/, /next_retry_at/, /retry_overdue/, /backoff_ms\(/],
          order: [/now_ms\(\)/, /retry_overdue/],
        },
        typescript: {
          all: [/BACKOFF_BASE_MS/, /BACKOFF_CAP_MS/, /next_retry_at/, /retry_overdue/, /backoffMs\(/],
          order: [/nowMs\(\)/, /retry_overdue/],
        },
        go: {
          all: [/backoffBaseMS/, /backoffCapMS/, /next_retry_at/, /retry_overdue/, /backoffMS\(/],
          order: [/nowMS\(\)/, /retry_overdue/],
        },
        scala: {
          all: [/BackoffBaseMs/, /BackoffCapMs/, /next_retry_at/, /retry_overdue/, /backoffMs\(/],
          order: [/nowMs\(\)/, /retry_overdue/],
        },
        cpp: {
          all: [/kBackoffBaseMs/, /kBackoffCapMs/, /next_retry_at/, /retry_overdue/, /backoffMs\(/],
          order: [/nowMs\(\)/, /retry_overdue/],
        },
      },
    },
    {
      id: 'tenant-scoped-404',
      title: 'A foreign job id is 404, never 403 with existence',
      detail:
        'The tenant comes from `X-Tenant-Id` and the job is resolved scoped to it; a job belonging to another tenant answers **404** — the same answer the caller gets for an id that never existed — and never **403**, which would confirm that the job exists. The starter looks the job up by id alone, so a job id is treated as a capability.',
      match: {
        python: {
          all: [/X-Tenant-Id/, /row\["tenant"\]/, /\b404\b/],
          none: [/\b403\b/],
          order: [/row\["tenant"\]/, /\b404\b/],
        },
        typescript: {
          all: [/x-tenant-id/, /row\.tenant/, /code\(\s*404\s*\)/],
          none: [/code\(\s*403\s*\)/],
          order: [/row\.tenant/, /code\(\s*404\s*\)/],
        },
        go: {
          all: [/X-Tenant-Id/, /row\.Tenant != tenant/, /StatusNotFound/],
          none: [/StatusForbidden/],
          order: [/row\.Tenant != tenant/, /StatusNotFound/],
        },
        scala: {
          all: [/X-Tenant-Id/, /row\.tenant/, /StatusCodes\.NotFound/],
          none: [/StatusCodes\.Forbidden/],
          order: [/row\.tenant/, /StatusCodes\.NotFound/],
        },
        cpp: {
          all: [/X-Tenant-Id/, /\["tenant"\]/, /\b404\b/],
          none: [/\b403\b/],
          order: [/\["tenant"\]/, /\b404\b/],
        },
      },
    },
    {
      id: 'job-history',
      title: 'Attempt history and dead-letter reason come from the job’s own tables',
      detail:
        '`attempt_history` is read from `job_attempts` as an ordered list (`ORDER BY attempt_no`) and `dead_letter_reason` is surfaced from `job_dead_letter`. The starter answers with the row’s attempt counter and says nothing about why a buried job died, so the history the endpoint exists to show is missing.',
      match: {
        python: {
          all: [/job_attempts/, /ORDER BY attempt_no/, /attempt_history/, /job_dead_letter/, /dead_letter_reason/],
        },
        typescript: {
          all: [/job_attempts/, /ORDER BY attempt_no/, /attempt_history/, /job_dead_letter/, /dead_letter_reason/],
        },
        go: {
          all: [/job_attempts/, /ORDER BY attempt_no/, /attempt_history/, /job_dead_letter/, /dead_letter_reason/],
        },
        scala: {
          all: [/job_attempts/, /ORDER BY attempt_no/, /attempt_history/, /job_dead_letter/, /dead_letter_reason/],
        },
        cpp: {
          all: [/job_attempts/, /ORDER BY attempt_no/, /attempt_history/, /job_dead_letter/, /dead_letter_reason/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""GET /v1/jobs/{job_id}: flawed code that echoes the stored jobs row."""
import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("jobqd")


def job_row(job_id: str) -> dict | None:
    cur.execute(
        "SELECT type, state, attempts, next_retry_at_ms FROM jobs WHERE id = %s",
        (job_id,),
    )
    return cur.fetchone()


@app.get("/v1/jobs/{job_id}")
def read_job(job_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    row = job_row(job_id)
    if row is None:
        return JSONResponse({"error": "unknown job"}, status_code=404)
    logger.info("job read job_id=%s tenant=%s", job_id, tenant)
    return JSONResponse(
        {
            "job_id": job_id,
            "type": row["type"],
            "state": row["state"],
            "attempts": row["attempts"],
            "next_retry_at": row["next_retry_at_ms"],
        },
        status_code=200,
    )
`,
      solution: `"""GET /v1/jobs/{job_id}: the job's state reconciled against the queue's own sets."""
import logging
import time

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("jobqd")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

INFLIGHT_KEY = "jobs:inflight"
JOB_KEY = "jobs:job:{job_id}"
VISIBILITY_TIMEOUT_S = 60
MAX_ATTEMPTS = 5
BACKOFF_BASE_MS = 1000
BACKOFF_CAP_MS = 30000


def now_ms() -> int:
    return int(time.time() * 1000)


def backoff_ms(attempts: int) -> int:
    """The exponential backoff for an attempt count, capped at BACKOFF_CAP_MS."""
    return min(BACKOFF_BASE_MS * (2 ** max(attempts - 1, 0)), BACKOFF_CAP_MS)


def job_row(job_id: str) -> dict | None:
    """The jobs row: the record of what the platform wrote, tenant included."""
    cur.execute(
        "SELECT tenant, type, state, attempts, next_retry_at_ms FROM jobs WHERE id = %s",
        (job_id,),
    )
    return cur.fetchone()


def attempt_history(job_id: str) -> list[dict]:
    """Every attempt so far, oldest first: the history a support engineer reads."""
    cur.execute(
        "SELECT attempt_no, error_class, error_message, started_at_ms, finished_at_ms"
        " FROM job_attempts WHERE job_id = %s ORDER BY attempt_no",
        (job_id,),
    )
    return cur.fetchall()


def dead_letter_reason(job_id: str) -> str | None:
    """Why the job was buried, or None while it is still alive."""
    cur.execute("SELECT reason FROM job_dead_letter WHERE job_id = %s", (job_id,))
    row = cur.fetchone()
    return None if row is None else row["reason"]


def claim_age_ms(job_id: str, now: int) -> int | None:
    """The age of an expired claim: the job is in jobs:inflight with a deadline already past."""
    deadline = r.zscore(INFLIGHT_KEY, job_id)
    if deadline is None or deadline > now:
        return None
    return now - int(deadline)


def next_retry(attempts: int, stored_ms: int | None, now: int) -> tuple[int | None, bool]:
    """A retry time the caller can trust: the stored one while it is still ahead of the clock,
    otherwise a recomputed backoff plus retry_overdue, so support knows a retry is owed."""
    if stored_ms is not None and stored_ms > now:
        return stored_ms, False
    if attempts >= MAX_ATTEMPTS:
        return None, True
    return now + backoff_ms(attempts), True


@app.get("/v1/jobs/{job_id}")
def read_job(job_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    row = job_row(job_id)
    # 404, not 403: a foreign job must be indistinguishable from one that never existed.
    if row is None or row["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="unknown job")

    now = now_ms()
    queue_state = r.hgetall(JOB_KEY.format(job_id=job_id))
    stranded_for = claim_age_ms(job_id, now)
    state = "stalled" if stranded_for is not None else queue_state.get("state", row["state"])
    retry_at, overdue = next_retry(row["attempts"], row["next_retry_at_ms"], now)
    logger.info("job read job_id=%s tenant=%s state=%s", job_id, tenant, state)
    return JSONResponse(
        {
            "job_id": job_id,
            "type": row["type"],
            "state": state,
            "attempts": row["attempts"],
            "worker": queue_state.get("worker"),
            "claim_age_ms": stranded_for,
            "next_retry_at": retry_at,
            "retry_overdue": overdue,
            "attempt_history": attempt_history(job_id),
            "dead_letter_reason": dead_letter_reason(job_id),
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/jobs/:jobId: flawed code that echoes the stored jobs row. */
import Fastify from 'fastify';

export const app = Fastify();

interface JobRow {
  type: string;
  state: string;
  attempts: number;
  next_retry_at_ms: number | null;
}

/** The jobs row as the platform stored it; this step only reads it. */
async function jobRow(jobId: string): Promise<JobRow | undefined> {
  const {rows} = (await db.query('SELECT type, state, attempts, next_retry_at_ms FROM jobs WHERE id = $1', [
    jobId,
  ])) as {rows: JobRow[]};
  return rows[0];
}

app.get('/v1/jobs/:jobId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  const {jobId} = request.params as {jobId: string};
  const row = await jobRow(jobId);
  if (row === undefined) return reply.code(404).send({error: 'unknown job'});
  request.log.info({job_id: jobId, tenant}, 'job read');
  return reply.code(200).send({
    job_id: jobId,
    type: row.type,
    state: row.state,
    attempts: row.attempts,
    next_retry_at: row.next_retry_at_ms,
  });
});
`,
      solution: `/** GET /v1/jobs/:jobId: the job's state reconciled against the queue's own sets. */
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
export const redis = new Redis({host: 'redis', port: 6379});

const INFLIGHT_KEY = 'jobs:inflight';
const JOB_KEY_PREFIX = 'jobs:job:';
const VISIBILITY_TIMEOUT_S = 60;
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30000;

interface JobRow {
  tenant: string;
  type: string;
  state: string;
  attempts: number;
  next_retry_at_ms: number | null;
}

interface AttemptRow {
  attempt_no: number;
  error_class: string;
  error_message: string;
  started_at_ms: number;
  finished_at_ms: number | null;
}

export function nowMs(): number {
  return Date.now();
}

/** The exponential backoff for an attempt count, capped at BACKOFF_CAP_MS. */
function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), BACKOFF_CAP_MS);
}

/** The jobs row: the record of what the platform wrote, tenant included. */
async function jobRow(jobId: string): Promise<JobRow | undefined> {
  const {rows} = (await db.query(
    'SELECT tenant, type, state, attempts, next_retry_at_ms FROM jobs WHERE id = $1',
    [jobId],
  )) as {rows: JobRow[]};
  return rows[0];
}

/** Every attempt so far, oldest first: the history a support engineer reads. */
async function attemptHistory(jobId: string): Promise<AttemptRow[]> {
  const {rows} = (await db.query(
    'SELECT attempt_no, error_class, error_message, started_at_ms, finished_at_ms' +
      ' FROM job_attempts WHERE job_id = $1 ORDER BY attempt_no',
    [jobId],
  )) as {rows: AttemptRow[]};
  return rows;
}

/** Why the job was buried, or null while it is still alive. */
async function deadLetterReason(jobId: string): Promise<string | null> {
  const {rows} = (await db.query('SELECT reason FROM job_dead_letter WHERE job_id = $1', [jobId])) as {
    rows: {reason: string}[];
  };
  return rows[0]?.reason ?? null;
}

/** The age of an expired claim: the job is in jobs:inflight with a deadline already past. */
async function claimAgeMs(jobId: string, now: number): Promise<number | null> {
  const deadline = await redis.zscore(INFLIGHT_KEY, jobId);
  if (deadline === null || Number(deadline) > now) return null;
  return now - Number(deadline);
}

/** A retry time the caller can trust: the stored one while it is still ahead of the clock,
 * otherwise a recomputed backoff plus retry_overdue, so support knows a retry is owed. */
function nextRetry(
  attempts: number,
  storedMs: number | null,
  now: number,
): {retryAt: number | null; overdue: boolean} {
  if (storedMs !== null && storedMs > now) return {retryAt: storedMs, overdue: false};
  if (attempts >= MAX_ATTEMPTS) return {retryAt: null, overdue: true};
  return {retryAt: now + backoffMs(attempts), overdue: true};
}

app.get('/v1/jobs/:jobId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const {jobId} = request.params as {jobId: string};
  const row = await jobRow(jobId);
  // 404, not 403: a foreign job must be indistinguishable from one that never existed.
  if (row === undefined || row.tenant !== tenant) return reply.code(404).send({error: 'unknown job'});

  const now = nowMs();
  const queueState = await redis.hgetall(JOB_KEY_PREFIX + jobId);
  const strandedFor = await claimAgeMs(jobId, now);
  const state = strandedFor === null ? queueState['state'] ?? row.state : 'stalled';
  const retry = nextRetry(row.attempts, row.next_retry_at_ms, now);
  request.log.info({job_id: jobId, tenant, state}, 'job read');
  return reply.code(200).send({
    job_id: jobId,
    type: row.type,
    state,
    attempts: row.attempts,
    worker: queueState['worker'] ?? null,
    claim_age_ms: strandedFor,
    next_retry_at: retry.retryAt,
    retry_overdue: retry.overdue,
    attempt_history: await attemptHistory(jobId),
    dead_letter_reason: await deadLetterReason(jobId),
  });
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

// jobRow is the stored jobs row; this step only reads it.
type jobRow struct {
	Type          string
	State         string
	Attempts      int64
	NextRetryAtMs *int64
}

func readJobRow(r *http.Request, jobID string) (jobRow, error) {
	var row jobRow
	err := db.QueryRowContext(
		r.Context(),
		"SELECT type, state, attempts, next_retry_at_ms FROM jobs WHERE id = $1",
		jobID,
	).Scan(&row.Type, &row.State, &row.Attempts, &row.NextRetryAtMs)
	return row, err
}

func readJob(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	jobID := r.PathValue("jobID")
	row, err := readJobRow(r, jobID)
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown job"})
		return
	}
	log.Printf("job read job_id=%s tenant=%s", jobID, tenant)
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id":        jobID,
		"type":          row.Type,
		"state":         row.State,
		"attempts":      row.Attempts,
		"next_retry_at": row.NextRetryAtMs,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/jobs/{jobID}", readJob)
	_ = http.ListenAndServe("0.0.0.0:8443", mux)
}
`,
      solution: `package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	inflightKey      = "jobs:inflight"
	jobKeyPrefix     = "jobs:job:"
	visibilityTimeoS = 60
	maxAttempts      = 5
	backoffBaseMS    = 1000
	backoffCapMS     = 30000
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func nowMS() int64 {
	return time.Now().UnixMilli()
}

// backoffMS is the exponential backoff for an attempt count, capped at backoffCapMS.
func backoffMS(attempts int64) int64 {
	shift := attempts - 1
	if shift < 0 {
		shift = 0
	}
	if backoff := backoffBaseMS << shift; backoff < backoffCapMS {
		return backoff
	}
	return backoffCapMS
}

// jobRow is the stored jobs row: the record of what the platform wrote, tenant included.
type jobRow struct {
	Tenant        string
	Type          string
	State         string
	Attempts      int64
	NextRetryAtMs *int64
}

// attemptRow is one attempt of the job, in the order it happened.
type attemptRow struct {
	AttemptNo    int64  \`json:"attempt_no"\`
	ErrorClass   string \`json:"error_class"\`
	ErrorMessage string \`json:"error_message"\`
	StartedAtMs  int64  \`json:"started_at_ms"\`
	FinishedAtMs *int64 \`json:"finished_at_ms"\`
}

func readJobRow(r *http.Request, jobID string) (jobRow, error) {
	var row jobRow
	err := db.QueryRowContext(
		r.Context(),
		"SELECT tenant, type, state, attempts, next_retry_at_ms FROM jobs WHERE id = $1",
		jobID,
	).Scan(&row.Tenant, &row.Type, &row.State, &row.Attempts, &row.NextRetryAtMs)
	return row, err
}

// attemptHistory reads every attempt so far, oldest first: the history a support engineer reads.
func attemptHistory(r *http.Request, jobID string) ([]attemptRow, error) {
	rows, err := db.QueryContext(
		r.Context(),
		"SELECT attempt_no, error_class, error_message, started_at_ms, finished_at_ms"+
			" FROM job_attempts WHERE job_id = $1 ORDER BY attempt_no",
		jobID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	history := []attemptRow{}
	for rows.Next() {
		var attempt attemptRow
		if scanErr := rows.Scan(
			&attempt.AttemptNo,
			&attempt.ErrorClass,
			&attempt.ErrorMessage,
			&attempt.StartedAtMs,
			&attempt.FinishedAtMs,
		); scanErr != nil {
			return nil, scanErr
		}
		history = append(history, attempt)
	}
	return history, rows.Err()
}

// deadLetterReason is why the job was buried, or nil while it is still alive.
func deadLetterReason(r *http.Request, jobID string) (any, error) {
	var reason string
	err := db.QueryRowContext(
		r.Context(),
		"SELECT reason FROM job_dead_letter WHERE job_id = $1",
		jobID,
	).Scan(&reason)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return reason, nil
}

// claimAgeMS is the age of an expired claim: the job is in jobs:inflight with a deadline already past.
func claimAgeMS(r *http.Request, jobID string, now int64) (*int64, error) {
	deadline, err := rdb.ZScore(r.Context(), inflightKey, jobID).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if int64(deadline) > now {
		return nil, nil
	}
	age := now - int64(deadline)
	return &age, nil
}

// nextRetry is a retry time the caller can trust: the stored one while it is still ahead of the
// clock, otherwise a recomputed backoff plus retry_overdue, so support knows a retry is owed.
func nextRetry(attempts int64, storedMS *int64, now int64) (*int64, bool) {
	if storedMS != nil && *storedMS > now {
		return storedMS, false
	}
	if attempts >= maxAttempts {
		return nil, true
	}
	at := now + backoffMS(attempts)
	return &at, true
}

func readJob(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	jobID := r.PathValue("jobID")
	row, err := readJobRow(r, jobID)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown job"})
		return
	}
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "lookup failed"})
		return
	}
	// 404, not 403: a foreign job must be indistinguishable from one that never existed.
	if row.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown job"})
		return
	}

	now := nowMS()
	queueState, err := rdb.HGetAll(r.Context(), jobKeyPrefix+jobID).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "queue state unavailable"})
		return
	}
	claimAge, err := claimAgeMS(r, jobID, now)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "claim unavailable"})
		return
	}

	state := row.State
	if queued, ok := queueState["state"]; ok && queued != "" {
		state = queued
	}
	if claimAge != nil {
		state = "stalled"
	}
	var worker any
	if name, ok := queueState["worker"]; ok && name != "" {
		worker = name
	}
	retryAt, overdue := nextRetry(row.Attempts, row.NextRetryAtMs, now)

	history, err := attemptHistory(r, jobID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "history unavailable"})
		return
	}
	reason, err := deadLetterReason(r, jobID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "dead letter unavailable"})
		return
	}

	log.Printf("job read job_id=%s tenant=%s state=%s", jobID, tenant, state)
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id":             jobID,
		"type":               row.Type,
		"state":              state,
		"attempts":           row.Attempts,
		"worker":             worker,
		"claim_age_ms":       claimAge,
		"next_retry_at":      retryAt,
		"retry_overdue":      overdue,
		"attempt_history":    history,
		"dead_letter_reason": reason,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/jobs/{jobID}", readJob)
	_ = http.ListenAndServe("0.0.0.0:8443", mux)
}
`,
    },
    scala: {
      starter: `import java.sql.Connection

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

final case class JobRow(jobType: String, state: String, attempts: Long, nextRetryAtMs: Option[Long])

object JobRead {
  implicit val system: ActorSystem = ActorSystem("jobqd")

  def jsonEntity(body: String): ResponseEntity =
    HttpEntity(ContentTypes.\`application/json\`, body)

  /** The stored jobs row; this step only reads it. */
  def jobRow(jobId: String): Option[JobRow] = {
    val stmt = conn.prepareStatement("SELECT type, state, attempts, next_retry_at_ms FROM jobs WHERE id = ?")
    stmt.setString(1, jobId)
    val rows = stmt.executeQuery()
    if (!rows.next()) None
    else {
      val attempts = rows.getLong("attempts")
      val storedRetry = rows.getLong("next_retry_at_ms")
      val retryAt = if (rows.wasNull()) None else Some(storedRetry)
      Some(JobRow(rows.getString("type"), rows.getString("state"), attempts, retryAt))
    }
  }

  val route: Route =
    path("v1" / "jobs" / Segment) { jobId =>
      get {
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        jobRow(jobId) match {
          case Some(row) =>
            val response = JsObject(
              "job_id" -> JsString(jobId),
              "type" -> JsString(row.jobType),
              "state" -> JsString(row.state),
              "attempts" -> JsNumber(row.attempts),
              "next_retry_at" -> row.nextRetryAtMs.map(JsNumber(_)).getOrElse(JsNull)
            )
            complete(StatusCodes.OK, jsonEntity(response.compactPrint))
          case None =>
            complete(StatusCodes.NotFound, jsonEntity("""{"error":"unknown job"}"""))
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.sql.Connection

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

/** The stored jobs row: the record of what the platform wrote, tenant included. */
final case class JobRow(
    tenant: String,
    jobType: String,
    state: String,
    attempts: Long,
    nextRetryAtMs: Option[Long],
)

object JobRead {
  implicit val system: ActorSystem = ActorSystem("jobqd")

  val InflightKey = "jobs:inflight"
  val JobKeyPrefix = "jobs:job:"
  val VisibilityTimeoutS = 60
  val MaxAttempts = 5
  val BackoffBaseMs = 1000L
  val BackoffCapMs = 30000L

  def jsonEntity(body: String): ResponseEntity =
    HttpEntity(ContentTypes.\`application/json\`, body)

  def nowMs(): Long = System.currentTimeMillis()

  /** The exponential backoff for an attempt count, capped at BackoffCapMs. */
  def backoffMs(attempts: Long): Long =
    math.min(BackoffBaseMs * (1L << math.max(attempts - 1, 0).toInt), BackoffCapMs)

  def jobRow(jobId: String): Option[JobRow] = {
    val stmt = conn.prepareStatement(
      "SELECT tenant, type, state, attempts, next_retry_at_ms FROM jobs WHERE id = ?"
    )
    stmt.setString(1, jobId)
    val rows = stmt.executeQuery()
    if (!rows.next()) None
    else {
      val attempts = rows.getLong("attempts")
      val storedRetry = rows.getLong("next_retry_at_ms")
      val retryAt = if (rows.wasNull()) None else Some(storedRetry)
      Some(
        JobRow(
          rows.getString("tenant"),
          rows.getString("type"),
          rows.getString("state"),
          attempts,
          retryAt
        )
      )
    }
  }

  /** Every attempt so far, oldest first: the history a support engineer reads. */
  def attemptHistory(jobId: String): List[JsObject] = {
    val stmt = conn.prepareStatement(
      "SELECT attempt_no, error_class, error_message, started_at_ms, finished_at_ms" +
        " FROM job_attempts WHERE job_id = ? ORDER BY attempt_no"
    )
    stmt.setString(1, jobId)
    val rows = stmt.executeQuery()
    val history = List.newBuilder[JsObject]
    while (rows.next()) {
      val finished = rows.getLong("finished_at_ms")
      val finishedJson = if (rows.wasNull()) JsNull else JsNumber(finished)
      history += JsObject(
        "attempt_no" -> JsNumber(rows.getLong("attempt_no")),
        "error_class" -> JsString(rows.getString("error_class")),
        "error_message" -> JsString(rows.getString("error_message")),
        "started_at_ms" -> JsNumber(rows.getLong("started_at_ms")),
        "finished_at_ms" -> finishedJson
      )
    }
    history.result()
  }

  /** Why the job was buried, or None while it is still alive. */
  def deadLetterReason(jobId: String): Option[String] = {
    val stmt = conn.prepareStatement("SELECT reason FROM job_dead_letter WHERE job_id = ?")
    stmt.setString(1, jobId)
    val rows = stmt.executeQuery()
    if (rows.next()) Some(rows.getString("reason")) else None
  }

  /** The age of an expired claim: the job is in jobs:inflight with a deadline already past. */
  def claimAgeMs(jobId: String, now: Long): Option[Long] =
    Option(jedis.zscore(InflightKey, jobId)).map(_.toLong).filter(_ <= now).map(deadline => now - deadline)

  /** A retry time the caller can trust: the stored one while it is still ahead of the clock,
    * otherwise a recomputed backoff plus retry_overdue, so support knows a retry is owed. */
  def nextRetry(attempts: Long, storedMs: Option[Long], now: Long): (Option[Long], Boolean) =
    storedMs.filter(_ > now) match {
      case Some(stored)                    => (Some(stored), false)
      case None if attempts >= MaxAttempts => (None, true)
      case None                            => (Some(now + backoffMs(attempts)), true)
    }

  val route: Route =
    path("v1" / "jobs" / Segment) { jobId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          val tenant = tenantOpt.filter(_.nonEmpty)
          if (tenant.isEmpty) complete(StatusCodes.Unauthorized, jsonEntity("""{"error":"missing X-Tenant-Id"}"""))
          else {
            jobRow(jobId) match {
              // 404, not 403: a foreign job must be indistinguishable from one that never existed.
              case Some(row) if row.tenant == tenant.get =>
                val now = nowMs()
                val queueState = Option(jedis.hget(JobKeyPrefix + jobId, "state"))
                val strandedFor = claimAgeMs(jobId, now)
                val state = if (strandedFor.isDefined) "stalled" else queueState.getOrElse(row.state)
                val worker = Option(jedis.hget(JobKeyPrefix + jobId, "worker"))
                val (retryAt, overdue) = nextRetry(row.attempts, row.nextRetryAtMs, now)
                val response = JsObject(
                  "job_id" -> JsString(jobId),
                  "type" -> JsString(row.jobType),
                  "state" -> JsString(state),
                  "attempts" -> JsNumber(row.attempts),
                  "worker" -> worker.map(JsString(_)).getOrElse(JsNull),
                  "claim_age_ms" -> strandedFor.map(JsNumber(_)).getOrElse(JsNull),
                  "next_retry_at" -> retryAt.map(JsNumber(_)).getOrElse(JsNull),
                  "retry_overdue" -> JsBoolean(overdue),
                  "attempt_history" -> JsArray(attemptHistory(jobId).toVector),
                  "dead_letter_reason" -> deadLetterReason(jobId).map(JsString(_)).getOrElse(JsNull)
                )
                complete(StatusCodes.OK, jsonEntity(response.compactPrint))
              case _ =>
                complete(StatusCodes.NotFound, jsonEntity("""{"error":"unknown job"}"""))
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

using json = nlohmann::json;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/jobs/([\\w-]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    const std::string job_id = req.matches[1];
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    pqxx::work tx(db_pool());
    const auto jobs = tx.exec_params(
        "SELECT type, state, attempts, next_retry_at_ms FROM jobs WHERE id = $1", job_id);
    if (jobs.empty()) {
      res.status = 404;
      res.set_content(R"({"error":"unknown job"})", "application/json");
      return;
    }
    std::cerr << "job read job_id=" << job_id << " tenant=" << tenant << "\\n";
    res.status = 200;
    res.set_content(
        json{{"job_id", job_id},
             {"type", jobs[0]["type"].as<std::string>()},
             {"state", jobs[0]["state"].as<std::string>()},
             {"attempts", jobs[0]["attempts"].as<long long>()},
             {"next_retry_at", jobs[0]["next_retry_at_ms"]}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <iostream>
#include <optional>
#include <string>

using json = nlohmann::json;

constexpr int kVisibilityTimeoutS = 60;
constexpr int kMaxAttempts = 5;
constexpr long long kBackoffBaseMs = 1000;
constexpr long long kBackoffCapMs = 30000;

const std::string kInflightKey = "jobs:inflight";
const std::string kJobKeyPrefix = "jobs:job:";

long long nowMs() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

/** The exponential backoff for an attempt count, capped at kBackoffCapMs. */
long long backoffMs(long long attempts) {
  const long long shift = std::max<long long>(attempts - 1, 0);
  return std::min(kBackoffBaseMs * (1LL << shift), kBackoffCapMs);
}

/** The age of an expired claim: the job is in jobs:inflight with a deadline already past. */
std::optional<long long> claimAgeMs(const std::string& job_id, long long now) {
  const auto deadline = redis.zscore(kInflightKey, job_id);
  if (!deadline.has_value() || static_cast<long long>(*deadline) > now) return std::nullopt;
  return now - static_cast<long long>(*deadline);
}

/** A retry time the caller can trust: the stored one while it is still ahead of the clock,
 * otherwise a recomputed backoff plus retry_overdue, so support knows a retry is owed. */
std::pair<std::optional<long long>, bool> nextRetry(
    long long attempts, const std::optional<long long>& stored_ms, long long now) {
  if (stored_ms.has_value() && *stored_ms > now) return {stored_ms, false};
  if (attempts >= kMaxAttempts) return {std::nullopt, true};
  return {now + backoffMs(attempts), true};
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/jobs/([\\w-]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const std::string job_id = req.matches[1];

    pqxx::work tx(db_pool());
    const auto jobs = tx.exec_params(
        "SELECT tenant, type, state, attempts, next_retry_at_ms FROM jobs WHERE id = $1", job_id);
    // 404, not 403: a foreign job must be indistinguishable from one that never existed.
    if (jobs.empty() || jobs[0]["tenant"].as<std::string>() != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"unknown job"})", "application/json");
      return;
    }
    const auto& row = jobs[0];
    const long long attempts = row["attempts"].as<long long>();
    std::optional<long long> stored_retry;
    if (!row["next_retry_at_ms"].is_null()) stored_retry = row["next_retry_at_ms"].as<long long>();

    const long long now = nowMs();
    const auto queue_state = redis.hget(kJobKeyPrefix + job_id, "state");
    const auto stranded_for = claimAgeMs(job_id, now);
    std::string state = queue_state.value_or(row["state"].as<std::string>());
    if (stranded_for.has_value()) state = "stalled";
    const auto worker = redis.hget(kJobKeyPrefix + job_id, "worker");
    const auto retry = nextRetry(attempts, stored_retry, now);

    const auto history = tx.exec_params(
        "SELECT attempt_no, error_class, error_message, started_at_ms, finished_at_ms"
        " FROM job_attempts WHERE job_id = $1 ORDER BY attempt_no",
        job_id);
    json attempt_history = json::array();
    for (const auto& attempt : history)
      attempt_history.push_back(json{
          {"attempt_no", attempt["attempt_no"].as<long long>()},
          {"error_class", attempt["error_class"].as<std::string>()},
          {"error_message", attempt["error_message"].as<std::string>()},
          {"started_at_ms", attempt["started_at_ms"].as<long long>()},
          {"finished_at_ms",
           attempt["finished_at_ms"].is_null() ? json(nullptr)
                                              : json(attempt["finished_at_ms"].as<long long>())}});

    const auto buried = tx.exec_params("SELECT reason FROM job_dead_letter WHERE job_id = $1", job_id);
    const json dead_letter_reason =
        buried.empty() ? json(nullptr) : json(buried[0]["reason"].as<std::string>());

    std::cerr << "job read job_id=" << job_id << " tenant=" << tenant << " state=" << state << "\\n";
    res.status = 200;
    res.set_content(
        json{{"job_id", job_id},
             {"type", row["type"].as<std::string>()},
             {"state", state},
             {"attempts", attempts},
             {"worker", worker.has_value() ? json(*worker) : json(nullptr)},
             {"claim_age_ms", stranded_for.has_value() ? json(*stranded_for) : json(nullptr)},
             {"next_retry_at", retry.first.has_value() ? json(*retry.first) : json(nullptr)},
             {"retry_overdue", retry.second},
             {"attempt_history", attempt_history},
             {"dead_letter_reason", dead_letter_reason}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Support watches a job sit at "queued, next retry 09:14" for three hours after a worker node died at 09:10, and nothing ever retries it.',
    '`job_row` selects by id with no tenant and the handler echoes `row["state"]` and `row["next_retry_at_ms"]`; nothing consults `jobs:inflight`, `job_attempts` or `job_dead_letter`, and the clock is not read.',
    'Filter by tenant and answer 404 on mismatch; `ZSCORE jobs:inflight` and report `stalled` with `claim_age_ms` when the deadline is past; recompute backoff and set `retry_overdue` when stored time < now; read history and reason from their tables.',
  ],
  debrief: `The read half of a queue is judged by whether it reports the state the queue is in, and whether this caller may see it. The row is written by the API and the worker, so a worker that dies mid-attempt leaves a row that still says \`queued\`; reconciling against \`jobs:inflight\` is how the endpoint sees the crash the row cannot. A stored retry time is a promise about the past, and only the clock turns it into one about the future, which is why the read recomputes and flags an overdue retry rather than echoing it. The history and the dead-letter reason come from their own tables because the row's counter explains nothing. The tenant lookup answers 404 so a guessed id confirms nothing. Production systems add a sweep that re-queues stalled claims instead of only reporting them.`,
};
