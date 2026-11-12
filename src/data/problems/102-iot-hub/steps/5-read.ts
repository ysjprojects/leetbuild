import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/devices/{id}/shadow: both documents and the delta',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'hub', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/devices/{device_id}/shadow\` from
\`shadow.read_shadow\` (step 2, provided): it merges the two documents into one \`document\` with the
desired values on top, answers the larger of the two versions as \`version\`, and serves any device
to any caller. It serves the demo and hides three flaws.

**Failure mode the checks target.** A thermostat still on last week's schedule reads as converged,
because the desired values hide the reported ones; one version cannot say which side is behind; and
any tenant reads another tenant's device configuration by guessing its id.

- Answer \`{device_id, desired, reported, desired_version, reported_version, delta}\`, both documents
  and both versions as the store holds them.
- \`delta\` is the sorted list of desired fields whose reported value differs or is missing; an empty
  list means the device has converged.
- \`X-Tenant-Id\` is required (**401** without it); compare \`registry.owner(device_id)\` with it before
  reading the shadow, and answer **404** for another tenant's device or an unknown one.`,
  sequence: {
    participants: ['Operator', 'iothub', 'Redis'],
    messages: [
      {from: 'Operator', to: 'iothub', label: 'GET /v1/devices/{id}/shadow · X-Tenant-Id', kind: 'sync'},
      {from: 'iothub', to: 'Redis', label: 'registry.owner(id) · another tenant → 404', kind: 'sync'},
      {from: 'iothub', to: 'Redis', label: 'read_shadow(id)', kind: 'sync'},
      {from: 'Redis', to: 'iothub', label: '{desired, reported, desired_version, reported_version}', kind: 'reply'},
      {from: 'iothub', to: 'Operator', label: '200 {both documents, both versions, delta: [fan, mode]}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/devices/{id}/shadow',
      detail: 'Register `GET /v1/devices/{device_id}/shadow`; the owner of a device reads its shadow with 200.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/devices\/\{device_id\}\/shadow["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/devices\/:\w+\/shadow['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/devices\/\{device_id\}\/shadow"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"devices"\s*\/\s*Segment\s*\/\s*"shadow"\s*\)/, /\bget\b/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/devices\//, /\/shadow\)"/]},
      },
    },
    {
      id: 'side-by-side',
      title: 'Serves both documents and both versions',
      detail:
        'The response carries `desired` and `reported` untouched with `desired_version` and `reported_version` as stored; the starter merges the documents and keeps the larger version only.',
      match: {
        python: {
          all: [/["']desired_version["']\s*:/, /["']reported_version["']\s*:/, /["']reported["']\s*:/],
          none: [/["']version["']\s*:/, /["']document["']/],
        },
        typescript: {all: [/desired_version:/, /reported_version:/, /reported:/], none: [/\bversion:/, /\bdocument\b/]},
        go: {
          all: [/"desired_version":/, /"reported_version":/, /"reported":/],
          none: [/"version":/, /"document"/],
        },
        scala: {
          all: [/"desired_version"\s*->/, /"reported_version"\s*->/, /"reported"\s*->/],
          none: [/"version"\s*->/, /"document"/],
        },
        cpp: {
          all: [/\{"desired_version",/, /\{"reported_version",/, /\{"reported",/],
          none: [/\{"version",/, /"document"/],
        },
      },
    },
    {
      id: 'delta',
      title: 'Lists the desired fields the device has not reached',
      detail:
        '`delta` is the sorted list of desired fields whose reported value differs or is missing, empty once the device has converged; the starter has no delta, and its merge hides the difference.',
      match: {
        python: {all: [/["']delta["']\s*:/, /sorted\(/]},
        typescript: {all: [/delta:/, /\.sort\(/]},
        go: {all: [/"delta":/, /sort\.Strings\(|slices\.Sort\(/]},
        scala: {all: [/"delta"\s*->/, /\.sorted/]},
        cpp: {all: [/\{"delta",/]},
      },
    },
    {
      id: 'foreign-device-404',
      title: 'A device of another tenant is 404',
      detail:
        "Without `X-Tenant-Id` the read is 401; the device's owner is compared with the tenant before the shadow is read, and another tenant's device answers 404 like an unknown one. The starter serves any device to any caller.",
      match: {
        python: {
          all: [/registry\.owner\(/, /\b404\b/, /\b401\b/, /x-tenant-id/i],
          order: [/registry\.owner\(/, /shadow\.read_shadow\(/],
        },
        typescript: {
          all: [/owner\(/, /code\(\s*404\s*\)/, /code\(\s*401\s*\)/, /x-tenant-id/i],
          order: [/owner\(/, /readShadow\(/],
        },
        go: {
          all: [/registry\.Owner\(/, /StatusNotFound|\b404\b/, /StatusUnauthorized|\b401\b/, /X-Tenant-Id/i],
          order: [/registry\.Owner\(/, /shadow\.ReadShadow\(/],
        },
        scala: {
          all: [/Registry\.owner\(/, /StatusCodes\.NotFound/, /StatusCodes\.Unauthorized/, /X-Tenant-Id/i],
          order: [/Registry\.owner\(/, /Shadow\.readShadow\(/],
        },
        cpp: {
          all: [/registry::owner\(/, /\b404\b/, /\b401\b/, /X-Tenant-Id/i],
          order: [/registry::owner\(/, /shadow::readShadow\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from iothub import registry, shadow  # registry.owner(device_id); shadow.read_shadow(device_id)

app = FastAPI()


@app.get("/v1/devices/{device_id}/shadow")
def get_shadow(device_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    s = shadow.read_shadow(device_id)
    document = {**s["reported"], **s["desired"]}
    version = max(s["desired_version"], s["reported_version"])
    return JSONResponse({"device_id": device_id, "version": version, "document": document})
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from iothub import registry, shadow  # registry.owner(device_id); shadow.read_shadow(device_id)

app = FastAPI()


def delta_fields(desired: dict[str, str], reported: dict[str, str]) -> list[str]:
    """The desired fields the device has not reached, sorted."""
    return sorted(field for field, value in desired.items() if reported.get(field) != value)


@app.get("/v1/devices/{device_id}/shadow")
def get_shadow(device_id: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    # Another tenant's device answers like one that does not exist, before anything is read.
    if registry.owner(device_id) != tenant:
        return JSONResponse({"error": "no such device"}, status_code=404)
    s = shadow.read_shadow(device_id)
    return JSONResponse({
        "device_id": device_id,
        "desired": s["desired"],
        "reported": s["reported"],
        "desired_version": s["desired_version"],
        "reported_version": s["reported_version"],
        "delta": delta_fields(s["desired"], s["reported"]),
    })
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {owner} from 'iothub/registry';
import {readShadow} from 'iothub/shadow';

export const app = Fastify();

app.get('/v1/devices/:deviceId/shadow', async request => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const {deviceId} = request.params as {deviceId: string};
  const s = await readShadow(deviceId);
  const document = {...s.reported, ...s.desired};
  return {device_id: deviceId, version: Math.max(s.desired_version, s.reported_version), document};
});
`,
      solution: `import Fastify from 'fastify';

import {owner} from 'iothub/registry';
import {readShadow} from 'iothub/shadow';

export const app = Fastify();

/** The desired fields the device has not reached, sorted. */
export const deltaFields = (desired: Record<string, string>, reported: Record<string, string>): string[] =>
  Object.keys(desired)
    .filter(field => reported[field] !== desired[field])
    .sort();

app.get('/v1/devices/:deviceId/shadow', async (request, reply) => {
  const {deviceId} = request.params as {deviceId: string};
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  // Another tenant's device answers like one that does not exist, before anything is read.
  if ((await owner(deviceId)) !== tenant) return reply.code(404).send({error: 'no such device'});
  const s = await readShadow(deviceId);
  return {
    device_id: deviceId,
    desired: s.desired,
    reported: s.reported,
    desired_version: s.desired_version,
    reported_version: s.reported_version,
    delta: deltaFields(s.desired, s.reported),
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"iothub/shadow" // shadow.ReadShadow(ctx, deviceID)
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func getShadow(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	deviceID := r.PathValue("device_id")
	s, err := shadow.ReadShadow(r.Context(), deviceID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	document := map[string]string{}
	for field, value := range s.Reported {
		document[field] = value
	}
	for field, value := range s.Desired {
		document[field] = value
	}
	version := s.DesiredVersion
	if s.ReportedVersion > version {
		version = s.ReportedVersion
	}
	writeJSON(rw, http.StatusOK, map[string]any{"device_id": deviceID, "version": version, "document": document})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/devices/{device_id}/shadow", getShadow)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"sort"

	"iothub/registry" // registry.Owner(ctx, deviceID)
	"iothub/shadow"   // shadow.ReadShadow(ctx, deviceID)
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// deltaFields is the desired fields the device has not reached, sorted.
func deltaFields(desired, reported map[string]string) []string {
	delta := []string{}
	for field, value := range desired {
		if got, ok := reported[field]; !ok || got != value {
			delta = append(delta, field)
		}
	}
	sort.Strings(delta)
	return delta
}

func getShadow(rw http.ResponseWriter, r *http.Request) {
	deviceID := r.PathValue("device_id")
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	// Another tenant's device answers like one that does not exist, before anything is read.
	if owner, ok := registry.Owner(r.Context(), deviceID); !ok || owner != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such device"})
		return
	}
	s, err := shadow.ReadShadow(r.Context(), deviceID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"device_id":        deviceID,
		"desired":          s.Desired,
		"reported":         s.Reported,
		"desired_version":  s.DesiredVersion,
		"reported_version": s.ReportedVersion,
		"delta":            deltaFields(s.Desired, s.Reported),
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/devices/{device_id}/shadow", getShadow)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import iothub.{Registry, Shadow} // Registry.owner(deviceId); Shadow.readShadow(deviceId)

object ShadowRead {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def strings(m: Map[String, String]): JsObject = JsObject(m.map { case (k, v) => k -> JsString(v) })

  val route: Route =
    path("v1" / "devices" / Segment / "shadow") { deviceId =>
      get {
        // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
        val s = Shadow.readShadow(deviceId)
        val document = s.reported ++ s.desired
        complete(json(StatusCodes.OK, JsObject(
          "device_id" -> JsString(deviceId),
          "version" -> JsNumber(math.max(s.desiredVersion, s.reportedVersion)),
          "document" -> strings(document))))
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import iothub.{Registry, Shadow} // Registry.owner(deviceId); Shadow.readShadow(deviceId)

object ShadowRead {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def strings(m: Map[String, String]): JsObject = JsObject(m.map { case (k, v) => k -> JsString(v) })

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  /** The desired fields the device has not reached, sorted. */
  def deltaFields(desired: Map[String, String], reported: Map[String, String]): Seq[String] =
    desired.collect { case (field, value) if !reported.get(field).contains(value) => field }.toSeq.sorted

  val route: Route =
    path("v1" / "devices" / Segment / "shadow") { deviceId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
          // Another tenant's device answers like one that does not exist, before anything is read.
          case Some(tenant) if !Registry.owner(deviceId).contains(tenant) => complete(error(StatusCodes.NotFound, "no such device"))
          case Some(_) =>
            val s = Shadow.readShadow(deviceId)
            complete(json(StatusCodes.OK, JsObject(
              "device_id" -> JsString(deviceId),
              "desired" -> strings(s.desired),
              "reported" -> strings(s.reported),
              "desired_version" -> JsNumber(s.desiredVersion),
              "reported_version" -> JsNumber(s.reportedVersion),
              "delta" -> JsArray(deltaFields(s.desired, s.reported).map(JsString(_)).toVector))))
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <string>

#include "iothub/registry.h"  // registry::owner(device_id)
#include "iothub/shadow.h"    // shadow::readShadow(device_id)

using json = nlohmann::json;

void get_shadow(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string device_id = req.matches[1];
  const shadow::Shadow s = shadow::readShadow(device_id);
  std::map<std::string, std::string> document = s.reported;
  for (const auto& [field, value] : s.desired) document[field] = value;
  const json body = {{"device_id", device_id}, {"version", std::max(s.desired_version, s.reported_version)}, {"document", document}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/devices/([\\w-]+)/shadow)", get_shadow);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <vector>

#include "iothub/registry.h"  // registry::owner(device_id)
#include "iothub/shadow.h"    // shadow::readShadow(device_id)

using json = nlohmann::json;

// The desired fields the device has not reached, sorted (a std::map iterates in key order).
std::vector<std::string> deltaFields(const std::map<std::string, std::string>& desired, const std::map<std::string, std::string>& reported) {
  std::vector<std::string> delta;
  for (const auto& [field, value] : desired) {
    const auto got = reported.find(field);
    if (got == reported.end() || got->second != value) delta.push_back(field);
  }
  return delta;
}

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void get_shadow(const httplib::Request& req, httplib::Response& res) {
  const std::string device_id = req.matches[1];
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  // Another tenant's device answers like one that does not exist, before anything is read.
  if (registry::owner(device_id) != tenant) return reply(res, 404, {{"error", "no such device"}});
  const shadow::Shadow s = shadow::readShadow(device_id);
  reply(res, 200,
        {{"device_id", device_id},
         {"desired", s.desired},
         {"reported", s.reported},
         {"desired_version", s.desired_version},
         {"reported_version", s.reported_version},
         {"delta", deltaFields(s.desired, s.reported)}});
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/devices/([\\w-]+)/shadow)", get_shadow);
}
`,
    },
  },
  harness: {
    python: `from iothub import registry, shadow

THERMO = "thermo-3"
DESIRED = {"mode": "eco", "setpoint": "21", "fan": "auto"}
REPORTED = {"mode": "normal", "setpoint": "21"}


def _api(ctx):
    m = ctx.load("read")
    registry.enroll(THERMO, "acme")
    registry.enroll("thermo-8", "globex")
    for field, value in DESIRED.items():
        shadow.update_desired(THERMO, {field: value})
    shadow.apply_report(THERMO, REPORTED, 7)
    return ctx.client(m.app)


async def _read(c, device=THERMO, tenant="acme"):
    headers = {} if tenant is None else {"X-Tenant-Id": tenant}
    return await c.get(f"/v1/devices/{device}/shadow", headers=headers)


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _read(c)
    assert r.status_code == 200, f"GET /v1/devices/{THERMO}/shadow by its owner answered {r.status_code}: {r.text}"
    assert r.json().get("device_id") == THERMO, f"the shadow read must name the device, got {r.json()}"


async def check_side_by_side(ctx):
    async with _api(ctx) as c:
        body = (await _read(c)).json()
    assert body.get("desired") == DESIRED and body.get("reported") == REPORTED, f"the shadow read answered desired {body.get('desired')!r} and reported {body.get('reported')!r}, expected both documents as stored: merged, the desired values hide that the device still runs mode=normal"
    assert (body.get("desired_version"), body.get("reported_version")) == (3, 7), f"the shadow read answered desired_version {body.get('desired_version')!r} and reported_version {body.get('reported_version')!r}, expected 3 and 7 as stored"


async def check_delta(ctx):
    async with _api(ctx) as c:
        body = (await _read(c)).json()
        assert body.get("delta") == ["fan", "mode"], f"the device reports mode=normal and no fan, the operator wants mode=eco and fan=auto, and the read answered delta {body.get('delta')!r}, expected ['fan', 'mode']"
        shadow.apply_report(THERMO, DESIRED, 8)
        converged = (await _read(c)).json()
    assert converged.get("delta") == [], f"once the device reports every desired value the read answered delta {converged.get('delta')!r}, expected []"


async def check_foreign_device_404(ctx):
    async with _api(ctx) as c:
        foreign = await _read(c, THERMO, "globex")
        unknown = await _read(c, "thermo-404", "acme")
        anonymous = await _read(c, THERMO, None)
    assert foreign.status_code == 404, f"tenant globex read acme's {THERMO} and got {foreign.status_code}: {foreign.text}. Another tenant's device must answer 404"
    assert "eco" not in foreign.text, f"the refused read still carried the shadow: {foreign.text}"
    assert unknown.status_code == 404, f"an unknown device answered {unknown.status_code}, expected 404"
    assert anonymous.status_code == 401, f"a read without X-Tenant-Id answered {anonymous.status_code}, expected 401"
`,
    typescript: `const THERMO = 'thermo-3';
const DESIRED = {mode: 'eco', setpoint: '21', fan: 'auto'};
const REPORTED = {mode: 'normal', setpoint: '21'};

async function api(ctx) {
  const m = ctx.load('read');
  const registry = ctx.load('/support/iothub/registry.ts');
  const shadow = ctx.load('/support/iothub/shadow.ts');
  await registry.enroll(THERMO, 'acme');
  await registry.enroll('thermo-8', 'globex');
  for (const [field, value] of Object.entries(DESIRED)) await shadow.updateDesired(THERMO, {[field]: value});
  await shadow.applyReport(THERMO, REPORTED, 7);
  return {c: ctx.client(m.app), shadow};
}

const read = (c, device = THERMO, tenant: string | null = 'acme') =>
  c.get(\`/v1/devices/\${device}/shadow\`, {headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});

export async function check_route(ctx) {
  const {c} = await api(ctx);
  const r = await read(c);
  assert.equal(r.status, 200, \`GET /v1/devices/\${THERMO}/shadow by its owner answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().device_id, THERMO, \`the shadow read must name the device, got \${r.text}\`);
}

export async function check_side_by_side(ctx) {
  const {c} = await api(ctx);
  const r = await read(c);
  const body = r.json();
  assert(body.desired !== undefined && body.reported !== undefined, \`the shadow read answered \${r.text}, expected desired and reported as stored: merged, the desired values hide that the device still runs mode=normal\`);
  assert.deepEqual(body.desired, DESIRED, \`the shadow read answered desired \${JSON.stringify(body.desired)}, expected the stored desired document\`);
  assert.deepEqual(body.reported, REPORTED, \`the shadow read answered reported \${JSON.stringify(body.reported)}, expected the stored reported document\`);
  assert(body.desired_version === 3 && body.reported_version === 7, \`the shadow read answered desired_version \${body.desired_version} and reported_version \${body.reported_version}, expected 3 and 7 as stored\`);
}

export async function check_delta(ctx) {
  const {c, shadow} = await api(ctx);
  const body = (await read(c)).json();
  assert.deepEqual(body.delta, ['fan', 'mode'], \`the device reports mode=normal and no fan, the operator wants mode=eco and fan=auto, and the read answered delta \${JSON.stringify(body.delta)}, expected ["fan","mode"]\`);
  await shadow.applyReport(THERMO, DESIRED, 8);
  const converged = (await read(c)).json();
  assert.deepEqual(converged.delta, [], \`once the device reports every desired value the read answered delta \${JSON.stringify(converged.delta)}, expected []\`);
}

export async function check_foreign_device_404(ctx) {
  const {c} = await api(ctx);
  const foreign = await read(c, THERMO, 'globex');
  const unknown = await read(c, 'thermo-404', 'acme');
  const anonymous = await read(c, THERMO, null);
  assert.equal(foreign.status, 404, \`tenant globex read acme's \${THERMO} and got \${foreign.status}: \${foreign.text}. Another tenant's device must answer 404\`);
  assert(!foreign.text.includes('eco'), \`the refused read still carried the shadow: \${foreign.text}\`);
  assert.equal(unknown.status, 404, \`an unknown device answered \${unknown.status}, expected 404\`);
  assert.equal(anonymous.status, 401, \`a read without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"iothub/registry"
	"iothub/shadow"

	"leetbuild/harness"
)

const readThermo = "thermo-3"

var (
	readDesired  = map[string]string{"mode": "eco", "setpoint": "21", "fan": "auto"}
	readReported = map[string]string{"mode": "normal", "setpoint": "21"}
)

type shadowReply struct {
	DeviceID        string            \`json:"device_id"\`
	Desired         map[string]string \`json:"desired"\`
	Reported        map[string]string \`json:"reported"\`
	DesiredVersion  int64             \`json:"desired_version"\`
	ReportedVersion int64             \`json:"reported_version"\`
	Delta           []string          \`json:"delta"\`
}

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	bg := context.Background()
	registry.Enroll(bg, readThermo, "acme")
	registry.Enroll(bg, "thermo-8", "globex")
	for _, field := range []string{"mode", "setpoint", "fan"} {
		shadow.UpdateDesired(bg, readThermo, map[string]string{field: readDesired[field]})
	}
	shadow.ApplyReport(bg, readThermo, readReported, 7)
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readAs(c *harness.HTTP, device, tenant string) *harness.Response {
	if tenant == "" {
		return c.Get("/v1/devices/" + device + "/shadow")
	}
	return c.Get("/v1/devices/"+device+"/shadow", "X-Tenant-Id", tenant)
}

func shadowOf(ctx *harness.Ctx, r *harness.Response) shadowReply {
	ctx.Equal(r.Status, 200, "the owner's shadow read (%s); the status", r.Text())
	var body shadowReply
	r.Decode(&body)
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	c := readAPI(ctx)
	r := readAs(c, readThermo, "acme")
	ctx.Equal(r.Status, 200, "GET /v1/devices/%s/shadow by its owner (%s); the status", readThermo, r.Text())
	ctx.Equal(shadowOf(ctx, r).DeviceID, readThermo, "the shadow read must name the device")
}

func CheckSideBySide(ctx *harness.Ctx) {
	c := readAPI(ctx)
	body := shadowOf(ctx, readAs(c, readThermo, "acme"))
	ctx.Equal(body.Desired, readDesired, "the shadow read must answer the stored desired document (merged, the desired values hide that the device still runs mode=normal); desired")
	ctx.Equal(body.Reported, readReported, "the shadow read must answer the stored reported document; reported")
	ctx.Assert(body.DesiredVersion == 3 && body.ReportedVersion == 7, "the shadow read answered desired_version %d and reported_version %d, expected 3 and 7 as stored", body.DesiredVersion, body.ReportedVersion)
}

func CheckDelta(ctx *harness.Ctx) {
	c := readAPI(ctx)
	body := shadowOf(ctx, readAs(c, readThermo, "acme"))
	ctx.Equal(body.Delta, []string{"fan", "mode"}, "the device reports mode=normal and no fan, the operator wants mode=eco and fan=auto; delta")
	shadow.ApplyReport(context.Background(), readThermo, readDesired, 8)
	converged := shadowOf(ctx, readAs(c, readThermo, "acme"))
	ctx.Assert(converged.Delta != nil && len(converged.Delta) == 0, "once the device reports every desired value the read must answer an empty delta, got %v", converged.Delta)
}

func CheckForeignDevice404(ctx *harness.Ctx) {
	c := readAPI(ctx)
	foreign := readAs(c, readThermo, "globex")
	unknown := readAs(c, "thermo-404", "acme")
	anonymous := readAs(c, readThermo, "")
	ctx.Equal(foreign.Status, 404, "tenant globex read acme's %s (%s): another tenant's device must answer 404; the status", readThermo, foreign.Text())
	ctx.Assert(!strings.Contains(foreign.Text(), "eco"), "the refused read still carried the shadow: %s", foreign.Text())
	ctx.Equal(unknown.Status, 404, "an unknown device; the status")
	ctx.Equal(anonymous.Status, 401, "a read without X-Tenant-Id; the status")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <vector>

#include "iothub/registry.h"
#include "iothub/shadow.h"

namespace {

const std::string kReadThermo = "thermo-3";
const std::map<std::string, std::string> kDesired = {{"mode", "eco"}, {"setpoint", "21"}, {"fan", "auto"}};
const std::map<std::string, std::string> kReported = {{"mode", "normal"}, {"setpoint", "21"}};

harness::HTTP readApi(harness::Ctx& ctx) {
  registry::enroll(kReadThermo, "acme");
  registry::enroll("thermo-8", "globex");
  for (const std::string field : {"mode", "setpoint", "fan"}) shadow::updateDesired(kReadThermo, {{field, kDesired.at(field)}});
  shadow::applyReport(kReadThermo, kReported, 7);
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response readAs(harness::HTTP& c, const std::string& device, const std::string& tenant) {
  if (tenant.empty()) return c.Get("/v1/devices/" + device + "/shadow");
  return c.Get("/v1/devices/" + device + "/shadow", "X-Tenant-Id", tenant);
}

nlohmann::json shadowOf(harness::Ctx& ctx, const harness::Response& r) {
  ctx.Equal(r.Status, 200, "the owner's shadow read (%s); the status", r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the shadow read must answer a JSON object, got %s", r.Text());
  return body;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto r = readAs(c, kReadThermo, "acme");
  ctx.Equal(r.Status, 200, "GET /v1/devices/%s/shadow by its owner (%s); the status", kReadThermo, r.Text());
  ctx.Equal(shadowOf(ctx, r).value("device_id", ""), kReadThermo, "the shadow read must name the device");
}

void CheckSideBySide(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto body = shadowOf(ctx, readAs(c, kReadThermo, "acme"));
  ctx.Equal(body.value("desired", nlohmann::json()), nlohmann::json(kDesired),
            "the shadow read must answer the stored desired document (merged, the desired values hide that the device still runs mode=normal); desired");
  ctx.Equal(body.value("reported", nlohmann::json()), nlohmann::json(kReported), "the shadow read must answer the stored reported document; reported");
  ctx.Assert(body.value("desired_version", 0LL) == 3 && body.value("reported_version", 0LL) == 7,
             "the shadow read answered desired_version %d and reported_version %d, expected 3 and 7 as stored", body.value("desired_version", 0LL),
             body.value("reported_version", 0LL));
}

void CheckDelta(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto body = shadowOf(ctx, readAs(c, kReadThermo, "acme"));
  ctx.Equal(body.value("delta", nlohmann::json()), nlohmann::json({"fan", "mode"}),
            "the device reports mode=normal and no fan, the operator wants mode=eco and fan=auto; delta");
  shadow::applyReport(kReadThermo, kDesired, 8);
  const auto converged = shadowOf(ctx, readAs(c, kReadThermo, "acme"));
  ctx.Equal(converged.value("delta", nlohmann::json()), nlohmann::json::array(), "once the device reports every desired value; delta");
}

void CheckForeignDevice404(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto foreign = readAs(c, kReadThermo, "globex");
  const auto unknown = readAs(c, "thermo-404", "acme");
  const auto anonymous = readAs(c, kReadThermo, "");
  ctx.Equal(foreign.Status, 404, "tenant globex read acme's %s (%s): another tenant's device must answer 404; the status", kReadThermo, foreign.Text());
  ctx.Assert(foreign.Text().find("eco") == std::string::npos, "the refused read still carried the shadow: %s", foreign.Text());
  ctx.Equal(unknown.Status, 404, "an unknown device; the status");
  ctx.Equal(anonymous.Status, 401, "a read without X-Tenant-Id; the status");
}
`,
  },
  hints: [
    "Set `mode=eco` while the device still reports `mode=normal`, then read the shadow: it says `eco`, one version, nothing behind. Send another tenant's id in `X-Tenant-Id`: the read still answers.",
    '`{**reported, **desired}` lets every desired value overwrite the reported one, and `max` of the two counters keeps only the newer side. No owner is compared before `read_shadow` runs.',
    '401 without `X-Tenant-Id`, 404 unless `registry.owner(device_id)` equals it; then answer `desired`, `reported` and both versions untouched, with `delta` = `sorted(f for f, v in desired.items() if reported.get(f) != v)`.',
  ],
  debrief: `The read is a diagnostic, not a merge: support needs what the operator asked for, what the device last said and how far apart they are, so both documents and both counters come back untouched and the delta is computed from them rather than stored beside them. Another tenant's device answers 404 like a missing one, so the endpoint never confirms which ids exist elsewhere, and the owner check runs before the shadow is read so a refused request costs nothing. AWS IoT publishes the delta as its own message whenever it changes, so devices need not poll for it; a production read also returns when each field last changed, which is what tells a stuck device from a slow one.`,
};
