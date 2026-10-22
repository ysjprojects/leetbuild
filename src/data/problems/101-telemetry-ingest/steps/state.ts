import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis per-device rate and latest-value state',
  concept: 'redis',
  file: 'state',
  focus: ['ingest', 'redis', 'tsdb'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a device with room in its
window gets its batch through and its latest values are visible to the dashboard, so the demo looks
right. The draft hides a race, a leak and a half-applied write. Find them, fix them, and prove the
fix with the checks below.

Implement \`admit(device_id, samples)\`, the Redis decision the ingest path makes before it writes
anything:

- Each device may send at most **600 samples** per **60-second window**. The counter key is
  \`rate:{device_id}:{window}\` where \`window\` is the UTC minute bucket
  (\`floor(unix_seconds / 60)\`) — a window-less key never resets, so a device that had one busy
  minute is refused forever.
- One **atomic Lua \`EVAL\`** must read the counter, **reject the whole batch when it does not
  fit**, and only on success increment the counter **and** write the latest value of every metric
  into \`latest:{device_id}\` (a hash field per metric). A read followed by a separate increment lets
  a storm of samples pass the same check before any counter moves; a value written outside the
  script can land while the rate check fails, so a refused batch still changes the device's latest
  value.
- The window key must **expire with its window**: set \`EXPIRE\` inside the same script on the first
  write and report the remaining \`TTL\`, so per-device state is forgotten instead of tracked
  forever.
- A refused batch is **429** with \`Retry-After\` (seconds, the key's remaining TTL) and
  \`X-RateLimit-Remaining\` (samples left in the window), and it must leave both keys untouched.

**Failure mode the checks target.** Two concurrent batches both read budget that only one of them
can spend; the counter lives in a client-side read-then-increment whose window is exactly where a
retry storm fits; the latest value is written even when the batch is refused; and a device that sent
one sample in March is still allocating keys in December.`,
  sequence: {
    participants: ['Telemetry Ingest', 'Redis', 'Time-series store'],
    messages: [
      {
        from: 'Telemetry Ingest',
        to: 'Redis',
        label: 'EVAL admit · KEYS[rate:{device}:{window}, latest:{device}]',
        kind: 'sync',
      },
      {
        from: 'Redis',
        to: 'Telemetry Ingest',
        label: '{1|0, remaining, ttl} — a refused batch writes nothing',
        kind: 'reply',
      },
      {
        from: 'Telemetry Ingest',
        to: 'Telemetry Ingest',
        label: '429 {Retry-After, X-RateLimit-Remaining} when refused',
        kind: 'sync',
      },
      {
        from: 'Telemetry Ingest',
        to: 'Time-series store',
        label: 'WritePoints · only admitted samples',
        kind: 'sync',
      },
      {from: 'Time-series store', to: 'Telemetry Ingest', label: 'accepted / failed sub-batches', kind: 'reply'},
    ],
  },
  hints: [
    'Read, decide and write inside one script: `HGET` the window counter, compare it against the limit with the batch size added, and return the refusal tuple **before** any `HINCRBY` or `HSET`. A client-side `GET` followed by `INCRBY` has a window between the two commands, and that window is exactly where a retry storm fits.',
    'A window key must die with its window: check `TTL` inside the same script and call `EXPIRE` when the key was just created. Without it the per-minute budget accumulates forever, and a device that sent once is tracked for the lifetime of the cluster.',
    'The latest value belongs to the same script as the counter, because "the batch was admitted" and "the device\'s latest value is this" are one decision. Two commands mean a refused batch can still move the dashboard, and a crash between them leaves the counter charged for a value that was never written.',
  ],
  checks: [
    {
      id: 'atomic-script',
      title: 'Rate counter and latest value share one Lua script',
      detail:
        'One `EVAL`/`NewScript` call runs a script that touches both keys: the window counter (`HINCRBY`) and the latest-value hash (`HSET`). The draft increments the counter from the client after writing the values, so the two can disagree.',
      match: {
        python: {all: [/ADMIT_LUA/, /\.eval\(/, /HINCRBY/, /HSET/]},
        typescript: {all: [/ADMIT_LUA/, /\.eval\(/, /HINCRBY/, /HSET/]},
        go: {all: [/admitScript/, /\.Run\(/, /HINCRBY/, /HSET/]},
        scala: {all: [/AdmitLua/, /\.eval\(/, /HINCRBY/, /HSET/]},
        cpp: {all: [/kAdmitLua/, /\.eval</, /HINCRBY/, /HSET/]},
      },
    },
    {
      id: 'reject-before-write',
      title: 'Reads the counter before it increments or writes a value',
      detail:
        "Inside the script the order is `HGET` → `HINCRBY` → `HSET`: the counter is read and compared first, so a batch that does not fit returns before anything is written. The draft writes the values first and moves the counter afterwards, so a refused batch still changes the device's latest value.",
      match: {
        python: {order: [/HGET/, /HINCRBY/, /HSET/]},
        typescript: {order: [/HGET/, /HINCRBY/, /HSET/]},
        go: {order: [/HGET/, /HINCRBY/, /HSET/]},
        scala: {order: [/HGET/, /HINCRBY/, /HSET/]},
        cpp: {order: [/HGET/, /HINCRBY/, /HSET/]},
      },
    },
    {
      id: 'window-ttl',
      title: 'The window key expires on first write',
      detail:
        "The script sets the key's expiry (`EXPIRE`) when it creates it and reports the remaining `TTL`, so the per-minute budget resets and a device that sent once is not tracked forever. The draft never expires its keys.",
      match: {
        python: {all: [/EXPIRE/, /TTL/]},
        typescript: {all: [/EXPIRE/, /TTL/]},
        go: {all: [/EXPIRE/, /TTL/]},
        scala: {all: [/EXPIRE/, /TTL/]},
        cpp: {all: [/EXPIRE/, /TTL/]},
      },
    },
    {
      id: 'window-key',
      title: 'Keys the counter by device and window bucket',
      detail:
        "The counter key is `rate:{device_id}:{window}` built from the device id and the 60-second bucket, so one window cannot spend another window's budget and the counter resets every minute. The draft's `rate:{device_id}` key never resets.",
      match: {
        python: {all: [/rate:\{device_id\}:\{window\}/, /WINDOW_S/]},
        typescript: {all: [/rate:\$\{deviceId\}:\$\{window\}/, /WINDOW_S/]},
        go: {all: [/rate:%s:%d/, /windowSeconds/]},
        scala: {all: [/rate:\$deviceId:\$window/, /WindowSeconds/]},
        cpp: {all: [/"rate:" \+ deviceId \+ ":" \+ std::to_string\(window\)/, /kWindowSeconds/]},
      },
    },
    {
      id: 'reject-429',
      title: 'Refuses with 429, Retry-After and remaining samples',
      detail:
        "A device over its rate gets `429 Too Many Requests` with `Retry-After` and `X-RateLimit-Remaining` built from the script's return value, not from a constant. The draft answers a bare 429 and gives the client nothing to back off with.",
      match: {
        python: {all: [/Retry-After/, /X-RateLimit-Remaining/, /status_code\s*=\s*429/]},
        typescript: {all: [/Retry-After/, /X-RateLimit-Remaining/, /\.code\(\s*429\s*\)/]},
        go: {all: [/Retry-After/, /X-RateLimit-Remaining/, /StatusTooManyRequests/]},
        scala: {all: [/Retry-After/, /X-RateLimit-Remaining/, /StatusCodes\.TooManyRequests/]},
        cpp: {all: [/Retry-After/, /X-RateLimit-Remaining/, /status\s*=\s*429/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 60
RATE_LIMIT_SAMPLES = 600


class Sample(BaseModel):
    metric: str
    value: float


class TelemetryBatch(BaseModel):
    device_id: str
    samples: list[Sample]


def rate_key(device_id: str) -> str:
    return f"rate:{device_id}"


def latest_key(device_id: str) -> str:
    return f"latest:{device_id}"


def admit(device_id: str, samples: list[Sample]) -> tuple[bool, int, int]:
    # TODO: this draft writes the latest values first and moves the rate counter afterwards, so a
    # storm of samples passes the check before any counter moves, and its keys never expire, so a
    # device that sent once is tracked forever.
    used = int(r.get(rate_key(device_id)) or 0)
    if used + len(samples) > RATE_LIMIT_SAMPLES:
        return False, RATE_LIMIT_SAMPLES - used, WINDOW_S
    for sample in samples:
        r.hset(latest_key(device_id), sample.metric, sample.value)
    r.incrby(rate_key(device_id), len(samples))
    return True, RATE_LIMIT_SAMPLES - used - len(samples), WINDOW_S


@app.post("/v1/telemetry")
def ingest(batch: TelemetryBatch) -> JSONResponse:
    ok, remaining, ttl = admit(batch.device_id, batch.samples)
    if not ok:
        return JSONResponse({"error": "device rate exceeded"}, status_code=429)
    return JSONResponse({"device_id": batch.device_id, "remaining": remaining}, status_code=202)
`,
      solution: `import time

import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 60
RATE_LIMIT_SAMPLES = 600

ADMIT_LUA = """
local used = tonumber(redis.call('HGET', KEYS[1], 'samples')) or 0
local want = tonumber(ARGV[1])
if used + want > tonumber(ARGV[2]) then
  return {0, tonumber(ARGV[2]) - used, redis.call('TTL', KEYS[1])}
end
redis.call('HINCRBY', KEYS[1], 'samples', want)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
for index = 4, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[index], ARGV[index + 1])
end
return {1, tonumber(ARGV[2]) - used - want, redis.call('TTL', KEYS[1])}
"""


class Sample(BaseModel):
    metric: str
    value: float


class TelemetryBatch(BaseModel):
    device_id: str
    samples: list[Sample]


def rate_key(device_id: str, window: int) -> str:
    return f"rate:{device_id}:{window}"


def latest_key(device_id: str) -> str:
    return f"latest:{device_id}"


def admit(device_id: str, samples: list[Sample]) -> tuple[bool, int, int]:
    """Reserve the batch against the device's window and record its latest values, atomically."""
    window = int(time.time()) // WINDOW_S
    args: list[str] = [str(len(samples)), str(RATE_LIMIT_SAMPLES), str(WINDOW_S)]
    for sample in samples:
        args += [sample.metric, str(sample.value)]
    ok, remaining, ttl = r.eval(ADMIT_LUA, 2, rate_key(device_id, window), latest_key(device_id), *args)
    return bool(ok), int(remaining), int(ttl)


@app.post("/v1/telemetry")
def ingest(batch: TelemetryBatch) -> JSONResponse:
    ok, remaining, ttl = admit(batch.device_id, batch.samples)
    if not ok:
        return JSONResponse(
            {"error": "device rate exceeded"},
            status_code=429,
            headers={"Retry-After": str(max(ttl, 1)), "X-RateLimit-Remaining": str(remaining)},
        )
    return JSONResponse({"device_id": batch.device_id, "remaining": remaining}, status_code=202)
`,
    },
    typescript: {
      starter: `/** Per-device rate and latest-value state: a model-generated draft that writes values first. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const WINDOW_S = 60;
const RATE_LIMIT_SAMPLES = 600;

interface Sample {
  metric: string;
  value: number;
}

interface TelemetryBatch {
  device_id: string;
  samples: Sample[];
}

async function admit(deviceId: string, samples: Sample[]): Promise<[boolean, number, number]> {
  // TODO: this draft writes the latest values first and moves the rate counter afterwards, so a
  // storm of samples passes the check before any counter moves, and its keys never expire, so a
  // device that sent once is tracked forever.
  const used = Number((await r.get(\`rate:\${deviceId}\`)) ?? 0);
  if (used + samples.length > RATE_LIMIT_SAMPLES) return [false, RATE_LIMIT_SAMPLES - used, WINDOW_S];
  for (const sample of samples) await r.hset(\`latest:\${deviceId}\`, sample.metric, String(sample.value));
  await r.incrby(\`rate:\${deviceId}\`, samples.length);
  return [true, RATE_LIMIT_SAMPLES - used - samples.length, WINDOW_S];
}

app.post('/v1/telemetry', async (request, reply) => {
  const batch = request.body as TelemetryBatch;
  const [ok, remaining] = await admit(batch.device_id, batch.samples);
  if (!ok) return reply.code(429).send({error: 'device rate exceeded'});
  return reply.code(202).send({device_id: batch.device_id, remaining});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Per-device rate and latest-value state: one script decides, or nothing is written. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const WINDOW_S = 60;
const RATE_LIMIT_SAMPLES = 600;

const ADMIT_LUA = \`
local used = tonumber(redis.call('HGET', KEYS[1], 'samples')) or 0
local want = tonumber(ARGV[1])
if used + want > tonumber(ARGV[2]) then
  return {0, tonumber(ARGV[2]) - used, redis.call('TTL', KEYS[1])}
end
redis.call('HINCRBY', KEYS[1], 'samples', want)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
for index = 4, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[index], ARGV[index + 1])
end
return {1, tonumber(ARGV[2]) - used - want, redis.call('TTL', KEYS[1])}
\`;

interface Sample {
  metric: string;
  value: number;
}

interface TelemetryBatch {
  device_id: string;
  samples: Sample[];
}

function rateKey(deviceId: string, window: number): string {
  return \`rate:\${deviceId}:\${window}\`;
}

function latestKey(deviceId: string): string {
  return \`latest:\${deviceId}\`;
}

async function admit(deviceId: string, samples: Sample[]): Promise<[boolean, number, number]> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const args: string[] = [String(samples.length), String(RATE_LIMIT_SAMPLES), String(WINDOW_S)];
  for (const sample of samples) args.push(sample.metric, String(sample.value));
  const reply = (await r.eval(
    ADMIT_LUA,
    2,
    rateKey(deviceId, window),
    latestKey(deviceId),
    ...args,
  )) as [number, number, number];
  return [reply[0] === 1, reply[1], reply[2]];
}

app.post('/v1/telemetry', async (request, reply) => {
  const batch = request.body as TelemetryBatch;
  const [ok, remaining, ttl] = await admit(batch.device_id, batch.samples);
  if (!ok) {
    return reply
      .code(429)
      .header('Retry-After', String(Math.max(ttl, 1)))
      .header('X-RateLimit-Remaining', String(remaining))
      .send({error: 'device rate exceeded'});
  }
  return reply.code(202).send({device_id: batch.device_id, remaining});
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
	"strconv"

	"github.com/redis/go-redis/v9"
)

const (
	windowSeconds    = 60
	rateLimitSamples = 600
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Sample struct {
	Metric string  \`json:"metric"\`
	Value  float64 \`json:"value"\`
}

type TelemetryBatch struct {
	DeviceID string   \`json:"device_id"\`
	Samples  []Sample \`json:"samples"\`
}

func rateKey(deviceID string) string { return "rate:" + deviceID }

func latestKey(deviceID string) string { return "latest:" + deviceID }

func admit(ctx context.Context, deviceID string, samples []Sample) (bool, int64, int64, error) {
	// TODO: this draft writes the latest values first and moves the rate counter afterwards, so a
	// storm of samples passes the check before any counter moves, and its keys never expire, so a
	// device that sent once is tracked forever.
	used, err := rdb.Get(ctx, rateKey(deviceID)).Int64()
	if err == redis.Nil {
		used, err = 0, nil
	}
	if err != nil {
		return false, 0, 0, err
	}
	if used+int64(len(samples)) > rateLimitSamples {
		return false, rateLimitSamples - used, windowSeconds, nil
	}
	for _, sample := range samples {
		if err := rdb.HSet(ctx, latestKey(deviceID), sample.Metric, strconv.FormatFloat(sample.Value, 'f', -1, 64)).Err(); err != nil {
			return false, 0, 0, err
		}
	}
	if err := rdb.IncrBy(ctx, rateKey(deviceID), int64(len(samples))).Err(); err != nil {
		return false, 0, 0, err
	}
	return true, rateLimitSamples - used - int64(len(samples)), windowSeconds, nil
}

func ingest(rw http.ResponseWriter, r *http.Request) {
	var batch TelemetryBatch
	if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
		rw.WriteHeader(http.StatusBadRequest)
		return
	}
	ok, remaining, _, err := admit(r.Context(), batch.DeviceID, batch.Samples)
	if err != nil {
		rw.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	if !ok {
		rw.WriteHeader(http.StatusTooManyRequests)
		return
	}
	rw.WriteHeader(http.StatusAccepted)
	_ = remaining
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
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	windowSeconds    = 60
	rateLimitSamples = 600
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// One script owns both keys: it reads the window counter, refuses the whole batch when it does not
// fit, and only then increments the counter and writes the latest value of every metric.
var admitScript = redis.NewScript(\`
local used = tonumber(redis.call('HGET', KEYS[1], 'samples')) or 0
local want = tonumber(ARGV[1])
if used + want > tonumber(ARGV[2]) then
  return {0, tonumber(ARGV[2]) - used, redis.call('TTL', KEYS[1])}
end
redis.call('HINCRBY', KEYS[1], 'samples', want)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
for index = 4, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[index], ARGV[index + 1])
end
return {1, tonumber(ARGV[2]) - used - want, redis.call('TTL', KEYS[1])}
\`)

type Sample struct {
	Metric string  \`json:"metric"\`
	Value  float64 \`json:"value"\`
}

type TelemetryBatch struct {
	DeviceID string   \`json:"device_id"\`
	Samples  []Sample \`json:"samples"\`
}

func rateKey(deviceID string, window int64) string {
	return fmt.Sprintf("rate:%s:%d", deviceID, window)
}

func latestKey(deviceID string) string { return "latest:" + deviceID }

func admit(ctx context.Context, deviceID string, samples []Sample) (bool, int64, int64, error) {
	window := time.Now().Unix() / windowSeconds
	args := []interface{}{len(samples), rateLimitSamples, windowSeconds}
	for _, sample := range samples {
		args = append(args, sample.Metric, strconv.FormatFloat(sample.Value, 'f', -1, 64))
	}
	reply, err := admitScript.Run(ctx, rdb, []string{rateKey(deviceID, window), latestKey(deviceID)}, args...).Slice()
	if err != nil {
		return false, 0, 0, err
	}
	ok, _ := reply[0].(int64)
	remaining, _ := reply[1].(int64)
	ttl, _ := reply[2].(int64)
	return ok == 1, remaining, ttl, nil
}

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
	ok, remaining, ttl, err := admit(r.Context(), batch.DeviceID, batch.Samples)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "state unavailable"})
		return
	}
	if !ok {
		if ttl < 1 {
			ttl = 1
		}
		rw.Header().Set("Retry-After", strconv.FormatInt(ttl, 10))
		rw.Header().Set("X-RateLimit-Remaining", strconv.FormatInt(remaining, 10))
		writeJSON(rw, http.StatusTooManyRequests, map[string]string{"error": "device rate exceeded"})
		return
	}
	writeJSON(rw, http.StatusAccepted, map[string]any{"device_id": batch.DeviceID, "remaining": remaining})
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
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Sample(metric: String, value: Double)
final case class TelemetryBatch(device_id: String, samples: List[Sample])

object DeviceState {
  implicit val system: ActorSystem = ActorSystem("telemetry-ingest")
  implicit val sampleFormat: RootJsonFormat[Sample] = jsonFormat2(Sample)
  implicit val batchFormat: RootJsonFormat[TelemetryBatch] = jsonFormat2(TelemetryBatch)

  val WindowSeconds = 60L
  val RateLimitSamples = 600L
  val jedis = new Jedis("redis", 6379)

  def rateKey(deviceId: String): String = s"rate:$deviceId"

  def latestKey(deviceId: String): String = s"latest:$deviceId"

  // TODO: this draft writes the latest values first and moves the rate counter afterwards, so a
  // storm of samples passes the check before any counter moves, and its keys never expire, so a
  // device that sent once is tracked forever.
  def admit(deviceId: String, samples: List[Sample]): (Boolean, Long, Long) = {
    val used = Option(jedis.get(rateKey(deviceId))).map(_.toLong).getOrElse(0L)
    if (used + samples.length > RateLimitSamples) {
      (false, RateLimitSamples - used, WindowSeconds)
    } else {
      samples.foreach(sample => jedis.hset(latestKey(deviceId), sample.metric, sample.value.toString))
      jedis.incrBy(rateKey(deviceId), samples.length.toLong)
      (true, RateLimitSamples - used - samples.length, WindowSeconds)
    }
  }

  val route: Route =
    route {
      path("v1" / "telemetry") {
        post {
          entity(as[TelemetryBatch]) { batch =>
            val (ok, _, _) = admit(batch.device_id, batch.samples)
            if (!ok) {
              complete(StatusCodes.TooManyRequests, """{"error":"device rate exceeded"}""")
            } else {
              complete(StatusCodes.Accepted, """{"accepted":true}""")
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
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Sample(metric: String, value: Double)
final case class TelemetryBatch(device_id: String, samples: List[Sample])

object DeviceState {
  implicit val system: ActorSystem = ActorSystem("telemetry-ingest")
  implicit val sampleFormat: RootJsonFormat[Sample] = jsonFormat2(Sample)
  implicit val batchFormat: RootJsonFormat[TelemetryBatch] = jsonFormat2(TelemetryBatch)

  val WindowSeconds = 60L
  val RateLimitSamples = 600L
  val jedis = new Jedis("redis", 6379)

  val AdmitLua =
    """
      |local used = tonumber(redis.call('HGET', KEYS[1], 'samples')) or 0
      |local want = tonumber(ARGV[1])
      |if used + want > tonumber(ARGV[2]) then
      |  return {0, tonumber(ARGV[2]) - used, redis.call('TTL', KEYS[1])}
      |end
      |redis.call('HINCRBY', KEYS[1], 'samples', want)
      |if redis.call('TTL', KEYS[1]) < 0 then
      |  redis.call('EXPIRE', KEYS[1], ARGV[3])
      |end
      |for index = 4, #ARGV, 2 do
      |  redis.call('HSET', KEYS[2], ARGV[index], ARGV[index + 1])
      |end
      |return {1, tonumber(ARGV[2]) - used - want, redis.call('TTL', KEYS[1])}
      |""".stripMargin

  def rateKey(deviceId: String, window: Long): String = s"rate:$deviceId:$window"

  def latestKey(deviceId: String): String = s"latest:$deviceId"

  def admit(deviceId: String, samples: List[Sample]): (Boolean, Long, Long) = {
    val window = System.currentTimeMillis() / 1000 / WindowSeconds
    val keys = java.util.List.of(rateKey(deviceId, window), latestKey(deviceId))
    val args = new java.util.ArrayList[String]()
    args.add(samples.length.toString)
    args.add(RateLimitSamples.toString)
    args.add(WindowSeconds.toString)
    samples.foreach { sample =>
      args.add(sample.metric)
      args.add(sample.value.toString)
    }
    val result = jedis.eval(AdmitLua, keys, args).asInstanceOf[java.util.List[Long]]
    (result.get(0) == 1L, result.get(1), result.get(2))
  }

  val route: Route =
    route {
      path("v1" / "telemetry") {
        post {
          entity(as[TelemetryBatch]) { batch =>
            val (ok, remaining, ttl) = admit(batch.device_id, batch.samples)
            if (!ok) {
              complete(
                HttpResponse(
                  StatusCodes.TooManyRequests,
                  headers = List(
                    RawHeader("Retry-After", math.max(ttl, 1L).toString),
                    RawHeader("X-RateLimit-Remaining", remaining.toString)
                  ),
                  entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"device rate exceeded"}""")
                )
              )
            } else {
              complete(StatusCodes.Accepted, s"""{"remaining":$remaining}""")
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
#include <sw/redis++/redis++.h>

#include <string>
#include <tuple>
#include <vector>

using json = nlohmann::json;

constexpr long long kWindowSeconds = 60;
constexpr long long kRateLimitSamples = 600;

std::string rateKey(const std::string& deviceId) { return "rate:" + deviceId; }

std::string latestKey(const std::string& deviceId) { return "latest:" + deviceId; }

std::tuple<bool, long long, long long> admit(
    sw::redis::Redis& redis,
    const std::string& deviceId,
    const std::vector<std::pair<std::string, double>>& samples) {
  // TODO: this draft writes the latest values first and moves the rate counter afterwards, so a
  // storm of samples passes the check before any counter moves, and its keys never expire, so a
  // device that sent once is tracked forever.
  const auto raw = redis.get(rateKey(deviceId));
  const long long used = raw ? std::stoll(*raw) : 0;
  if (used + static_cast<long long>(samples.size()) > kRateLimitSamples) {
    return {false, kRateLimitSamples - used, kWindowSeconds};
  }
  for (const auto& sample : samples) {
    redis.hset(latestKey(deviceId), sample.first, std::to_string(sample.second));
  }
  redis.incrby(rateKey(deviceId), static_cast<long long>(samples.size()));
  return {true, kRateLimitSamples - used - static_cast<long long>(samples.size()), kWindowSeconds};
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/telemetry", [&redis](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    std::vector<std::pair<std::string, double>> samples;
    for (const auto& sample : body.value("samples", json::array())) {
      samples.emplace_back(sample.value("metric", std::string()), sample.value("value", 0.0));
    }
    const auto [ok, remaining, ttl] = admit(redis, body.value("device_id", std::string()), samples);
    if (!ok) {
      res.status = 429;
      res.set_content(R"({"error":"device rate exceeded"})", "application/json");
      return;
    }
    res.status = 202;
    res.set_content(json{{"remaining", remaining}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

using json = nlohmann::json;

constexpr long long kWindowSeconds = 60;
constexpr long long kRateLimitSamples = 600;

// One script owns both keys: it reads the window counter, refuses the whole batch when it does not
// fit, and only then increments the counter and writes the latest value of every metric.
const std::string kAdmitLua = R"LUA(
local used = tonumber(redis.call('HGET', KEYS[1], 'samples')) or 0
local want = tonumber(ARGV[1])
if used + want > tonumber(ARGV[2]) then
  return {0, tonumber(ARGV[2]) - used, redis.call('TTL', KEYS[1])}
end
redis.call('HINCRBY', KEYS[1], 'samples', want)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
for index = 4, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[index], ARGV[index + 1])
end
return {1, tonumber(ARGV[2]) - used - want, redis.call('TTL', KEYS[1])}
)LUA";

std::string rateKey(const std::string& deviceId, long long window) {
  return "rate:" + deviceId + ":" + std::to_string(window);
}

std::string latestKey(const std::string& deviceId) { return "latest:" + deviceId; }

std::tuple<bool, long long, long long> admit(
    sw::redis::Redis& redis,
    const std::string& deviceId,
    const std::vector<std::pair<std::string, double>>& samples) {
  const auto window = std::chrono::duration_cast<std::chrono::seconds>(
                          std::chrono::system_clock::now().time_since_epoch())
                          .count() /
                      kWindowSeconds;
  std::vector<std::string> args{std::to_string(samples.size()), std::to_string(kRateLimitSamples),
                                std::to_string(kWindowSeconds)};
  for (const auto& sample : samples) {
    args.push_back(sample.first);
    args.push_back(std::to_string(sample.second));
  }
  const auto result = redis.eval<std::vector<long long>>(
      kAdmitLua, {rateKey(deviceId, window), latestKey(deviceId)}, args);
  auto ttl = result[2];
  if (ttl < 1) ttl = 1;
  return {result[0] == 1, result[1], ttl};
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/telemetry", [&redis](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    std::vector<std::pair<std::string, double>> samples;
    for (const auto& sample : body.value("samples", json::array())) {
      samples.emplace_back(sample.value("metric", std::string()), sample.value("value", 0.0));
    }
    const auto [ok, remaining, ttl] = admit(redis, body.value("device_id", std::string()), samples);
    if (!ok) {
      res.status = 429;
      res.set_header("Retry-After", std::to_string(ttl));
      res.set_header("X-RateLimit-Remaining", std::to_string(remaining));
      res.set_content(R"({"error":"device rate exceeded"})", "application/json");
      return;
    }
    res.status = 202;
    res.set_content(json{{"remaining", remaining}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question behind this step is atomicity plus lifetime. A read-then-increment limiter passes every serial test and fails exactly when the fleet is loud, which is when the limit matters: two concurrent batches both observe budget that only one of them can spend, and the counter ends up below zero. One Lua script makes read, compare, increment and the latest-value write a single step, so a refusal changes nothing at all — no half-applied state where the dashboard shows a value from a batch the pipeline refused. Setting the expiry inside the same script ties the counter's life to its window, which is also what makes the state self-cleaning instead of a key per device that has ever been seen. The 429 headers are the third half of the contract: a client that receives \`Retry-After\` and \`X-RateLimit-Remaining\` can back off by exactly as much as the window needs, while a bare 429 invites the retry storm the limiter exists to stop. Real edges add per-metric weights, sliding windows, and a per-device admission lock for very high-rate devices, but they all start here.`,
};
