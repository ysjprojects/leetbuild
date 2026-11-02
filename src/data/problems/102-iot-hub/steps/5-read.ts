import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/devices/{id}/shadow: divergence you can see',
  concept: 'http',
  file: 'read',
  focus: ['client', 'hub', 'shadow'],
  task: `## Task

**Starting point.** The starter's \`GET /v1/devices/{device_id}/shadow\` calls
\`shadows.read(device_id)\`, merges the two documents as \`{**reported, **desired}\`, takes
\`max(desired_version, reported_version)\` as one \`version\`, logs it, and answers
\`{device_id, version, document}\` to any caller. It compiles and hides four flaws.

**Failure mode the checks target.** A device still running last week's configuration reads as
converged, because the desired values overwrite the reported ones in the merge. One version on both
sides hides which side is stale, so support cannot tell whether to wait or escalate. Any tenant can
read any device's shadow by guessing an id.

Requirements:

- The tenant comes from \`X-Tenant-Id\`; missing is \`401\`.
- \`assert_tenant_owns(tenant, devices.get(device_id))\` compares the register row's owner with the
  tenant before the shadow is read; a foreign or unknown device is \`404\` either way.
- The response carries \`"desired"\` and \`"reported"\` untouched, plus
  \`"desired_version": shadow["desired_version"]\` and
  \`"reported_version": shadow["reported_version"]\` exactly as the store holds them.
- \`"divergence": divergent_fields(desired, reported)\`: the sorted top-level fields of \`desired\`
  where \`reported.get(field) != desired[field]\`. Empty means converged.
- Log tenant, device and the two versions, not the documents; a shadow document is operator
  configuration and outlives the request in every log sink.`,
  sequence: {
    participants: ['Operator', 'IoT Hub', 'Shadow'],
    messages: [
      {from: 'Operator', to: 'IoT Hub', label: 'GET /v1/devices/{id}/shadow · X-Tenant-Id', kind: 'sync'},
      {from: 'IoT Hub', to: 'IoT Hub', label: 'register lookup · foreign device → 404', kind: 'sync'},
      {from: 'IoT Hub', to: 'Shadow', label: 'read shadow:{device_id} · desired/reported + versions', kind: 'sync'},
      {from: 'Shadow', to: 'IoT Hub', label: '{desired, reported, desired_version, reported_version}', kind: 'reply'},
      {from: 'IoT Hub', to: 'IoT Hub', label: 'divergence: desired fields the device is behind on', kind: 'sync'},
      {from: 'IoT Hub', to: 'Operator', label: '200 {desired, reported, both versions, divergence}', kind: 'reply'},
    ],
  },
  hints: [
    'Support sees a thermostat as converged on the dashboard while the device on site still runs the old schedule, and a customer reports reading a device id that belongs to another tenant.',
    '`{**reported, **desired}` lets every desired value overwrite the reported one, and `max(...)` of the two counters discards whichever side is behind; no owner is compared before the read.',
    'Return `desired`, `reported`, `desired_version`, `reported_version` from `shadows.read` untouched, plus `divergence: divergent_fields(desired, reported)`. Add `assert_tenant_owns` against `devices.get(device_id)` with `404` before the read.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/devices/{id}/shadow',
      detail: 'Register the shadow read on `GET /v1/devices/{id}/shadow`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/devices\/\{device_id\}\/shadow["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/devices\/:deviceId\/shadow['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/devices\/\{device_id\}\/shadow"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"devices"\s*\/\s*Segment\s*\/\s*"shadow"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/devices\//]},
      },
    },
    {
      id: 'both-documents',
      title: 'Serves the desired and reported documents side by side',
      detail:
        'The response carries both documents untouched under `desired` and `reported`, read through the shadow store. The starter merges them into one `document`, so the desired values overwrite the reported ones and nothing downstream can tell the device is behind.',
      match: {
        python: {all: [/"desired":/, /"reported":/, /shadows\.read\(/]},
        typescript: {all: [/desired:\s*shadow\.desired/, /reported:\s*shadow\.reported/, /shadows\.read\(/]},
        go: {all: [/json:"desired"/, /json:"reported"/, /shadows\.Read\(/]},
        scala: {all: [/desired = shadow\.desired/, /reported = shadow\.reported/, /shadows\.read\(/]},
        cpp: {all: [/\{"desired",\s*shadow\.desired\}/, /\{"reported",\s*shadow\.reported\}/, /shadows\.read\(/]},
      },
    },
    {
      id: 'both-versions-exact',
      title: 'Both versions are returned exactly as the store holds them',
      detail:
        'The response reports `desired_version` and `reported_version` as the counter each side actually carries: a device reporting version 3 while the operator is on version 7 comes back with 7 and 3, not 7 on both. The starter collapses the two into the newer version.',
      match: {
        python: {
          all: [
            /"desired_version":\s*shadow\["desired_version"\]/,
            /"reported_version":\s*shadow\["reported_version"\]/,
          ],
        },
        typescript: {
          all: [/desired_version:\s*shadow\.desired_version/, /reported_version:\s*shadow\.reported_version/],
        },
        go: {all: [/json:"desired_version"/, /json:"reported_version"/]},
        scala: {all: [/desired_version = shadow\.desired_version/, /reported_version = shadow\.reported_version/]},
        cpp: {
          all: [
            /\{"desired_version",\s*shadow\.desired_version\}/,
            /\{"reported_version",\s*shadow\.reported_version\}/,
          ],
        },
      },
    },
    {
      id: 'divergence-list',
      title: 'Divergence is computed from both documents and listed',
      detail:
        '`divergence` names every top-level field of `desired` whose value the `reported` document does not match, sorted, so a converged device answers with an empty list and a behind device says exactly what is outstanding. The starter merges the documents, so the divergent field disappears behind the desired value.',
      match: {
        python: {all: [/"divergence":\s*divergent_fields\(/, /reported\.get\(field\)\s*!=\s*desired\[field\]/]},
        typescript: {
          all: [
            /divergence:\s*divergentFields\(/,
            /JSON\.stringify\(reported\[field\]\)\s*!==\s*JSON\.stringify\(desired\[field\]\)/,
          ],
        },
        go: {all: [/json:"divergence"/, /divergentFields\(/, /reflect\.DeepEqual\(reported\[field\], value\)/]},
        scala: {all: [/divergence = divergentFields\(/, /reported\.get\(field\)\.contains\(value\)/]},
        cpp: {all: [/"divergence", divergent_fields\(/, /reported\.value\(field, json\(\)\)\s*!=\s*value/]},
      },
    },
    {
      id: 'foreign-device-404',
      title: 'A device the caller does not own is 404',
      detail:
        'The device is looked up and its owner compared with the authenticated tenant before the shadow is read; a foreign device answers **404**, indistinguishable from a device that does not exist. The starter serves any device to any caller.',
      match: {
        python: {all: [/assert_tenant_owns\(/, /devices\.get\(device_id\)/, /status_code\s*=\s*404/]},
        typescript: {all: [/assertTenantOwns\(/, /device\.owner !== tenant/, /statusCode = 404/]},
        go: {all: [/assertTenantOwns\(/, /device\.Owner != tenant/, /StatusNotFound/]},
        scala: {
          all: [/devices\.get\(deviceId\)/, /optionalHeaderValueByName\("X-Tenant-Id"\)/, /StatusCodes\.NotFound/],
        },
        cpp: {all: [/assert_tenant_owns\(/, /device->owner != tenant/, /\b404\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("shadow-read")


class DeviceRegistry:
    def get(self, device_id: str) -> dict | None:
        """The device register row carrying its owner, or None when the device is unknown."""
        raise NotImplementedError


class ShadowStore:
    def read(self, device_id: str) -> dict:
        """The shadow from the hash shadow:{device_id}: both documents and both version counters."""
        raise NotImplementedError


devices = DeviceRegistry()
shadows = ShadowStore()


@app.get("/v1/devices/{device_id}/shadow")
def read_shadow(device_id: str) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    shadow = shadows.read(device_id)
    merged = {**shadow["reported"], **shadow["desired"]}
    version = max(shadow["desired_version"], shadow["reported_version"])
    logger.info("shadow read device=%s version=%d", device_id, version)
    return JSONResponse(
        {
            "device_id": device_id,
            "version": version,
            "document": merged,
        },
        status_code=200,
    )
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("shadow-read")


class DeviceRegistry:
    def get(self, device_id: str) -> dict | None:
        """The device register row carrying its owner, or None when the device is unknown."""
        raise NotImplementedError


class ShadowStore:
    def read(self, device_id: str) -> dict:
        """The shadow from the hash shadow:{device_id}: both documents and both version counters."""
        raise NotImplementedError


devices = DeviceRegistry()
shadows = ShadowStore()


def assert_tenant_owns(tenant: str, device: dict | None) -> dict:
    """404, not 403: a foreign device id must stay indistinguishable from an unknown one."""
    if device is None or device["owner"] != tenant:
        raise HTTPException(status_code=404, detail="device not found")
    return device


def divergent_fields(desired: dict, reported: dict) -> list[str]:
    """The fields of the desired document the device's reported document is behind on."""
    return sorted(field for field in desired if reported.get(field) != desired[field])


@app.get("/v1/devices/{device_id}/shadow")
def read_shadow(
    device_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    assert_tenant_owns(tenant, devices.get(device_id))

    shadow = shadows.read(device_id)
    body = {
        "device_id": device_id,
        "desired_version": shadow["desired_version"],
        "reported_version": shadow["reported_version"],
        "desired": shadow["desired"],
        "reported": shadow["reported"],
        "divergence": divergent_fields(shadow["desired"], shadow["reported"]),
    }
    logger.info(
        "shadow read tenant=%s device=%s desired_version=%d reported_version=%d divergent=%d",
        tenant,
        device_id,
        body["desired_version"],
        body["reported_version"],
        len(body["divergence"]),
    )
    return JSONResponse(body, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/devices/:id/shadow: serves a device shadow to its tenant. */
import Fastify from 'fastify';

export const app = Fastify();

interface Shadow {
  desired_version: number;
  reported_version: number;
  desired: Record<string, unknown>;
  reported: Record<string, unknown>;
}

class ShadowStore {
  async read(deviceId: string): Promise<Shadow> {
    throw new Error('read the shadow hash');
  }
}

const shadows = new ShadowStore();

app.get('/v1/devices/:deviceId/shadow', async (request, reply) => {
  const {deviceId} = request.params as {deviceId: string};
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const shadow = await shadows.read(deviceId);
  const merged = {...shadow.reported, ...shadow.desired};
  const version = Math.max(shadow.desired_version, shadow.reported_version);
  request.log.info({deviceId, version}, 'shadow read');
  return reply.code(200).send({device_id: deviceId, version, document: merged});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/devices/:id/shadow: desired, reported and the fields where they diverge. */
import Fastify from 'fastify';

import {devices, shadows} from './store';
import type {Shadow} from './store';

export const app = Fastify();

function divergentFields(desired: Record<string, unknown>, reported: Record<string, unknown>): string[] {
  return Object.keys(desired)
    .filter(field => JSON.stringify(reported[field]) !== JSON.stringify(desired[field]))
    .sort();
}

async function assertTenantOwns(tenant: string, deviceId: string): Promise<void> {
  const device = await devices.get(deviceId);
  if (device === null || device.owner !== tenant) {
    const error = new Error('device not found') as Error & {statusCode: number};
    error.statusCode = 404;
    throw error;
  }
}

app.get('/v1/devices/:deviceId/shadow', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {deviceId} = request.params as {deviceId: string};
  await assertTenantOwns(tenant, deviceId);

  const shadow: Shadow = await shadows.read(deviceId);
  request.log.info({tenant, deviceId, versions: [shadow.desired_version, shadow.reported_version]}, 'shadow read');
  return reply.code(200).send({
    device_id: deviceId,
    desired_version: shadow.desired_version,
    reported_version: shadow.reported_version,
    desired: shadow.desired,
    reported: shadow.reported,
    divergence: divergentFields(shadow.desired, shadow.reported),
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

type Shadow struct {
	DesiredVersion  int
	ReportedVersion int
	Desired         map[string]any
	Reported        map[string]any
}

type ShadowStore struct{}

func (s *ShadowStore) Read(ctx context.Context, deviceID string) (*Shadow, error) {
	fields, err := rdb.HGetAll(ctx, "shadow:"+deviceID).Result()
	if err != nil {
		return nil, err
	}
	shadow := &Shadow{Desired: map[string]any{}, Reported: map[string]any{}}
	shadow.DesiredVersion, _ = strconv.Atoi(fields["desired_version"])
	shadow.ReportedVersion, _ = strconv.Atoi(fields["reported_version"])
	_ = json.Unmarshal([]byte(fields["desired"]), &shadow.Desired)
	_ = json.Unmarshal([]byte(fields["reported"]), &shadow.Reported)
	return shadow, nil
}

var shadows = &ShadowStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readShadow(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	deviceID := r.PathValue("device_id")
	shadow, err := shadows.Read(r.Context(), deviceID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "shadow unavailable"})
		return
	}
	merged := map[string]any{}
	for field, value := range shadow.Reported {
		merged[field] = value
	}
	for field, value := range shadow.Desired {
		merged[field] = value
	}
	version := shadow.DesiredVersion
	if shadow.ReportedVersion > version {
		version = shadow.ReportedVersion
	}
	log.Printf("shadow read device=%s version=%d", deviceID, version)
	writeJSON(rw, http.StatusOK, map[string]any{"device_id": deviceID, "version": version, "document": merged})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/devices/{device_id}/shadow", readShadow)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"reflect"
	"sort"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

type Device struct {
	ID    string
	Owner string
}

type DeviceRegistry struct{}

func (d *DeviceRegistry) Get(ctx context.Context, deviceID string) (*Device, error) {
	return nil, nil
}

var devices = &DeviceRegistry{}

type Shadow struct {
	DesiredVersion  int
	ReportedVersion int
	Desired         map[string]any
	Reported        map[string]any
}

type ShadowStore struct{}

func (s *ShadowStore) Read(ctx context.Context, deviceID string) (*Shadow, error) {
	fields, err := rdb.HGetAll(ctx, "shadow:"+deviceID).Result()
	if err != nil {
		return nil, err
	}
	shadow := &Shadow{Desired: map[string]any{}, Reported: map[string]any{}}
	shadow.DesiredVersion, _ = strconv.Atoi(fields["desired_version"])
	shadow.ReportedVersion, _ = strconv.Atoi(fields["reported_version"])
	_ = json.Unmarshal([]byte(fields["desired"]), &shadow.Desired)
	_ = json.Unmarshal([]byte(fields["reported"]), &shadow.Reported)
	return shadow, nil
}

var shadows = &ShadowStore{}

type ShadowView struct {
	DeviceID        string         \`json:"device_id"\`
	DesiredVersion  int            \`json:"desired_version"\`
	ReportedVersion int            \`json:"reported_version"\`
	Desired         map[string]any \`json:"desired"\`
	Reported        map[string]any \`json:"reported"\`
	Divergence      []string       \`json:"divergence"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func assertTenantOwns(tenant string, device *Device) error {
	if device == nil || device.Owner != tenant {
		return errors.New("device not found")
	}
	return nil
}

func divergentFields(desired, reported map[string]any) []string {
	fields := []string{}
	for field, value := range desired {
		if !reflect.DeepEqual(reported[field], value) {
			fields = append(fields, field)
		}
	}
	sort.Strings(fields)
	return fields
}

func readShadow(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	deviceID := r.PathValue("device_id")
	device, err := devices.Get(r.Context(), deviceID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "device lookup failed"})
		return
	}
	if err := assertTenantOwns(tenant, device); err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "device not found"})
		return
	}
	shadow, err := shadows.Read(r.Context(), deviceID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "shadow unavailable"})
		return
	}
	log.Printf("shadow read tenant=%s device=%s desired_version=%d reported_version=%d", tenant, deviceID, shadow.DesiredVersion, shadow.ReportedVersion)
	writeJSON(rw, http.StatusOK, ShadowView{
		DeviceID:        deviceID,
		DesiredVersion:  shadow.DesiredVersion,
		ReportedVersion: shadow.ReportedVersion,
		Desired:         shadow.Desired,
		Reported:        shadow.Reported,
		Divergence:      divergentFields(shadow.Desired, shadow.Reported),
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/devices/{device_id}/shadow", readShadow)
	log.Fatal(http.ListenAndServe(":8443", mux))
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

final case class Shadow(
    desired_version: Int,
    reported_version: Int,
    desired: Map[String, JsValue],
    reported: Map[String, JsValue],
)

object ShadowReadApi {
  implicit val system: ActorSystem = ActorSystem("iothub")

  object shadows {
    def read(deviceId: String): Shadow = Shadow(0, 0, Map.empty, Map.empty)
  }

  val route: Route =
    path("v1" / "devices" / Segment / "shadow") { deviceId =>
      get {
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        val shadow = shadows.read(deviceId)
        val merged = JsObject(shadow.reported ++ shadow.desired)
        val version = math.max(shadow.desired_version, shadow.reported_version)
        system.log.info(s"shadow read device=$deviceId version=$version")
        val body = JsObject(
          "device_id" -> JsString(deviceId),
          "version" -> JsNumber(version),
          "document" -> merged,
        )
        complete(StatusCodes.OK, body.compactPrint)
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
import spray.json.DefaultJsonProtocol._
import spray.json.JsValue
import spray.json.RootJsonFormat

final case class Shadow(
    desired_version: Int,
    reported_version: Int,
    desired: Map[String, JsValue],
    reported: Map[String, JsValue],
)
final case class ShadowView(
    device_id: String,
    desired_version: Int,
    reported_version: Int,
    desired: Map[String, JsValue],
    reported: Map[String, JsValue],
    divergence: List[String],
)

object ShadowReadApi {
  implicit val system: ActorSystem = ActorSystem("iothub")
  implicit val viewFormat: RootJsonFormat[ShadowView] = jsonFormat6(ShadowView)

  object devices {
    def get(deviceId: String): Option[String] = None
  }

  object shadows {
    def read(deviceId: String): Shadow = Shadow(0, 0, Map.empty, Map.empty)
  }

  def divergentFields(desired: Map[String, JsValue], reported: Map[String, JsValue]): List[String] =
    desired.filter { case (field, value) => !reported.get(field).contains(value) }.keys.toList.sorted

  val route: Route =
    path("v1" / "devices" / Segment / "shadow") { deviceId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else if (!devices.get(deviceId).contains(tenantOpt.get)) {
            complete(StatusCodes.NotFound, """{"error":"device not found"}""")
          } else {
            val tenant = tenantOpt.get
            val shadow = shadows.read(deviceId)
            val desiredVersion = shadow.desired_version
            val reportedVersion = shadow.reported_version
            system.log.info(
              s"shadow read tenant=$tenant device=$deviceId desired=$desiredVersion reported=$reportedVersion",
            )
            val view = ShadowView(
              device_id = deviceId,
              desired_version = shadow.desired_version,
              reported_version = shadow.reported_version,
              desired = shadow.desired,
              reported = shadow.reported,
              divergence = divergentFields(shadow.desired, shadow.reported),
            )
            complete(StatusCodes.OK, view)
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

#include <algorithm>
#include <iostream>
#include <string>

using json = nlohmann::json;

struct Shadow {
  int desired_version;
  int reported_version;
  json desired;
  json reported;
};

struct ShadowStore {
  Shadow read(const std::string& deviceId);
};

ShadowStore shadows;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/devices/([^/]+)/shadow)", [](const httplib::Request& req, httplib::Response& res) {
    const auto deviceId = req.matches[1].str();
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    const auto shadow = shadows.read(deviceId);
    json merged = shadow.reported;
    merged.update(shadow.desired);
    const int version = std::max(shadow.desired_version, shadow.reported_version);
    std::cerr << "shadow read device=" << deviceId << " version=" << version << "\\n";
    res.status = 200;
    res.set_content(
        json{{"device_id", deviceId}, {"version", version}, {"document", merged}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

struct Device {
  std::string id;
  std::string owner;
};

struct Shadow {
  int desired_version;
  int reported_version;
  json desired;
  json reported;
};

struct DeviceRegistry {
  std::optional<Device> get(const std::string& deviceId);
};

struct ShadowStore {
  Shadow read(const std::string& deviceId);
};

DeviceRegistry devices;
ShadowStore shadows;

std::optional<Device> assert_tenant_owns(const std::string& tenant, const std::string& deviceId) {
  const auto device = devices.get(deviceId);
  if (!device || device->owner != tenant) return std::nullopt;
  return device;
}

std::vector<std::string> divergent_fields(const json& desired, const json& reported) {
  std::vector<std::string> fields;
  for (const auto& [field, value] : desired.items()) {
    if (reported.value(field, json()) != value) fields.push_back(field);
  }
  std::sort(fields.begin(), fields.end());
  return fields;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/devices/([^/]+)/shadow)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto deviceId = req.matches[1].str();
    const auto device = assert_tenant_owns(tenant, deviceId);
    if (!device) {
      res.status = 404;
      res.set_content(R"({"error":"device not found"})", "application/json");
      return;
    }
    const auto shadow = shadows.read(deviceId);
    std::cerr << "shadow read tenant=" << tenant << " device=" << deviceId
              << " desired_version=" << shadow.desired_version
              << " reported_version=" << shadow.reported_version << "\\n";
    res.status = 200;
    res.set_content(
        json{{"device_id", deviceId},
             {"desired_version", shadow.desired_version},
             {"reported_version", shadow.reported_version},
             {"desired", shadow.desired},
             {"reported", shadow.reported},
             {"divergence", divergent_fields(shadow.desired, shadow.reported)}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The response keeps the shadow's four fields separate because disagreement is the data: a
merged document can only show the desired value, and a single \`max\` version cannot say which side is
behind. \`divergence\` is computed by comparing the documents field by field rather than inferred from
the counters, because a device can report a newer version and still be missing one field. The
ownership check runs before the read and answers \`404\` rather than \`403\` so a guessed id reveals
nothing about whether the device exists. This step stops at top-level fields and a point-in-time
read. A production shadow read also walks nested paths in the divergence, and the hub alerts when a
device's divergence has aged past its reconciliation budget instead of waiting for someone to look.`,
};
