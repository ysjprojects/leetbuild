import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/telemetry: registry devices, declared metrics, sane values',
  concept: 'http',
  guides: ['request-boundaries'],
  file: 'api',
  focus: ['device', 'ingest', 'registry'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/telemetry\` with body
\`{"batch_id", "device_id", "samples": [{"metric", "value", "ts"}]}\`: it checks the shape (both ids,
1 to 500 samples), resolves the device with \`registry.lookup(...)\` or else
\`registry.register_device(...)\`, appends the batch to the ingest WAL (\`wal.append\`) and answers
\`202\` with the accepted count. It serves the demo and hides four flaws.

**Failure mode the checks target.** A typo in a device id becomes a fleet member; a metric the device
never declared lands in the store; one 64-bit overflow reading rescales every aggregate built on it;
and a device whose clock runs a year ahead pins the dashboard's newest point to next year.

- The device must already exist: \`registry.lookup\` returning nothing is **404**, and the ingest path
  writes no registry row.
- Every sample's metric is declared for the device (\`device["metrics"]\`); an undeclared one is
  **400** naming the metric.
- Every value lies inside its metric's \`[low, high]\`; outside is **422** naming the metric and the
  range.
- Every \`ts\` (epoch seconds) lies between \`MAX_AGE_S = 3600\` before now and \`MAX_SKEW_S = 300\`
  after it; outside is **422**.
- A rejected batch appends nothing: every sample is checked before \`wal.append\` and the \`202\`.`,
  sequence: {
    participants: ['Device', 'Telemetry Ingest', 'Device registry', 'Ingest WAL'],
    messages: [
      {from: 'Device', to: 'Telemetry Ingest', label: 'POST /v1/telemetry · batch_id · samples[]', kind: 'sync'},
      {from: 'Telemetry Ingest', to: 'Device registry', label: 'lookup(device_id)', kind: 'sync'},
      {from: 'Device registry', to: 'Telemetry Ingest', label: 'device row / none → 404', kind: 'reply'},
      {
        from: 'Telemetry Ingest',
        to: 'Telemetry Ingest',
        label: 'per sample: declared metric (400) · [low, high] (422) · ts window (422)',
        kind: 'sync',
      },
      {from: 'Telemetry Ingest', to: 'Ingest WAL', label: 'append(batch) · only a valid batch', kind: 'sync'},
      {from: 'Telemetry Ingest', to: 'Device', label: '202 {batch_id, accepted}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Accepts a valid batch on POST /v1/telemetry',
      detail:
        'A batch from a registered device with declared, in-range, current readings is appended to the WAL and answered `202` with the accepted count; an empty batch is `400`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/telemetry["']/, /wal\.append\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/telemetry['"]/, /\bappend\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/telemetry"/, /wal\.Append\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"telemetry"\s*\)/, /\bpost\b/, /Wal\.append\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/telemetry"/, /wal::append\(/]},
      },
    },
    {
      id: 'device-known',
      title: 'An unknown device is 404 and creates no registry row',
      detail:
        'The device comes from `registry.lookup` and an unknown id answers **404**. The starter falls back to `register_device`, so any id a caller sends becomes a registry row.',
      match: {
        python: {all: [/registry\.lookup\(/, /\b404\b/], none: [/register_device\(/]},
        typescript: {all: [/\blookup\(/, /\b404\b/], none: [/registerDevice\(/]},
        go: {all: [/registry\.Lookup\(/, /StatusNotFound|\b404\b/], none: [/registry\.RegisterDevice\(/]},
        scala: {all: [/Registry\.lookup\(/, /NotFound|\b404\b/], none: [/registerDevice\(/]},
        cpp: {all: [/registry::lookup\(/, /\b404\b/], none: [/registry::registerDevice\(/]},
      },
    },
    {
      id: 'metric-known',
      title: 'An undeclared metric is 400 naming it',
      detail:
        "Every sample's metric is looked up in the device's declared metrics; one the device never declared answers **400** with the metric in the body. The starter never reads the declared metrics.",
      match: {
        python: {all: [/\[\s*["']metrics["']\s*\]/, /\b400\b/]},
        typescript: {all: [/\.metrics\b/, /\b400\b/]},
        go: {all: [/\.Metrics\[/, /StatusBadRequest|\b400\b/]},
        scala: {all: [/\.metrics\.get\(/, /BadRequest|\b400\b/]},
        cpp: {all: [/\.metrics\.find\(|->metrics\.find\(/, /\b400\b/]},
      },
    },
    {
      id: 'value-range',
      title: 'An out-of-range value is 422 naming the metric and the range',
      detail:
        "A value outside its metric's declared `[low, high]` answers **422** naming the metric and the bounds, and nothing of the batch reaches the WAL. The starter appends it, overflow readings included.",
      match: {
        python: {all: [/\b422\b/, /\blow\b/, /\bhigh\b/]},
        typescript: {all: [/\b422\b/, /\blow\b/, /\bhigh\b/]},
        go: {all: [/StatusUnprocessableEntity|\b422\b/, /\blow\b/, /\bhigh\b/]},
        scala: {all: [/UnprocessableEntity|\b422\b/, /\blow\b/, /\bhigh\b/]},
        cpp: {all: [/\b422\b/, /\blow\b/, /\bhigh\b/]},
      },
    },
    {
      id: 'timestamp-window',
      title: 'A timestamp outside the ingest window is 422',
      detail:
        'A reading older than `MAX_AGE_S` (one hour) or more than `MAX_SKEW_S` (five minutes) ahead of the clock answers **422**. The starter takes any `ts`, so one device with a wrong clock owns the newest point of its series.',
      match: {
        python: {all: [/MAX_AGE_S/, /MAX_SKEW_S/, /time\.time\(\)/]},
        typescript: {all: [/MAX_AGE_S/, /MAX_SKEW_S/, /Date\.now\(\)/]},
        go: {all: [/maxAgeS/, /maxSkewS/, /time\.Now\(\)/]},
        scala: {all: [/MaxAgeSeconds/, /MaxSkewSeconds/, /currentTimeMillis|Instant\.now/]},
        cpp: {all: [/kMaxAgeS/, /kMaxSkewS/, /system_clock::now\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from ingestd import registry, wal  # registry.lookup, registry.register_device; wal.append

app = FastAPI()

MAX_SAMPLES = 500


class Sample(BaseModel):
    metric: str
    value: float
    ts: int  # epoch seconds


class TelemetryBatch(BaseModel):
    batch_id: str
    device_id: str
    samples: list[Sample]


@app.post("/v1/telemetry", status_code=202)
def ingest(batch: TelemetryBatch) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    if not batch.batch_id or not batch.device_id:
        raise HTTPException(status_code=400, detail="batch_id and device_id are required")
    if not 1 <= len(batch.samples) <= MAX_SAMPLES:
        raise HTTPException(status_code=400, detail=f"samples must hold 1 to {MAX_SAMPLES} readings")
    device = registry.lookup(batch.device_id) or registry.register_device(batch.device_id, "unassigned", {})
    wal.append(batch.model_dump())
    return {"batch_id": batch.batch_id, "device_id": device["id"], "accepted": len(batch.samples)}
`,
      solution: `import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from ingestd import registry, wal  # registry.lookup, registry.register_device; wal.append

app = FastAPI()

MAX_SAMPLES = 500
MAX_AGE_S = 3600  # older than an hour is a backfill, not live telemetry
MAX_SKEW_S = 300  # a device clock may run at most five minutes ahead


class Sample(BaseModel):
    metric: str
    value: float
    ts: int  # epoch seconds


class TelemetryBatch(BaseModel):
    batch_id: str
    device_id: str
    samples: list[Sample]


@app.post("/v1/telemetry", status_code=202)
def ingest(batch: TelemetryBatch) -> dict:
    if not batch.batch_id or not batch.device_id:
        raise HTTPException(status_code=400, detail="batch_id and device_id are required")
    if not 1 <= len(batch.samples) <= MAX_SAMPLES:
        raise HTTPException(status_code=400, detail=f"samples must hold 1 to {MAX_SAMPLES} readings")
    # Provisioning owns the registry: an id it does not know is the caller's mistake.
    device = registry.lookup(batch.device_id)
    if device is None:
        raise HTTPException(status_code=404, detail=f"unknown device {batch.device_id}")
    now = time.time()
    for sample in batch.samples:
        bounds = device["metrics"].get(sample.metric)
        if bounds is None:
            raise HTTPException(status_code=400, detail=f"unknown metric {sample.metric}")
        low, high = bounds
        if not low <= sample.value <= high:
            raise HTTPException(status_code=422, detail=f"metric {sample.metric} out of range [{low}, {high}]: {sample.value}")
        if not now - MAX_AGE_S <= sample.ts <= now + MAX_SKEW_S:
            raise HTTPException(status_code=422, detail=f"timestamp {sample.ts} of {sample.metric} is outside the ingest window")
    # Every sample passed: only now does the batch become durable and acknowledged.
    wal.append(batch.model_dump())
    return {"batch_id": batch.batch_id, "device_id": device["id"], "accepted": len(batch.samples)}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {lookup, registerDevice} from 'ingestd/registry';
import {type Batch, append} from 'ingestd/wal';

export const app = Fastify();

export const MAX_SAMPLES = 500;

app.post('/v1/telemetry', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const batch = request.body as Batch;
  if (!batch.batch_id || !batch.device_id) return reply.code(400).send({error: 'batch_id and device_id are required'});
  if (!Array.isArray(batch.samples) || batch.samples.length < 1 || batch.samples.length > MAX_SAMPLES) {
    return reply.code(400).send({error: \`samples must hold 1 to \${MAX_SAMPLES} readings\`});
  }
  const device = (await lookup(batch.device_id)) ?? (await registerDevice(batch.device_id, 'unassigned', {}));
  await append(batch);
  return reply.code(202).send({batch_id: batch.batch_id, device_id: device.id, accepted: batch.samples.length});
});
`,
      solution: `import Fastify from 'fastify';

import {lookup} from 'ingestd/registry';
import {type Batch, append} from 'ingestd/wal';

export const app = Fastify();

export const MAX_SAMPLES = 500;
export const MAX_AGE_S = 3600; // older than an hour is a backfill, not live telemetry
export const MAX_SKEW_S = 300; // a device clock may run at most five minutes ahead

app.post('/v1/telemetry', async (request, reply) => {
  const batch = request.body as Batch;
  if (!batch.batch_id || !batch.device_id) return reply.code(400).send({error: 'batch_id and device_id are required'});
  if (!Array.isArray(batch.samples) || batch.samples.length < 1 || batch.samples.length > MAX_SAMPLES) {
    return reply.code(400).send({error: \`samples must hold 1 to \${MAX_SAMPLES} readings\`});
  }
  // Provisioning owns the registry: an id it does not know is the caller's mistake.
  const device = await lookup(batch.device_id);
  if (device === null) return reply.code(404).send({error: \`unknown device \${batch.device_id}\`});
  const now = Date.now() / 1000;
  for (const sample of batch.samples) {
    const bounds = device.metrics[sample.metric];
    if (bounds === undefined) return reply.code(400).send({error: \`unknown metric \${sample.metric}\`});
    const [low, high] = bounds;
    if (!(sample.value >= low && sample.value <= high)) {
      return reply.code(422).send({error: \`metric \${sample.metric} out of range [\${low}, \${high}]: \${sample.value}\`});
    }
    if (!(sample.ts >= now - MAX_AGE_S && sample.ts <= now + MAX_SKEW_S)) {
      return reply.code(422).send({error: \`timestamp \${sample.ts} of \${sample.metric} is outside the ingest window\`});
    }
  }
  // Every sample passed: only now does the batch become durable and acknowledged.
  await append(batch);
  return reply.code(202).send({batch_id: batch.batch_id, device_id: device.id, accepted: batch.samples.length});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	"ingestd/registry" // registry.Lookup(ctx, id), registry.RegisterDevice(ctx, id, fleet, metrics)
	"ingestd/wal"      // wal.Batch, wal.Sample, wal.Append(ctx, batch)
)

const maxSamples = 500

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func fail(rw http.ResponseWriter, status int, message string) {
	writeJSON(rw, status, map[string]string{"error": message})
}

func ingest(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	var batch wal.Batch
	if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
		fail(rw, http.StatusBadRequest, "body must be a telemetry batch")
		return
	}
	if batch.BatchID == "" || batch.DeviceID == "" {
		fail(rw, http.StatusBadRequest, "batch_id and device_id are required")
		return
	}
	if len(batch.Samples) < 1 || len(batch.Samples) > maxSamples {
		fail(rw, http.StatusBadRequest, fmt.Sprintf("samples must hold 1 to %d readings", maxSamples))
		return
	}
	device, err := registry.Lookup(r.Context(), batch.DeviceID)
	if err == nil && device == nil {
		device, err = registry.RegisterDevice(r.Context(), batch.DeviceID, "unassigned", nil)
	}
	if err != nil {
		fail(rw, http.StatusInternalServerError, err.Error())
		return
	}
	if err := wal.Append(r.Context(), batch); err != nil {
		fail(rw, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(rw, http.StatusAccepted, map[string]any{"batch_id": batch.BatchID, "device_id": device.ID, "accepted": len(batch.Samples)})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/telemetry", ingest)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"ingestd/registry" // registry.Lookup(ctx, id), registry.RegisterDevice(ctx, id, fleet, metrics)
	"ingestd/wal"      // wal.Batch, wal.Sample, wal.Append(ctx, batch)
)

const (
	maxSamples = 500
	maxAgeS    = 3600 // older than an hour is a backfill, not live telemetry
	maxSkewS   = 300  // a device clock may run at most five minutes ahead
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func fail(rw http.ResponseWriter, status int, message string) {
	writeJSON(rw, status, map[string]string{"error": message})
}

func ingest(rw http.ResponseWriter, r *http.Request) {
	var batch wal.Batch
	if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
		fail(rw, http.StatusBadRequest, "body must be a telemetry batch")
		return
	}
	if batch.BatchID == "" || batch.DeviceID == "" {
		fail(rw, http.StatusBadRequest, "batch_id and device_id are required")
		return
	}
	if len(batch.Samples) < 1 || len(batch.Samples) > maxSamples {
		fail(rw, http.StatusBadRequest, fmt.Sprintf("samples must hold 1 to %d readings", maxSamples))
		return
	}
	// Provisioning owns the registry: an id it does not know is the caller's mistake.
	device, err := registry.Lookup(r.Context(), batch.DeviceID)
	if err != nil {
		fail(rw, http.StatusInternalServerError, err.Error())
		return
	}
	if device == nil {
		fail(rw, http.StatusNotFound, "unknown device "+batch.DeviceID)
		return
	}
	now := time.Now().Unix()
	for _, sample := range batch.Samples {
		bounds, declared := device.Metrics[sample.Metric]
		if !declared {
			fail(rw, http.StatusBadRequest, "unknown metric "+sample.Metric)
			return
		}
		low, high := bounds[0], bounds[1]
		if sample.Value < low || sample.Value > high {
			fail(rw, http.StatusUnprocessableEntity, fmt.Sprintf("metric %s out of range [%g, %g]: %g", sample.Metric, low, high, sample.Value))
			return
		}
		if sample.TS < now-maxAgeS || sample.TS > now+maxSkewS {
			fail(rw, http.StatusUnprocessableEntity, fmt.Sprintf("timestamp %d of %s is outside the ingest window", sample.TS, sample.Metric))
			return
		}
	}
	// Every sample passed: only now does the batch become durable and acknowledged.
	if err := wal.Append(r.Context(), batch); err != nil {
		fail(rw, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(rw, http.StatusAccepted, map[string]any{"batch_id": batch.BatchID, "device_id": device.ID, "accepted": len(batch.Samples)})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/telemetry", ingest)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import ingestd.{Batch, Registry, Sample, Wal} // Registry.lookup, Registry.registerDevice, Wal.append

object IngestApi {
  val MaxSamples = 500

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def fail(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  /** The request body as a batch; a missing field is empty. */
  private def parse(raw: String): Batch = {
    val fields = raw.parseJson.asJsObject.fields
    def text(f: Map[String, JsValue], name: String): String = f.get(name).collect { case JsString(s) => s }.getOrElse("")
    def number(f: Map[String, JsValue], name: String): BigDecimal = f.get(name).collect { case JsNumber(n) => n }.getOrElse(BigDecimal(0))
    val samples = fields.get("samples").collect { case JsArray(items) => items }.getOrElse(Vector.empty).map { item =>
      val s = item.asJsObject.fields
      Sample(text(s, "metric"), number(s, "value").toDouble, number(s, "ts").toLong)
    }
    Batch(text(fields, "batch_id"), text(fields, "device_id"), samples)
  }

  val route: Route = path("v1" / "telemetry") {
    post {
      entity(as[String]) { raw =>
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        val batch = parse(raw)
        if (batch.batchId.isEmpty || batch.deviceId.isEmpty) complete(fail(StatusCodes.BadRequest, "batch_id and device_id are required"))
        else if (batch.samples.isEmpty || batch.samples.size > MaxSamples) complete(fail(StatusCodes.BadRequest, s"samples must hold 1 to $MaxSamples readings"))
        else {
          val device = Registry.lookup(batch.deviceId).getOrElse(Registry.registerDevice(batch.deviceId, "unassigned", Map.empty))
          Wal.append(batch)
          complete(json(StatusCodes.Accepted, JsObject("batch_id" -> JsString(batch.batchId), "device_id" -> JsString(device.id), "accepted" -> JsNumber(batch.samples.size))))
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

import ingestd.{Batch, Device, Registry, Sample, Wal} // Registry.lookup, Registry.registerDevice, Wal.append

object IngestApi {
  val MaxSamples = 500
  val MaxAgeSeconds = 3600L // older than an hour is a backfill, not live telemetry
  val MaxSkewSeconds = 300L // a device clock may run at most five minutes ahead

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def fail(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  /** The request body as a batch; a missing field is empty. */
  private def parse(raw: String): Batch = {
    val fields = raw.parseJson.asJsObject.fields
    def text(f: Map[String, JsValue], name: String): String = f.get(name).collect { case JsString(s) => s }.getOrElse("")
    def number(f: Map[String, JsValue], name: String): BigDecimal = f.get(name).collect { case JsNumber(n) => n }.getOrElse(BigDecimal(0))
    val samples = fields.get("samples").collect { case JsArray(items) => items }.getOrElse(Vector.empty).map { item =>
      val s = item.asJsObject.fields
      Sample(text(s, "metric"), number(s, "value").toDouble, number(s, "ts").toLong)
    }
    Batch(text(fields, "batch_id"), text(fields, "device_id"), samples)
  }

  /** The answer for the first sample the device's declared metrics or the ingest window refuse. */
  private def rejection(device: Device, batch: Batch, now: Long): Option[HttpResponse] =
    batch.samples.iterator.flatMap { sample =>
      device.metrics.get(sample.metric) match {
        case None => Some(fail(StatusCodes.BadRequest, s"unknown metric \${sample.metric}"))
        case Some((low, high)) if sample.value < low || sample.value > high =>
          Some(fail(StatusCodes.UnprocessableEntity, s"metric \${sample.metric} out of range [$low, $high]: \${sample.value}"))
        case _ if sample.ts < now - MaxAgeSeconds || sample.ts > now + MaxSkewSeconds =>
          Some(fail(StatusCodes.UnprocessableEntity, s"timestamp \${sample.ts} of \${sample.metric} is outside the ingest window"))
        case _ => None
      }
    }.nextOption()

  val route: Route = path("v1" / "telemetry") {
    post {
      entity(as[String]) { raw =>
        val batch = parse(raw)
        if (batch.batchId.isEmpty || batch.deviceId.isEmpty) complete(fail(StatusCodes.BadRequest, "batch_id and device_id are required"))
        else if (batch.samples.isEmpty || batch.samples.size > MaxSamples) complete(fail(StatusCodes.BadRequest, s"samples must hold 1 to $MaxSamples readings"))
        else
          // Provisioning owns the registry: an id it does not know is the caller's mistake.
          Registry.lookup(batch.deviceId) match {
            case None => complete(fail(StatusCodes.NotFound, s"unknown device \${batch.deviceId}"))
            case Some(device) =>
              rejection(device, batch, System.currentTimeMillis() / 1000) match {
                case Some(refused) => complete(refused)
                case None =>
                  // Every sample passed: only now does the batch become durable and acknowledged.
                  Wal.append(batch)
                  complete(json(StatusCodes.Accepted, JsObject("batch_id" -> JsString(batch.batchId), "device_id" -> JsString(device.id), "accepted" -> JsNumber(batch.samples.size))))
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

#include <string>

#include "ingestd/registry.h"  // registry::lookup(id), registry::registerDevice(id, fleet, metrics)
#include "ingestd/wal.h"       // wal::Batch, wal::Sample, wal::append(batch)

using json = nlohmann::json;

constexpr size_t kMaxSamples = 500;

void answer(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// The request body as a batch; a missing field is empty.
wal::Batch parseBatch(const json& body) {
  wal::Batch batch{body.value("batch_id", ""), body.value("device_id", ""), {}};
  for (const json& s : body.value("samples", json::array())) batch.samples.push_back({s.value("metric", ""), s.value("value", 0.0), s.value("ts", 0LL)});
  return batch;
}

void ingest(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return answer(res, 400, {{"error", "body must be a telemetry batch"}});
  const wal::Batch batch = parseBatch(body);
  if (batch.batch_id.empty() || batch.device_id.empty()) return answer(res, 400, {{"error", "batch_id and device_id are required"}});
  if (batch.samples.empty() || batch.samples.size() > kMaxSamples) {
    return answer(res, 400, {{"error", "samples must hold 1 to " + std::to_string(kMaxSamples) + " readings"}});
  }
  auto device = registry::lookup(batch.device_id);
  if (!device) device = registry::registerDevice(batch.device_id, "unassigned", {});
  wal::append(batch);
  answer(res, 202, {{"batch_id", batch.batch_id}, {"device_id", device->id}, {"accepted", batch.samples.size()}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/telemetry", ingest); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>

#include "ingestd/registry.h"  // registry::lookup(id), registry::registerDevice(id, fleet, metrics)
#include "ingestd/wal.h"       // wal::Batch, wal::Sample, wal::append(batch)

using json = nlohmann::json;

constexpr size_t kMaxSamples = 500;
constexpr long long kMaxAgeS = 3600;  // older than an hour is a backfill, not live telemetry
constexpr long long kMaxSkewS = 300;  // a device clock may run at most five minutes ahead

void answer(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// The request body as a batch; a missing field is empty.
wal::Batch parseBatch(const json& body) {
  wal::Batch batch{body.value("batch_id", ""), body.value("device_id", ""), {}};
  for (const json& s : body.value("samples", json::array())) batch.samples.push_back({s.value("metric", ""), s.value("value", 0.0), s.value("ts", 0LL)});
  return batch;
}

void ingest(const httplib::Request& req, httplib::Response& res) {
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return answer(res, 400, {{"error", "body must be a telemetry batch"}});
  const wal::Batch batch = parseBatch(body);
  if (batch.batch_id.empty() || batch.device_id.empty()) return answer(res, 400, {{"error", "batch_id and device_id are required"}});
  if (batch.samples.empty() || batch.samples.size() > kMaxSamples) {
    return answer(res, 400, {{"error", "samples must hold 1 to " + std::to_string(kMaxSamples) + " readings"}});
  }
  // Provisioning owns the registry: an id it does not know is the caller's mistake.
  const auto device = registry::lookup(batch.device_id);
  if (!device) return answer(res, 404, {{"error", "unknown device " + batch.device_id}});
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  for (const wal::Sample& sample : batch.samples) {
    const auto bounds = device->metrics.find(sample.metric);
    if (bounds == device->metrics.end()) return answer(res, 400, {{"error", "unknown metric " + sample.metric}});
    const auto [low, high] = bounds->second;
    if (sample.value < low || sample.value > high) {
      return answer(res, 422, {{"error", "metric out of range"}, {"metric", sample.metric}, {"range", {low, high}}, {"value", sample.value}});
    }
    if (sample.ts < now - kMaxAgeS || sample.ts > now + kMaxSkewS) {
      return answer(res, 422, {{"error", "timestamp outside the ingest window"}, {"metric", sample.metric}, {"ts", sample.ts}});
    }
  }
  // Every sample passed: only now does the batch become durable and acknowledged.
  wal::append(batch);
  answer(res, 202, {{"batch_id", batch.batch_id}, {"device_id", device->id}, {"accepted", batch.samples.size()}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/telemetry", ingest); }
`,
    },
  },
  harness: {
    python: `import json

from ingestd import registry

RANGES = {"temp_c": [-40, 85], "humidity": [0, 100]}


def _api(ctx):
    registry.register_device("d-1", "f-1", RANGES)
    return ctx.client(ctx.load("api").app)


def _batch(samples, device_id="d-1", batch_id="b-1"):
    return {"batch_id": batch_id, "device_id": device_id, "samples": samples}


def _wal(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("wal:ingest", 0, -1)]


def _now(ctx):
    return int(ctx.clock.time())


async def check_route(ctx):
    now = _now(ctx)
    async with _api(ctx) as c:
        r = await c.post("/v1/telemetry", json=_batch([{"metric": "temp_c", "value": 21.5, "ts": now - 10}, {"metric": "humidity", "value": 40, "ts": now - 10}]))
        empty = await c.post("/v1/telemetry", json=_batch([], batch_id="b-2"))
    assert r.status_code == 202, f"a valid batch from d-1 answered {r.status_code}: {r.text}"
    assert r.json().get("accepted") == 2, f"the 202 must carry the accepted count 2, got {r.json()}"
    rows = _wal(ctx)
    assert len(rows) == 1 and rows[0]["batch_id"] == "b-1" and len(rows[0]["samples"]) == 2, f"the WAL must hold batch b-1 with its two samples, it holds {rows}"
    assert empty.status_code == 400, f"a batch with no samples answered {empty.status_code}, expected 400"


async def check_device_known(ctx):
    now = _now(ctx)
    async with _api(ctx) as c:
        r = await c.post("/v1/telemetry", json=_batch([{"metric": "temp_c", "value": 21.5, "ts": now}], device_id="d-typo"))
    assert r.status_code == 404, f"a batch from d-typo, a device the registry does not know, answered {r.status_code}, expected 404"
    created = registry.lookup("d-typo")
    assert created is None, f"the ingest path created a registry row for d-typo: {created}. Only provisioning registers devices"
    assert _wal(ctx) == [], f"a batch from an unknown device reached the WAL: {_wal(ctx)}"


async def check_metric_known(ctx):
    now = _now(ctx)
    async with _api(ctx) as c:
        r = await c.post("/v1/telemetry", json=_batch([{"metric": "temp_c", "value": 21.5, "ts": now}, {"metric": "pressure_hpa", "value": 1013, "ts": now}]))
    assert r.status_code == 400, f"a batch with pressure_hpa, a metric d-1 never declared, answered {r.status_code}, expected 400"
    assert "pressure_hpa" in r.text, f"the 400 must name the undeclared metric pressure_hpa, got {r.text}"
    assert _wal(ctx) == [], f"a batch with an undeclared metric reached the WAL: {_wal(ctx)}"


async def check_value_range(ctx):
    now = _now(ctx)
    async with _api(ctx) as c:
        r = await c.post("/v1/telemetry", json=_batch([{"metric": "humidity", "value": 40, "ts": now}, {"metric": "temp_c", "value": 9.2e18, "ts": now}]))
        edge = await c.post("/v1/telemetry", json=_batch([{"metric": "temp_c", "value": 85, "ts": now}], batch_id="b-2"))
    assert r.status_code == 422, f"temp_c = 9.2e18 against a declared range of [-40, 85] answered {r.status_code}, expected 422"
    assert "temp_c" in r.text and "85" in r.text, f"the 422 must name the metric temp_c and its range [-40, 85], got {r.text}"
    rows = _wal(ctx)
    assert all(row["batch_id"] != "b-1" for row in rows), f"the batch with the overflow reading reached the WAL: {rows}"
    assert edge.status_code == 202, f"temp_c = 85, the top of its declared range, answered {edge.status_code}: the range is inclusive"


async def check_timestamp_window(ctx):
    now = _now(ctx)
    async with _api(ctx) as c:
        ahead = await c.post("/v1/telemetry", json=_batch([{"metric": "temp_c", "value": 21.5, "ts": now + 365 * 86400}]))
        stale = await c.post("/v1/telemetry", json=_batch([{"metric": "temp_c", "value": 21.5, "ts": now - 7200}], batch_id="b-2"))
        skewed = await c.post("/v1/telemetry", json=_batch([{"metric": "temp_c", "value": 21.5, "ts": now + 60}], batch_id="b-3"))
    assert ahead.status_code == 422, f"a reading stamped a year ahead of the clock answered {ahead.status_code}, expected 422"
    assert stale.status_code == 422, f"a reading stamped two hours ago (past MAX_AGE_S) answered {stale.status_code}, expected 422"
    assert skewed.status_code == 202, f"a reading 60 s ahead (inside MAX_SKEW_S) answered {skewed.status_code}: {skewed.text}"
    batches = [row["batch_id"] for row in _wal(ctx)]
    assert batches == ["b-3"], f"the WAL holds batches {batches}, expected only b-3"
`,
    typescript: `const RANGES = {temp_c: [-40, 85], humidity: [0, 100]};

async function api(ctx) {
  const registry = ctx.load('/support/ingestd/registry.ts');
  await registry.registerDevice('d-1', 'f-1', RANGES);
  return {c: ctx.client(ctx.load('api').app), registry};
}

const batch = (samples, deviceId = 'd-1', batchId = 'b-1') => ({batch_id: batchId, device_id: deviceId, samples});
const walRows = ctx => ctx.redis.lrange('wal:ingest', 0, -1).map(row => JSON.parse(row));
const nowS = ctx => Math.floor(ctx.clock.now() / 1000);

export async function check_route(ctx) {
  const now = nowS(ctx);
  const {c} = await api(ctx);
  const r = await c.post('/v1/telemetry', {json: batch([{metric: 'temp_c', value: 21.5, ts: now - 10}, {metric: 'humidity', value: 40, ts: now - 10}])});
  assert.equal(r.status, 202, \`a valid batch from d-1 answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().accepted, 2, \`the 202 must carry the accepted count 2, got \${r.text}\`);
  const rows = walRows(ctx);
  assert(rows.length === 1 && rows[0].batch_id === 'b-1' && rows[0].samples.length === 2, \`the WAL must hold batch b-1 with its two samples, it holds \${JSON.stringify(rows)}\`);
  const empty = await c.post('/v1/telemetry', {json: batch([], 'd-1', 'b-2')});
  assert.equal(empty.status, 400, \`a batch with no samples answered \${empty.status}, expected 400\`);
}

export async function check_device_known(ctx) {
  const now = nowS(ctx);
  const {c, registry} = await api(ctx);
  const r = await c.post('/v1/telemetry', {json: batch([{metric: 'temp_c', value: 21.5, ts: now}], 'd-typo')});
  assert.equal(r.status, 404, \`a batch from d-typo, a device the registry does not know, answered \${r.status}, expected 404\`);
  const created = await registry.lookup('d-typo');
  assert.equal(created, null, \`the ingest path created a registry row for d-typo: \${JSON.stringify(created)}. Only provisioning registers devices\`);
  assert.equal(walRows(ctx).length, 0, \`a batch from an unknown device reached the WAL: \${JSON.stringify(walRows(ctx))}\`);
}

export async function check_metric_known(ctx) {
  const now = nowS(ctx);
  const {c} = await api(ctx);
  const r = await c.post('/v1/telemetry', {json: batch([{metric: 'temp_c', value: 21.5, ts: now}, {metric: 'pressure_hpa', value: 1013, ts: now}])});
  assert.equal(r.status, 400, \`a batch with pressure_hpa, a metric d-1 never declared, answered \${r.status}, expected 400\`);
  assert(r.text.includes('pressure_hpa'), \`the 400 must name the undeclared metric pressure_hpa, got \${r.text}\`);
  assert.equal(walRows(ctx).length, 0, \`a batch with an undeclared metric reached the WAL: \${JSON.stringify(walRows(ctx))}\`);
}

export async function check_value_range(ctx) {
  const now = nowS(ctx);
  const {c} = await api(ctx);
  const r = await c.post('/v1/telemetry', {json: batch([{metric: 'humidity', value: 40, ts: now}, {metric: 'temp_c', value: 9.2e18, ts: now}])});
  assert.equal(r.status, 422, \`temp_c = 9.2e18 against a declared range of [-40, 85] answered \${r.status}, expected 422\`);
  assert(r.text.includes('temp_c') && r.text.includes('85'), \`the 422 must name the metric temp_c and its range [-40, 85], got \${r.text}\`);
  const rows = walRows(ctx);
  assert(rows.every(row => row.batch_id !== 'b-1'), \`the batch with the overflow reading reached the WAL: \${JSON.stringify(rows)}\`);
  const edge = await c.post('/v1/telemetry', {json: batch([{metric: 'temp_c', value: 85, ts: now}], 'd-1', 'b-2')});
  assert.equal(edge.status, 202, \`temp_c = 85, the top of its declared range, answered \${edge.status}: the range is inclusive\`);
}

export async function check_timestamp_window(ctx) {
  const now = nowS(ctx);
  const {c} = await api(ctx);
  const ahead = await c.post('/v1/telemetry', {json: batch([{metric: 'temp_c', value: 21.5, ts: now + 365 * 86400}])});
  const stale = await c.post('/v1/telemetry', {json: batch([{metric: 'temp_c', value: 21.5, ts: now - 7200}], 'd-1', 'b-2')});
  const skewed = await c.post('/v1/telemetry', {json: batch([{metric: 'temp_c', value: 21.5, ts: now + 60}], 'd-1', 'b-3')});
  assert.equal(ahead.status, 422, \`a reading stamped a year ahead of the clock answered \${ahead.status}, expected 422\`);
  assert.equal(stale.status, 422, \`a reading stamped two hours ago (past MAX_AGE_S) answered \${stale.status}, expected 422\`);
  assert.equal(skewed.status, 202, \`a reading 60 s ahead (inside MAX_SKEW_S) answered \${skewed.status}: \${skewed.text}\`);
  const batches = walRows(ctx).map(row => row.batch_id);
  assert.deepEqual(batches, ['b-3'], \`the WAL holds batches \${JSON.stringify(batches)}, expected only b-3\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"ingestd/registry"

	"leetbuild/harness"
)

type walRow struct {
	BatchID string           \`json:"batch_id"\`
	Samples []map[string]any \`json:"samples"\`
}

func api(ctx *harness.Ctx) *harness.HTTP {
	_, err := registry.RegisterDevice(context.Background(), "d-1", "f-1", map[string][2]float64{"temp_c": {-40, 85}, "humidity": {0, 100}})
	ctx.NoError(err, "registering d-1")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func telemetry(batchID, deviceID string, samples ...map[string]any) map[string]any {
	return map[string]any{"batch_id": batchID, "device_id": deviceID, "samples": samples}
}

func reading(metric string, value float64, ts int64) map[string]any {
	return map[string]any{"metric": metric, "value": value, "ts": ts}
}

func walRows(ctx *harness.Ctx) []walRow {
	var rows []walRow
	for _, text := range ctx.Redis.LRange("wal:ingest", 0, -1) {
		var row walRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "a WAL entry must be JSON: %s", text)
		rows = append(rows, row)
	}
	return rows
}

func nowS(ctx *harness.Ctx) int64 { return ctx.Clock.Now() / 1000 }

func CheckRoute(ctx *harness.Ctx) {
	now := nowS(ctx)
	c := api(ctx)
	r := c.Post("/v1/telemetry", telemetry("b-1", "d-1", reading("temp_c", 21.5, now-10), reading("humidity", 40, now-10)))
	ctx.Equal(r.Status, 202, "a valid batch from d-1 (%s)", r.Text())
	var body struct {
		Accepted int \`json:"accepted"\`
	}
	r.Decode(&body)
	ctx.Equal(body.Accepted, 2, "the 202 must carry the accepted count (%s)", r.Text())
	rows := walRows(ctx)
	ctx.Assert(len(rows) == 1 && rows[0].BatchID == "b-1" && len(rows[0].Samples) == 2, "the WAL must hold batch b-1 with its two samples, it holds %v", rows)
	empty := c.Post("/v1/telemetry", telemetry("b-2", "d-1"))
	ctx.Equal(empty.Status, 400, "a batch with no samples")
}

func CheckDeviceKnown(ctx *harness.Ctx) {
	now := nowS(ctx)
	c := api(ctx)
	r := c.Post("/v1/telemetry", telemetry("b-1", "d-typo", reading("temp_c", 21.5, now)))
	ctx.Equal(r.Status, 404, "a batch from d-typo, a device the registry does not know")
	created, err := registry.Lookup(context.Background(), "d-typo")
	ctx.NoError(err, "looking d-typo up")
	ctx.Assert(created == nil, "the ingest path created a registry row for d-typo: %+v. Only provisioning registers devices", created)
	ctx.Equal(len(walRows(ctx)), 0, "a batch from an unknown device must not reach the WAL; WAL entries")
}

func CheckMetricKnown(ctx *harness.Ctx) {
	now := nowS(ctx)
	c := api(ctx)
	r := c.Post("/v1/telemetry", telemetry("b-1", "d-1", reading("temp_c", 21.5, now), reading("pressure_hpa", 1013, now)))
	ctx.Equal(r.Status, 400, "a batch with pressure_hpa, a metric d-1 never declared")
	ctx.Assert(strings.Contains(r.Text(), "pressure_hpa"), "the 400 must name the undeclared metric pressure_hpa, got %s", r.Text())
	ctx.Equal(len(walRows(ctx)), 0, "a batch with an undeclared metric must not reach the WAL; WAL entries")
}

func CheckValueRange(ctx *harness.Ctx) {
	now := nowS(ctx)
	c := api(ctx)
	r := c.Post("/v1/telemetry", telemetry("b-1", "d-1", reading("humidity", 40, now), reading("temp_c", 9.2e18, now)))
	ctx.Equal(r.Status, 422, "temp_c = 9.2e18 against a declared range of [-40, 85]")
	ctx.Assert(strings.Contains(r.Text(), "temp_c") && strings.Contains(r.Text(), "85"), "the 422 must name the metric temp_c and its range [-40, 85], got %s", r.Text())
	for _, row := range walRows(ctx) {
		ctx.Assert(row.BatchID != "b-1", "the batch with the overflow reading reached the WAL: %v", row)
	}
	edge := c.Post("/v1/telemetry", telemetry("b-2", "d-1", reading("temp_c", 85, now)))
	ctx.Equal(edge.Status, 202, "temp_c = 85, the top of its declared range (the range is inclusive)")
}

func CheckTimestampWindow(ctx *harness.Ctx) {
	now := nowS(ctx)
	c := api(ctx)
	ahead := c.Post("/v1/telemetry", telemetry("b-1", "d-1", reading("temp_c", 21.5, now+365*86400)))
	stale := c.Post("/v1/telemetry", telemetry("b-2", "d-1", reading("temp_c", 21.5, now-7200)))
	skewed := c.Post("/v1/telemetry", telemetry("b-3", "d-1", reading("temp_c", 21.5, now+60)))
	ctx.Equal(ahead.Status, 422, "a reading stamped a year ahead of the clock")
	ctx.Equal(stale.Status, 422, "a reading stamped two hours ago (past maxAgeS)")
	ctx.Equal(skewed.Status, 202, "a reading 60 s ahead, inside maxSkewS (%s)", skewed.Text())
	var batches []string
	for _, row := range walRows(ctx) {
		batches = append(batches, row.BatchID)
	}
	ctx.Equal(batches, []string{"b-3"}, "the WAL must hold only b-3; it holds")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "ingestd/registry.h"

using json = nlohmann::json;

namespace {

harness::HTTP api(harness::Ctx& ctx) {
  registry::registerDevice("d-1", "f-1", {{"temp_c", {-40, 85}}, {"humidity", {0, 100}}});
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

json reading(const std::string& metric, double value, long long ts) { return {{"metric", metric}, {"value", value}, {"ts", ts}}; }

harness::Response postBatch(harness::HTTP& c, const std::string& batch_id, const std::string& device_id, const json& samples) {
  return c.Post("/v1/telemetry", json{{"batch_id", batch_id}, {"device_id", device_id}, {"samples", samples}}.dump(), "Content-Type", "application/json");
}

std::vector<json> walRows(harness::Ctx& ctx) {
  std::vector<json> rows;
  for (const auto& text : ctx.Redis.LRange("wal:ingest", 0, -1)) rows.push_back(json::parse(text, nullptr, false));
  return rows;
}

long long nowS(harness::Ctx& ctx) { return ctx.Clock.Now() / 1000; }

bool contains(const std::string& text, const std::string& part) { return text.find(part) != std::string::npos; }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  const long long now = nowS(ctx);
  auto c = api(ctx);
  const auto r = postBatch(c, "b-1", "d-1", json::array({reading("temp_c", 21.5, now - 10), reading("humidity", 40, now - 10)}));
  ctx.Equal(r.Status, 202, "a valid batch from d-1 (%s)", r.Text());
  ctx.Equal(json::parse(r.Text(), nullptr, false).value("accepted", 0), 2, "the 202 must carry the accepted count (%s)", r.Text());
  const auto rows = walRows(ctx);
  ctx.Assert(rows.size() == 1 && rows[0].value("batch_id", "") == "b-1" && rows[0]["samples"].size() == 2, "the WAL must hold batch b-1 with its two samples, it holds %d entries", rows.size());
  const auto empty = postBatch(c, "b-2", "d-1", json::array());
  ctx.Equal(empty.Status, 400, "a batch with no samples");
}

void CheckDeviceKnown(harness::Ctx& ctx) {
  const long long now = nowS(ctx);
  auto c = api(ctx);
  const auto r = postBatch(c, "b-1", "d-typo", json::array({reading("temp_c", 21.5, now)}));
  ctx.Equal(r.Status, 404, "a batch from d-typo, a device the registry does not know");
  const auto created = registry::lookup("d-typo");
  ctx.Assert(!created, "the ingest path created a registry row for d-typo (fleet %q). Only provisioning registers devices", created ? created->fleet : "");
  ctx.Equal(walRows(ctx).size(), 0, "a batch from an unknown device must not reach the WAL; WAL entries");
}

void CheckMetricKnown(harness::Ctx& ctx) {
  const long long now = nowS(ctx);
  auto c = api(ctx);
  const auto r = postBatch(c, "b-1", "d-1", json::array({reading("temp_c", 21.5, now), reading("pressure_hpa", 1013, now)}));
  ctx.Equal(r.Status, 400, "a batch with pressure_hpa, a metric d-1 never declared");
  ctx.Assert(contains(r.Text(), "pressure_hpa"), "the 400 must name the undeclared metric pressure_hpa, got %s", r.Text());
  ctx.Equal(walRows(ctx).size(), 0, "a batch with an undeclared metric must not reach the WAL; WAL entries");
}

void CheckValueRange(harness::Ctx& ctx) {
  const long long now = nowS(ctx);
  auto c = api(ctx);
  const auto r = postBatch(c, "b-1", "d-1", json::array({reading("humidity", 40, now), reading("temp_c", 9.2e18, now)}));
  ctx.Equal(r.Status, 422, "temp_c = 9.2e18 against a declared range of [-40, 85]");
  ctx.Assert(contains(r.Text(), "temp_c") && contains(r.Text(), "85"), "the 422 must name the metric temp_c and its range [-40, 85], got %s", r.Text());
  for (const auto& row : walRows(ctx)) ctx.Assert(row.value("batch_id", "") != "b-1", "the batch with the overflow reading reached the WAL: %s", row.dump());
  const auto edge = postBatch(c, "b-2", "d-1", json::array({reading("temp_c", 85, now)}));
  ctx.Equal(edge.Status, 202, "temp_c = 85, the top of its declared range (the range is inclusive)");
}

void CheckTimestampWindow(harness::Ctx& ctx) {
  const long long now = nowS(ctx);
  auto c = api(ctx);
  const auto ahead = postBatch(c, "b-1", "d-1", json::array({reading("temp_c", 21.5, now + 365LL * 86400)}));
  const auto stale = postBatch(c, "b-2", "d-1", json::array({reading("temp_c", 21.5, now - 7200)}));
  const auto skewed = postBatch(c, "b-3", "d-1", json::array({reading("temp_c", 21.5, now + 60)}));
  ctx.Equal(ahead.Status, 422, "a reading stamped a year ahead of the clock");
  ctx.Equal(stale.Status, 422, "a reading stamped two hours ago (past kMaxAgeS)");
  ctx.Equal(skewed.Status, 202, "a reading 60 s ahead, inside kMaxSkewS (%s)", skewed.Text());
  std::vector<std::string> batches;
  for (const auto& row : walRows(ctx)) batches.push_back(row.value("batch_id", ""));
  ctx.Equal(batches, {"b-3"}, "the WAL must hold only b-3; it holds");
}
`,
  },
  hints: [
    'Post a batch for a device id with a typo, then one with `temp_c = 9.2e18`: both answer 202, the typo now has a registry row, and the overflow sits in the WAL for the store.',
    'The handler checks the batch shape and nothing else. `lookup(...) or register_device(...)` turns every unknown id into a device, and no sample is compared with what the registry declares for its metric or with the clock.',
    'Drop the `register_device` fallback and answer 404; for every sample read `device["metrics"].get(metric)` (400 when missing), compare `low <= value <= high` (422) and `now - MAX_AGE_S <= ts <= now + MAX_SKEW_S` (422); append only after the loop.',
  ],
  debrief: `The handler is a funnel: shape, then identity, then each reading against what the registry declared, and the append last, so the 202 means the whole batch is durable and nothing of a refused batch is. The registry stays read-only on this path because an ingest endpoint is reachable by every device and every bug in every firmware; letting it mint devices turns a typo into a fleet member nobody provisioned. The timestamp window is the check most pipelines learn late: a reading from the future is not wrong in any single field, yet it owns the newest point of its series until the clock catches up. Production edges cache registry rows with a short TTL so a fleet reconnecting after an outage does not become a lookup storm, and they count rejections per device so a broken firmware shows up on a dashboard instead of in a log.`,
};
