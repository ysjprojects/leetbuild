import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/synthetic/jobs/{id}: provenance a reviewer can trace',
  concept: 'http',
  file: 'read',
  focus: ['client', 'synth', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a report comes back, the row
count looks healthy and the demo ships. It authorizes nothing, it hides the records nobody scored,
and it cannot say where a single admitted record came from. Find the flaws, fix them, and prove the
fix.

Implement \`GET /v1/synthetic/jobs/{job_id}\`, the report a reviewer reads before the corpus ships:

- The job is looked up for the **authenticated tenant**: \`assert_tenant_owns(tenant, job_id)\`. A job
  belonging to another tenant, or one that does not exist, answers **404** — a foreign job id must be
  indistinguishable from a missing one. The draft serves any job id it is handed.
- The body reports the four outcomes: **\`generated\`**, **\`admitted\`**, **\`parked\`** and
  **\`rejected\`**. The parked count is the one that matters — records a timed-out judge never scored
  are neither admitted nor rejected, and a report that only shows a total hides them.
- The body carries **\`coverage\`**: the per-entity counts read from the job's coverage hash
  (\`HGETALL synth:cov:{job_id}\`), not a single total. Diversity is the thing a reviewer is checking.
- The body carries the **\`judge_version\`** that scored the corpus, so a set scored by a judge nobody
  can name cannot ship.
- Every admitted record **resolves to a seed digest**: read the digest stored on the admitted record
  (\`records.admitted(job_id)\`) and return it per record. The draft recomputes a digest from whatever
  the seed looks like *now*, so a record generated before a seed version bump points at the wrong
  seed — the linkage is lost exactly for the records generated across retries.

**Failure mode the checks target.** Provenance is the subtle one: it looks like a field, and it is
the difference between a corpus you can defend and a pile of text. Recomputing the digest from the
current seed is plausible, cheap and wrong the moment a seed gets re-versioned. Foreign-job reads are
the isolation bug — a report is a list of what a tenant's seeds produced. And a totals-only body is
the report that let the collapsed, timeout-ridden corpus through in the first place.`,
  sequence: {
    participants: ['Data curator', 'Synthetic Data API', 'record store', 'Redis'],
    messages: [
      {
        from: 'Data curator',
        to: 'Synthetic Data API',
        label: 'GET /v1/synthetic/jobs/job-7 · X-Tenant-Id',
        kind: 'sync',
      },
      {from: 'Synthetic Data API', to: 'record store', label: 'assert_tenant_owns(tenant, job-7)', kind: 'sync'},
      {from: 'record store', to: 'Synthetic Data API', label: 'owner / nil → 404', kind: 'reply'},
      {from: 'Synthetic Data API', to: 'record store', label: 'counts + records.admitted(job-7)', kind: 'sync'},
      {
        from: 'record store',
        to: 'Synthetic Data API',
        label: 'generated · admitted · parked · rejected · seed_digest per record',
        kind: 'reply',
      },
      {from: 'Synthetic Data API', to: 'Redis', label: 'HGETALL synth:cov:job-7', kind: 'sync'},
      {from: 'Redis', to: 'Synthetic Data API', label: '{ent-42: 5, ent-77: 2}', kind: 'reply'},
      {
        from: 'Synthetic Data API',
        to: 'Data curator',
        label: '200 {counts, coverage, judge_version, provenance}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Authorize the read like the write: fetch the job row under the authenticated tenant first and answer `404` for anything else, so a foreign job id is indistinguishable from a missing one.',
    'Report the four outcomes separately, and read coverage from the same hash the workers wrote (`synth:cov:{job_id}`). A totals-only body cannot distinguish a diverse corpus from one entity repeated ten thousand times, and it cannot show the parked records nobody scored.',
    'The digest belongs to the record, not to the seed: store it at admission and read it back here. Recomputing it from the current seed version is the plausible bug — it silently rewrites history for every record generated before a bump, which is exactly the retry path a reviewer is auditing.',
  ],
  checks: [
    {
      id: 'counts',
      title: 'Reports generated, admitted, parked and rejected counts',
      detail:
        'The report separates the four outcomes — `generated`, `admitted`, `parked`, `rejected` — on `GET /v1/synthetic/jobs/{id}`. The draft reports a total plus admitted, so the unscored records it parked nowhere are invisible.',
      match: {
        python: {
          all: [/@app\.get\(/, /\/v1\/synthetic\/jobs\//, /"generated"/, /"admitted"/, /"parked"/, /"rejected"/],
        },
        typescript: {
          all: [/app\.get\(/, /\/v1\/synthetic\/jobs\//, /\bgenerated\b/, /\badmitted\b/, /\bparked\b/, /\brejected\b/],
        },
        go: {
          all: [
            /HandleFunc\(/,
            /"GET \/v1\/synthetic\/jobs\/"/,
            /\bgenerated\b/,
            /\badmitted\b/,
            /\bparked\b/,
            /\brejected\b/,
          ],
        },
        scala: {all: [/path\(/, /"jobs"/, /\bget\s*\{/, /\bgenerated\b/, /\badmitted\b/, /\bparked\b/, /\brejected\b/]},
        cpp: {
          all: [/svr\.Get\(/, /\/v1\/synthetic\/jobs\//, /\bgenerated\b/, /\badmitted\b/, /\bparked\b/, /\brejected\b/],
        },
      },
    },
    {
      id: 'coverage',
      title: 'Returns per-entity coverage, not a total',
      detail:
        'Coverage is read from the job’s coverage hash (`HGETALL synth:cov:{job_id}`) and returned per entity. The draft returns a single generated count, which is the number that hid the collapse.',
      match: {
        python: {all: [/coverage/, /hgetall\(/]},
        typescript: {all: [/coverage/, /hgetall\(/]},
        go: {all: [/coverage/, /HGetAll\(/]},
        scala: {all: [/coverage/, /hgetAll\(/]},
        cpp: {all: [/coverage/, /hgetall\(/]},
      },
    },
    {
      id: 'judge-version',
      title: 'Names the judge version that scored the corpus',
      detail:
        'The report carries `judge_version`, so a corpus scored by an unnamed judge cannot ship. The draft reports no judge identity at all.',
      match: {
        python: {all: [/judge_version/]},
        typescript: {all: [/judge_version|judgeVersion/]},
        go: {all: [/JudgeVersion/]},
        scala: {all: [/judge_version|JudgeVersion/]},
        cpp: {all: [/judge_version/]},
      },
    },
    {
      id: 'provenance',
      title: 'Resolves every admitted record to its stored seed digest',
      detail:
        'Each admitted record is read with its stored `seed_digest` (`records.admitted(...)`), so a record generated before a seed version bump still points at the seed it came from. The draft recomputes the digest from the current seed.',
      match: {
        python: {all: [/seed_digest/, /records\.admitted\(/], none: [/recompute_digest/]},
        typescript: {all: [/seed_digest/, /records\.admitted\(/], none: [/recomputeDigest/]},
        go: {all: [/SeedDigest/, /Admitted\(/], none: [/recomputeDigest/]},
        scala: {all: [/seed_digest/, /admitted\(/], none: [/recomputeDigest/]},
        cpp: {all: [/seed_digest/, /admitted\(/], none: [/recompute_digest/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Scopes the report to the authenticated tenant',
      detail:
        'The job is authorized against the request tenant before its counters are read, and a foreign job answers **404**. The draft serves any job id in the path.',
      match: {
        python: {all: [/assert_tenant_owns/, /404/]},
        typescript: {all: [/assertTenantOwns/, /404/]},
        go: {all: [/assertTenantOwns/, /StatusNotFound/]},
        scala: {all: [/assertTenantOwns/, /NotFound/]},
        cpp: {all: [/assert_tenant_owns/, /404/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""GET /v1/synthetic/jobs/{job_id}: a model-generated draft that reports a total."""
import hashlib

from fastapi import FastAPI, Header

app = FastAPI()


class ReportStore:
    """The job rows and the admitted records the dashboard reads."""

    def total(self, job_id: str) -> int:
        """The generated count the dashboard shows."""
        raise NotImplementedError

    def admitted_count(self, job_id: str) -> int:
        """How many records of the job were admitted."""
        raise NotImplementedError

    def seed_row(self, job_id: str, record_id: str) -> str:
        """The seed row this record maps to today."""
        raise NotImplementedError


records = ReportStore()


def recompute_digest(seed_row: str) -> str:
    # TODO: this draft reports a total and an admitted count, so the records nobody scored are
    # invisible; it serves any tenant's job; and it resolves provenance by re-hashing the seed row
    # as it looks today, so a record generated before a seed version bump points at the wrong seed.
    return hashlib.sha256(seed_row.encode("utf-8")).hexdigest()


@app.get("/v1/synthetic/jobs/{job_id}")
def read_job(job_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> dict:
    return {
        "job_id": job_id,
        "total": records.total(job_id),
        "admitted": records.admitted_count(job_id),
        "provenance_digest": recompute_digest(records.seed_row(job_id, job_id)),
    }
`,
      solution: `import logging

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("synthd")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

JUDGE_VERSION = "judge-2026.04"


class ReportStore:
    """Job rows and admitted records; every read is scoped to the tenant that owns the job."""

    def owner(self, job_id: str) -> str | None:
        """The tenant that owns the job, or None when the job does not exist."""
        raise NotImplementedError

    def counts(self, job_id: str) -> dict:
        """generated / admitted / parked / rejected counts for the job."""
        raise NotImplementedError

    def admitted(self, job_id: str) -> list[dict]:
        """The admitted records, each carrying the seed_digest stored when it was admitted."""
        raise NotImplementedError


records = ReportStore()


def assert_tenant_owns(tenant: str, job_id: str) -> None:
    """404 for a missing job and for one another tenant owns — indistinguishable on purpose."""
    owner = records.owner(job_id)
    if owner is None or owner != tenant:
        raise HTTPException(status_code=404, detail="job not found")


def coverage_of(job_id: str) -> dict:
    """Per-entity coverage the generator workers wrote: synth:cov:{job_id}."""
    fields = r.hgetall(f"synth:cov:{job_id}")
    return {entity: int(count) for entity, count in fields.items()}


@app.get("/v1/synthetic/jobs/{job_id}")
def read_job(job_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    assert_tenant_owns(tenant, job_id)

    counts = records.counts(job_id)
    provenance = [
        {"record_id": record["record_id"], "seed_digest": record["seed_digest"]}
        for record in records.admitted(job_id)
    ]
    body = {
        "job_id": job_id,
        "generated": counts["generated"],
        "admitted": counts["admitted"],
        "parked": counts["parked"],
        "rejected": counts["rejected"],
        "coverage": coverage_of(job_id),
        "judge_version": JUDGE_VERSION,
        "provenance": provenance,
    }
    logger.info("report job_id=%s admitted=%s parked=%s", job_id, counts["admitted"], counts["parked"])
    return JSONResponse(body, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/synthetic/jobs/:jobId: a model-generated draft that reports a total. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';

import {records} from './store';

export const app = Fastify();

// TODO: this draft reports a total and an admitted count, so the records nobody scored are
// invisible; it serves any tenant's job; and it resolves provenance by re-hashing the seed row as
// it looks today, so a record generated before a seed version bump points at the wrong seed.
function recomputeDigest(seedRow: string): string {
  const digest = createHash('sha256').update(seedRow).digest('hex');
  return digest;
}

app.get('/v1/synthetic/jobs/:jobId', async (request, reply) => {
  const {jobId} = request.params as {jobId: string};
  const seedRow = await records.seedRow(jobId, jobId);
  return reply.code(200).send({
    job_id: jobId,
    total: await records.total(jobId),
    admitted: await records.admittedCount(jobId),
    provenance_digest: recomputeDigest(seedRow),
  });
});

void app.listen({port: 8080, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/synthetic/jobs/:jobId: the report a reviewer reads before the corpus ships. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {records} from './store';

export const app = Fastify();
const redis = new Redis('redis://redis:6379');

const JUDGE_VERSION = 'judge-2026.04';

interface AdmittedRecord {
  record_id: string;
  seed_digest: string;
}

interface JobCounts {
  generated: number;
  admitted: number;
  parked: number;
  rejected: number;
}

/** 404 for a missing job and for one another tenant owns — indistinguishable on purpose. */
async function assertTenantOwns(tenant: string, jobId: string): Promise<void> {
  const owner = await records.owner(jobId);
  if (owner === null || owner !== tenant) {
    const notFound = new Error('job not found') as Error & {statusCode: number};
    notFound.statusCode = 404;
    throw notFound;
  }
}

async function coverageOf(jobId: string): Promise<Record<string, number>> {
  const fields = await redis.hgetall(\`synth:cov:\${jobId}\`);
  const coverage: Record<string, number> = {};
  for (const entity of Object.keys(fields)) coverage[entity] = Number(fields[entity]);
  return coverage;
}

app.get('/v1/synthetic/jobs/:jobId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const {jobId} = request.params as {jobId: string};
  try {
    await assertTenantOwns(tenant, jobId);
  } catch (error) {
    return reply.code((error as {statusCode?: number}).statusCode ?? 500).send({error: 'job not found'});
  }

  const counts: JobCounts = await records.counts(jobId);
  const admitted: AdmittedRecord[] = await records.admitted(jobId);
  const provenance = admitted.map(record => ({
    record_id: record.record_id,
    seed_digest: record.seed_digest,
  }));
  request.log.info({jobId, admitted: counts.admitted, parked: counts.parked}, 'report');
  return reply.code(200).send({
    job_id: jobId,
    generated: counts.generated,
    admitted: counts.admitted,
    parked: counts.parked,
    rejected: counts.rejected,
    coverage: await coverageOf(jobId),
    judge_version: JUDGE_VERSION,
    provenance,
  });
});

void app.listen({port: 8080, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `// GET /v1/synthetic/jobs/{job_id}: a model-generated draft that reports a total.
package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
)

type ReportStore struct{}

func (s *ReportStore) Total(jobID string) int  { return 0 }
func (s *ReportStore) SeedRow(jobID, recordID string) string { return "" }

var records = &ReportStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// recomputeDigest re-hashes the seed row as it looks today.
//
// TODO: this draft reports a total only, so the records nobody scored are invisible; it serves any
// tenant's job; and provenance is recomputed from the current seed row instead of the digest
// stored when the record was admitted, so a record made before a seed version bump drifts.
func recomputeDigest(seedRow string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(seedRow)))
}

func reportJob(rw http.ResponseWriter, r *http.Request) {
	jobID := strings.TrimPrefix(r.URL.Path, "/v1/synthetic/jobs/")
	log.Printf("report job_id=%s", jobID)
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id":            jobID,
		"total":             records.Total(jobID),
		"provenance_digest": recomputeDigest(records.SeedRow(jobID, jobID)),
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/synthetic/jobs/", reportJob)
	log.Fatal(http.ListenAndServe(":8080", mux))
}
`,
      solution: `// GET /v1/synthetic/jobs/{job_id}: the report a reviewer reads before the corpus ships.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

const JudgeVersion = "judge-2026.04"

type AdmittedRecord struct {
	RecordID   string \`json:"record_id"\`
	SeedDigest string \`json:"seed_digest"\`
}

type JobCounts struct {
	Generated int \`json:"generated"\`
	Admitted  int \`json:"admitted"\`
	Parked    int \`json:"parked"\`
	Rejected  int \`json:"rejected"\`
}

type ReportStore struct{}

func (s *ReportStore) Owner(ctx context.Context, jobID string) (string, bool) { return "", false }

func (s *ReportStore) Counts(ctx context.Context, jobID string) (JobCounts, error) {
	return JobCounts{}, nil
}

func (s *ReportStore) Admitted(ctx context.Context, jobID string) ([]AdmittedRecord, error) {
	return nil, nil
}

var (
	records = &ReportStore{}
	rdb     = redis.NewClient(&redis.Options{Addr: "redis:6379"})
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// assertTenantOwns answers 404 for a missing job and for one another tenant owns: the two are
// indistinguishable on purpose, so a foreign job id leaks nothing about another tenant's corpus.
func assertTenantOwns(ctx context.Context, tenant, jobID string) bool {
	owner, ok := records.Owner(ctx, jobID)
	return ok && owner == tenant
}

func coverageOf(ctx context.Context, jobID string) (map[string]int64, error) {
	fields, err := rdb.HGetAll(ctx, "synth:cov:"+jobID).Result()
	if err != nil {
		return nil, err
	}
	coverage := make(map[string]int64, len(fields))
	for entity, count := range fields {
		n, _ := strconv.ParseInt(count, 10, 64)
		coverage[entity] = n
	}
	return coverage, nil
}

func reportJob(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	jobID := strings.TrimPrefix(r.URL.Path, "/v1/synthetic/jobs/")
	if !assertTenantOwns(r.Context(), tenant, jobID) {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "job not found"})
		return
	}
	counts, err := records.Counts(r.Context(), jobID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	admitted, err := records.Admitted(r.Context(), jobID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	coverage, err := coverageOf(r.Context(), jobID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	provenance := make([]map[string]string, 0, len(admitted))
	for _, record := range admitted {
		provenance = append(provenance, map[string]string{"record_id": record.RecordID, "seed_digest": record.SeedDigest})
	}
	log.Printf("report job_id=%s admitted=%d parked=%d", jobID, counts.Admitted, counts.Parked)
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id":        jobID,
		"generated":     counts.Generated,
		"admitted":      counts.Admitted,
		"parked":        counts.Parked,
		"rejected":      counts.Rejected,
		"coverage":      coverage,
		"judge_version": JudgeVersion,
		"provenance":    provenance,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/synthetic/jobs/", reportJob)
	log.Fatal(http.ListenAndServe(":8080", mux))
}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object ReportStore {
  def total(jobId: String): Long = 0L
  def admittedCount(jobId: String): Long = 0L
  def seedRow(jobId: String, recordId: String): String = ""
}

object SynthReport {
  implicit val system: ActorSystem = ActorSystem("synthd")

  val records = ReportStore

  // TODO: this draft reports a total and an admitted count, so the records nobody scored are
  // invisible; it serves any tenant's job; and it resolves provenance by re-hashing the seed row as
  // it looks today, so a record generated before a seed version bump points at the wrong seed.
  def recomputeDigest(seedRow: String): String =
    MessageDigest.getInstance("sha256").digest(seedRow.getBytes("UTF-8")).map("%02x".format(_)).mkString

  val route: Route = path("v1" / "synthetic" / "jobs" / Segment) { jobId =>
    get {
      complete(
        StatusCodes.OK,
        s"""{"job_id":"$jobId","total":\${records.total(jobId)},"admitted":\${records.admittedCount(jobId)},"provenance_digest":"\${recomputeDigest(records.seedRow(jobId, jobId))}"}"""
      )
    }
  }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8080).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import scala.jdk.CollectionConverters._

final case class JobCounts(generated: Long, admitted: Long, parked: Long, rejected: Long)
final case class AdmittedRecord(record_id: String, seed_digest: String)
final case class Provenance(record_id: String, seed_digest: String)

object ReportStore {
  def owner(jobId: String): Option[String] = None
  def counts(jobId: String): JobCounts = JobCounts(0L, 0L, 0L, 0L)
  def admitted(jobId: String): List[AdmittedRecord] = Nil
}

object SynthReport {
  implicit val system: ActorSystem = ActorSystem("synthd")
  implicit val provenanceFormat: RootJsonFormat[Provenance] = jsonFormat2(Provenance)

  val JudgeVersion = "judge-2026.04"
  val records = ReportStore
  val r = new Jedis("redis", 6379)

  // 404 for a missing job and for one another tenant owns: indistinguishable on purpose, so a
  // foreign job id leaks nothing about another tenant's corpus.
  def assertTenantOwns(tenant: String, jobId: String): Boolean =
    ReportStore.owner(jobId).contains(tenant)

  def coverageOf(jobId: String): Map[String, Long] =
    r.hgetAll(s"synth:cov:$jobId").asScala.map { case (entity, count) => entity -> count.toLong }.toMap

  val route: Route = path("v1" / "synthetic" / "jobs" / Segment) { jobId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
        if (!tenantOpt.exists(_.nonEmpty)) {
          complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
        } else if (!assertTenantOwns(tenantOpt.get, jobId)) {
          complete(StatusCodes.NotFound, """{"error":"job not found"}""")
        } else {
          val counts = ReportStore.counts(jobId)
          val provenance = ReportStore.admitted(jobId).map(record => Provenance(record.record_id, record.seed_digest))
          val coverage = coverageOf(jobId)
          system.log.info(s"report job_id=$jobId admitted=\${counts.admitted} parked=\${counts.parked}")
          complete(
            StatusCodes.OK,
            s"""{"job_id":"$jobId","generated":\${counts.generated},"admitted":\${counts.admitted},"parked":\${counts.parked},"rejected":\${counts.rejected},"coverage":\${coverage.toJson},"judge_version":"$JudgeVersion","provenance":\${provenance.toJson}}"""
          )
        }
      }
    }
  }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8080).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `// GET /v1/synthetic/jobs/{job_id}: a model-generated draft that reports a total.
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

using json = nlohmann::json;

struct ReportStore {
  long long total(const std::string& jobId);
  long long admittedCount(const std::string& jobId);
  std::string seedRow(const std::string& jobId, const std::string& recordId);
};

ReportStore records;
std::string sha256Hex(const std::string& input);

// TODO: this draft reports a total and an admitted count, so the records nobody scored are
// invisible; it serves any tenant's job; and it resolves provenance by re-hashing the seed row as
// it looks today, so a record generated before a seed version bump points at the wrong seed.
std::string recomputeDigest(const std::string& seedRow) {
  return sha256Hex(seedRow);
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/synthetic/jobs/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto jobId = req.matches[1].str();
    const json body = {
        {"job_id", jobId},
        {"total", records.total(jobId)},
        {"admitted", records.admittedCount(jobId)},
        {"provenance_digest", recomputeDigest(records.seedRow(jobId, jobId))},
    };
    std::cerr << "report job_id=" << jobId << "\\n";
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8080);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kJudgeVersion = "judge-2026.04";

struct AdmittedRecord {
  std::string record_id;
  std::string seed_digest;
};

struct JobCounts {
  long long generated = 0;
  long long admitted = 0;
  long long parked = 0;
  long long rejected = 0;
};

struct ReportStore {
  std::optional<std::string> owner(const std::string& jobId);
  JobCounts counts(const std::string& jobId);
  std::vector<AdmittedRecord> admitted(const std::string& jobId);
};

ReportStore records;
sw::redis::Redis redis("tcp://redis:6379");

// 404 for a missing job and for one another tenant owns: indistinguishable on purpose, so a
// foreign job id leaks nothing about another tenant's corpus.
bool assert_tenant_owns(const std::string& tenant, const std::string& jobId) {
  const auto owner = records.owner(jobId);
  return owner.has_value() && *owner == tenant;
}

json coverageOf(const std::string& jobId) {
  json coverage = json::object();
  for (const auto& [entity, count] : redis.hgetall("synth:cov:" + jobId)) {
    coverage[entity] = std::stoll(count);
  }
  return coverage;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/synthetic/jobs/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto jobId = req.matches[1].str();
    if (!assert_tenant_owns(tenant, jobId)) {
      res.status = 404;
      res.set_content(R"({"error":"job not found"})", "application/json");
      return;
    }
    const auto counts = records.counts(jobId);
    json provenance = json::array();
    for (const auto& record : records.admitted(jobId)) {
      provenance.push_back(json{{"record_id", record.record_id}, {"seed_digest", record.seed_digest}});
    }
    std::cerr << "report job_id=" << jobId << " admitted=" << counts.admitted << " parked=" << counts.parked << "\\n";
    res.status = 200;
    res.set_content(json{{"job_id", jobId},
                         {"generated", counts.generated},
                         {"admitted", counts.admitted},
                         {"parked", counts.parked},
                         {"rejected", counts.rejected},
                         {"coverage", coverageOf(jobId)},
                         {"judge_version", kJudgeVersion},
                         {"provenance", provenance}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8080);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can tell a report from a metric. Totals are cheap and they are exactly what let a collapsed, timeout-ridden corpus pass review: the number went up, so the set looked healthy. The four outcomes are the actual contract — generated, admitted, parked, rejected — and the parked count is the one that turns infrastructure flakiness into a visible, arguable number instead of silent label noise. Coverage per entity is the diversity check, and the judge version is what makes the score auditable later. The provenance field is the subtle one: a digest recomputed from the seed's current version looks equivalent in a demo and rewrites history after the first version bump, so the digest has to be stored at admission and read back unchanged. Real platforms add a rejudge queue for parked records, a diversity metric over entity types, and signed manifests that pin seed digests per released corpus.`,
};
