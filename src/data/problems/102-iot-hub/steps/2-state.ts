import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis shadow with desired/reported versions reconciled',
  concept: 'redis',
  file: 'state',
  focus: ['hub', 'shadow', 'device'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: an operator's desired document
is stored, a device's report is stored, and the demo shows the shadow changing. What happens to the
operator's change when a device reconnects with its old configuration — and to the version numbers
the fleet reads back — is the flaw. Review it like the service owner, fix it, and prove the fix.

Implement the Redis shadow state behind the hub. One hash per device at \`shadow:{device_id}\`:

- The shadow holds **two documents with their own counters**: the operator's \`desired\` document with
  \`desired_version\`, and the device's \`reported\` document with \`reported_version\`. A counter
  advances only when *its own* document changes — a report must never advance \`desired_version\`,
  and an operator write must never advance \`reported_version\`.
- \`PUT /v1/devices/{id}/desired\` replaces \`desired\` with the body's \`state\`, bumps
  \`desired_version\` by exactly **one**, and answers \`{"desired_version": n}\`.
- \`POST /v1/devices/{id}/reported\` carries the device's \`reported_version\`. The update **merges by
  version**: a report that is **not newer** than the stored \`reported_version\` is ignored — it
  writes nothing at all — while a newer one stores \`reported\` and records its version. It never
  touches the desired document. Answer \`{"accepted": bool, "reported_version": n}\`.
- The comparison, the write and the version bump happen in **one atomic script** (a Lua \`EVAL\`). A
  \`HGET\` in your process followed by an \`HSET\` lets two reports that arrive together both see the
  old version and both write.
- \`POST /v1/devices/{id}/reconcile\` reads both documents and both counters and answers
  \`{"converged": bool, "divergence": ["fields where reported is behind"], "apply": <the desired document>}\`.
  Reconciliation converges **on the desired document**: the device is asked to adopt what the
  operator wants, never the other way around.

**Failure mode the checks target.** The draft keeps one \`state\` document and one fused \`version\`
counter for both sides, and it advances that counter by two on every write, so the versions the
fleet sees skip every other number and neither document owns its version. Because there is only one
document, a device that reconnects with its old configuration overwrites the operator's intended
change wholesale: intent disappears and no divergence is ever flagged. And with no version
comparison, whatever arrives last wins — a report delayed by a reconnect erases a newer document,
and there is nothing left to reconcile back to.`,
  sequence: {
    participants: ['IoT Hub', 'Shadow', 'Device'],
    messages: [
      {from: 'IoT Hub', to: 'Shadow', label: 'EVAL desired · HINCRBY desired_version · HSET desired', kind: 'sync'},
      {from: 'Shadow', to: 'IoT Hub', label: '{desired_version: 3}', kind: 'reply'},
      {from: 'Device', to: 'IoT Hub', label: 'POST reported {reported_version: 6, state}', kind: 'sync'},
      {from: 'IoT Hub', to: 'Shadow', label: 'EVAL report · 6 > stored 5 → HSET reported only', kind: 'sync'},
      {from: 'Shadow', to: 'IoT Hub', label: '{1, 6} — accepted', kind: 'reply'},
      {from: 'IoT Hub', to: 'Device', label: 'stale report {5} → {0, 5}, desired untouched', kind: 'sync'},
      {from: 'IoT Hub', to: 'Shadow', label: 'HGETALL reconcile · reported_version < desired_version', kind: 'sync'},
      {from: 'Shadow', to: 'IoT Hub', label: '{divergence: [mode], apply: desired}', kind: 'reply'},
    ],
  },
  hints: [
    'Two documents, two counters. The desired write is `HINCRBY` on `desired_version` inside its own script; the report script records the device’s own `reported_version`. A fused counter cannot tell an operator write from a device report, makes the numbers skip, and leaves neither document with a version of its own.',
    'Merging by version is a comparison that has to live inside Redis: read the stored version with `HGET`, then `if incoming <= stored then return {0, stored} end`. Do the read, the comparison and the `HSET` in one script — two reports that arrive together otherwise both see the old version and the later one wins.',
    'The reconciler is read-only and one-directional: both documents, both counters, `behind = reported_version < desired_version`, and `apply` is always the desired document with `divergence` listing the fields the device has not adopted. Copying reported into desired is the draft’s bug, not convergence.',
  ],
  checks: [
    {
      id: 'desired-version',
      title: 'The desired document owns its version counter',
      detail:
        'A desired write bumps `desired_version` by one inside its own `DESIRED_LUA`/`desiredScript` script (`HINCRBY` on that field), so the operator’s document has a version of its own. The draft shares one fused `version` counter for both sides and advances it by two per write, so the numbers skip and neither side can be compared against the other.',
      match: {
        python: {all: [/DESIRED_LUA/, /'desired_version'/, /HINCRBY/]},
        typescript: {all: [/DESIRED_LUA/, /'desired_version'/, /HINCRBY/]},
        go: {all: [/desiredScript/, /'desired_version'/, /HINCRBY/]},
        scala: {all: [/DesiredLua/, /'desired_version'/, /HINCRBY/]},
        cpp: {all: [/kDesiredLua/, /'desired_version'/, /HINCRBY/]},
      },
    },
    {
      id: 'reported-version',
      title: 'The reported document owns its version counter',
      detail:
        'A report advances `reported_version` through its own report script (`REPORT_LUA`) and writes the `reported` field: the device’s reports move the reported counter, an operator write never does, and the desired counter is never touched by a report. The draft advances one shared counter for both documents.',
      match: {
        python: {all: [/REPORT_LUA/, /'reported_version'/, /HSET/]},
        typescript: {all: [/REPORT_LUA/, /'reported_version'/, /HSET/]},
        go: {all: [/reportScript/, /'reported_version'/, /HSET/]},
        scala: {all: [/ReportLua/, /'reported_version'/, /HSET/]},
        cpp: {all: [/kReportLua/, /'reported_version'/, /HSET/]},
      },
    },
    {
      id: 'stale-report-guard',
      title: 'A report that is not newer changes nothing',
      detail:
        'The report script reads the stored `reported_version` (`HGET`) and keeps only a strictly newer one: `if incoming <= stored then return {0, stored} end`. The draft writes whatever arrives, so a device that reconnects with its old configuration overwrites the current document and the operator’s newer intent is lost.',
      match: {
        python: {all: [/'reported_version'/, /incoming\s*<=\s*stored/, /return \{0/]},
        typescript: {all: [/'reported_version'/, /incoming\s*<=\s*stored/, /return \{0/]},
        go: {all: [/'reported_version'/, /incoming\s*<=\s*stored/, /return \{0/]},
        scala: {all: [/'reported_version'/, /incoming\s*<=\s*stored/, /return \{0/]},
        cpp: {all: [/'reported_version'/, /incoming\s*<=\s*stored/, /return \{0/]},
      },
    },
    {
      id: 'merge-by-version',
      title: 'Two documents merged by version, never overwritten wholesale',
      detail:
        'The desired and reported documents live in their own hash fields (`desired`, `reported`) under the one `shadow:{device_id}` key: a report writes `reported`, an operator write writes `desired`, and the pair is merged by version. The draft keeps a single `state` field whose newest writer wins, so a device report replaces the operator’s document wholesale.',
      match: {
        python: {all: [/'desired'/, /'reported'/, /HSET/]},
        typescript: {all: [/'desired'/, /'reported'/, /HSET/]},
        go: {all: [/'desired'/, /'reported'/, /HSET/]},
        scala: {all: [/'desired'/, /'reported'/, /HSET/]},
        cpp: {all: [/'desired'/, /'reported'/, /HSET/]},
      },
    },
    {
      id: 'converge',
      title: 'Reconciliation converges on the desired document',
      detail:
        '`reconcile` reads both documents and both counters, lists the fields where reported is behind desired (`divergence`), and hands the **desired** document back as what the device must apply — `behind = reported_version < desired_version`. The draft has no reconciler at all: with one document, the last writer wins and the operator’s intent is what gets lost.',
      match: {
        python: {all: [/def reconcile\(/, /reported_version\s*<\s*desired_version/, /divergence/]},
        typescript: {all: [/function reconcile\(/, /reportedVersion\s*<\s*desiredVersion/, /divergence/]},
        go: {all: [/func reconcile\(/, /reportedVersion\s*<\s*desiredVersion/, /divergence/]},
        scala: {all: [/def reconcile\(/, /reportedVersion\s*<\s*desiredVersion/, /divergence/]},
        cpp: {all: [/json reconcile\(/, /reportedVersion\s*<\s*desiredVersion/, /divergence/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def shadow_key(device_id: str) -> str:
    return f"shadow:{device_id}"


class DesiredBody(BaseModel):
    state: dict[str, str]


class ReportedBody(BaseModel):
    reported_version: int
    state: dict[str, str]


def write_state(device_id: str, state: dict[str, str]) -> int:
    # TODO: the draft keeps one document ("state") and one fused counter for both sides, advancing
    # it by two per write so the versions it hands out skip every other number. A device that
    # reports its old configuration overwrites the operator's intended document wholesale. Give
    # desired and reported their own fields and their own version counters, ignore a report that is
    # not newer than the stored reported_version, and reconcile toward the desired document.
    key = shadow_key(device_id)
    version = r.hincrby(key, "version", 2)
    r.hset(key, "state", json.dumps(state))
    return version


@app.put("/v1/devices/{device_id}/desired")
def put_desired(device_id: str, body: DesiredBody) -> dict:
    return {"version": write_state(device_id, body.state)}


@app.post("/v1/devices/{device_id}/reported")
def post_reported(device_id: str, body: ReportedBody) -> dict:
    # The device's own version is ignored: the last write wins.
    return {"version": write_state(device_id, body.state)}
`,
      solution: `import json

import redis
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# Each document owns its counter: the desired script bumps only desired_version, and the report
# script records only a version that is newer than the stored one.
DESIRED_LUA = """
local version = redis.call('HINCRBY', KEYS[1], 'desired_version', 1)
redis.call('HSET', KEYS[1], 'desired', ARGV[1])
return version
"""

REPORT_LUA = """
local stored = tonumber(redis.call('HGET', KEYS[1], 'reported_version')) or 0
local incoming = tonumber(ARGV[1])
if incoming <= stored then
  return {0, stored}
end
redis.call('HSET', KEYS[1], 'reported', ARGV[2])
redis.call('HSET', KEYS[1], 'reported_version', incoming)
return {1, incoming}
"""


def shadow_key(device_id: str) -> str:
    return f"shadow:{device_id}"


class DesiredBody(BaseModel):
    state: dict[str, str]


class ReportedBody(BaseModel):
    reported_version: int
    state: dict[str, str]


def write_desired(device_id: str, state: dict[str, str]) -> int:
    return int(r.eval(DESIRED_LUA, 1, shadow_key(device_id), json.dumps(state)))


def record_reported(device_id: str, reported_version: int, state: dict[str, str]) -> tuple[bool, int]:
    accepted, version = r.eval(REPORT_LUA, 1, shadow_key(device_id), reported_version, json.dumps(state))
    return bool(accepted), int(version)


def reconcile(device_id: str) -> dict:
    """Converges on the desired document: the device adopts it, never the other way around."""
    fields = r.hgetall(shadow_key(device_id))
    desired = json.loads(fields.get("desired", "{}"))
    reported = json.loads(fields.get("reported", "{}"))
    desired_version = int(fields.get("desired_version", 0))
    reported_version = int(fields.get("reported_version", 0))
    behind = reported_version < desired_version
    divergence = sorted(field for field in desired if reported.get(field) != desired[field])
    return {"converged": not behind and not divergence, "divergence": divergence, "apply": desired}


@app.put("/v1/devices/{device_id}/desired")
def put_desired(device_id: str, body: DesiredBody) -> dict:
    return {"desired_version": write_desired(device_id, body.state)}


@app.post("/v1/devices/{device_id}/reported")
def post_reported(device_id: str, body: ReportedBody) -> dict:
    accepted, version = record_reported(device_id, body.reported_version, body.state)
    return {"accepted": accepted, "reported_version": version}


@app.post("/v1/devices/{device_id}/reconcile")
def post_reconcile(device_id: str) -> dict:
    return reconcile(device_id)
`,
    },
    typescript: {
      starter: `/** IoT hub shadow state: a model-generated draft with one document and one fused counter. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const shadowKey = (deviceId: string): string => \`shadow:\${deviceId}\`;

interface DesiredBody {
  state: Record<string, string>;
}

interface ReportedBody {
  reported_version: number;
  state: Record<string, string>;
}

async function writeState(deviceId: string, state: Record<string, string>): Promise<number> {
  // TODO: the draft keeps one document ('state') and one fused counter for both sides, advancing it
  // by two per write so the versions it hands out skip every other number, and a device that
  // reports its old configuration overwrites the operator's intended document wholesale. Give
  // desired and reported their own fields and their own version counters, ignore a report that is
  // not newer than the stored reported_version, and reconcile toward the desired document.
  const key = shadowKey(deviceId);
  const version = await r.hincrby(key, 'version', 2);
  await r.hset(key, 'state', JSON.stringify(state));
  return version;
}

app.put('/v1/devices/:deviceId/desired', async request => {
  const {deviceId} = request.params as {deviceId: string};
  const body = request.body as DesiredBody;
  return {version: await writeState(deviceId, body.state)};
});

app.post('/v1/devices/:deviceId/reported', async request => {
  const {deviceId} = request.params as {deviceId: string};
  const body = request.body as ReportedBody;
  // The device's own version is ignored: the last write wins.
  return {version: await writeState(deviceId, body.state)};
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** IoT hub shadow state: each document owns its version, a stale report changes nothing. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

// Each document owns its counter: the desired script bumps only desired_version, and the report
// script records only a version that is newer than the stored one.
const DESIRED_LUA = \`
local version = redis.call('HINCRBY', KEYS[1], 'desired_version', 1)
redis.call('HSET', KEYS[1], 'desired', ARGV[1])
return version
\`;

const REPORT_LUA = \`
local stored = tonumber(redis.call('HGET', KEYS[1], 'reported_version')) or 0
local incoming = tonumber(ARGV[1])
if incoming <= stored then
  return {0, stored}
end
redis.call('HSET', KEYS[1], 'reported', ARGV[2])
redis.call('HSET', KEYS[1], 'reported_version', incoming)
return {1, incoming}
\`;

const shadowKey = (deviceId: string): string => \`shadow:\${deviceId}\`;

interface DesiredBody {
  state: Record<string, string>;
}

interface ReportedBody {
  reported_version: number;
  state: Record<string, string>;
}

async function writeDesired(deviceId: string, state: Record<string, string>): Promise<number> {
  return Number(await r.eval(DESIRED_LUA, 1, shadowKey(deviceId), JSON.stringify(state)));
}

async function recordReported(
  deviceId: string,
  reportedVersion: number,
  state: Record<string, string>,
): Promise<[boolean, number]> {
  const [accepted, version] = (await r.eval(
    REPORT_LUA,
    1,
    shadowKey(deviceId),
    reportedVersion,
    JSON.stringify(state),
  )) as [number, number];
  return [accepted === 1, version];
}

/** Converges on the desired document: the device adopts it, never the other way around. */
async function reconcile(deviceId: string): Promise<Record<string, unknown>> {
  const fields = await r.hgetall(shadowKey(deviceId));
  const desired = JSON.parse(fields.desired ?? '{}') as Record<string, string>;
  const reported = JSON.parse(fields.reported ?? '{}') as Record<string, string>;
  const desiredVersion = Number(fields.desired_version ?? 0);
  const reportedVersion = Number(fields.reported_version ?? 0);
  const behind = reportedVersion < desiredVersion;
  const divergence = Object.keys(desired)
    .filter(field => reported[field] !== desired[field])
    .sort();
  return {converged: !behind && divergence.length === 0, divergence, apply: desired};
}

app.put('/v1/devices/:deviceId/desired', async request => {
  const {deviceId} = request.params as {deviceId: string};
  const body = request.body as DesiredBody;
  return {desired_version: await writeDesired(deviceId, body.state)};
});

app.post('/v1/devices/:deviceId/reported', async request => {
  const {deviceId} = request.params as {deviceId: string};
  const body = request.body as ReportedBody;
  const [accepted, version] = await recordReported(deviceId, body.reported_version, body.state);
  return {accepted, reported_version: version};
});

app.post('/v1/devices/:deviceId/reconcile', async request => {
  const {deviceId} = request.params as {deviceId: string};
  return reconcile(deviceId);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

func shadowKey(deviceID string) string {
	return fmt.Sprintf("shadow:%s", deviceID)
}

func writeState(ctx context.Context, deviceID string, state map[string]string) int64 {
	// TODO: the draft keeps one document ("state") and one fused counter for both sides, advancing
	// it by two per write so the versions it hands out skip every other number. A device that
	// reports its old configuration overwrites the operator's intended document wholesale. Give
	// desired and reported their own fields and their own version counters, ignore a report that
	// is not newer than the stored reported_version, and reconcile toward the desired document.
	payload, _ := json.Marshal(state)
	version, _ := rdb.HIncrBy(ctx, shadowKey(deviceID), "version", 2).Result()
	rdb.HSet(ctx, shadowKey(deviceID), "state", string(payload))
	return version
}

func putDesired(rw http.ResponseWriter, r *http.Request) {
	var body struct {
		State map[string]string \`json:"state"\`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	version := writeState(r.Context(), r.PathValue("id"), body.State)
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(fmt.Sprintf(\`{"version":%d}\`, version)))
}

func postReported(rw http.ResponseWriter, r *http.Request) {
	var body struct {
		ReportedVersion int64             \`json:"reported_version"\`
		State           map[string]string \`json:"state"\`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	// The device's own version is ignored: the last write wins.
	version := writeState(r.Context(), r.PathValue("id"), body.State)
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(fmt.Sprintf(\`{"version":%d}\`, version)))
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /v1/devices/{id}/desired", putDesired)
	mux.HandleFunc("POST /v1/devices/{id}/reported", postReported)
	_ = http.ListenAndServe(":8080", mux)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

// Each document owns its counter: the desired script bumps only desired_version, and the report
// script records only a version that is newer than the stored one.
var desiredScript = redis.NewScript(\`
local version = redis.call('HINCRBY', KEYS[1], 'desired_version', 1)
redis.call('HSET', KEYS[1], 'desired', ARGV[1])
return version
\`)

var reportScript = redis.NewScript(\`
local stored = tonumber(redis.call('HGET', KEYS[1], 'reported_version')) or 0
local incoming = tonumber(ARGV[1])
if incoming <= stored then
  return {0, stored}
end
redis.call('HSET', KEYS[1], 'reported', ARGV[2])
redis.call('HSET', KEYS[1], 'reported_version', incoming)
return {1, incoming}
\`)

func shadowKey(deviceID string) string {
	return fmt.Sprintf("shadow:%s", deviceID)
}

func writeDesired(ctx context.Context, deviceID string, state map[string]string) (int64, error) {
	payload, err := json.Marshal(state)
	if err != nil {
		return 0, err
	}
	return desiredScript.Run(ctx, rdb, []string{shadowKey(deviceID)}, string(payload)).Int64()
}

func recordReported(ctx context.Context, deviceID string, reportedVersion int64, state map[string]string) (bool, int64, error) {
	payload, err := json.Marshal(state)
	if err != nil {
		return false, 0, err
	}
	values, err := reportScript.Run(ctx, rdb, []string{shadowKey(deviceID)}, reportedVersion, string(payload)).Int64Slice()
	if err != nil {
		return false, 0, err
	}
	return values[0] == 1, values[1], nil
}

func decodeDocument(raw string) map[string]string {
	document := map[string]string{}
	if raw == "" {
		return document
	}
	_ = json.Unmarshal([]byte(raw), &document)
	return document
}

func reconcile(ctx context.Context, deviceID string) (map[string]any, error) {
	fields, err := rdb.HGetAll(ctx, shadowKey(deviceID)).Result()
	if err != nil {
		return nil, err
	}
	desired := decodeDocument(fields["desired"])
	reported := decodeDocument(fields["reported"])
	desiredVersion, _ := strconv.ParseInt(fields["desired_version"], 10, 64)
	reportedVersion, _ := strconv.ParseInt(fields["reported_version"], 10, 64)
	behind := reportedVersion < desiredVersion
	divergence := make([]string, 0, len(desired))
	for field, value := range desired {
		if other, ok := reported[field]; !ok || other != value {
			divergence = append(divergence, field)
		}
	}
	sort.Strings(divergence)
	return map[string]any{
		"converged":  !behind && len(divergence) == 0,
		"divergence": divergence,
		"apply":      desired,
	}, nil
}

func putDesired(rw http.ResponseWriter, r *http.Request) {
	var body struct {
		State map[string]string \`json:"state"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, \`{"error":"invalid json"}\`, http.StatusBadRequest)
		return
	}
	version, err := writeDesired(r.Context(), r.PathValue("id"), body.State)
	if err != nil {
		http.Error(rw, \`{"error":"shadow unavailable"}\`, http.StatusServiceUnavailable)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(fmt.Sprintf(\`{"desired_version":%d}\`, version)))
}

func postReported(rw http.ResponseWriter, r *http.Request) {
	var body struct {
		ReportedVersion int64             \`json:"reported_version"\`
		State           map[string]string \`json:"state"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, \`{"error":"invalid json"}\`, http.StatusBadRequest)
		return
	}
	accepted, version, err := recordReported(r.Context(), r.PathValue("id"), body.ReportedVersion, body.State)
	if err != nil {
		http.Error(rw, \`{"error":"shadow unavailable"}\`, http.StatusServiceUnavailable)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(fmt.Sprintf(\`{"accepted":%t,"reported_version":%d}\`, accepted, version)))
}

func postReconcile(rw http.ResponseWriter, r *http.Request) {
	view, err := reconcile(r.Context(), r.PathValue("id"))
	if err != nil {
		http.Error(rw, \`{"error":"shadow unavailable"}\`, http.StatusServiceUnavailable)
		return
	}
	payload, _ := json.Marshal(view)
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write(payload)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /v1/devices/{id}/desired", putDesired)
	mux.HandleFunc("POST /v1/devices/{id}/reported", postReported)
	mux.HandleFunc("POST /v1/devices/{id}/reconcile", postReconcile)
	_ = http.ListenAndServe(":8080", mux)
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
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json._

final case class DesiredBody(state: Map[String, String])
final case class ReportedBody(reported_version: Long, state: Map[String, String])

object ShadowStateApi {
  implicit val system: ActorSystem = ActorSystem("iot-hub")
  implicit val desiredFormat: RootJsonFormat[DesiredBody] = jsonFormat1(DesiredBody)
  implicit val reportedFormat: RootJsonFormat[ReportedBody] = jsonFormat2(ReportedBody)

  val jedis = new Jedis("redis", 6379)

  def shadowKey(deviceId: String): String = "shadow:" + deviceId

  def writeState(deviceId: String, state: Map[String, String]): Long = {
    // TODO: the draft keeps one document ("state") and one fused counter for both sides, advancing
    // it by two per write so the versions it hands out skip every other number, and a device that
    // reports its old configuration overwrites the operator's intended document wholesale. Give
    // desired and reported their own fields and their own version counters, ignore a report that
    // is not newer than the stored reported_version, and reconcile toward the desired document.
    val key = shadowKey(deviceId)
    val version = jedis.hincrBy(key, "version", 2)
    jedis.hset(key, "state", state.toJson.compactPrint)
    version
  }

  val route: Route =
    pathPrefix("v1" / "devices" / Segment) { deviceId =>
      path("desired") {
        put {
          entity(as[DesiredBody]) { body =>
            complete(StatusCodes.OK, s"""{"version":\${writeState(deviceId, body.state)}}""")
          }
        }
      } ~
        path("reported") {
          post {
            entity(as[ReportedBody]) { body =>
              // The device's own version is ignored: the last write wins.
              complete(StatusCodes.OK, s"""{"version":\${writeState(deviceId, body.state)}}""")
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
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json._
import scala.jdk.CollectionConverters._

final case class DesiredBody(state: Map[String, String])
final case class ReportedBody(reported_version: Long, state: Map[String, String])
final case class ShadowView(converged: Boolean, divergence: List[String], apply: Map[String, String])

object ShadowStateApi {
  implicit val system: ActorSystem = ActorSystem("iot-hub")
  implicit val desiredFormat: RootJsonFormat[DesiredBody] = jsonFormat1(DesiredBody)
  implicit val reportedFormat: RootJsonFormat[ReportedBody] = jsonFormat2(ReportedBody)
  implicit val viewFormat: RootJsonFormat[ShadowView] = jsonFormat3(ShadowView)

  // Each document owns its counter: the desired script bumps only desired_version, and the report
  // script records only a version that is newer than the stored one.
  val DesiredLua =
    """
      |local version = redis.call('HINCRBY', KEYS[1], 'desired_version', 1)
      |redis.call('HSET', KEYS[1], 'desired', ARGV[1])
      |return version
      |""".stripMargin

  val ReportLua =
    """
      |local stored = tonumber(redis.call('HGET', KEYS[1], 'reported_version')) or 0
      |local incoming = tonumber(ARGV[1])
      |if incoming <= stored then
      |  return {0, stored}
      |end
      |redis.call('HSET', KEYS[1], 'reported', ARGV[2])
      |redis.call('HSET', KEYS[1], 'reported_version', incoming)
      |return {1, incoming}
      |""".stripMargin

  val jedis = new Jedis("redis", 6379)

  def shadowKey(deviceId: String): String = "shadow:" + deviceId

  def writeDesired(deviceId: String, state: Map[String, String]): Long = {
    val payload = state.toJson.compactPrint
    jedis.eval(DesiredLua, 1, shadowKey(deviceId), payload).asInstanceOf[java.lang.Long].longValue()
  }

  def recordReported(deviceId: String, reportedVersion: Long, state: Map[String, String]): (Boolean, Long) = {
    val payload = state.toJson.compactPrint
    val result = jedis
      .eval(ReportLua, 1, shadowKey(deviceId), reportedVersion.toString, payload)
      .asInstanceOf[java.util.List[Any]]
    (result.get(0) == 1L, result.get(1).asInstanceOf[java.lang.Long].longValue())
  }

  def reconcile(deviceId: String): ShadowView = {
    val fields = jedis.hgetAll(shadowKey(deviceId)).asScala.toMap
    val desired = fields.get("desired").map(_.parseJson.convertTo[Map[String, String]]).getOrElse(Map.empty)
    val reported = fields.get("reported").map(_.parseJson.convertTo[Map[String, String]]).getOrElse(Map.empty)
    val desiredVersion = fields.get("desired_version").map(_.toLong).getOrElse(0L)
    val reportedVersion = fields.get("reported_version").map(_.toLong).getOrElse(0L)
    val behind = reportedVersion < desiredVersion
    val divergence = desired.filter { case (field, value) => !reported.get(field).contains(value) }.keys.toList.sorted
    ShadowView(converged = !behind && divergence.isEmpty, divergence = divergence, apply = desired)
  }

  val route: Route =
    pathPrefix("v1" / "devices" / Segment) { deviceId =>
      path("desired") {
        put {
          entity(as[DesiredBody]) { body =>
            complete(StatusCodes.OK, s"""{"desired_version":\${writeDesired(deviceId, body.state)}}""")
          }
        }
      } ~
        path("reported") {
          post {
            entity(as[ReportedBody]) { body =>
              val (accepted, version) = recordReported(deviceId, body.reported_version, body.state)
              complete(StatusCodes.OK, s"""{"accepted":$accepted,"reported_version":$version}""")
            }
          }
        } ~
        path("reconcile") {
          post {
            complete(StatusCodes.OK, reconcile(deviceId))
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

using json = nlohmann::json;

std::string shadowKey(const std::string& deviceId) {
  return "shadow:" + deviceId;
}

long long writeState(sw::redis::Redis& redis, const std::string& deviceId, const json& state) {
  // TODO: the draft keeps one document ("state") and one fused counter for both sides, advancing
  // it by two per write so the versions it hands out skip every other number. A device that
  // reports its old configuration overwrites the operator's intended document wholesale. Give
  // desired and reported their own fields and their own version counters, ignore a report that is
  // not newer than the stored reported_version, and reconcile toward the desired document.
  const auto key = shadowKey(deviceId);
  const long long version = redis.hincrby(key, "version", 2);
  redis.hset(key, "state", state.dump());
  return version;
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Put(R"(/v1/devices/([^/]+)/desired)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto deviceId = req.matches[1].str();
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto version = writeState(redis, deviceId, body.value("state", json::object()));
    res.set_content(json{{"version", version}}.dump(), "application/json");
  });

  svr.Post(R"(/v1/devices/([^/]+)/reported)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto deviceId = req.matches[1].str();
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    // The device's own version is ignored: the last write wins.
    const auto version = writeState(redis, deviceId, body.value("state", json::object()));
    res.set_content(json{{"version", version}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <string>
#include <tuple>
#include <unordered_map>
#include <vector>

using json = nlohmann::json;

// Each document owns its counter: the desired script bumps only desired_version, and the report
// script records only a version that is newer than the stored one.
const char* kDesiredLua = R"LUA(
local version = redis.call('HINCRBY', KEYS[1], 'desired_version', 1)
redis.call('HSET', KEYS[1], 'desired', ARGV[1])
return version
)LUA";

const char* kReportLua = R"LUA(
local stored = tonumber(redis.call('HGET', KEYS[1], 'reported_version')) or 0
local incoming = tonumber(ARGV[1])
if incoming <= stored then
  return {0, stored}
end
redis.call('HSET', KEYS[1], 'reported', ARGV[2])
redis.call('HSET', KEYS[1], 'reported_version', incoming)
return {1, incoming}
)LUA";

std::string shadowKey(const std::string& deviceId) {
  return "shadow:" + deviceId;
}

std::unordered_map<std::string, std::string> readDocument(const std::string& raw) {
  std::unordered_map<std::string, std::string> document;
  const json parsed = json::parse(raw, nullptr, false);
  if (!parsed.is_object()) return document;
  for (const auto& [field, value] : parsed.items()) document[field] = value.get<std::string>();
  return document;
}

long long writeDesired(sw::redis::Redis& redis, const std::string& deviceId, const json& state) {
  return redis.eval<long long>(kDesiredLua, {shadowKey(deviceId)}, {state.dump()});
}

std::tuple<bool, long long> recordReported(
    sw::redis::Redis& redis,
    const std::string& deviceId,
    long long reportedVersion,
    const json& state) {
  const auto reply = redis.eval<std::vector<long long>>(
      kReportLua, {shadowKey(deviceId)}, {reportedVersion, state.dump()});
  return {reply[0] == 1, reply[1]};
}

json reconcile(sw::redis::Redis& redis, const std::string& deviceId) {
  const auto key = shadowKey(deviceId);
  auto rawDesired = redis.hget(key, "desired");
  auto rawReported = redis.hget(key, "reported");
  auto rawDesiredVersion = redis.hget(key, "desired_version");
  auto rawReportedVersion = redis.hget(key, "reported_version");
  const auto desired = readDocument(rawDesired ? *rawDesired : std::string());
  const auto reported = readDocument(rawReported ? *rawReported : std::string());
  const long long desiredVersion = rawDesiredVersion ? std::stoll(*rawDesiredVersion) : 0;
  const long long reportedVersion = rawReportedVersion ? std::stoll(*rawReportedVersion) : 0;
  const bool behind = reportedVersion < desiredVersion;
  std::vector<std::string> divergence;
  for (const auto& [field, value] : desired) {
    const auto other = reported.find(field);
    if (other == reported.end() || other->second != value) divergence.push_back(field);
  }
  std::sort(divergence.begin(), divergence.end());
  return json{
      {"converged", !behind && divergence.empty()},
      {"divergence", divergence},
      {"apply", desired},
  };
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Put(R"(/v1/devices/([^/]+)/desired)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto deviceId = req.matches[1].str();
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto version = writeDesired(redis, deviceId, body.value("state", json::object()));
    res.set_content(json{{"desired_version", version}}.dump(), "application/json");
  });

  svr.Post(R"(/v1/devices/([^/]+)/reported)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto deviceId = req.matches[1].str();
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto [accepted, version] = recordReported(
        redis, deviceId, body.value("reported_version", 0LL), body.value("state", json::object()));
    res.set_content(json{{"accepted", accepted}, {"reported_version", version}}.dump(), "application/json");
  });

  svr.Post(R"(/v1/devices/([^/]+)/reconcile)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto deviceId = req.matches[1].str();
    res.set_content(reconcile(redis, deviceId).dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question behind this step is state that is allowed to disagree with itself. A shadow exists because desired and reported are two different documents, and every property the fleet depends on follows from keeping them apart: two documents with two counters, a merge that refuses to move backward, and a read that reports the disagreement instead of hiding it. The draft looks right because the demo writes the same value twice; its real behaviour is that the device is the authority, so an operator's change is undone the moment the device reconnects with its old configuration, and the fused counter makes the versions the fleet reads meaningless — they skip numbers and neither side can be compared against the other. The stale guard has to be a comparison inside Redis, not in your process: a \`HGET\` followed by an \`HSET\` lets two reports that arrive together both observe the old version and the later one wins. Convergence is the last piece and the easiest to get backwards: reconciliation asks the device to adopt the desired document, never the reverse, and copying reported into desired is how intent is lost, not how a shadow converges. Real device managers add per-document TTLs, delta updates over MQTT, per-field conflict policies, and a delivery loop that re-sends the desired document until the device acknowledges it.`,
};
