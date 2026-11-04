import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/metrics: a batch is validated whole before it is acknowledged',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/metrics\` with \`{"batch_id": "…", "samples":
[{"metric", "labels", "timestamp", "value"}]}\` for the \`X-Tenant-Id\` tenant (401 without one): it
drops the samples whose metric name is malformed, hands the rest to \`merge_batch\` (provided as
\`metrics.windows\`) and answers \`{"accepted": n, "applied": …}\`. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** One tenant's label explosion multiplies series until the store
fills; a sample from yesterday rewrites a window that already rolled up; and a 200 for a batch the
handler partly dropped tells the sender to delete datapoints that were never stored.

- \`MAX_BATCH_SAMPLES = 500\`: a larger batch is **400** \`batch_too_large\`.
- Every label name is in \`allowed_labels(tenant)\` (\`metrics.model\`), else **422**
  \`label_not_allowed\` naming the label; at most \`MAX_LABELS_PER_SAMPLE = 8\` labels, else **422**
  \`too_many_labels\`.
- A timestamp more than \`MAX_SKEW_SECONDS = 3600\` from now, either way, is **400**
  \`timestamp_out_of_skew\`.
- A malformed metric name is **400** \`invalid_metric\`. \`validate_batch\` checks the whole batch
  before \`merge_batch\` runs, so a rejected batch writes nothing and leaves its \`batch_id\` unclaimed.`,
  sequence: {
    participants: ['Metrics client', 'metricsd', 'label policy', 'Redis'],
    messages: [
      {from: 'Metrics client', to: 'metricsd', label: 'POST /v1/metrics · X-Tenant-Id · ≤ 500 samples', kind: 'sync'},
      {from: 'metricsd', to: 'label policy', label: 'allowed_labels(tenant)', kind: 'sync'},
      {from: 'metricsd', to: 'metricsd', label: 'validate_batch: names · labels ≤ 8 · skew ≤ 3600 s', kind: 'sync'},
      {from: 'metricsd', to: 'Metrics client', label: '400 / 422 naming the sample · nothing written', kind: 'reply'},
      {from: 'metricsd', to: 'Redis', label: 'merge_batch(tenant, batch_id, samples)', kind: 'sync'},
      {from: 'metricsd', to: 'Metrics client', label: '200 {accepted, applied}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/metrics for a tenant',
      detail:
        'Register `POST /v1/metrics`, answer **401** without `X-Tenant-Id`, and hand a valid batch to `merge_batch`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/metrics["']/, /merge_batch\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/metrics['"]/, /mergeBatch\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/metrics"/, /windows\.MergeBatch\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"metrics"\s*\)/, /Windows\.mergeBatch\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/metrics"/, /metrics::mergeBatch\(/]},
      },
    },
    {
      id: 'batch-limit',
      title: 'Caps a batch at 500 samples',
      detail:
        'A batch of more than `MAX_BATCH_SAMPLES` (500) samples is **400** `batch_too_large` and nothing is merged. The starter merges a batch of any size.',
      match: {
        python: {all: [/MAX_BATCH_SAMPLES\s*=\s*500\b/, />\s*MAX_BATCH_SAMPLES/, /batch_too_large/]},
        typescript: {all: [/MAX_BATCH_SAMPLES\s*=\s*500\b/, />\s*MAX_BATCH_SAMPLES/, /batch_too_large/]},
        go: {all: [/maxBatchSamples\s*=\s*500\b/, />\s*maxBatchSamples/, /batch_too_large/]},
        scala: {all: [/MaxBatchSamples\s*=\s*500\b/, />\s*MaxBatchSamples/, /batch_too_large/]},
        cpp: {all: [/kMaxBatchSamples\s*=\s*500\b/, />\s*kMaxBatchSamples/, /batch_too_large/]},
      },
    },
    {
      id: 'label-budget',
      title: "Enforces the tenant's label allowlist and the label budget",
      detail:
        'Every label name must be in `allowed_labels(tenant)` and a sample carries at most `MAX_LABELS_PER_SAMPLE` (8) labels; a violation is **422** naming the label (`label_not_allowed`) or `too_many_labels`. The starter accepts any label set, so one tenant can mint series without limit.',
      match: {
        python: {
          all: [/allowed_labels\(\s*tenant\s*\)/, /MAX_LABELS_PER_SAMPLE\s*=\s*8\b/, /\b422\b/, /label_not_allowed/],
        },
        typescript: {
          all: [/allowedLabels\(\s*tenant\s*\)/, /MAX_LABELS_PER_SAMPLE\s*=\s*8\b/, /\b422\b/, /label_not_allowed/],
        },
        go: {
          all: [
            /model\.AllowedLabels\(\s*tenant\s*\)/,
            /maxLabelsPerSample\s*=\s*8\b/,
            /StatusUnprocessableEntity|\b422\b/,
            /label_not_allowed/,
          ],
        },
        scala: {
          all: [
            /allowedLabels\(\s*tenant\s*\)/,
            /MaxLabelsPerSample\s*=\s*8\b/,
            /UnprocessableEntity|\b422\b/,
            /label_not_allowed/,
          ],
        },
        cpp: {
          all: [
            /metrics::allowedLabels\(\s*tenant\s*\)/,
            /kMaxLabelsPerSample\s*=\s*8\b/,
            /\b422\b/,
            /label_not_allowed/,
          ],
        },
      },
    },
    {
      id: 'timestamp-skew',
      title: 'Rejects timestamps outside the accepted skew',
      detail:
        'A sample more than `MAX_SKEW_SECONDS` (3600) away from now, in the past or the future, is **400** `timestamp_out_of_skew`. The starter accepts a timestamp from yesterday and adds it to a window that already rolled up.',
      match: {
        python: {all: [/MAX_SKEW_SECONDS\s*=\s*3600\b/, /time\.time\(\)/, /timestamp_out_of_skew/]},
        typescript: {all: [/MAX_SKEW_SECONDS\s*=\s*3600\b/, /Date\.now\(\)/, /timestamp_out_of_skew/]},
        go: {all: [/maxSkewSeconds\s*=\s*3600\b/, /time\.Now\(\)/, /timestamp_out_of_skew/]},
        scala: {all: [/MaxSkewSeconds\s*=\s*3600L?\b/, /currentTimeMillis|Instant\.now/, /timestamp_out_of_skew/]},
        cpp: {all: [/kMaxSkewSeconds\s*=\s*3600\b/, /system_clock::now\(\)/, /timestamp_out_of_skew/]},
      },
    },
    {
      id: 'validate-before-ack',
      title: 'Rejects the whole batch before anything is merged',
      detail:
        '`validate_batch` runs over every sample before `merge_batch`; a malformed metric name is **400** `invalid_metric`, nothing is written and the `batch_id` stays unclaimed for the corrected retry. The starter drops the bad samples, merges the rest and answers 200 for all of them.',
      match: {
        python: {
          all: [/invalid_metric/],
          order: [/(?<!def )validate_batch\(/, /merge_batch\(/],
          none: [/for \w+ in batch\.samples if /],
        },
        typescript: {
          all: [/invalid_metric/],
          order: [/(?<!function )validateBatch\(/, /mergeBatch\(/],
          none: [/samples\.filter\(/],
        },
        go: {
          all: [/invalid_metric/],
          order: [/(?<!func )validateBatch\(/, /windows\.MergeBatch\(/],
          none: [/\bkept\b/],
        },
        scala: {
          all: [/invalid_metric/],
          order: [/(?<!def )validateBatch\(/, /Windows\.mergeBatch\(/],
          none: [/\.filter\(/],
        },
        cpp: {all: [/invalid_metric/], order: [/(?<!> )validateBatch\(/, /metrics::mergeBatch\(/], none: [/\bkept\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import re

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from metrics.model import allowed_labels
from metrics.windows import merge_batch  # merge_batch(tenant, batch_id, samples) -> bool

app = FastAPI()

METRIC_NAME = re.compile(r"[a-zA-Z_:][a-zA-Z0-9_:]*")


class Sample(BaseModel):
    metric: str
    labels: dict[str, str] = {}
    timestamp: int
    value: float


class Batch(BaseModel):
    batch_id: str
    samples: list[Sample]


@app.post("/v1/metrics")
def ingest(batch: Batch, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "missing_tenant"}, status_code=401)
    samples = [s.model_dump() for s in batch.samples if METRIC_NAME.fullmatch(s.metric)]
    applied = merge_batch(tenant, batch.batch_id, samples)
    return JSONResponse({"accepted": len(batch.samples), "applied": applied})
`,
      solution: `import re
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from metrics.model import allowed_labels
from metrics.windows import merge_batch  # merge_batch(tenant, batch_id, samples) -> bool

app = FastAPI()

METRIC_NAME = re.compile(r"[a-zA-Z_:][a-zA-Z0-9_:]*")
MAX_BATCH_SAMPLES = 500
MAX_LABELS_PER_SAMPLE = 8
MAX_SKEW_SECONDS = 3600


class Sample(BaseModel):
    metric: str
    labels: dict[str, str] = {}
    timestamp: int
    value: float


class Batch(BaseModel):
    batch_id: str
    samples: list[Sample]


def validate_batch(tenant: str, batch: Batch) -> JSONResponse | None:
    """The rejection for the first sample that breaks a rule, or None when the whole batch is valid."""
    if len(batch.samples) > MAX_BATCH_SAMPLES:
        return JSONResponse({"error": "batch_too_large", "limit": MAX_BATCH_SAMPLES}, status_code=400)
    allowed = allowed_labels(tenant)
    now = int(time.time())
    for i, sample in enumerate(batch.samples):
        if not METRIC_NAME.fullmatch(sample.metric):
            return JSONResponse({"error": "invalid_metric", "sample": i, "metric": sample.metric}, status_code=400)
        for name in sorted(sample.labels):
            if name not in allowed:
                return JSONResponse({"error": "label_not_allowed", "sample": i, "label": name}, status_code=422)
        if len(sample.labels) > MAX_LABELS_PER_SAMPLE:
            return JSONResponse({"error": "too_many_labels", "sample": i, "limit": MAX_LABELS_PER_SAMPLE}, status_code=422)
        if abs(now - sample.timestamp) > MAX_SKEW_SECONDS:
            return JSONResponse({"error": "timestamp_out_of_skew", "sample": i}, status_code=400)
    return None


@app.post("/v1/metrics")
def ingest(batch: Batch, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "missing_tenant"}, status_code=401)
    # The whole batch is judged before anything is written: a 200 means every sample is stored.
    rejected = validate_batch(tenant, batch)
    if rejected is not None:
        return rejected
    applied = merge_batch(tenant, batch.batch_id, [s.model_dump() for s in batch.samples])
    return JSONResponse({"accepted": len(batch.samples), "applied": applied})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type Sample, allowedLabels} from 'metrics/model';
import {mergeBatch} from 'metrics/windows'; // mergeBatch(tenant, batchId, samples): Promise<boolean>

export const app = Fastify();

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

interface Batch {
  batch_id: string;
  samples: Sample[];
}

app.post('/v1/metrics', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing_tenant'});
  const batch = request.body as Batch;
  const samples = batch.samples.filter(s => METRIC_NAME.test(s.metric));
  const applied = await mergeBatch(tenant, batch.batch_id, samples);
  return {accepted: batch.samples.length, applied};
});
`,
      solution: `import Fastify from 'fastify';

import {type Sample, allowedLabels} from 'metrics/model';
import {mergeBatch} from 'metrics/windows'; // mergeBatch(tenant, batchId, samples): Promise<boolean>

export const app = Fastify();

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const MAX_BATCH_SAMPLES = 500;
const MAX_LABELS_PER_SAMPLE = 8;
const MAX_SKEW_SECONDS = 3600;

interface Batch {
  batch_id: string;
  samples: Sample[];
}

interface Rejection {
  status: number;
  body: Record<string, unknown>;
}

/** The rejection for the first sample that breaks a rule, or null when the whole batch is valid. */
function validateBatch(tenant: string, batch: Batch): Rejection | null {
  if (batch.samples.length > MAX_BATCH_SAMPLES) return {status: 400, body: {error: 'batch_too_large', limit: MAX_BATCH_SAMPLES}};
  const allowed = allowedLabels(tenant);
  const now = Math.floor(Date.now() / 1000);
  for (const [i, sample] of batch.samples.entries()) {
    if (!METRIC_NAME.test(sample.metric)) return {status: 400, body: {error: 'invalid_metric', sample: i, metric: sample.metric}};
    const names = Object.keys(sample.labels ?? {}).sort();
    const unknown = names.find(name => !allowed.has(name));
    if (unknown !== undefined) return {status: 422, body: {error: 'label_not_allowed', sample: i, label: unknown}};
    if (names.length > MAX_LABELS_PER_SAMPLE) return {status: 422, body: {error: 'too_many_labels', sample: i, limit: MAX_LABELS_PER_SAMPLE}};
    if (Math.abs(now - sample.timestamp) > MAX_SKEW_SECONDS) return {status: 400, body: {error: 'timestamp_out_of_skew', sample: i}};
  }
  return null;
}

app.post('/v1/metrics', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing_tenant'});
  const batch = request.body as Batch;
  // The whole batch is judged before anything is written: a 200 means every sample is stored.
  const rejected = validateBatch(tenant, batch);
  if (rejected !== null) return reply.code(rejected.status).send(rejected.body);
  const applied = await mergeBatch(tenant, batch.batch_id, batch.samples);
  return {accepted: batch.samples.length, applied};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"regexp"

	"metrics/model"   // model.Sample, model.AllowedLabels(tenant)
	"metrics/windows" // windows.MergeBatch(ctx, tenant, batchID, samples) (bool, error)
)

var metricName = regexp.MustCompile(\`^[a-zA-Z_:][a-zA-Z0-9_:]*$\`)

type batch struct {
	BatchID string         \`json:"batch_id"\`
	Samples []model.Sample \`json:"samples"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func ingest(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing_tenant"})
		return
	}
	var b batch
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_body"})
		return
	}
	kept := []model.Sample{}
	for _, s := range b.Samples {
		if metricName.MatchString(s.Metric) {
			kept = append(kept, s)
		}
	}
	applied, err := windows.MergeBatch(r.Context(), tenant, b.BatchID, kept)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"accepted": len(b.Samples), "applied": applied})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/metrics", ingest)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"regexp"
	"sort"
	"time"

	"metrics/model"   // model.Sample, model.AllowedLabels(tenant)
	"metrics/windows" // windows.MergeBatch(ctx, tenant, batchID, samples) (bool, error)
)

const (
	maxBatchSamples    = 500
	maxLabelsPerSample = 8
	maxSkewSeconds     = 3600
)

var metricName = regexp.MustCompile(\`^[a-zA-Z_:][a-zA-Z0-9_:]*$\`)

type batch struct {
	BatchID string         \`json:"batch_id"\`
	Samples []model.Sample \`json:"samples"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// validateBatch is the status and body for the first sample that breaks a rule, or 0 when the whole batch is valid.
func validateBatch(tenant string, b batch) (int, map[string]any) {
	if len(b.Samples) > maxBatchSamples {
		return http.StatusBadRequest, map[string]any{"error": "batch_too_large", "limit": maxBatchSamples}
	}
	allowed := model.AllowedLabels(tenant)
	now := time.Now().Unix()
	for i, s := range b.Samples {
		if !metricName.MatchString(s.Metric) {
			return http.StatusBadRequest, map[string]any{"error": "invalid_metric", "sample": i, "metric": s.Metric}
		}
		names := make([]string, 0, len(s.Labels))
		for name := range s.Labels {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			if !allowed[name] {
				return http.StatusUnprocessableEntity, map[string]any{"error": "label_not_allowed", "sample": i, "label": name}
			}
		}
		if len(names) > maxLabelsPerSample {
			return http.StatusUnprocessableEntity, map[string]any{"error": "too_many_labels", "sample": i, "limit": maxLabelsPerSample}
		}
		if skew := now - s.Timestamp; skew > maxSkewSeconds || skew < -maxSkewSeconds {
			return http.StatusBadRequest, map[string]any{"error": "timestamp_out_of_skew", "sample": i}
		}
	}
	return 0, nil
}

func ingest(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing_tenant"})
		return
	}
	var b batch
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_body"})
		return
	}
	// The whole batch is judged before anything is written: a 200 means every sample is stored.
	if status, rejection := validateBatch(tenant, b); status != 0 {
		writeJSON(rw, status, rejection)
		return
	}
	applied, err := windows.MergeBatch(r.Context(), tenant, b.BatchID, b.Samples)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"accepted": len(b.Samples), "applied": applied})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/metrics", ingest)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import metrics.Model.{Sample, allowedLabels}
import metrics.Windows // Windows.mergeBatch(tenant, batchId, samples): Boolean

object Api {
  private val MetricName = "[a-zA-Z_:][a-zA-Z0-9_:]*".r

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def parseSample(js: JsValue): Sample = {
    val f = js.asJsObject.fields
    Sample(
      f.get("metric").collect { case JsString(s) => s }.getOrElse(""),
      f.get("labels").map(_.asJsObject.fields.collect { case (name, JsString(value)) => name -> value }).getOrElse(Map.empty),
      f.get("timestamp").collect { case JsNumber(n) => n.toLong }.getOrElse(0L),
      f.get("value").collect { case JsNumber(n) => n.toDouble }.getOrElse(0.0)
    )
  }

  val route: Route = path("v1" / "metrics") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("missing_tenant"))))
        case Some(tenant) =>
          entity(as[String]) { raw =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            val body = raw.parseJson.asJsObject.fields
            val batchId = body.get("batch_id").collect { case JsString(s) => s }.getOrElse("")
            val samples = body.get("samples").collect { case JsArray(items) => items.map(parseSample) }.getOrElse(Vector.empty)
            val applied = Windows.mergeBatch(tenant, batchId, samples.filter(s => MetricName.matches(s.metric)))
            complete(json(StatusCodes.OK, JsObject("accepted" -> JsNumber(samples.size), "applied" -> JsBoolean(applied))))
          }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import metrics.Model.{Sample, allowedLabels}
import metrics.Windows // Windows.mergeBatch(tenant, batchId, samples): Boolean

object Api {
  private val MetricName = "[a-zA-Z_:][a-zA-Z0-9_:]*".r
  val MaxBatchSamples = 500
  val MaxLabelsPerSample = 8
  val MaxSkewSeconds = 3600L

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def parseSample(js: JsValue): Sample = {
    val f = js.asJsObject.fields
    Sample(
      f.get("metric").collect { case JsString(s) => s }.getOrElse(""),
      f.get("labels").map(_.asJsObject.fields.collect { case (name, JsString(value)) => name -> value }).getOrElse(Map.empty),
      f.get("timestamp").collect { case JsNumber(n) => n.toLong }.getOrElse(0L),
      f.get("value").collect { case JsNumber(n) => n.toDouble }.getOrElse(0.0)
    )
  }

  private def rejection(error: String, i: Int): JsObject = JsObject("error" -> JsString(error), "sample" -> JsNumber(i))

  /** The rejection for the first sample that breaks a rule, or None when the whole batch is valid. */
  def validateBatch(tenant: String, samples: Seq[Sample]): Option[(StatusCode, JsObject)] =
    if (samples.size > MaxBatchSamples) Some(StatusCodes.BadRequest -> JsObject("error" -> JsString("batch_too_large"), "limit" -> JsNumber(MaxBatchSamples)))
    else {
      val allowed = allowedLabels(tenant)
      val now = System.currentTimeMillis() / 1000
      samples.zipWithIndex.view.flatMap { case (s, i) =>
        val unknown = s.labels.keys.toSeq.sorted.find(name => !allowed(name))
        if (!MetricName.matches(s.metric)) Some(StatusCodes.BadRequest -> rejection("invalid_metric", i))
        else if (unknown.isDefined) Some(StatusCodes.UnprocessableEntity -> JsObject(rejection("label_not_allowed", i).fields + ("label" -> JsString(unknown.get))))
        else if (s.labels.size > MaxLabelsPerSample) Some(StatusCodes.UnprocessableEntity -> rejection("too_many_labels", i))
        else if (math.abs(now - s.timestamp) > MaxSkewSeconds) Some(StatusCodes.BadRequest -> rejection("timestamp_out_of_skew", i))
        else None
      }.headOption
    }

  val route: Route = path("v1" / "metrics") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("missing_tenant"))))
        case Some(tenant) =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject.fields
            val batchId = body.get("batch_id").collect { case JsString(s) => s }.getOrElse("")
            val samples = body.get("samples").collect { case JsArray(items) => items.map(parseSample) }.getOrElse(Vector.empty)
            // The whole batch is judged before anything is written: a 200 means every sample is stored.
            validateBatch(tenant, samples) match {
              case Some((status, body)) => complete(json(status, body))
              case None =>
                val applied = Windows.mergeBatch(tenant, batchId, samples)
                complete(json(StatusCodes.OK, JsObject("accepted" -> JsNumber(samples.size), "applied" -> JsBoolean(applied))))
            }
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

#include <cctype>
#include <map>
#include <string>
#include <vector>

#include "metrics/model.h"    // metrics::Sample, metrics::allowedLabels(tenant)
#include "metrics/windows.h"  // metrics::mergeBatch(tenant, batch_id, samples) -> bool

using json = nlohmann::json;

// [a-zA-Z_:][a-zA-Z0-9_:]*
bool validMetricName(const std::string& name) {
  if (name.empty() || std::isdigit(static_cast<unsigned char>(name[0]))) return false;
  for (char c : name) {
    if (!std::isalnum(static_cast<unsigned char>(c)) && c != '_' && c != ':') return false;
  }
  return true;
}

std::vector<metrics::Sample> parseSamples(const json& body) {
  std::vector<metrics::Sample> out;
  for (const json& s : body.value("samples", json::array())) {
    out.push_back(metrics::Sample{s.value("metric", ""), s.value("labels", std::map<std::string, std::string>{}),
                                  s.value("timestamp", 0LL), s.value("value", 0.0)});
  }
  return out;
}

void ingest(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing_tenant"})", "application/json");
    return;
  }
  const json body = json::parse(req.body, nullptr, false);
  const std::vector<metrics::Sample> samples = parseSamples(body);
  std::vector<metrics::Sample> kept;
  for (const metrics::Sample& s : samples) {
    if (validMetricName(s.metric)) kept.push_back(s);
  }
  const bool applied = metrics::mergeBatch(tenant, body.value("batch_id", ""), kept);
  res.set_content(json{{"accepted", samples.size()}, {"applied", applied}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/metrics", ingest); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cctype>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "metrics/model.h"    // metrics::Sample, metrics::allowedLabels(tenant)
#include "metrics/windows.h"  // metrics::mergeBatch(tenant, batch_id, samples) -> bool

using json = nlohmann::json;

constexpr size_t kMaxBatchSamples = 500;
constexpr size_t kMaxLabelsPerSample = 8;
constexpr long long kMaxSkewSeconds = 3600;

// [a-zA-Z_:][a-zA-Z0-9_:]*
bool validMetricName(const std::string& name) {
  if (name.empty() || std::isdigit(static_cast<unsigned char>(name[0]))) return false;
  for (char c : name) {
    if (!std::isalnum(static_cast<unsigned char>(c)) && c != '_' && c != ':') return false;
  }
  return true;
}

std::vector<metrics::Sample> parseSamples(const json& body) {
  std::vector<metrics::Sample> out;
  for (const json& s : body.value("samples", json::array())) {
    out.push_back(metrics::Sample{s.value("metric", ""), s.value("labels", std::map<std::string, std::string>{}),
                                  s.value("timestamp", 0LL), s.value("value", 0.0)});
  }
  return out;
}

// The rejection (status, body) for the first sample that breaks a rule, or none when the whole batch is valid.
std::optional<std::pair<int, json>> validateBatch(const std::string& tenant, const std::vector<metrics::Sample>& samples) {
  if (samples.size() > kMaxBatchSamples) return std::make_pair(400, json{{"error", "batch_too_large"}, {"limit", kMaxBatchSamples}});
  const auto allowed = metrics::allowedLabels(tenant);
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  for (size_t i = 0; i < samples.size(); i++) {
    const metrics::Sample& s = samples[i];
    if (!validMetricName(s.metric)) return std::make_pair(400, json{{"error", "invalid_metric"}, {"sample", i}, {"metric", s.metric}});
    for (const auto& [name, value] : s.labels) {  // std::map: sorted by name
      if (allowed.count(name) == 0) return std::make_pair(422, json{{"error", "label_not_allowed"}, {"sample", i}, {"label", name}});
    }
    if (s.labels.size() > kMaxLabelsPerSample) return std::make_pair(422, json{{"error", "too_many_labels"}, {"sample", i}, {"limit", kMaxLabelsPerSample}});
    if (std::llabs(now - s.timestamp) > kMaxSkewSeconds) return std::make_pair(400, json{{"error", "timestamp_out_of_skew"}, {"sample", i}});
  }
  return std::nullopt;
}

void ingest(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing_tenant"})", "application/json");
    return;
  }
  const json body = json::parse(req.body, nullptr, false);
  const std::vector<metrics::Sample> samples = parseSamples(body);
  // The whole batch is judged before anything is written: a 200 means every sample is stored.
  if (const auto rejected = validateBatch(tenant, samples)) {
    res.status = rejected->first;
    res.set_content(rejected->second.dump(), "application/json");
    return;
  }
  const bool applied = metrics::mergeBatch(tenant, body.value("batch_id", ""), samples);
  res.set_content(json{{"accepted", samples.size()}, {"applied", applied}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/metrics", ingest); }
`,
    },
  },
  harness: {
    python: `import time

from metrics.model import series_id, window_start
from metrics.windows import window_key

HOST = {"host": "a", "region": "eu"}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


def _sample(metric="http_requests", labels=None, ago=5, value=1.0):
    return {"metric": metric, "labels": dict(HOST) if labels is None else labels, "timestamp": int(time.time()) - ago, "value": value}


async def _post(c, samples, batch_id="b-1", tenant="acme"):
    headers = {"X-Tenant-Id": tenant} if tenant else {}
    return await c.post("/v1/metrics", json={"batch_id": batch_id, "samples": samples}, headers=headers)


def _key(sample, tenant="acme"):
    return window_key(tenant, series_id(sample["metric"], sample["labels"]), window_start(sample["timestamp"]))


def _written(ctx):
    return sorted(ctx.redis.keys("win:*")) + sorted(ctx.redis.keys("batch:*"))


async def check_route(ctx):
    a, b = _sample(value=2.0), _sample(value=3.0)
    async with _api(ctx) as c:
        r = await _post(c, [a, b])
        assert r.status_code == 200, f"a valid batch answered {r.status_code}: {r.text}"
        assert r.json() == {"accepted": 2, "applied": True}, f"a valid batch of 2 samples must answer {{accepted: 2, applied: true}}, got {r.json()}"
        stored = ctx.redis.hgetall(_key(a))
        assert stored.get("count") == "2" and float(stored.get("sum", 0)) == 5.0, f"{_key(a)} holds {stored} after the batch, expected count 2 and sum 5"
        r = await _post(c, [a], batch_id="b-2", tenant="")
    assert r.status_code == 401, f"a batch without X-Tenant-Id answered {r.status_code}, expected 401"


async def check_batch_limit(ctx):
    async with _api(ctx) as c:
        r = await _post(c, [_sample(value=float(i)) for i in range(501)])
        assert r.status_code == 400 and "batch_too_large" in r.text, f"a batch of 501 samples answered {r.status_code} {r.text}, expected 400 batch_too_large"
        assert _written(ctx) == [], f"a rejected batch wrote {_written(ctx)[:3]}…: nothing may be merged"
        r = await _post(c, [_sample(value=1.0) for _ in range(500)], batch_id="b-2")
    assert r.status_code == 200, f"a batch of exactly 500 samples answered {r.status_code}: {r.text}"


async def check_label_budget(ctx):
    async with _api(ctx) as c:
        r = await _post(c, [_sample(), _sample(labels={**HOST, "user_id": "u-81"})])
        assert r.status_code == 422 and "user_id" in r.text, f"a sample labelled user_id answered {r.status_code} {r.text}, expected 422 naming user_id: every user id would mint a series"
        assert _written(ctx) == [], f"a batch with a label outside the allowlist wrote {_written(ctx)}"
        r = await _post(c, [_sample(labels={"host": "a", "pod": "p-1"})], batch_id="b-2", tenant="globex")
        assert r.status_code == 422 and "pod" in r.text, f"globex sent the label pod, which only acme may send, and got {r.status_code} {r.text}: the allowlist is per tenant"
        nine = {name: "x" for name in ("env", "host", "job", "method", "pod", "region", "route", "service", "status")}
        r = await _post(c, [_sample(labels=nine)], batch_id="b-3")
        assert r.status_code == 422 and "too_many_labels" in r.text, f"a sample with 9 labels answered {r.status_code} {r.text}, expected 422 too_many_labels"
        eight = {name: "x" for name in ("env", "host", "job", "method", "pod", "region", "route", "service")}
        r = await _post(c, [_sample(labels=eight)], batch_id="b-4")
    assert r.status_code == 200, f"a sample with 8 allowed labels answered {r.status_code}: {r.text}"


async def check_timestamp_skew(ctx):
    async with _api(ctx) as c:
        for ago, when in ((7200, "two hours old"), (-7200, "two hours in the future")):
            r = await _post(c, [_sample(), _sample(ago=ago)], batch_id=f"b{ago}")
            assert r.status_code == 400 and "timestamp_out_of_skew" in r.text, f"a sample {when} answered {r.status_code} {r.text}, expected 400 timestamp_out_of_skew: it would rewrite a window readers already saw"
        assert _written(ctx) == [], f"a batch with a stale sample wrote {_written(ctx)}"
        late = _sample(ago=3500)
        r = await _post(c, [late], batch_id="b-ok")
    assert r.status_code == 200, f"a sample 3500 s old is within the skew and answered {r.status_code}: {r.text}"
    assert ctx.redis.exists(_key(late)) == 1, f"the sample 3500 s old was not merged into {_key(late)}"


async def check_validate_before_ack(ctx):
    good = _sample()
    async with _api(ctx) as c:
        r = await _post(c, [good, _sample(metric="http requests")])
        assert r.status_code == 400 and "invalid_metric" in r.text, f"a batch with a malformed metric name answered {r.status_code} {r.text}, expected 400 invalid_metric: a 200 tells the sender to drop a sample that was never stored"
        assert _written(ctx) == [], f"the rejected batch still wrote {_written(ctx)}: validate the whole batch before merge_batch"
        r = await _post(c, [good])
    assert r.status_code == 200 and r.json().get("applied") is True, f"the corrected retry of batch b-1 answered {r.status_code} {r.text}: the rejected attempt must leave the batch id unclaimed"
    assert ctx.redis.hget(_key(good), "count") == "1", f"after the corrected retry {_key(good)} holds {ctx.redis.hgetall(_key(good))}"
`,
    typescript: `const HOST = {host: 'a', region: 'eu'};

function setup(ctx) {
  const m = ctx.load('api');
  const model = ctx.load('/support/metrics/model.ts');
  const windows = ctx.load('/support/metrics/windows.ts');
  return {c: ctx.client(m.app), model, windows};
}

const now = ctx => Math.floor(ctx.clock.now() / 1000);

const sample = (ctx, {metric = 'http_requests', labels = HOST as Record<string, string>, ago = 5, value = 1} = {}) => ({
  metric,
  labels: {...labels},
  timestamp: now(ctx) - ago,
  value,
});

const post = (c, samples, batchId = 'b-1', tenant = 'acme') =>
  c.post('/v1/metrics', {json: {batch_id: batchId, samples}, headers: tenant ? {'X-Tenant-Id': tenant} : {}});

const keyOf = ({model, windows}, s, tenant = 'acme') => windows.windowKey(tenant, model.seriesId(s.metric, s.labels), model.windowStart(s.timestamp));

const written = ctx => [...(ctx.redis.keys('win:*') as string[]).sort(), ...(ctx.redis.keys('batch:*') as string[]).sort()];

export async function check_route(ctx) {
  const t = setup(ctx);
  const a = sample(ctx, {value: 2});
  const b = sample(ctx, {value: 3});
  let r = await post(t.c, [a, b]);
  assert.equal(r.status, 200, \`a valid batch answered \${r.status}: \${r.text}\`);
  assert.deepStrictEqual(r.json(), {accepted: 2, applied: true}, \`a valid batch of 2 samples must answer {accepted: 2, applied: true}, got \${r.text}\`);
  const stored = ctx.redis.hgetall(keyOf(t, a));
  assert(stored.count === '2' && Number(stored.sum) === 5, \`\${keyOf(t, a)} holds \${JSON.stringify(stored)} after the batch, expected count 2 and sum 5\`);
  r = await post(t.c, [a], 'b-2', '');
  assert.equal(r.status, 401, \`a batch without X-Tenant-Id answered \${r.status}, expected 401\`);
}

export async function check_batch_limit(ctx) {
  const t = setup(ctx);
  let r = await post(t.c, Array.from({length: 501}, (_, i) => sample(ctx, {value: i})));
  assert(r.status === 400 && r.text.includes('batch_too_large'), \`a batch of 501 samples answered \${r.status} \${r.text}, expected 400 batch_too_large\`);
  assert.deepStrictEqual(written(ctx), [], 'a rejected batch must merge nothing');
  r = await post(t.c, Array.from({length: 500}, () => sample(ctx)), 'b-2');
  assert.equal(r.status, 200, \`a batch of exactly 500 samples answered \${r.status}: \${r.text}\`);
}

export async function check_label_budget(ctx) {
  const t = setup(ctx);
  let r = await post(t.c, [sample(ctx), sample(ctx, {labels: {...HOST, user_id: 'u-81'}})]);
  assert(r.status === 422 && r.text.includes('user_id'), \`a sample labelled user_id answered \${r.status} \${r.text}, expected 422 naming user_id: every user id would mint a series\`);
  assert.deepStrictEqual(written(ctx), [], 'a batch with a label outside the allowlist must write nothing');
  r = await post(t.c, [sample(ctx, {labels: {host: 'a', pod: 'p-1'}})], 'b-2', 'globex');
  assert(r.status === 422 && r.text.includes('pod'), \`globex sent the label pod, which only acme may send, and got \${r.status} \${r.text}: the allowlist is per tenant\`);
  const names = ['env', 'host', 'job', 'method', 'pod', 'region', 'route', 'service', 'status'];
  r = await post(t.c, [sample(ctx, {labels: Object.fromEntries(names.map(n => [n, 'x']))})], 'b-3');
  assert(r.status === 422 && r.text.includes('too_many_labels'), \`a sample with 9 labels answered \${r.status} \${r.text}, expected 422 too_many_labels\`);
  r = await post(t.c, [sample(ctx, {labels: Object.fromEntries(names.slice(0, 8).map(n => [n, 'x']))})], 'b-4');
  assert.equal(r.status, 200, \`a sample with 8 allowed labels answered \${r.status}: \${r.text}\`);
}

export async function check_timestamp_skew(ctx) {
  const t = setup(ctx);
  for (const [ago, when] of [[7200, 'two hours old'], [-7200, 'two hours in the future']] as const) {
    const r = await post(t.c, [sample(ctx), sample(ctx, {ago})], \`b\${ago}\`);
    assert(r.status === 400 && r.text.includes('timestamp_out_of_skew'), \`a sample \${when} answered \${r.status} \${r.text}, expected 400 timestamp_out_of_skew: it would rewrite a window readers already saw\`);
  }
  assert.deepStrictEqual(written(ctx), [], 'a batch with a stale sample must write nothing');
  const late = sample(ctx, {ago: 3500});
  const r = await post(t.c, [late], 'b-ok');
  assert.equal(r.status, 200, \`a sample 3500 s old is within the skew and answered \${r.status}: \${r.text}\`);
  assert.equal(ctx.redis.exists(keyOf(t, late)), 1, \`the sample 3500 s old was not merged into \${keyOf(t, late)}\`);
}

export async function check_validate_before_ack(ctx) {
  const t = setup(ctx);
  const good = sample(ctx);
  let r = await post(t.c, [good, sample(ctx, {metric: 'http requests'})]);
  assert(r.status === 400 && r.text.includes('invalid_metric'), \`a batch with a malformed metric name answered \${r.status} \${r.text}, expected 400 invalid_metric: a 200 tells the sender to drop a sample that was never stored\`);
  assert.deepStrictEqual(written(ctx), [], \`the rejected batch still wrote \${JSON.stringify(written(ctx))}: validate the whole batch before mergeBatch\`);
  r = await post(t.c, [good]);
  assert(r.status === 200 && r.json().applied === true, \`the corrected retry of batch b-1 answered \${r.status} \${r.text}: the rejected attempt must leave the batch id unclaimed\`);
  assert.equal(ctx.redis.hget(keyOf(t, good), 'count'), '1', 'after the corrected retry the window must hold one sample');
}
`,
    go: `package main

import (
	"fmt"
	"net/http"
	"strings"

	"metrics/model"
	"metrics/windows"

	"leetbuild/harness"
)

var apiHost = map[string]string{"host": "a", "region": "eu"}

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiSample(ctx *harness.Ctx, metric string, labels map[string]string, ago int64, value float64) model.Sample {
	if labels == nil {
		labels = apiHost
	}
	return model.Sample{Metric: metric, Labels: labels, Timestamp: ctx.Clock.Now()/1000 - ago, Value: value}
}

func apiPost(c *harness.HTTP, samples []model.Sample, batchID, tenant string) *harness.Response {
	body := map[string]any{"batch_id": batchID, "samples": samples}
	if tenant == "" {
		return c.Post("/v1/metrics", body)
	}
	return c.Post("/v1/metrics", body, "X-Tenant-Id", tenant)
}

func apiKey(s model.Sample) string {
	return windows.WindowKey("acme", model.SeriesID(s.Metric, s.Labels), model.WindowStart(s.Timestamp))
}

func apiWritten(ctx *harness.Ctx) []string {
	return append(ctx.Redis.Keys("win:*"), ctx.Redis.Keys("batch:*")...)
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	a, b := apiSample(ctx, "http_requests", nil, 5, 2), apiSample(ctx, "http_requests", nil, 5, 3)
	r := apiPost(c, []model.Sample{a, b}, "b-1", "acme")
	ctx.Equal(r.Status, 200, "a valid batch (%s)", r.Text())
	ctx.Equal(r.JSON(), map[string]any{"accepted": 2, "applied": true}, "a valid batch of 2 samples must answer {accepted: 2, applied: true}")
	stored := ctx.Redis.HGetAll(apiKey(a))
	ctx.Assert(stored["count"] == "2" && stored["sum"] == "5", "%s holds %v after the batch, expected count 2 and sum 5", apiKey(a), stored)
	r = apiPost(c, []model.Sample{a}, "b-2", "")
	ctx.Equal(r.Status, 401, "a batch without X-Tenant-Id")
}

func CheckBatchLimit(ctx *harness.Ctx) {
	c := apiClient(ctx)
	big := []model.Sample{}
	for i := 0; i < 501; i++ {
		big = append(big, apiSample(ctx, "http_requests", nil, 5, float64(i)))
	}
	r := apiPost(c, big, "b-1", "acme")
	ctx.Assert(r.Status == 400 && strings.Contains(r.Text(), "batch_too_large"), "a batch of 501 samples answered %d %s, expected 400 batch_too_large", r.Status, r.Text())
	ctx.Equal(len(apiWritten(ctx)), 0, "a rejected batch must merge nothing; keys written")
	r = apiPost(c, big[:500], "b-2", "acme")
	ctx.Equal(r.Status, 200, "a batch of exactly 500 samples (%s)", r.Text())
}

func labelsOf(names ...string) map[string]string {
	out := map[string]string{}
	for _, n := range names {
		out[n] = "x"
	}
	return out
}

func CheckLabelBudget(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, []model.Sample{apiSample(ctx, "http_requests", nil, 5, 1), apiSample(ctx, "http_requests", map[string]string{"host": "a", "region": "eu", "user_id": "u-81"}, 5, 1)}, "b-1", "acme")
	ctx.Assert(r.Status == 422 && strings.Contains(r.Text(), "user_id"), "a sample labelled user_id answered %d %s, expected 422 naming user_id: every user id would mint a series", r.Status, r.Text())
	ctx.Equal(apiWritten(ctx), []string{}, "a batch with a label outside the allowlist must write nothing; keys written")
	r = apiPost(c, []model.Sample{apiSample(ctx, "http_requests", map[string]string{"host": "a", "pod": "p-1"}, 5, 1)}, "b-2", "globex")
	ctx.Assert(r.Status == 422 && strings.Contains(r.Text(), "pod"), "globex sent the label pod, which only acme may send, and got %d %s: the allowlist is per tenant", r.Status, r.Text())
	nine := labelsOf("env", "host", "job", "method", "pod", "region", "route", "service", "status")
	r = apiPost(c, []model.Sample{apiSample(ctx, "http_requests", nine, 5, 1)}, "b-3", "acme")
	ctx.Assert(r.Status == 422 && strings.Contains(r.Text(), "too_many_labels"), "a sample with 9 labels answered %d %s, expected 422 too_many_labels", r.Status, r.Text())
	eight := labelsOf("env", "host", "job", "method", "pod", "region", "route", "service")
	r = apiPost(c, []model.Sample{apiSample(ctx, "http_requests", eight, 5, 1)}, "b-4", "acme")
	ctx.Equal(r.Status, 200, "a sample with 8 allowed labels (%s)", r.Text())
}

func CheckTimestampSkew(ctx *harness.Ctx) {
	c := apiClient(ctx)
	for _, ago := range []int64{7200, -7200} {
		r := apiPost(c, []model.Sample{apiSample(ctx, "http_requests", nil, 5, 1), apiSample(ctx, "http_requests", nil, ago, 1)}, fmt.Sprintf("b%d", ago), "acme")
		ctx.Assert(r.Status == 400 && strings.Contains(r.Text(), "timestamp_out_of_skew"), "a sample %d s old (negative: in the future) answered %d %s, expected 400 timestamp_out_of_skew: it would rewrite a window readers already saw", ago, r.Status, r.Text())
	}
	ctx.Equal(apiWritten(ctx), []string{}, "a batch with a stale sample must write nothing; keys written")
	late := apiSample(ctx, "http_requests", nil, 3500, 1)
	r := apiPost(c, []model.Sample{late}, "b-ok", "acme")
	ctx.Equal(r.Status, 200, "a sample 3500 s old is within the skew (%s)", r.Text())
	ctx.Equal(ctx.Redis.Exists(apiKey(late)), 1, "the sample 3500 s old must be merged into %s", apiKey(late))
}

func CheckValidateBeforeAck(ctx *harness.Ctx) {
	c := apiClient(ctx)
	good := apiSample(ctx, "http_requests", nil, 5, 1)
	r := apiPost(c, []model.Sample{good, apiSample(ctx, "http requests", nil, 5, 1)}, "b-1", "acme")
	ctx.Assert(r.Status == 400 && strings.Contains(r.Text(), "invalid_metric"), "a batch with a malformed metric name answered %d %s, expected 400 invalid_metric: a 200 tells the sender to drop a sample that was never stored", r.Status, r.Text())
	ctx.Equal(apiWritten(ctx), []string{}, "the rejected batch must write nothing (validate the whole batch before MergeBatch); keys written")
	r = apiPost(c, []model.Sample{good}, "b-1", "acme")
	ctx.Assert(r.Status == 200 && strings.Contains(r.Text(), \`"applied":true\`), "the corrected retry of batch b-1 answered %d %s: the rejected attempt must leave the batch id unclaimed", r.Status, r.Text())
	count, _ := ctx.Redis.HGet(apiKey(good), "count")
	ctx.Equal(count, "1", "after the corrected retry, the window's count")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <optional>
#include <map>
#include <string>
#include <vector>

#include "metrics/model.h"
#include "metrics/windows.h"

namespace {

using Labels = std::map<std::string, std::string>;
const Labels kHost = {{"host", "a"}, {"region", "eu"}};

harness::HTTP apiClient(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

metrics::Sample apiSample(harness::Ctx& ctx, const std::string& metric = "http_requests", const Labels& labels = kHost, long long ago = 5,
                          double value = 1) {
  return metrics::Sample{metric, labels, ctx.Clock.Now() / 1000 - ago, value};
}

harness::Response apiPost(harness::HTTP& c, const std::vector<metrics::Sample>& samples, const std::string& batch_id = "b-1",
                          const std::string& tenant = "acme") {
  nlohmann::json body = {{"batch_id", batch_id}, {"samples", nlohmann::json::array()}};
  for (const auto& s : samples) {
    body["samples"].push_back({{"metric", s.metric}, {"labels", s.labels}, {"timestamp", s.timestamp}, {"value", s.value}});
  }
  if (tenant.empty()) return c.Post("/v1/metrics", body.dump(), "Content-Type", "application/json");
  return c.Post("/v1/metrics", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant);
}

std::string apiKey(const metrics::Sample& s) {
  return metrics::windowKey("acme", metrics::seriesId(s.metric, s.labels), metrics::windowStart(s.timestamp));
}

std::vector<std::string> apiWritten(harness::Ctx& ctx) {
  auto keys = ctx.Redis.Keys("win:*");
  for (const auto& k : ctx.Redis.Keys("batch:*")) keys.push_back(k);
  return keys;
}

bool has(const harness::Response& r, const std::string& text) { return r.Text().find(text) != std::string::npos; }

Labels labelsOf(const std::vector<std::string>& names) {
  Labels out;
  for (const auto& n : names) out[n] = "x";
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const auto a = apiSample(ctx, "http_requests", kHost, 5, 2);
  const auto b = apiSample(ctx, "http_requests", kHost, 5, 3);
  auto r = apiPost(c, {a, b});
  ctx.Equal(r.Status, 200, "a valid batch (%s)", r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object() && body.value("accepted", 0) == 2 && body.value("applied", false), "a valid batch of 2 samples must answer {accepted: 2, applied: true}, got %s", r.Text());
  const auto stored = ctx.Redis.HGetAll(apiKey(a));
  ctx.Assert(stored.count("count") && stored.at("count") == "2" && stored.count("sum") && std::stod(stored.at("sum")) == 5.0,
             "%s holds %v after the batch, expected count 2 and sum 5", apiKey(a), stored);
  r = apiPost(c, {a}, "b-2", "");
  ctx.Equal(r.Status, 401, "a batch without X-Tenant-Id");
}

void CheckBatchLimit(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  std::vector<metrics::Sample> big;
  for (int i = 0; i < 501; i++) big.push_back(apiSample(ctx, "http_requests", kHost, 5, i));
  auto r = apiPost(c, big);
  ctx.Assert(r.Status == 400 && has(r, "batch_too_large"), "a batch of 501 samples answered %d %s, expected 400 batch_too_large", r.Status, r.Text());
  ctx.Equal(apiWritten(ctx).size(), 0, "a rejected batch must merge nothing; keys written");
  big.pop_back();
  r = apiPost(c, big, "b-2");
  ctx.Equal(r.Status, 200, "a batch of exactly 500 samples (%s)", r.Text());
}

void CheckLabelBudget(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  auto r = apiPost(c, {apiSample(ctx), apiSample(ctx, "http_requests", {{"host", "a"}, {"region", "eu"}, {"user_id", "u-81"}})});
  ctx.Assert(r.Status == 422 && has(r, "user_id"), "a sample labelled user_id answered %d %s, expected 422 naming user_id: every user id would mint a series", r.Status, r.Text());
  ctx.Equal(apiWritten(ctx).size(), 0, "a batch with a label outside the allowlist must write nothing; keys written");
  r = apiPost(c, {apiSample(ctx, "http_requests", {{"host", "a"}, {"pod", "p-1"}})}, "b-2", "globex");
  ctx.Assert(r.Status == 422 && has(r, "pod"), "globex sent the label pod, which only acme may send, and got %d %s: the allowlist is per tenant", r.Status, r.Text());
  r = apiPost(c, {apiSample(ctx, "http_requests", labelsOf({"env", "host", "job", "method", "pod", "region", "route", "service", "status"}))}, "b-3");
  ctx.Assert(r.Status == 422 && has(r, "too_many_labels"), "a sample with 9 labels answered %d %s, expected 422 too_many_labels", r.Status, r.Text());
  r = apiPost(c, {apiSample(ctx, "http_requests", labelsOf({"env", "host", "job", "method", "pod", "region", "route", "service"}))}, "b-4");
  ctx.Equal(r.Status, 200, "a sample with 8 allowed labels (%s)", r.Text());
}

void CheckTimestampSkew(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  for (long long ago : {7200LL, -7200LL}) {
    const auto r = apiPost(c, {apiSample(ctx), apiSample(ctx, "http_requests", kHost, ago)}, "b" + std::to_string(ago));
    ctx.Assert(r.Status == 400 && has(r, "timestamp_out_of_skew"), "a sample %d s old (negative: in the future) answered %d %s, expected 400 timestamp_out_of_skew: it would rewrite a window readers already saw", ago, r.Status, r.Text());
  }
  ctx.Equal(apiWritten(ctx).size(), 0, "a batch with a stale sample must write nothing; keys written");
  const auto late = apiSample(ctx, "http_requests", kHost, 3500);
  const auto r = apiPost(c, {late}, "b-ok");
  ctx.Equal(r.Status, 200, "a sample 3500 s old is within the skew (%s)", r.Text());
  ctx.Equal(ctx.Redis.Exists(apiKey(late)), 1, "the sample 3500 s old must be merged into %s", apiKey(late));
}

void CheckValidateBeforeAck(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const auto good = apiSample(ctx);
  auto r = apiPost(c, {good, apiSample(ctx, "http requests")});
  ctx.Assert(r.Status == 400 && has(r, "invalid_metric"), "a batch with a malformed metric name answered %d %s, expected 400 invalid_metric: a 200 tells the sender to drop a sample that was never stored", r.Status, r.Text());
  ctx.Equal(apiWritten(ctx).size(), 0, "the rejected batch must write nothing (validate the whole batch before mergeBatch); keys written");
  r = apiPost(c, {good});
  ctx.Assert(r.Status == 200 && has(r, "\\"applied\\":true"), "the corrected retry of batch b-1 answered %d %s: the rejected attempt must leave the batch id unclaimed", r.Status, r.Text());
  ctx.Equal(ctx.Redis.HGet(apiKey(good), "count"), std::optional<std::string>("1"), "after the corrected retry, the window's count");
}
`,
  },
  hints: [
    'Send a batch where one sample carries a user_id label, another is two hours old and a third has a space in its metric name: the answer is 200, and the chart shows two of the three.',
    'The handler filters the batch while building the list it merges, so a bad sample disappears instead of failing the request, and nothing looks at the label names, the label count or the timestamp.',
    'Write `validate_batch(tenant, batch)`: size against `MAX_BATCH_SAMPLES`, each metric name, each label against `allowed_labels(tenant)`, the count against `MAX_LABELS_PER_SAMPLE`, the skew against `MAX_SKEW_SECONDS`. Return its rejection before calling `merge_batch` with the whole batch.',
  ],
  debrief: `The fix moves every judgement in front of the write and makes it about the whole batch, because the response is a promise to the sender: a 200 means every sample is stored, so the sender may drop its buffer. Rejecting the batch, with the sample and the label named, gives its retry loop something to correct, and leaving the batch id unclaimed lets the corrected retry through. The allowlist and the label cap bound how many series one tenant can mint; the skew bound keeps a late sample out of a window readers already saw. Production ingest also counts active series per tenant over time, since a per-sample cap does not stop a slow label leak, and reports limits in response headers so clients can back off before they hit them.`,
};
