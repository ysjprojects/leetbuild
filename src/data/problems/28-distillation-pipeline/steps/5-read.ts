import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/distill/jobs/{id}: the acceptance report',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis', 'db'],
  task: `## Task

The starter is a plausible model-generated draft: it has a route, it returns counts, and the
dashboard shows a healthy percentage. Both invariants are broken. Find them, fix them, and prove the
fix.

Implement \`GET /v1/distill/jobs/{job_id}\` — the report that decides whether anyone trusts a run.

- The tenant comes from \`X-Tenant-Id\` (**401** when missing) and an unknown job is **404**.
- \`sampled\`, \`accepted\` and \`rejected\` come from the **live** job counters, read at request time.
  A report cached when the job started is a lie the moment one sample is rejected: read
  \`distill:progress:{job_id}\` (and \`distill:reasons:{job_id}\`) on every request, and carry the
  revision you read them at (\`updated_at\`) so a client can tell two reports apart.
- The counts must **reconcile**: \`accepted + rejected == sampled\`. If they do not, the report is
  wrong about the past — answer an error rather than a plausible number.
- \`reasons\` reports the rejection breakdown by name (\`duplicate\`, \`refusal\`, \`empty\`,
  \`budget\`, \`deadline\`, …) so a run that rejected 40 percent of its samples can be explained.
- An acceptance rate **above 95 percent** is **flagged** as implausible, never certified as clean:
  a filter that accepts nearly everything is usually a filter that is not running, and the reviewer
  should look at a sample by hand. Report \`acceptance_rate\` and the flag; do not invent a badge.
- The report is **200** with \`{job_id, status, sampled, accepted, rejected, reasons,
  acceptance_rate, updated_at}\`, plus the flag when it applies.

**Failure mode the checks target.** Counting \`accepted\` as \`sampled - failures\` is the one that
ships a bad student: the duplicates the dedupe filter removed are not hard failures, so the arithmetic
silently counts them as good training data and every acceptance rate in the dashboard reads high.
Serving that arithmetic from a cache written at job start makes it worse — the report cannot even
change when the filter is fixed mid-run.`,
  sequence: {
    participants: ['Client', 'Distill API', 'Redis'],
    messages: [
      {from: 'Client', to: 'Distill API', label: 'GET /v1/distill/jobs/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Distill API', to: 'Redis', label: 'HGETALL distill:progress:{id}', kind: 'sync'},
      {from: 'Distill API', to: 'Redis', label: 'HGETALL distill:reasons:{id}', kind: 'sync'},
      {from: 'Redis', to: 'Distill API', label: 'live counters · rejection reasons', kind: 'reply'},
      {from: 'Distill API', to: 'Distill API', label: 'reconcile: accepted + rejected == sampled', kind: 'sync'},
      {from: 'Distill API', to: 'Distill API', label: 'flag an acceptance rate above 95%', kind: 'sync'},
      {from: 'Distill API', to: 'Client', label: '200 {counts, reasons, acceptance_rate, updated_at}', kind: 'reply'},
    ],
  },
  hints: [
    'Read the counters from Redis on every request (`HGETALL` on the progress and reasons hashes) and report the revision you read them at. A cache written when the job started can only ever be a historical document, and a client cannot tell it apart from a current one.',
    'Make the reconciliation explicit rather than implied: `accepted + rejected != sampled` is a bug, so return an error status instead of a number. If you compute `accepted = sampled - failures`, you have already decided the duplicates were good samples.',
    'Above 95 percent acceptance is a signal, not a success: flag it (`UNRELIABLE_ACCEPTANCE_RATE`) and say what to do — review a sample by hand. The reasons hash is what turns that flag into an investigation: `duplicate` dominant means the filter is working, `refusal` dominant means the teacher is. Never certify a run the data cannot support.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/distill/jobs/{id}',
      detail: 'Register the report route on `GET /v1/distill/jobs/{job_id}` with the job id as a path parameter.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/distill\/jobs\/\{job_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/distill\/jobs\/:job_id['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/distill\/jobs\/\{jobID\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"distill"\s*\/\s*"jobs"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\([^,\n]*v1\/distill\/jobs\//]},
      },
    },
    {
      id: 'reconcile',
      title: 'Reconciles accepted + rejected against sampled',
      detail:
        'The report checks `accepted + rejected == sampled` and answers an error when it does not, instead of publishing numbers that disagree with the past. The draft computes `accepted` from the sampled count and the failures it happens to have counted.',
      match: {
        python: {all: [/reconcile/, /accepted \+ rejected/]},
        typescript: {all: [/reconcile/, /accepted \+ rejected/]},
        go: {all: [/[Rr]econcile/, /accepted\s*\+\s*rejected/]},
        scala: {all: [/reconcile/, /accepted \+ rejected/]},
        cpp: {all: [/reconcile/, /accepted \+ rejected/]},
      },
    },
    {
      id: 'reasons',
      title: 'Reports the rejection reasons by name',
      detail:
        'The reply carries the `reasons` breakdown read from `distill:reasons:{job_id}` beside the `rejected` count, so a rejection rate can be explained. The draft reports a single rejected number and nothing about why.',
      match: {
        python: {all: [/reasons/, /rejected/]},
        typescript: {all: [/reasons/, /rejected/]},
        go: {all: [/[Rr]easons/, /[Rr]ejected/]},
        scala: {all: [/reasons/, /rejected/]},
        cpp: {all: [/reasons/, /rejected/]},
      },
    },
    {
      id: 'implausible-rate',
      title: 'Flags an acceptance rate above 95 percent',
      detail:
        'An acceptance rate above `UNRELIABLE_ACCEPTANCE_RATE` (0.95) is flagged as implausible rather than reported as a clean run, with a note to review a sample by hand. The draft has no ceiling at all: the better the number, the happier the response.',
      match: {
        python: {all: [/UNRELIABLE_ACCEPTANCE_RATE/, /flag/]},
        typescript: {all: [/UNRELIABLE_ACCEPTANCE_RATE/, /flag/]},
        go: {all: [/unreliableAcceptanceRate/, /[Ff]lag/]},
        scala: {all: [/UnreliableAcceptanceRate/, /flag/]},
        cpp: {all: [/kUnreliableAcceptanceRate/, /flag/]},
      },
    },
    {
      id: 'live-counters',
      title: 'Reads the live counters and reports the revision',
      detail:
        'The counts are read from Redis at request time (`HGETALL`) and the report carries the revision it was read at (`updated_at`), so a late failure shows up in the next report. The draft serves a copy written when the job started.',
      match: {
        python: {all: [/hgetall/, /updated_at/]},
        typescript: {all: [/hgetall/, /updated_at/]},
        go: {all: [/HGetAll/, /UpdatedAt/]},
        scala: {all: [/hgetAll/, /updated_at|updatedAt/]},
        cpp: {all: [/hgetall/i, /updated_at/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("distill.report")

REPORT_CACHE: dict[str, dict] = {}


@app.get("/v1/distill/jobs/{job_id}")
def read_job(job_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft serves the report it cached when the job started, and it counts accepted as
    # sampled minus the failures it remembers, so the duplicates the dedupe filter removed are
    # silently counted as good training data. Review both.
    report = REPORT_CACHE.get(job_id)
    if report is None:
        report = {"job_id": job_id, "sampled": 0, "accepted": 0, "rejected": 0}
    failures = report.get("rejected", 0)
    report["accepted"] = report["sampled"] - failures
    report["acceptance_rate"] = report["accepted"] / report["sampled"] if report["sampled"] else 0.0
    return JSONResponse(report, status_code=200)
`,
      solution: `import logging

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("distill.report")

PROGRESS_PREFIX = "distill:progress:"
REASONS_PREFIX = "distill:reasons:"
UNRELIABLE_ACCEPTANCE_RATE = 0.95

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class JobStore:
    def get(self, job_id: str) -> dict | None:
        """The job row: its status and the revision its counters were last written at."""
        raise NotImplementedError


store = JobStore()


def read_counters(job_id: str) -> tuple[dict[str, int], dict[str, int]]:
    """The live counters: a report cached at job start would never see a late failure."""
    pipe = r.pipeline()
    pipe.hgetall(PROGRESS_PREFIX + job_id)
    pipe.hgetall(REASONS_PREFIX + job_id)
    progress, reasons = pipe.execute()
    return (
        {key: int(value) for key, value in (progress or {}).items()},
        {key: int(value) for key, value in (reasons or {}).items()},
    )


def reconcile(job_id: str, counts: dict[str, int]) -> tuple[int, int, int]:
    """accepted + rejected must equal sampled: anything else is a bug, not a rounding error."""
    sampled = counts.get("sampled", 0)
    accepted = counts.get("accepted", 0)
    rejected = counts.get("rejected", 0)
    if accepted + rejected != sampled:
        raise HTTPException(status_code=409, detail=f"job {job_id} counters do not reconcile")
    return sampled, accepted, rejected


@app.get("/v1/distill/jobs/{job_id}")
def read_job(
    job_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    job = store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown job")

    counts, reasons = read_counters(job_id)
    sampled, accepted, rejected = reconcile(job_id, counts)
    rate = accepted / sampled if sampled else 0.0
    report = {
        "job_id": job_id,
        "status": job["status"],
        "sampled": sampled,
        "accepted": accepted,
        "rejected": rejected,
        "reasons": reasons,
        "acceptance_rate": rate,
        "updated_at": job["updated_at"],
        "flagged": None,
    }
    if sampled > 0 and rate > UNRELIABLE_ACCEPTANCE_RATE:
        report["flagged"] = "implausible_acceptance_rate"
        logger.warning("distill report job=%s rate=%.3f reason=implausible", job_id, rate)
    return JSONResponse(report, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/distill/jobs/{id}: a model-generated draft that serves a stale report. */
import Fastify from 'fastify';

export const app = Fastify();

const REPORT_CACHE: Record<string, Record<string, number | string>> = {};

app.get('/v1/distill/jobs/:job_id', async (request, reply) => {
  // TODO: this draft serves the report it cached when the job started, and it counts accepted as
  // sampled minus the failures it remembers, so the duplicates the dedupe filter removed are
  // silently counted as good training data. Review both.
  const {job_id: jobId} = request.params as {job_id: string};
  const report = REPORT_CACHE[jobId] ?? {job_id: jobId, sampled: 0, accepted: 0, rejected: 0};
  const sampled = Number(report.sampled ?? 0);
  const rejected = Number(report.rejected ?? 0);
  return reply.code(200).send({
    ...report,
    accepted: sampled - rejected,
    acceptance_rate: sampled > 0 ? (sampled - rejected) / sampled : 0,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/distill/jobs/{id}: the acceptance report, read from the live counters. */
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();

const PROGRESS_PREFIX = 'distill:progress:';
const REASONS_PREFIX = 'distill:reasons:';
const UNRELIABLE_ACCEPTANCE_RATE = 0.95;

const r = new Redis({host: 'redis', port: 6379});

interface JobRow {
  status: string;
  updated_at: string;
}

declare const store: {get(jobId: string): Promise<JobRow | null>};

function reconcileCounts(counts: Record<string, string>): {sampled: number; accepted: number; rejected: number} {
  const sampled = Number(counts.sampled ?? 0);
  const accepted = Number(counts.accepted ?? 0);
  const rejected = Number(counts.rejected ?? 0);
  if (accepted + rejected !== sampled) throw new Error('counters do not reconcile');
  return {sampled, accepted, rejected};
}

app.get('/v1/distill/jobs/:job_id', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const {job_id: jobId} = request.params as {job_id: string};
  const job = await store.get(jobId);
  if (job === null) return reply.code(404).send({error: 'unknown job'});

  const progress = await r.hgetall(PROGRESS_PREFIX + jobId);
  const reasons = await r.hgetall(REASONS_PREFIX + jobId);
  const counts = reconcileCounts(progress);
  const rate = counts.sampled > 0 ? counts.accepted / counts.sampled : 0;

  const report = {
    job_id: jobId,
    status: job.status,
    sampled: counts.sampled,
    accepted: counts.accepted,
    rejected: counts.rejected,
    reasons: Object.fromEntries(Object.entries(reasons).map(([reason, count]) => [reason, Number(count)])),
    acceptance_rate: rate,
    updated_at: job.updated_at,
  };
  if (counts.sampled > 0 && rate > UNRELIABLE_ACCEPTANCE_RATE) {
    request.log.warn({job_id: jobId, rate}, 'acceptance rate is implausible');
    return reply.code(200).send({...report, flagged: 'implausible_acceptance_rate'});
  }
  return reply.code(200).send({...report, flagged: null});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
)

var reportCache = map[string]map[string]any{}

func readJob(rw http.ResponseWriter, r *http.Request) {
	jobID := r.PathValue("jobID")
	// TODO: this draft serves the report it cached when the job started, and it counts accepted as
	// sampled minus the failures it remembers, so the duplicates the dedupe filter removed are
	// silently counted as good training data. Review both.
	report, ok := reportCache[jobID]
	if !ok {
		report = map[string]any{"job_id": jobID, "sampled": 0, "accepted": 0, "rejected": 0}
	}
	sampled := report["sampled"].(int)
	rejected := report["rejected"].(int)
	report["accepted"] = sampled - rejected
	if sampled > 0 {
		report["acceptance_rate"] = float64(sampled-rejected) / float64(sampled)
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(report)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/distill/jobs/{jobID}", readJob)
	http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const (
	progressPrefix           = "distill:progress:"
	reasonsPrefix            = "distill:reasons:"
	unreliableAcceptanceRate = 0.95
)

type JobRow struct {
	Status    string \`json:"status"\`
	UpdatedAt string \`json:"updated_at"\`
}

type JobStore struct{}

func (s *JobStore) Get(ctx context.Context, jobID string) (*JobRow, error) {
	return nil, nil
}

var store = &JobStore{}

var rdb *redis.Client

func reconcile(jobID string, counts map[string]string) (int, int, int, error) {
	sampled, _ := strconv.Atoi(counts["sampled"])
	accepted, _ := strconv.Atoi(counts["accepted"])
	rejected, _ := strconv.Atoi(counts["rejected"])
	if accepted + rejected != sampled {
		return 0, 0, 0, fmt.Errorf("job %s counters do not reconcile", jobID)
	}
	return sampled, accepted, rejected, nil
}

func readJob(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, \`{"error":"missing X-Tenant-Id"}\`, http.StatusUnauthorized)
		return
	}
	jobID := r.PathValue("jobID")
	job, err := store.Get(r.Context(), jobID)
	if err != nil || job == nil {
		http.Error(rw, \`{"error":"unknown job"}\`, http.StatusNotFound)
		return
	}
	progress, err := rdb.HGetAll(r.Context(), progressPrefix+jobID).Result()
	if err != nil {
		http.Error(rw, \`{"error":"counters unavailable"}\`, http.StatusServiceUnavailable)
		return
	}
	reasons, err := rdb.HGetAll(r.Context(), reasonsPrefix+jobID).Result()
	if err != nil {
		http.Error(rw, \`{"error":"counters unavailable"}\`, http.StatusServiceUnavailable)
		return
	}
	sampled, accepted, rejected, err := reconcile(jobID, progress)
	if err != nil {
		http.Error(rw, \`{"error":"counters do not reconcile"}\`, http.StatusConflict)
		return
	}
	rate := 0.0
	if sampled > 0 {
		rate = float64(accepted) / float64(sampled)
	}
	report := map[string]any{
		"job_id":          jobID,
		"status":          job.Status,
		"sampled":         sampled,
		"accepted":        accepted,
		"rejected":        rejected,
		"reasons":         reasons,
		"acceptance_rate": rate,
		"updated_at":      job.UpdatedAt,
		"flagged":         nil,
	}
	if sampled > 0 && rate > unreliableAcceptanceRate {
		report["flagged"] = "implausible_acceptance_rate"
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(report)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/distill/jobs/{jobID}", readJob)
	http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

object AcceptanceReport {
  implicit val system: ActorSystem = ActorSystem("distill-report")

  var reportCache = Map.empty[String, Map[String, Int]]

  val route: Route =
    path("v1" / "distill" / "jobs" / Segment) { jobId =>
      get {
        // TODO: this draft serves the report it cached when the job started, and it counts accepted
        // as sampled minus the failures it remembers, so the duplicates the dedupe filter removed
        // are silently counted as good training data. Review both.
        val cached = reportCache.getOrElse(jobId, Map("sampled" -> 0, "accepted" -> 0, "rejected" -> 0))
        val sampled = cached("sampled")
        val rejected = cached("rejected")
        val accepted = sampled - rejected
        val rate = if (sampled > 0) accepted.toDouble / sampled else 0.0
        complete(
          StatusCodes.OK,
          Map[String, JsValue](
            "job_id" -> JsString(jobId),
            "sampled" -> JsNumber(sampled),
            "accepted" -> JsNumber(accepted),
            "rejected" -> JsNumber(rejected),
            "acceptance_rate" -> JsNumber(rate)
          ).toJson.compactPrint
        )
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json._

object AcceptanceReport {
  implicit val system: ActorSystem = ActorSystem("distill-report")

  val ProgressPrefix = "distill:progress:"
  val ReasonsPrefix = "distill:reasons:"
  val UnreliableAcceptanceRate = 0.95

  val jedis = new Jedis("redis", 6379)
  val store = JobStore.open()

  def reconcile(jobId: String, counts: java.util.Map[String, String]): (Int, Int, Int) = {
    val sampled = Option(counts.get("sampled")).map(_.toInt).getOrElse(0)
    val accepted = Option(counts.get("accepted")).map(_.toInt).getOrElse(0)
    val rejected = Option(counts.get("rejected")).map(_.toInt).getOrElse(0)
    if (accepted + rejected != sampled) {
      throw new IllegalStateException(s"job $jobId counters do not reconcile")
    }
    (sampled, accepted, rejected)
  }

  val route: Route =
    path("v1" / "distill" / "jobs" / Segment) { jobId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            store.get(jobId) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"unknown job"}""")
              case Some(job) =>
                val counts = jedis.hgetAll(ProgressPrefix + jobId)
                val reasons = jedis.hgetAll(ReasonsPrefix + jobId)
                val (sampled, accepted, rejected) = reconcile(jobId, counts)
                val rate = if (sampled > 0) accepted.toDouble / sampled else 0.0
                val flagged = sampled > 0 && rate > UnreliableAcceptanceRate
                val report = Map[String, JsValue](
                  "job_id" -> JsString(jobId),
                  "status" -> JsString(job.status),
                  "sampled" -> JsNumber(sampled),
                  "accepted" -> JsNumber(accepted),
                  "rejected" -> JsNumber(rejected),
                  "reasons" -> reasons.toJson,
                  "acceptance_rate" -> JsNumber(rate),
                  "updated_at" -> JsString(job.updatedAt),
                  "flagged" -> (if (flagged) JsString("implausible_acceptance_rate") else JsNull)
                )
                complete(StatusCodes.OK, report.toJson.compactPrint)
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

#include <map>
#include <string>

using json = nlohmann::json;

std::map<std::string, json> reportCache;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/distill/jobs/(.*))", [](const httplib::Request& req, httplib::Response& res) {
    const auto jobId = req.matches[1].str();
    // TODO: this draft serves the report it cached when the job started, and it counts accepted as
    // sampled minus the failures it remembers, so the duplicates the dedupe filter removed are
    // silently counted as good training data. Review both.
    const auto found = reportCache.find(jobId);
    json report = found == reportCache.end()
                      ? json{{"job_id", jobId}, {"sampled", 0}, {"accepted", 0}, {"rejected", 0}}
                      : found->second;
    const long long sampled = report.value("sampled", 0);
    const long long rejected = report.value("rejected", 0);
    report["accepted"] = sampled - rejected;
    report["acceptance_rate"] = sampled > 0 ? static_cast<double>(sampled - rejected) / sampled : 0.0;
    res.status = 200;
    res.set_content(report.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>

using json = nlohmann::json;

const std::string kProgressPrefix = "distill:progress:";
const std::string kReasonsPrefix = "distill:reasons:";
constexpr double kUnreliableAcceptanceRate = 0.95;

struct JobRow {
  std::string status;
  std::string updated_at;
};

struct JobStore {
  std::optional<JobRow> get(const std::string& jobId);
};

JobStore store;
std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

struct Counts {
  long long sampled;
  long long accepted;
  long long rejected;
};

// The reconciliation invariant: accepted + rejected must equal sampled. Anything else is a bug
// in the pipeline's accounting, not a rounding error, so the report fails instead of publishing it.
Counts reconcile(const std::string& jobId, const std::unordered_map<std::string, std::string>& counters) {
  const auto read = [&counters](const std::string& field) -> long long {
    const auto found = counters.find(field);
    return found == counters.end() ? 0 : std::stoll(found->second);
  };
  const long long sampled = read("sampled");
  const long long accepted = read("accepted");
  const long long rejected = read("rejected");
  if (accepted + rejected != sampled) {
    throw std::runtime_error("job " + jobId + " counters do not reconcile");
  }
  return Counts{sampled, accepted, rejected};
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/distill/jobs/(.*))", [](const httplib::Request& req, httplib::Response& res) {
    if (req.get_header_value("X-Tenant-Id").empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto jobId = req.matches[1].str();
    const auto job = store.get(jobId);
    if (!job) {
      res.status = 404;
      res.set_content(R"({"error":"unknown job"})", "application/json");
      return;
    }
    const auto counters = redis->hgetall(kProgressPrefix + jobId);
    const auto reasons = redis->hgetall(kReasonsPrefix + jobId);
    const auto counts = reconcile(jobId, counters);
    const double rate =
        counts.sampled > 0 ? static_cast<double>(counts.accepted) / static_cast<double>(counts.sampled) : 0.0;
    json report = {{"job_id", jobId},
                   {"status", job->status},
                   {"sampled", counts.sampled},
                   {"accepted", counts.accepted},
                   {"rejected", counts.rejected},
                   {"reasons", reasons},
                   {"acceptance_rate", rate},
                   {"updated_at", job->updated_at},
                   {"flagged", nullptr}};
    if (counts.sampled > 0 && rate > kUnreliableAcceptanceRate) {
      report["flagged"] = "implausible_acceptance_rate";
    }
    res.status = 200;
    res.set_content(report.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `This is the step that decides whether a distillation run is believed. The draft passes a dashboard review because the number it reports is high; the bug is that it computed \`accepted\` as "everything that did not fail loudly", so the samples the dedupe filter removed — the ones that would have taught the student nothing — are counted as good data, which is exactly the failure the mock interview describes. The second bug is time: a report cached at job start cannot see a rejection that happened after it, so a run can look clean forever. The habits to name out loud are: read the counters live and carry their revision, reconcile the counts instead of deriving one from another, report why samples were rejected, and treat a suspiciously high acceptance rate as a reason to look rather than a reason to celebrate. Real platforms add per-slice breakdowns (by dataset shard, by teacher version), confidence bounds on the rate, and a stored sample of what the filter rejected.`,
};
