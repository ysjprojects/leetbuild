import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/metrics: cardinality is a production input',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api'],
  task: `## Task

**Starting point.** The starter registers \`POST /v1/metrics\`, parses a body of
\`{"samples": [{"metric": "…", "labels": {…}, "timestamp": 1719…, "value": 1.0}]}\` from an
\`X-Tenant-Id\` tenant and answers \`{"accepted": n}\`. It compiles, serves the demo and hides 4
flaws.

**Failure mode the checks target.** Labels are dimensions, so a label set the handler does not bound
multiplies series until one tenant's cardinality fills the store. A year-old timestamp backfills a
window that already rolled up, so the chart moves under a reader who has already looked. And a 200
written before validation reports a rejected sample as accepted; the sender deletes its buffer and the
datapoint is gone.

- A missing tenant is **401**.
- A batch carries at most **500** samples; a larger batch is **400**.
- Each sample's labels must come from the tenant's per-label allowlist, and the label set must fit
  the tenant's cardinality budget (**12** labels per sample). A sample that breaks either limit is
  **422**, and the body names the offending label.
- Each sample's \`timestamp\` must be within **3600** seconds of now; anything outside the accepted
  skew is **400**.
- Validation happens **before** the batch is acknowledged: if any sample fails, the whole batch is
  rejected with its reason, so nothing is accepted and then silently dropped.`,
  sequence: {
    participants: ['Metrics Client', 'Metrics API', 'label budget'],
    messages: [
      {from: 'Metrics Client', to: 'Metrics API', label: 'POST /v1/metrics · X-Tenant-Id · batch ≤ 500', kind: 'sync'},
      {from: 'Metrics API', to: 'Metrics API', label: 'validate metric name · labels · skew', kind: 'sync'},
      {from: 'Metrics API', to: 'label budget', label: 'check tenant allowlist and label count', kind: 'sync'},
      {from: 'label budget', to: 'Metrics API', label: 'budget left / offending label', kind: 'reply'},
      {from: 'Metrics API', to: 'Metrics Client', label: '200 accepted · 422 offending label', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/metrics',
      detail: 'Register the ingest route on `POST /v1/metrics`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/metrics["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/metrics['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/metrics"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"metrics"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/metrics"/]},
      },
    },
    {
      id: 'batch-limit',
      title: 'Caps a batch at 500 samples',
      detail:
        'A batch over **500** samples is **400**. The starter accepts any batch size, so one request can pin the ingest workers while it is parsed.',
      match: {
        python: {all: [/MAX_BATCH_SAMPLES/, /\b400\b/]},
        typescript: {all: [/MAX_BATCH_SAMPLES/, /status:\s*400/]},
        go: {all: [/maxBatchSamples/, /StatusBadRequest/]},
        scala: {all: [/MaxBatchSamples/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxBatchSamples/, /\b400\b/]},
      },
    },
    {
      id: 'label-allowlist',
      title: 'Enforces the tenant label allowlist and the cardinality budget',
      detail:
        'Every label name must be on the tenant allowlist and the label set must fit the per-sample budget (**12**); a violation is **422** naming the offending label. The starter accepts unbounded label sets, so a tenant can create series without limit.',
      match: {
        python: {all: [/LABEL_ALLOWLIST/, /MAX_LABELS_PER_SAMPLE/, /\b422\b/]},
        typescript: {all: [/LABEL_ALLOWLIST/, /MAX_LABELS_PER_SAMPLE/, /status:\s*422/]},
        go: {all: [/labelAllowlist/, /maxLabelsPerSample/, /StatusUnprocessableEntity/]},
        scala: {all: [/LabelAllowlist/, /MaxLabelsPerSample/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/kLabelAllowlist/, /kMaxLabelsPerSample/, /\b422\b/]},
      },
    },
    {
      id: 'timestamp-skew',
      title: 'Rejects timestamps outside the accepted skew',
      detail:
        'Each sample timestamp must be within **3600** seconds of now (**400** otherwise). The starter accepts timestamps a year old, so it backfills windows that already rolled up.',
      match: {
        python: {all: [/MAX_SKEW_SECONDS/, /time\.time\(\)/]},
        typescript: {all: [/MAX_SKEW_SECONDS/, /Date\.now\(\)/]},
        go: {all: [/maxSkewSeconds/, /time\.Now\(\)\.Unix\(\)/]},
        scala: {all: [/MaxSkewSeconds/, /System\.currentTimeMillis\(\)/]},
        cpp: {all: [/kMaxSkewSeconds/, /std::time\(nullptr\)/]},
      },
    },
    {
      id: 'validate-before-ack',
      title: 'Validates the batch before acknowledging it',
      detail:
        'Every sample is validated before the response is written, so a rejected batch is never acknowledged. The starter answers **200** first and validates nothing.',
      match: {
        python: {order: [/validate_batch\(/, /JSONResponse\(/]},
        typescript: {order: [/validateBatch\(/, /reply\.code\(/]},
        go: {order: [/validateBatch\(/, /WriteHeader\(/]},
        scala: {order: [/validateBatch\(/, /complete\(/]},
        cpp: {order: [/validate_batch\(/, /res\.status\s*=/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class Sample(BaseModel):
    metric: str
    labels: dict[str, str]
    timestamp: int
    value: float


class Batch(BaseModel):
    samples: list[Sample]


@app.post("/v1/metrics")
def ingest(batch: Batch, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    return JSONResponse({"accepted": len(batch.samples)}, status_code=200)
`,
      solution: `import time

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

MAX_BATCH_SAMPLES = 500
MAX_LABELS_PER_SAMPLE = 12
MAX_SKEW_SECONDS = 3600
LABEL_ALLOWLIST = {"host", "region", "service", "env", "shard"}


class Sample(BaseModel):
    metric: str
    labels: dict[str, str]
    timestamp: int
    value: float


class Batch(BaseModel):
    samples: list[Sample]


def validate_batch(batch: Batch) -> tuple[int, str]:
    """The status and reason for the first sample that fails, or (200, "ok")."""
    if len(batch.samples) > MAX_BATCH_SAMPLES:
        return 400, "batch_too_large"
    for sample in batch.samples:
        for name in sample.labels:
            if name not in LABEL_ALLOWLIST:
                return 422, name
        if len(sample.labels) > MAX_LABELS_PER_SAMPLE:
            return 422, "label_budget_exceeded"
        if abs(int(time.time()) - sample.timestamp) > MAX_SKEW_SECONDS:
            return 400, "timestamp_out_of_skew"
    return 200, "ok"


@app.post("/v1/metrics")
def ingest(batch: Batch, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    status, reason = validate_batch(batch)
    if status != 200:
        return JSONResponse({"error": reason, "tenant": tenant}, status_code=status)
    return JSONResponse({"accepted": len(batch.samples)}, status_code=200)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import type {FastifyReply, FastifyRequest} from 'fastify';

const app = Fastify();

interface Sample {
  metric: string;
  labels: Record<string, string>;
  timestamp: number;
  value: number;
}

interface Batch {
  samples: Sample[];
}

app.post('/v1/metrics', async (req: FastifyRequest, reply: FastifyReply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const batch = req.body as Batch;
  return reply.code(200).send({accepted: batch.samples.length});
});
`,
      solution: `import Fastify from 'fastify';
import type {FastifyReply, FastifyRequest} from 'fastify';

const app = Fastify();

const MAX_BATCH_SAMPLES = 500;
const MAX_LABELS_PER_SAMPLE = 12;
const MAX_SKEW_SECONDS = 3600;
const LABEL_ALLOWLIST = new Set(['host', 'region', 'service', 'env', 'shard']);

interface Sample {
  metric: string;
  labels: Record<string, string>;
  timestamp: number;
  value: number;
}

interface Batch {
  samples: Sample[];
}

function validateBatch(batch: Batch): {status: number; reason: string} {
  if (batch.samples.length > MAX_BATCH_SAMPLES) return {status: 400, reason: 'batch_too_large'};
  for (const sample of batch.samples) {
    for (const name of Object.keys(sample.labels)) {
      if (!LABEL_ALLOWLIST.has(name)) return {status: 422, reason: name};
    }
    if (Object.keys(sample.labels).length > MAX_LABELS_PER_SAMPLE)
      return {status: 422, reason: 'label_budget_exceeded'};
    if (Math.abs(Math.floor(Date.now() / 1000) - sample.timestamp) > MAX_SKEW_SECONDS)
      return {status: 400, reason: 'timestamp_out_of_skew'};
  }
  return {status: 200, reason: 'ok'};
}

app.post('/v1/metrics', async (req: FastifyRequest, reply: FastifyReply) => {
  const batch = req.body as Batch;
  const verdict = validateBatch(batch);
  if (verdict.status !== 200) return reply.code(verdict.status).send({error: verdict.reason});
  return reply.code(200).send({accepted: batch.samples.length});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
)

type Sample struct {
	Metric    string            \`json:"metric"\`
	Labels    map[string]string \`json:"labels"\`
	Timestamp int64             \`json:"timestamp"\`
	Value     float64           \`json:"value"\`
}

type Batch struct {
	Samples []Sample \`json:"samples"\`
}

func ingest(w http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	var batch Batch
	_ = json.NewDecoder(r.Body).Decode(&batch)
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]int{"accepted": len(batch.Samples)})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/metrics", ingest)
	_ = http.ListenAndServe(":8443", mux)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"time"
)

const (
	maxBatchSamples    = 500
	maxLabelsPerSample = 12
	maxSkewSeconds     = 3600
)

var labelAllowlist = map[string]bool{
	"host": true, "region": true, "service": true, "env": true, "shard": true,
}

type Sample struct {
	Metric    string            \`json:"metric"\`
	Labels    map[string]string \`json:"labels"\`
	Timestamp int64             \`json:"timestamp"\`
	Value     float64           \`json:"value"\`
}

type Batch struct {
	Samples []Sample \`json:"samples"\`
}

func validateBatch(batch Batch) (int, string) {
	if len(batch.Samples) > maxBatchSamples {
		return http.StatusBadRequest, "batch_too_large"
	}
	for _, sample := range batch.Samples {
		for name := range sample.Labels {
			if !labelAllowlist[name] {
				return http.StatusUnprocessableEntity, name
			}
		}
		if len(sample.Labels) > maxLabelsPerSample {
			return http.StatusUnprocessableEntity, "label_budget_exceeded"
		}
		delta := time.Now().Unix() - sample.Timestamp
		if delta > maxSkewSeconds || delta < -maxSkewSeconds {
			return http.StatusBadRequest, "timestamp_out_of_skew"
		}
	}
	return http.StatusOK, "ok"
}

func ingest(w http.ResponseWriter, r *http.Request) {
	var batch Batch
	if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	status, reason := validateBatch(batch)
	w.Header().Set("Content-Type", "application/json")
	if status != http.StatusOK {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": reason})
		return
	}
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]int{"accepted": len(batch.Samples)})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/metrics", ingest)
	_ = http.ListenAndServe(":8443", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._

final case class Sample(metric: String, labels: Map[String, String], timestamp: Long, value: Double)
final case class Batch(samples: List[Sample])

object Api {
  implicit val sampleFormat = jsonFormat4(Sample)
  implicit val batchFormat = jsonFormat1(Batch)

  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  val routes: Route = path("v1" / "metrics") {
    post {
      entity(as[Batch]) { batch =>
        complete(StatusCodes.OK -> s"accepted=\${batch.samples.length}")
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._

final case class Sample(metric: String, labels: Map[String, String], timestamp: Long, value: Double)
final case class Batch(samples: List[Sample])

object Api {
  implicit val sampleFormat = jsonFormat4(Sample)
  implicit val batchFormat = jsonFormat1(Batch)

  val MaxBatchSamples: Int = 500
  val MaxLabelsPerSample: Int = 12
  val MaxSkewSeconds: Long = 3600
  val LabelAllowlist: Set[String] = Set("host", "region", "service", "env", "shard")

  def validateBatch(batch: Batch): Option[String] = {
    if (batch.samples.length > MaxBatchSamples) Some("batch_too_large")
    else
      batch.samples.view
        .flatMap { sample =>
          sample.labels.keys
            .find(name => !LabelAllowlist.contains(name))
            .orElse(if (sample.labels.size > MaxLabelsPerSample) Some("label_budget_exceeded") else None)
            .orElse(
              if (Math.abs(System.currentTimeMillis() / 1000 - sample.timestamp) > MaxSkewSeconds)
                Some("timestamp_out_of_skew")
              else None,
            )
        }
        .headOption
  }

  val routes: Route = path("v1" / "metrics") {
    post {
      entity(as[Batch]) { batch =>
        validateBatch(batch) match {
          case Some("batch_too_large") => complete(StatusCodes.BadRequest -> "batch_too_large")
          case Some(reason)            => complete(StatusCodes.UnprocessableEntity -> reason)
          case None                    => complete(StatusCodes.OK -> s"accepted=\${batch.samples.length}")
        }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

int main() {
  httplib::Server svr;
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  svr.Post("/v1/metrics", [](const httplib::Request& req, httplib::Response& res) {
    const json batch = json::parse(req.body);
    res.status = 200;
    res.set_content("{\\"accepted\\":true}", "application/json");
  });
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cmath>
#include <ctime>
#include <set>
#include <string>

using json = nlohmann::json;

static const int kMaxBatchSamples = 500;
static const int kMaxLabelsPerSample = 12;
static const long kMaxSkewSeconds = 3600;
static const std::set<std::string> kLabelAllowlist = {"host", "region", "service", "env", "shard"};

static std::string validate_batch(const json& batch) {
  if (static_cast<int>(batch["samples"].size()) > kMaxBatchSamples) return "batch_too_large";
  for (const auto& sample : batch["samples"]) {
    for (auto it = sample["labels"].begin(); it != sample["labels"].end(); ++it) {
      if (kLabelAllowlist.find(it.key()) == kLabelAllowlist.end()) return it.key();
    }
    if (static_cast<int>(sample["labels"].size()) > kMaxLabelsPerSample) return "label_budget_exceeded";
    const long ts = sample["timestamp"].get<long>();
    if (std::labs(static_cast<long>(std::time(nullptr)) - ts) > kMaxSkewSeconds) return "timestamp_out_of_skew";
  }
  return "";
}

int main() {
  httplib::Server svr;
  svr.Post("/v1/metrics", [](const httplib::Request& req, httplib::Response& res) {
    const json batch = json::parse(req.body);
    const std::string reason = validate_batch(batch);
    if (reason == "batch_too_large") {
      res.status = 400;
      res.set_content(reason, "application/json");
      return;
    }
    if (!reason.empty()) {
      res.status = 422;
      res.set_content(reason, "application/json");
      return;
    }
    res.status = 200;
    res.set_content("{\\"accepted\\":true}", "application/json");
  });
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'A batch with a 13-label sample or a timestamp from last year returns 200 and the sender drops its buffer, yet the datapoint is missing from the chart and the series count keeps climbing.',
    'The handler builds the 200 from `len(batch.samples)` before any field is inspected, so there is no path that can answer 400 or 422 for a bad sample.',
    'Call `validate_batch` first: cap the batch at `MAX_BATCH_SAMPLES`, check each label against `LABEL_ALLOWLIST` and `MAX_LABELS_PER_SAMPLE` (422, naming the label), and reject timestamps beyond `MAX_SKEW_SECONDS` (400).',
  ],
  debrief: `Every field of an ingest batch is a claim the handler has to check before it writes anything, which is why the fix runs the whole validation pass before the first byte of the response. Labels are dimensions: bounding them per sample and per tenant is what keeps one tenant's label explosion from becoming everyone's store. The skew check is a freshness contract with readers; a window that already rolled up must not move. Rejecting the whole batch, with the offending label named, gives the sender's retry loop something it can act on. Beyond this step, production ingest enforces cardinality as a running per-tenant series count rather than a per-sample budget, and offers partial success only where the sender can retry the failed samples individually.`,
};
