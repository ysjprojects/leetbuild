import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/telemetry: devices from the registry, values in range',
  concept: 'http',
  file: 'api',
  focus: ['device', 'ingest', 'registry'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the batch and acknowledges it, so a device sending well-formed samples sees a pipeline that works.
It compiles, it serves the demo, and it hides three production flaws — one of which poisoned a whole
fleet's dashboard. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/telemetry\` with body
\`{"batch_id": "…", "device_id": "…", "samples": [{"metric": "temp_c", "value": 21.5}, …]}\`.

- \`batch_id\` and \`device_id\` are non-empty strings and \`samples\` holds **1 to 500** readings
  (**400** otherwise).
- The device **must already exist in the registry**: \`registry.lookup(device_id)\` returning nothing
  is **404**. An unknown device id is a client error — the ingest path must **never** create registry
  state, because a typo or a cloned firmware image would then become a permanent fleet member.
- Every sample's metric must be **declared for that device** with a range: an undeclared metric is
  **400** and the response **names the metric**.
- Every value must be a number **inside the metric's declared \`[low, high]\`**: anything outside is
  **422**, and the response names the metric and the range it declared. A single 64-bit overflow
  value that is accepted here is a value that every downstream aggregate, rollup and alert inherits.
- **Validate before acknowledging.** The batch is acknowledged (\`202\` with the accepted count) only
  after the registry lookup and every range check have passed. An ack that goes out first is a
  promise the pipeline cannot keep: the batch is already in the client's send buffer as delivered,
  and the rejection that follows has nowhere to go.

**Failure mode the checks target.** The draft acknowledges each batch before validating a reading and
does the work in the background, so unknown devices and wild values are absorbed into aggregates that
then look plausible; and it resolves a device with \`lookup(...) or register_device(...)\`, which
silently turns any invented id into a device the pipeline will track forever.`,
  sequence: {
    participants: ['Device', 'Telemetry Ingest', 'Device registry'],
    messages: [
      {
        from: 'Device',
        to: 'Telemetry Ingest',
        label: 'POST /v1/telemetry · batch_id · device_id · samples',
        kind: 'sync',
      },
      {from: 'Telemetry Ingest', to: 'Telemetry Ingest', label: 'batch_id · device_id · 1..500 samples', kind: 'sync'},
      {from: 'Telemetry Ingest', to: 'Device registry', label: 'lookup(device_id) — never register', kind: 'sync'},
      {
        from: 'Device registry',
        to: 'Telemetry Ingest',
        label: 'device row with metric ranges / none → 404',
        kind: 'reply',
      },
      {
        from: 'Telemetry Ingest',
        to: 'Telemetry Ingest',
        label: 'range-check every reading · name the metric on rejection',
        kind: 'sync',
      },
      {from: 'Telemetry Ingest', to: 'Device', label: '202 {batch_id, accepted} only after validation', kind: 'reply'},
    ],
  },
  hints: [
    'Write the guard clauses in cost order: batch shape, sample count, registry lookup, then the per-sample range checks. Every one of them returns before the acknowledgment, so the client learns about a bad batch instead of assuming the samples landed.',
    '`registry.lookup(device_id)` is the only device resolution allowed here. The draft’s `lookup(...) or register_device(...)` is the quiet bug: it turns ingest into a device-registration API, and no amount of downstream validation can undo a fleet that now contains an id nobody provisioned.',
    'The metric error must carry the metric name and, for a range failure, the declared `[low, high]`. "invalid sample" tells the device firmware nothing and turns one bad metric into a fleet-wide support ticket; naming it lets the sending device drop exactly the offending reading.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/telemetry',
      detail: 'Register the ingest route on `POST /v1/telemetry`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/telemetry["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/telemetry['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/telemetry"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"telemetry"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/telemetry"/]},
      },
    },
    {
      id: 'device-known',
      title: 'Requires a registry device and invents no registry state',
      detail:
        'The device comes from `registry.lookup(device_id)` and an unknown id is **404**. The draft resolves it with `lookup(...) or register_device(...)`, which creates a registry row for any id a caller sends — the one write an ingest path must never do.',
      match: {
        python: {all: [/registry\.lookup\(/, /status_code\s*=\s*404/], none: [/register_device\(/]},
        typescript: {all: [/registry\.lookup\(/, /code\(\s*404\s*\)/], none: [/registerDevice\(/]},
        go: {all: [/registry\.Lookup\(/, /StatusNotFound/], none: [/RegisterDevice\(/]},
        scala: {all: [/registry\.lookup\(/, /StatusCodes\.NotFound/], none: [/registerDevice\(/]},
        cpp: {all: [/registry\.lookup\(/, /\b404\b/], none: [/registerDevice\(/]},
      },
    },
    {
      id: 'metric-known',
      title: 'Rejects an undeclared metric and names it',
      detail:
        'A metric that is not declared for the device is **400** with the metric named in the response; the declared ranges come from the registry row (`metrics`/`Metrics`). The draft accepts any metric name it is given.',
      match: {
        python: {all: [/unknown metric/, /limits\.get\(/]},
        typescript: {all: [/unknown metric/, /device\.metrics\[/]},
        go: {all: [/unknown metric/, /device\.Metrics\[/]},
        scala: {all: [/unknown metric/, /device\.metrics\.contains\(/]},
        cpp: {all: [/unknown metric/, /device->metrics\.find\(/]},
      },
    },
    {
      id: 'value-range',
      title: 'Rejects an out-of-range value with the metric and its range',
      detail:
        'A value outside the metric’s declared `[low, high]` is **422** and the response names the metric and the declared bounds. The draft writes the value through, so one overflow reading rescales every aggregate built on it.',
      match: {
        python: {all: [/out of range/, /status_code\s*=\s*422/, /low\s*<=\s*sample\.value\s*<=\s*high/]},
        typescript: {all: [/out of range/, /code\(\s*422\s*\)/, /sample\.value >= low/]},
        go: {all: [/out of range/, /statusUnprocessableEntity/, /bounds\[0\]/]},
        scala: {all: [/out of range/, /StatusCodes\.UnprocessableEntity/, /bounds\._1/]},
        cpp: {all: [/out of range/, /\b422\b/, /->second\.first/]},
      },
    },
    {
      id: 'validate-first',
      title: 'Validates before acknowledging the batch',
      detail:
        'The registry lookup happens before the batch is acknowledged (`202`/`StatusAccepted`). The draft answers first and persists in the background, so a rejected batch has already been acknowledged to the device.',
      match: {
        python: {order: [/registry\.lookup\(/, /status_code\s*=\s*202/]},
        typescript: {order: [/registry\.lookup\(/, /code\(\s*202\s*\)/]},
        go: {order: [/registry\.Lookup\(/, /StatusAccepted/]},
        scala: {order: [/registry\.lookup\(/, /StatusCodes\.Accepted/]},
        cpp: {order: [/registry\.lookup\(/, /\b202\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import BackgroundTasks, FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("ingest")


class Sample(BaseModel):
    metric: str
    value: float


class TelemetryBatch(BaseModel):
    batch_id: str
    device_id: str
    samples: list[Sample]


class DeviceRegistry:
    def lookup(self, device_id: str) -> dict | None:
        """The device row: {"id", "fleet", "metrics": {name: [low, high]}}, or None."""
        raise NotImplementedError

    def register_device(self, device_id: str) -> dict:
        """Create a registry row for a device id we have not seen before."""
        raise NotImplementedError


registry = DeviceRegistry()


@app.post("/v1/telemetry")
def ingest(batch: TelemetryBatch, background: BackgroundTasks) -> JSONResponse:
    # TODO: this draft acknowledges the batch before it validates a single reading, invents a
    # registry row for a device id it has never seen, and accepts any value, so one 64-bit
    # overflow reading is absorbed into the aggregates and rescales a whole fleet's graph.
    background.add_task(persist, batch)
    logger.info("accepted batch=%s device=%s", batch.batch_id, batch.device_id)
    return JSONResponse({"batch_id": batch.batch_id, "accepted": len(batch.samples)}, status_code=202)


def persist(batch: TelemetryBatch) -> None:
    device = registry.lookup(batch.device_id) or registry.register_device(batch.device_id)
    for sample in batch.samples:
        write_point(device["id"], sample.metric, sample.value)
`,
      solution: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("ingest")

MAX_SAMPLES = 500


class Sample(BaseModel):
    metric: str
    value: float


class TelemetryBatch(BaseModel):
    batch_id: str
    device_id: str
    samples: list[Sample]


class DeviceRegistry:
    def lookup(self, device_id: str) -> dict | None:
        """The device row: {"id", "fleet", "metrics": {name: [low, high]}}, or None."""
        raise NotImplementedError


registry = DeviceRegistry()


@app.post("/v1/telemetry")
def ingest(batch: TelemetryBatch) -> JSONResponse:
    if batch.batch_id == "" or batch.device_id == "":
        return JSONResponse({"error": "batch_id and device_id are required"}, status_code=400)
    if len(batch.samples) < 1 or len(batch.samples) > MAX_SAMPLES:
        return JSONResponse({"error": "samples must be 1..500"}, status_code=400)

    # The device must already be in the registry: an unknown id is a client error, so the ingest
    # path never creates registry state for it.
    device = registry.lookup(batch.device_id)
    if device is None:
        return JSONResponse({"error": "unknown device"}, status_code=404)

    limits = device["metrics"]
    for sample in batch.samples:
        bounds = limits.get(sample.metric)
        if bounds is None:
            return JSONResponse({"error": f"unknown metric {sample.metric}"}, status_code=400)
        low, high = bounds
        if not low <= sample.value <= high:
            return JSONResponse(
                {"error": f"metric {sample.metric} out of range [{low}, {high}]"},
                status_code=422,
            )

    # Every reading is inside its declared range, so the batch may be acknowledged.
    logger.info("accepted batch=%s device=%s samples=%d", batch.batch_id, batch.device_id, len(batch.samples))
    return JSONResponse(
        {"batch_id": batch.batch_id, "device_id": batch.device_id, "accepted": len(batch.samples)},
        status_code=202,
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/telemetry: a model-generated draft that acks the batch and validates nothing. */
import Fastify from 'fastify';

import {registry, store} from './deps';

export const app = Fastify();

interface Sample {
  metric: string;
  value: number;
}

interface TelemetryBatch {
  batch_id: string;
  device_id: string;
  samples: Sample[];
}

app.post('/v1/telemetry', async (request, reply) => {
  // TODO: this draft acknowledges the batch before it validates a single reading, invents a
  // registry row for a device id it has never seen, and accepts any value, so one 64-bit
  // overflow reading is absorbed into the aggregates and rescales a whole fleet's graph.
  const batch = request.body as TelemetryBatch;
  void storeBatch(batch);
  return reply.code(202).send({batch_id: batch.batch_id, accepted: batch.samples.length});
});

async function storeBatch(batch: TelemetryBatch): Promise<void> {
  const device = (await registry.lookup(batch.device_id)) ?? (await registry.registerDevice(batch.device_id));
  for (const sample of batch.samples) await store.writePoint(device.id, sample.metric, sample.value);
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/telemetry: registry-bound devices and in-range readings, acked only after both. */
import Fastify from 'fastify';

import {registry} from './registry';

export const app = Fastify();

const MAX_SAMPLES = 500;

interface Sample {
  metric: string;
  value: number;
}

interface TelemetryBatch {
  batch_id: string;
  device_id: string;
  samples: Sample[];
}

app.post('/v1/telemetry', async (request, reply) => {
  const batch = request.body as Partial<TelemetryBatch> | null;
  if (batch === null || typeof batch !== 'object' || !batch.batch_id || !batch.device_id)
    return reply.code(400).send({error: 'batch_id and device_id are required'});
  const samples = batch.samples ?? [];
  if (samples.length < 1 || samples.length > MAX_SAMPLES)
    return reply.code(400).send({error: 'samples must be 1..500'});

  // Never register here: an unknown device id is the caller's mistake, not a new fleet member.
  const device = await registry.lookup(batch.device_id);
  if (device === null) return reply.code(404).send({error: 'unknown device'});

  for (const sample of samples) {
    const bounds = device.metrics[sample.metric];
    if (bounds === undefined) return reply.code(400).send({error: \`unknown metric \${sample.metric}\`});
    const [low, high] = bounds;
    if (!(sample.value >= low && sample.value <= high))
      return reply.code(422).send({error: \`metric \${sample.metric} out of range [\${low}, \${high}]\`});
  }

  request.log.info({batch_id: batch.batch_id, device_id: batch.device_id, samples: samples.length}, 'accepted');
  return reply
    .code(202)
    .send({batch_id: batch.batch_id, device_id: batch.device_id, accepted: samples.length});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
)

type Sample struct {
	Metric string  \`json:"metric"\`
	Value  float64 \`json:"value"\`
}

type TelemetryBatch struct {
	BatchID  string   \`json:"batch_id"\`
	DeviceID string   \`json:"device_id"\`
	Samples  []Sample \`json:"samples"\`
}

type Device struct {
	ID      string
	Fleet   string
	Metrics map[string][2]float64
}

type DeviceRegistry struct{}

func (d *DeviceRegistry) Lookup(ctx context.Context, deviceID string) (*Device, error) { return nil, nil }

func (d *DeviceRegistry) RegisterDevice(ctx context.Context, deviceID string) (*Device, error) {
	return &Device{ID: deviceID}, nil
}

var registry = &DeviceRegistry{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func ingest(rw http.ResponseWriter, r *http.Request) {
	var batch TelemetryBatch
	if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft acknowledges the batch before it validates a single reading, invents a
	// registry row for a device id it has never seen, and accepts any value, so one 64-bit
	// overflow reading is absorbed into the aggregates and rescales a whole fleet's graph.
	go persistBatch(batch)
	writeJSON(rw, http.StatusAccepted, map[string]any{"batch_id": batch.BatchID, "accepted": len(batch.Samples)})
}

func persistBatch(batch TelemetryBatch) {
	device, err := registry.Lookup(context.Background(), batch.DeviceID)
	if err != nil || device == nil {
		device, _ = registry.RegisterDevice(context.Background(), batch.DeviceID)
	}
	for _, sample := range batch.Samples {
		_ = storePoint(context.Background(), device.ID, sample.Metric, sample.Value)
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/telemetry", ingest)
	_ = http.ListenAndServe(":8443", mux)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

const (
	maxSamples                 = 500
	statusUnprocessableEntity  = 422
)

type Sample struct {
	Metric string  \`json:"metric"\`
	Value  float64 \`json:"value"\`
}

type TelemetryBatch struct {
	BatchID  string   \`json:"batch_id"\`
	DeviceID string   \`json:"device_id"\`
	Samples  []Sample \`json:"samples"\`
}

type Device struct {
	ID      string
	Fleet   string
	Metrics map[string][2]float64
}

type DeviceRegistry struct{}

// Lookup returns nil when the device id is not in the registry.
func (d *DeviceRegistry) Lookup(ctx context.Context, deviceID string) (*Device, error) { return nil, nil }

var registry = &DeviceRegistry{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func ingest(rw http.ResponseWriter, r *http.Request) {
	var batch TelemetryBatch
	if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if batch.BatchID == "" || batch.DeviceID == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "batch_id and device_id are required"})
		return
	}
	if len(batch.Samples) < 1 || len(batch.Samples) > maxSamples {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "samples must be 1..500"})
		return
	}

	// Never register here: an unknown device id is the caller's mistake, not a new fleet member.
	device, err := registry.Lookup(r.Context(), batch.DeviceID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "registry unavailable"})
		return
	}
	if device == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown device"})
		return
	}

	for _, sample := range batch.Samples {
		bounds, ok := device.Metrics[sample.Metric]
		if !ok {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown metric " + sample.Metric})
			return
		}
		if sample.Value < bounds[0] || sample.Value > bounds[1] {
			writeJSON(rw, statusUnprocessableEntity,
				map[string]string{"error": "metric " + sample.Metric + " out of range"})
			return
		}
	}

	log.Printf("accepted batch=%s device=%s samples=%d", batch.BatchID, batch.DeviceID, len(batch.Samples))
	writeJSON(rw, http.StatusAccepted, map[string]any{
		"batch_id":  batch.BatchID,
		"device_id": batch.DeviceID,
		"accepted":  len(batch.Samples),
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/telemetry", ingest)
	_ = http.ListenAndServe(":8443", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Sample(metric: String, value: Double)
final case class TelemetryBatch(batch_id: String, device_id: String, samples: List[Sample])

object IngestApi {
  implicit val system: ActorSystem = ActorSystem("telemetry-ingest")
  implicit val sampleFormat: RootJsonFormat[Sample] = jsonFormat2(Sample)
  implicit val batchFormat: RootJsonFormat[TelemetryBatch] = jsonFormat3(TelemetryBatch)

  val registry = DeviceRegistry.open()

  val route: Route =
    path("v1" / "telemetry") {
      post {
        entity(as[TelemetryBatch]) { batch =>
          // TODO: this draft acknowledges the batch before it validates a single reading, invents
          // a registry row for a device id it has never seen, and accepts any value, so one
          // 64-bit overflow reading is absorbed into the aggregates.
          system.dispatcher.execute(() => persist(batch))
          complete(
            StatusCodes.Accepted,
            s"""{"batch_id":"\${batch.batch_id}","accepted":\${batch.samples.length}}"""
          )
        }
      }
    }

  def persist(batch: TelemetryBatch): Unit = {
    val device = registry.lookup(batch.device_id).getOrElse(registry.registerDevice(batch.device_id))
    batch.samples.foreach(sample => storePoint(device.id, sample.metric, sample.value))
  }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Sample(metric: String, value: Double)
final case class TelemetryBatch(batch_id: String, device_id: String, samples: List[Sample])

object IngestApi {
  implicit val system: ActorSystem = ActorSystem("telemetry-ingest")
  implicit val sampleFormat: RootJsonFormat[Sample] = jsonFormat2(Sample)
  implicit val batchFormat: RootJsonFormat[TelemetryBatch] = jsonFormat3(TelemetryBatch)

  val MaxSamples = 500

  val registry = DeviceRegistry.open()

  val route: Route =
    path("v1" / "telemetry") {
      post {
        entity(as[TelemetryBatch]) { batch =>
          if (batch.batch_id.isEmpty || batch.device_id.isEmpty) {
            complete(StatusCodes.BadRequest, """{"error":"batch_id and device_id are required"}""")
          } else if (batch.samples.isEmpty || batch.samples.length > MaxSamples) {
            complete(StatusCodes.BadRequest, """{"error":"samples must be 1..500"}""")
          } else {
            // Never register here: an unknown device id is the caller's mistake, not a new member.
            registry.lookup(batch.device_id) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"unknown device"}""")
              case Some(device) =>
                batch.samples.find(sample => !device.metrics.contains(sample.metric)) match {
                  case Some(sample) =>
                    complete(StatusCodes.BadRequest, s"""{"error":"unknown metric \${sample.metric}"}""")
                  case None =>
                    batch.samples.find { sample =>
                      val bounds = device.metrics(sample.metric)
                      sample.value < bounds._1 || sample.value > bounds._2
                    } match {
                      case Some(sample) =>
                        val bounds = device.metrics(sample.metric)
                        complete(
                          StatusCodes.UnprocessableEntity,
                          s"""{"error":"metric \${sample.metric} out of range [\${bounds._1}, \${bounds._2}]"}"""
                        )
                      case None =>
                        system.log.info(
                          s"accepted batch=\${batch.batch_id} device=\${batch.device_id} samples=\${batch.samples.length}"
                        )
                        complete(
                          StatusCodes.Accepted,
                          s"""{"batch_id":"\${batch.batch_id}","device_id":"\${batch.device_id}","accepted":\${batch.samples.length}}"""
                        )
                    }
                }
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
#include <thread>

using json = nlohmann::json;

struct Device {
  std::string id;
  std::string fleet;
  std::map<std::string, std::pair<double, double>> metrics;
};

struct DeviceRegistry {
  std::optional<Device> lookup(const std::string& deviceId);
  Device registerDevice(const std::string& deviceId);
};

DeviceRegistry registry;

void persistBatch(const json& batch);

int main() {
  httplib::Server svr;

  svr.Post("/v1/telemetry", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft acknowledges the batch before it validates a single reading, invents a
    // registry row for a device id it has never seen, and accepts any value, so one 64-bit
    // overflow reading is absorbed into the aggregates and rescales a whole fleet's graph.
    res.status = 202;
    res.set_content(
        json{{"batch_id", body.value("batch_id", std::string())},
             {"accepted", body.value("samples", json::array()).size()}}
            .dump(),
        "application/json");
    std::thread([body]() { persistBatch(body); }).detach();
  });

  svr.listen("0.0.0.0", 8443);
}

void persistBatch(const json& batch) {
  const auto deviceId = batch.value("device_id", std::string());
  auto device = registry.lookup(deviceId);
  if (!device) device = registry.registerDevice(deviceId);
  for (const auto& sample : batch.value("samples", json::array())) {
    storePoint(device->id, sample.value("metric", std::string()), sample.value("value", 0.0));
  }
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <map>
#include <string>
#include <utility>

using json = nlohmann::json;

constexpr std::size_t kMaxSamples = 500;

struct Device {
  std::string id;
  std::string fleet;
  std::map<std::string, std::pair<double, double>> metrics;
};

struct DeviceRegistry {
  std::optional<Device> lookup(const std::string& deviceId);
};

DeviceRegistry registry;

int main() {
  httplib::Server svr;

  svr.Post("/v1/telemetry", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("batch_id") || !body["batch_id"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"batch_id and device_id are required"})", "application/json");
      return;
    }
    const auto batchId = body["batch_id"].get<std::string>();
    const auto deviceId = body.value("device_id", std::string());
    if (batchId.empty() || deviceId.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"batch_id and device_id are required"})", "application/json");
      return;
    }
    const auto samples = body.value("samples", json::array());
    if (samples.empty() || samples.size() > kMaxSamples) {
      res.status = 400;
      res.set_content(R"({"error":"samples must be 1..500"})", "application/json");
      return;
    }

    // Never register here: an unknown device id is the caller's mistake, not a new fleet member.
    const auto device = registry.lookup(deviceId);
    if (!device) {
      res.status = 404;
      res.set_content(R"({"error":"unknown device"})", "application/json");
      return;
    }

    for (const auto& sample : samples) {
      const auto metric = sample.value("metric", std::string());
      const auto bounds = device->metrics.find(metric);
      if (bounds == device->metrics.end()) {
        res.status = 400;
        res.set_content(json{{"error", "unknown metric " + metric}}.dump(), "application/json");
        return;
      }
      const auto value = sample.value("value", 0.0);
      if (value < bounds->second.first || value > bounds->second.second) {
        res.status = 422;
        res.set_content(
            json{{"error", "metric " + metric + " out of range [" +
                               std::to_string(bounds->second.first) + ", " +
                               std::to_string(bounds->second.second) + "]"}}
                .dump(),
            "application/json");
        return;
      }
    }

    std::cout << "accepted batch=" << batchId << " device=" << deviceId << " samples=" << samples.size() << "\\n";
    res.status = 202;
    res.set_content(
        json{{"batch_id", batchId}, {"device_id", deviceId}, {"accepted", samples.size()}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary of a data pipeline. The draft reads fine because the demo sends one well-formed batch from one known device. Three separate defects are being checked: the device must come from the registry (an ingest path that registers devices is a public write API with no auth model), every reading must be inside the range the metric declares (the overflow value that scaled a graph to zero arrived exactly here), and the acknowledgment must follow validation rather than lead it. That last one is the order bug interviewers love: an early 202 is a promise that the client will not retry, so the rejection that follows is invisible to the device and the batch is lost without a trace. Real edges add batch-level idempotency, per-metric cardinality limits, and a device clock skew check, but the validation funnel and the ack position are what make the pipeline's numbers defensible.`,
};
