import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/shipments/{id}: the customer view and the operations view',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'ops', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/shipments/{shipment_id}\`: it loads the shipment
(\`store.get_shipment\`), answers \`{shipment_id, status, delivered, timeline, carrier_error}\` with
the stored \`status\`, \`delivered\` read off it, the applied scans (\`store.scans\`) as the timeline
and the last poll error, and adds \`poll_health\` and \`rejects\` when the request carries an
\`X-Ops-Token\` header. It serves the demo and hides four flaws.

**Failure mode the checks target.** Any caller reads any tenant's parcel by guessing ids; an
operator override or a stale writer marks a parcel delivered that no scan delivered; the carrier's
error text lands on the customer's tracking page; any value in \`X-Ops-Token\` opens the
operations view.

- A missing \`X-Tenant-Id\` is **401**; a shipment that does not exist or whose \`tenant_id\` is
  another tenant's is the same **404**.
- \`customer_view\` derives \`status\` (the latest applied scan, \`label\` before any) and
  \`delivered\` from the scans, and carries nothing from poll health.
- \`operations_view\` adds \`poll_health\`, \`carrier_error\`, \`rejects\` and \`reconciliation\`
  (the stored status disagrees with the scans), only when \`X-Ops-Token\` equals \`OPS_TOKEN\`.`,
  sequence: {
    participants: ['Customer', 'Operations console', 'Shipment API', 'Redis'],
    messages: [
      {from: 'Customer', to: 'Shipment API', label: 'GET /v1/shipments/shp_1 · X-Tenant-Id', kind: 'sync'},
      {from: 'Shipment API', to: 'Redis', label: 'get_shipment · tenant_id ≠ caller → 404', kind: 'sync'},
      {from: 'Shipment API', to: 'Redis', label: 'scans(shp_1)', kind: 'sync'},
      {from: 'Shipment API', to: 'Customer', label: '200 customer_view: status from the scans, cities', kind: 'reply'},
      {from: 'Operations console', to: 'Shipment API', label: 'GET … · X-Ops-Token = OPS_TOKEN', kind: 'sync'},
      {from: 'Shipment API', to: 'Redis', label: 'poll_health · rejects', kind: 'sync'},
      {
        from: 'Shipment API',
        to: 'Operations console',
        label: '200 operations_view: + poll_health, carrier_error, reconciliation',
        kind: 'reply',
      },
    ],
  },
  hints: [
    "Ask for another tenant's shipment id and it answers; a parcel whose last scan is out for delivery reads delivered; the tracking page shows the carrier's 503 text; `X-Ops-Token: x` opens the operations view.",
    'The handler never reads the tenant, takes the status from the stored field that any writer can set, builds one payload for everyone with the poll error in it, and only checks that the token header exists.',
    '401 without a tenant, 404 when missing or `tenant_id` differs. `customer_view`: status from the last scan, `delivered`, timeline. `operations_view`: add `poll_health`, `carrier_error`, `rejects`, `reconciliation`, when the token equals `OPS_TOKEN`.',
  ],
  checks: [
    {
      id: 'read-route',
      title: 'Serves the shipment and its timeline',
      detail:
        'Register `GET /v1/shipments/{id}`; it answers the shipment id and the applied scans, oldest first, with their cities.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/shipments\/\{shipment_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/shipments\/:shipmentId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/shipments\/\{id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"shipments"\s*\/\s*Segment\s*\)/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/shipments\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Answers 404 for another tenant's shipment",
      detail:
        'The tenant comes from `X-Tenant-Id` (**401** without it); a shipment that is missing or belongs to another tenant answers the same **404**, so ids cannot be probed.',
      match: {
        python: {all: [/x-tenant-id/i, /tenant_id/, /\b401\b/]},
        typescript: {all: [/x-tenant-id/i, /tenant_id/, /\b401\b/]},
        go: {all: [/X-Tenant-Id/i, /TenantID/, /StatusUnauthorized|\b401\b/]},
        scala: {all: [/X-Tenant-Id/i, /tenantId/, /Unauthorized|\b401\b/]},
        cpp: {all: [/X-Tenant-Id/i, /tenant_id/, /\b401\b/]},
      },
    },
    {
      id: 'delivered-scan',
      title: 'Derives status and delivered from the scans',
      detail:
        'The customer sees the status of the latest applied scan (`label` before any) and `delivered` only after a delivered scan; the stored `status` field is what an override or a stale writer set.',
      match: {
        python: {
          all: [/store\.scans\(/],
          none: [/["']status["']:\s*shipment\[["']status["']\]/, /shipment\[["']status["']\]\s*==\s*["']delivered/],
        },
        typescript: {
          all: [/store\.scans\(/],
          none: [/status:\s*shipment\.status\b/, /shipment\.status\s*===\s*'delivered'/],
        },
        go: {all: [/store\.Scans\(/], none: [/"status":\s*shipment\.Status/, /shipment\.Status\s*==\s*"delivered"/]},
        scala: {
          all: [/Store\.scans\(/],
          none: [/"status"\s*->\s*JsString\(shipment\.status\)/, /shipment\.status\s*==\s*"delivered"/],
        },
        cpp: {
          all: [/store::scans\(/],
          none: [/\{"status",\s*shipment(->|\.)status\}/, /shipment(->|\.)status\s*==\s*"delivered"/],
        },
      },
    },
    {
      id: 'ops-view',
      title: 'Opens the operations view only for the operations token',
      detail:
        '`operations_view` (poll health, carrier error, dropped edges, reconciliation) is served only when `X-Ops-Token` equals `OPS_TOKEN`; a header that is merely present proves nothing.',
      match: {
        python: {all: [/OPS_TOKEN/, /def operations_view\(/]},
        typescript: {all: [/OPS_TOKEN/, /function operationsView\(/]},
        go: {all: [/opsToken/, /func operationsView\(/]},
        scala: {all: [/OpsToken/, /def operationsView\(/]},
        cpp: {all: [/kOpsToken/, /json operationsView\(/]},
      },
    },
    {
      id: 'no-error-leak',
      title: "Keeps the carrier's errors out of the customer view",
      detail:
        "`customer_view` carries the status, `delivered` and the timeline; the carrier's error text and poll health live only in `operations_view`.",
      match: {
        python: {
          all: [/def customer_view\(/],
          none: [/def customer_view(?:(?!\ndef )[\s\S])*?(carrier_error|last_error|poll_health)/],
        },
        typescript: {
          all: [/function customerView\(/],
          none: [/function customerView(?:(?!\n\}|\nfunction )[\s\S])*?(carrier_error|last_error|pollHealth)/],
        },
        go: {
          all: [/func customerView\(/],
          none: [/func customerView(?:(?!\n\})[\s\S])*?(carrier_error|LastError|PollHealth)/],
        },
        scala: {
          all: [/def customerView\(/],
          none: [/def customerView(?:(?!\n {2}def |\n {2}val )[\s\S])*?(carrier_error|lastError|pollHealth)/],
        },
        cpp: {
          all: [/json customerView\(/],
          none: [/json customerView(?:(?!\n\})[\s\S])*?(carrier_error|last_error|pollHealth)/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from shipments import store  # store.get_shipment, scans, rejects, poll_health

app = FastAPI()


@app.get("/v1/shipments/{shipment_id}")
def read_shipment(shipment_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    shipment = store.get_shipment(shipment_id)
    if shipment is None:
        return JSONResponse({"error": "no such shipment"}, status_code=404)
    health = store.poll_health(shipment_id, int(time.time()))
    view = {
        "shipment_id": shipment_id,
        "status": shipment["status"],
        "delivered": shipment["status"] == "delivered",
        "timeline": store.scans(shipment_id),
        "carrier_error": health["last_error"],
    }
    if request.headers.get("x-ops-token"):
        view["poll_health"] = health
        view["rejects"] = store.rejects(shipment_id)
    return JSONResponse(view)
`,
      solution: `import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from shipments import store  # store.get_shipment, scans, rejects, poll_health

app = FastAPI()

OPS_TOKEN = "ops-7f3a9c"
NOT_FOUND = {"error": "no such shipment"}


def status_from_scans(scans: list[dict]) -> str:
    """The status the applied scans prove: the latest one, label before any."""
    return scans[-1]["status"] if scans else "label"


def customer_view(shipment: dict, scans: list[dict]) -> dict:
    status = status_from_scans(scans)
    return {"shipment_id": shipment["shipment_id"], "status": status, "delivered": status == "delivered", "timeline": scans}


def operations_view(shipment: dict, scans: list[dict], now: int) -> dict:
    health = store.poll_health(shipment["shipment_id"], now)
    return {
        **customer_view(shipment, scans),
        "poll_health": health,
        "carrier_error": health["last_error"],
        "rejects": store.rejects(shipment["shipment_id"]),
        "reconciliation": shipment["status"] != status_from_scans(scans),  # an override or a stale writer
    }


@app.get("/v1/shipments/{shipment_id}")
def read_shipment(shipment_id: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    shipment = store.get_shipment(shipment_id)
    # Missing and foreign are one answer: an id another tenant owns cannot be told from one that does not exist.
    if shipment is None or shipment["tenant_id"] != tenant:
        return JSONResponse(NOT_FOUND, status_code=404)
    scans = store.scans(shipment_id)
    if request.headers.get("x-ops-token") == OPS_TOKEN:
        return JSONResponse(operations_view(shipment, scans, int(time.time())))
    return JSONResponse(customer_view(shipment, scans))
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import * as store from 'shipments/store'; // store.getShipment, scans, rejects, pollHealth

export const app = Fastify();

app.get('/v1/shipments/:shipmentId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {shipmentId} = request.params as {shipmentId: string};
  const shipment = await store.getShipment(shipmentId);
  if (shipment === null) return reply.code(404).send({error: 'no such shipment'});
  const health = await store.pollHealth(shipmentId, Math.floor(Date.now() / 1000));
  const view: Record<string, unknown> = {
    shipment_id: shipmentId,
    status: shipment.status,
    delivered: shipment.status === 'delivered',
    timeline: await store.scans(shipmentId),
    carrier_error: health.last_error,
  };
  if (request.headers['x-ops-token'] !== undefined) {
    view.poll_health = health;
    view.rejects = await store.rejects(shipmentId);
  }
  return view;
});
`,
      solution: `import Fastify from 'fastify';

import * as store from 'shipments/store'; // store.getShipment, scans, rejects, pollHealth

export const app = Fastify();

export const OPS_TOKEN = 'ops-7f3a9c';
const NOT_FOUND = {error: 'no such shipment'};

/** The status the applied scans prove: the latest one, label before any. */
export function statusFromScans(scans: store.Scan[]): string {
  return scans.length > 0 ? scans[scans.length - 1].status : 'label';
}

export function customerView(shipment: store.Shipment, scans: store.Scan[]): Record<string, unknown> {
  const status = statusFromScans(scans);
  return {shipment_id: shipment.shipment_id, status, delivered: status === 'delivered', timeline: scans};
}

export async function operationsView(shipment: store.Shipment, scans: store.Scan[], now: number): Promise<Record<string, unknown>> {
  const health = await store.pollHealth(shipment.shipment_id, now);
  return {
    ...customerView(shipment, scans),
    poll_health: health,
    carrier_error: health.last_error,
    rejects: await store.rejects(shipment.shipment_id),
    reconciliation: shipment.status !== statusFromScans(scans), // an override or a stale writer
  };
}

app.get('/v1/shipments/:shipmentId', async (request, reply) => {
  const {shipmentId} = request.params as {shipmentId: string};
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const shipment = await store.getShipment(shipmentId);
  // Missing and foreign are one answer: an id another tenant owns cannot be told from one that does not exist.
  if (shipment === null || shipment.tenant_id !== tenant) return reply.code(404).send(NOT_FOUND);
  const scans = await store.scans(shipmentId);
  if (request.headers['x-ops-token'] === OPS_TOKEN) return operationsView(shipment, scans, Math.floor(Date.now() / 1000));
  return customerView(shipment, scans);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"shipments/store" // store.GetShipment, Scans, Rejects, PollHealth
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readShipment(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	shipmentID := r.PathValue("id")
	shipment := store.GetShipment(r.Context(), shipmentID)
	if shipment == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such shipment"})
		return
	}
	health := store.PollHealth(r.Context(), shipmentID, time.Now().Unix())
	view := map[string]any{
		"shipment_id":   shipmentID,
		"status":        shipment.Status,
		"delivered":     shipment.Status == "delivered",
		"timeline":      store.Scans(r.Context(), shipmentID),
		"carrier_error": health.LastError,
	}
	if r.Header.Get("X-Ops-Token") != "" {
		view["poll_health"] = health
		view["rejects"] = store.Rejects(r.Context(), shipmentID)
	}
	writeJSON(rw, http.StatusOK, view)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/shipments/{id}", readShipment)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"shipments/store" // store.GetShipment, Scans, Rejects, PollHealth
)

const opsToken = "ops-7f3a9c"

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// statusFromScans is the status the applied scans prove: the latest one, label before any.
func statusFromScans(scans []store.Scan) string {
	if len(scans) == 0 {
		return "label"
	}
	return scans[len(scans)-1].Status
}

func customerView(shipment *store.Shipment, scans []store.Scan) map[string]any {
	status := statusFromScans(scans)
	return map[string]any{"shipment_id": shipment.ShipmentID, "status": status, "delivered": status == "delivered", "timeline": scans}
}

func operationsView(ctx context.Context, shipment *store.Shipment, scans []store.Scan, now int64) map[string]any {
	health := store.PollHealth(ctx, shipment.ShipmentID, now)
	view := customerView(shipment, scans) // a fresh map per call
	view["poll_health"] = health
	view["carrier_error"] = health.LastError
	view["rejects"] = store.Rejects(ctx, shipment.ShipmentID)
	view["reconciliation"] = shipment.Status != statusFromScans(scans) // an override or a stale writer
	return view
}

func readShipment(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	shipmentID := r.PathValue("id")
	shipment := store.GetShipment(r.Context(), shipmentID)
	// Missing and foreign are one answer: an id another tenant owns cannot be told from one that does not exist.
	if shipment == nil || shipment.TenantID != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such shipment"})
		return
	}
	scans := store.Scans(r.Context(), shipmentID)
	if r.Header.Get("X-Ops-Token") == opsToken {
		writeJSON(rw, http.StatusOK, operationsView(r.Context(), shipment, scans, time.Now().Unix()))
		return
	}
	writeJSON(rw, http.StatusOK, customerView(shipment, scans))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/shipments/{id}", readShipment)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import shipments.Store // Store.getShipment, scans, rejects, pollHealth

object Read {
  val route: Route = path("v1" / "shipments" / Segment) { shipmentId =>
    get {
      optionalHeaderValueByName("X-Ops-Token") { opsHeader =>
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        Store.getShipment(shipmentId) match {
          case None => complete(StatusCodes.NotFound -> "no such shipment")
          case Some(shipment) =>
            val health = Store.pollHealth(shipmentId, System.currentTimeMillis() / 1000)
            val base = Map(
              "shipment_id" -> JsString(shipmentId),
              "status" -> JsString(shipment.status),
              "delivered" -> JsBoolean(shipment.status == "delivered"),
              "timeline" -> JsArray(Store.scans(shipmentId).map(_.toJson).toVector),
              "carrier_error" -> JsString(health.lastError))
            val view =
              if (opsHeader.isDefined) base ++ Map("poll_health" -> health.toJson, "rejects" -> JsArray(Store.rejects(shipmentId).map(JsString(_)).toVector))
              else base
            complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, JsObject(view).compactPrint)))
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

import shipments.Store // Store.getShipment, scans, rejects, pollHealth

object Read {
  val OpsToken = "ops-7f3a9c"

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** The status the applied scans prove: the latest one, label before any. */
  def statusFromScans(scans: Seq[Store.Scan]): String = scans.lastOption.map(_.status).getOrElse("label")

  def customerView(shipment: Store.Shipment, scans: Seq[Store.Scan]): JsObject = {
    val status = statusFromScans(scans)
    JsObject("shipment_id" -> JsString(shipment.shipmentId), "status" -> JsString(status), "delivered" -> JsBoolean(status == "delivered"),
      "timeline" -> JsArray(scans.map(_.toJson).toVector))
  }

  def operationsView(shipment: Store.Shipment, scans: Seq[Store.Scan], now: Long): JsObject = {
    val health = Store.pollHealth(shipment.shipmentId, now)
    JsObject(customerView(shipment, scans).fields ++ Map(
      "poll_health" -> health.toJson,
      "carrier_error" -> JsString(health.lastError),
      "rejects" -> JsArray(Store.rejects(shipment.shipmentId).map(JsString(_)).toVector),
      "reconciliation" -> JsBoolean(shipment.status != statusFromScans(scans)))) // an override or a stale writer
  }

  private def read(shipmentId: String, tenant: String, opsToken: Option[String]): HttpResponse =
    if (tenant.isEmpty) json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required")))
    else
      // Missing and foreign are one answer: an id another tenant owns cannot be told from one that does not exist.
      Store.getShipment(shipmentId).filter(_.tenantId == tenant) match {
        case None => json(StatusCodes.NotFound, JsObject("error" -> JsString("no such shipment")))
        case Some(shipment) =>
          val scans = Store.scans(shipmentId)
          if (opsToken.contains(OpsToken)) json(StatusCodes.OK, operationsView(shipment, scans, System.currentTimeMillis() / 1000))
          else json(StatusCodes.OK, customerView(shipment, scans))
      }

  val route: Route = path("v1" / "shipments" / Segment) { shipmentId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        optionalHeaderValueByName("X-Ops-Token") { opsToken =>
          complete(read(shipmentId, tenant.getOrElse(""), opsToken))
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

#include <chrono>
#include <string>

#include "shipments/store.h"  // store::getShipment, scans, rejects, pollHealth

using json = nlohmann::json;

long now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void read_shipment(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string shipment_id = req.matches[1];
  const auto shipment = store::getShipment(shipment_id);
  if (!shipment) {
    res.status = 404;
    res.set_content(json{{"error", "no such shipment"}}.dump(), "application/json");
    return;
  }
  const store::PollHealth health = store::pollHealth(shipment_id, now_seconds());
  json view = {{"shipment_id", shipment_id},
               {"status", shipment->status},
               {"delivered", shipment->status == "delivered"},
               {"timeline", store::scans(shipment_id)},
               {"carrier_error", health.last_error}};
  if (req.has_header("X-Ops-Token")) {
    view["poll_health"] = health;
    view["rejects"] = store::rejects(shipment_id);
  }
  res.set_content(view.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/shipments/([\\w-]+))", read_shipment); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>
#include <vector>

#include "shipments/store.h"  // store::getShipment, scans, rejects, pollHealth

using json = nlohmann::json;

const std::string kOpsToken = "ops-7f3a9c";

long now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// The status the applied scans prove: the latest one, label before any.
std::string statusFromScans(const std::vector<store::Scan>& scans) { return scans.empty() ? "label" : scans.back().status; }

json customerView(const store::Shipment& shipment, const std::vector<store::Scan>& scans) {
  const std::string status = statusFromScans(scans);
  return json{{"shipment_id", shipment.shipment_id}, {"status", status}, {"delivered", status == "delivered"}, {"timeline", scans}};
}

json operationsView(const store::Shipment& shipment, const std::vector<store::Scan>& scans, long now) {
  const store::PollHealth health = store::pollHealth(shipment.shipment_id, now);
  json view = customerView(shipment, scans);
  view["poll_health"] = health;
  view["carrier_error"] = health.last_error;
  view["rejects"] = store::rejects(shipment.shipment_id);
  view["reconciliation"] = shipment.status != statusFromScans(scans);  // an override or a stale writer
  return view;
}

void reply_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void read_shipment(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply_json(res, 401, {{"error", "X-Tenant-Id is required"}});
  const std::string shipment_id = req.matches[1];
  const auto shipment = store::getShipment(shipment_id);
  // Missing and foreign are one answer: an id another tenant owns cannot be told from one that does not exist.
  if (!shipment || shipment->tenant_id != tenant) return reply_json(res, 404, {{"error", "no such shipment"}});
  const std::vector<store::Scan> scans = store::scans(shipment_id);
  if (req.get_header_value("X-Ops-Token") == kOpsToken) return reply_json(res, 200, operationsView(*shipment, scans, now_seconds()));
  reply_json(res, 200, customerView(*shipment, scans));
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/shipments/([\\w-]+))", read_shipment); }
`,
    },
  },
  harness: {
    python: `from shipments import store
from shipments.timeline import apply_scan

OPS = "ops-7f3a9c"
ERROR = "UPS: 503 upstream timeout"


def _world(ctx):
    store.save({"shipment_id": "shp_1", "tenant_id": "t-acme", "order_id": "ord_1", "carrier": "ups", "service_level": "ground", "status": "label", "replacement_of": "", "created_at": 0})
    apply_scan("shp_1", "in_transit", 100, "Memphis")
    apply_scan("shp_1", "out_for_delivery", 200, "Leeds")
    apply_scan("shp_1", "in_transit", 150, "Memphis")  # dropped: recorded as a rejected edge
    store.mark_poll_failed("shp_1", 250, ERROR)
    return ctx.client(ctx.load("read").app)


async def _get(c, tenant="t-acme", token=None, shipment_id="shp_1"):
    headers = {"X-Tenant-Id": tenant} if tenant else {}
    if token is not None:
        headers["X-Ops-Token"] = token
    return await c.get(f"/v1/shipments/{shipment_id}", headers=headers)


async def check_read_route(ctx):
    async with _world(ctx) as c:
        r = await _get(c)
    assert r.status_code == 200, f"GET /v1/shipments/shp_1 answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("shipment_id") == "shp_1", f"the read must answer shp_1, got {body}"
    cities = [(s.get("status"), s.get("city")) for s in body.get("timeline", [])]
    assert cities == [("in_transit", "Memphis"), ("out_for_delivery", "Leeds")], f"the timeline must list the applied scans with their cities, oldest first, got {cities}"


async def check_tenant_scope(ctx):
    async with _world(ctx) as c:
        foreign = await _get(c, tenant="t-globex")
        missing = await _get(c, shipment_id="shp_404")
        anonymous = await _get(c, tenant="")
    assert foreign.status_code == 404, f"t-globex reading t-acme's shp_1 answered {foreign.status_code}: {foreign.text[:200]}. Another tenant's shipment is 404"
    assert missing.status_code == 404, f"an unknown shipment answered {missing.status_code}"
    assert foreign.text == missing.text, f"a foreign shipment answered {foreign.text!r} and a missing one {missing.text!r}: the same answer keeps ids from being probed"
    assert anonymous.status_code == 401, f"a read without X-Tenant-Id answered {anonymous.status_code}, expected 401"


async def check_delivered_scan(ctx):
    async with _world(ctx) as c:
        store.set_status("shp_1", "delivered", 260)  # an override no scan backs
        body = (await _get(c)).json()
        assert body.get("status") == "out_for_delivery" and body.get("delivered") is False, f"the last applied scan is out_for_delivery but the customer reads status {body.get('status')!r}, delivered {body.get('delivered')!r}: derive both from the scans"
        store.save({"shipment_id": "shp_2", "tenant_id": "t-acme", "order_id": "ord_2", "carrier": "ups", "service_level": "ground", "status": "label", "replacement_of": "", "created_at": 0})
        fresh = (await _get(c, shipment_id="shp_2")).json()
        assert fresh.get("status") == "label" and fresh.get("delivered") is False, f"a shipment with no scans must read label, not delivered, got {fresh}"
        apply_scan("shp_2", "delivered", 300, "Leeds")
        done = (await _get(c, shipment_id="shp_2")).json()
    assert done.get("status") == "delivered" and done.get("delivered") is True, f"after a delivered scan the customer must read delivered, got {done}"


async def check_ops_view(ctx):
    async with _world(ctx) as c:
        forged = (await _get(c, token="x")).json()
        assert "poll_health" not in forged and "rejects" not in forged, f"X-Ops-Token: x opened the operations view: {forged}. Compare the token with OPS_TOKEN"
        store.set_status("shp_1", "delivered", 260)
        r = await _get(c, token=OPS)
    assert r.status_code == 200, f"the operations read answered {r.status_code}: {r.text}"
    ops = r.json()
    health = ops.get("poll_health") or {}
    assert health.get("failures") == 1 and ops.get("carrier_error") == ERROR, f"the operations view must carry poll_health (1 failure) and carrier_error {ERROR!r}, got {ops}"
    assert ops.get("rejects") == ["out_for_delivery->in_transit"], f"the operations view must list the dropped edges, got {ops.get('rejects')}"
    assert ops.get("reconciliation") is True, f"the stored status says delivered and the scans say out_for_delivery: reconciliation must be true, got {ops.get('reconciliation')!r}"


async def check_no_error_leak(ctx):
    async with _world(ctx) as c:
        r = await _get(c)
    assert r.status_code == 200, f"the customer read answered {r.status_code}"
    assert "503" not in r.text and ERROR not in r.text, f"the customer view carries the carrier's error: {r.text}"
    leaked = [k for k in ("carrier_error", "poll_health", "rejects", "reconciliation") if k in r.json()]
    assert not leaked, f"the customer view carries {leaked}: those belong to operations_view"
`,
    typescript: `const OPS = 'ops-7f3a9c';
const ERROR = 'UPS: 503 upstream timeout';

async function world(ctx) {
  const store = ctx.load('/support/shipments/store.ts');
  const {applyScan} = ctx.load('/support/shipments/timeline.ts');
  await store.save({shipment_id: 'shp_1', tenant_id: 't-acme', order_id: 'ord_1', carrier: 'ups', service_level: 'ground', status: 'label', replacement_of: '', created_at: 0});
  await applyScan('shp_1', 'in_transit', 100, 'Memphis');
  await applyScan('shp_1', 'out_for_delivery', 200, 'Leeds');
  await applyScan('shp_1', 'in_transit', 150, 'Memphis'); // dropped: recorded as a rejected edge
  await store.markPollFailed('shp_1', 250, ERROR);
  return {c: ctx.client(ctx.load('read').app), store, applyScan};
}

function get(c, tenant = 't-acme', token: string | null = null, shipmentId = 'shp_1') {
  const headers: Record<string, string> = {};
  if (tenant !== '') headers['X-Tenant-Id'] = tenant;
  if (token !== null) headers['X-Ops-Token'] = token;
  return c.get(\`/v1/shipments/\${shipmentId}\`, {headers});
}

export async function check_read_route(ctx) {
  const {c} = await world(ctx);
  const r = await get(c);
  assert.equal(r.status, 200, \`GET /v1/shipments/shp_1 answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert.equal(body.shipment_id, 'shp_1', \`the read must answer shp_1, got \${r.text}\`);
  const cities = (body.timeline ?? []).map(s => [s.status, s.city]);
  assert.deepStrictEqual(cities, [['in_transit', 'Memphis'], ['out_for_delivery', 'Leeds']], \`the timeline must list the applied scans with their cities, oldest first, got \${JSON.stringify(cities)}\`);
}

export async function check_tenant_scope(ctx) {
  const {c} = await world(ctx);
  const foreign = await get(c, 't-globex');
  const missing = await get(c, 't-acme', null, 'shp_404');
  const anonymous = await get(c, '');
  assert.equal(foreign.status, 404, \`t-globex reading t-acme's shp_1 answered \${foreign.status}: \${foreign.text.slice(0, 200)}. Another tenant's shipment is 404\`);
  assert.equal(missing.status, 404, \`an unknown shipment answered \${missing.status}\`);
  assert.equal(foreign.text, missing.text, \`a foreign shipment answered \${foreign.text} and a missing one \${missing.text}: the same answer keeps ids from being probed\`);
  assert.equal(anonymous.status, 401, \`a read without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
}

export async function check_delivered_scan(ctx) {
  const {c, store, applyScan} = await world(ctx);
  await store.setStatus('shp_1', 'delivered', 260); // an override no scan backs
  const body = (await get(c)).json();
  assert(body.status === 'out_for_delivery' && body.delivered === false, \`the last applied scan is out_for_delivery but the customer reads status \${body.status}, delivered \${body.delivered}: derive both from the scans\`);
  await store.save({shipment_id: 'shp_2', tenant_id: 't-acme', order_id: 'ord_2', carrier: 'ups', service_level: 'ground', status: 'label', replacement_of: '', created_at: 0});
  const fresh = (await get(c, 't-acme', null, 'shp_2')).json();
  assert(fresh.status === 'label' && fresh.delivered === false, \`a shipment with no scans must read label, not delivered, got \${JSON.stringify(fresh)}\`);
  await applyScan('shp_2', 'delivered', 300, 'Leeds');
  const done = (await get(c, 't-acme', null, 'shp_2')).json();
  assert(done.status === 'delivered' && done.delivered === true, \`after a delivered scan the customer must read delivered, got \${JSON.stringify(done)}\`);
}

export async function check_ops_view(ctx) {
  const {c, store} = await world(ctx);
  const forged = (await get(c, 't-acme', 'x')).json();
  assert(!('poll_health' in forged) && !('rejects' in forged), \`X-Ops-Token: x opened the operations view: \${JSON.stringify(forged)}. Compare the token with OPS_TOKEN\`);
  await store.setStatus('shp_1', 'delivered', 260);
  const r = await get(c, 't-acme', OPS);
  assert.equal(r.status, 200, \`the operations read answered \${r.status}: \${r.text}\`);
  const ops = r.json();
  assert(ops.poll_health?.failures === 1 && ops.carrier_error === ERROR, \`the operations view must carry poll_health (1 failure) and carrier_error "\${ERROR}", got \${r.text}\`);
  assert.deepStrictEqual(ops.rejects, ['out_for_delivery->in_transit'], \`the operations view must list the dropped edges, got \${JSON.stringify(ops.rejects)}\`);
  assert.equal(ops.reconciliation, true, \`the stored status says delivered and the scans say out_for_delivery: reconciliation must be true, got \${ops.reconciliation}\`);
}

export async function check_no_error_leak(ctx) {
  const {c} = await world(ctx);
  const r = await get(c);
  assert.equal(r.status, 200, \`the customer read answered \${r.status}\`);
  assert(!r.text.includes('503'), \`the customer view carries the carrier's error: \${r.text}\`);
  const leaked = ['carrier_error', 'poll_health', 'rejects', 'reconciliation'].filter(k => k in r.json());
  assert.equal(leaked.length, 0, \`the customer view carries \${JSON.stringify(leaked)}: those belong to operationsView\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"shipments/store"
	"shipments/timeline"

	"leetbuild/harness"
)

const (
	ops     = "ops-7f3a9c"
	carrErr = "UPS: 503 upstream timeout"
)

var readBg = context.Background()

func save(id string) {
	store.Save(readBg, store.Shipment{ShipmentID: id, TenantID: "t-acme", OrderID: "ord_" + id, Carrier: "ups", ServiceLevel: "ground", Status: "label"})
}

func world(ctx *harness.Ctx) *harness.HTTP {
	save("shp_1")
	timeline.ApplyScan(readBg, "shp_1", "in_transit", 100, "Memphis")
	timeline.ApplyScan(readBg, "shp_1", "out_for_delivery", 200, "Leeds")
	timeline.ApplyScan(readBg, "shp_1", "in_transit", 150, "Memphis") // dropped: recorded as a rejected edge
	store.MarkPollFailed(readBg, "shp_1", 250, carrErr)
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func get(c *harness.HTTP, tenant, token, shipmentID string) *harness.Response {
	headers := []string{}
	if tenant != "" {
		headers = append(headers, "X-Tenant-Id", tenant)
	}
	if token != "" {
		headers = append(headers, "X-Ops-Token", token)
	}
	return c.Get("/v1/shipments/"+shipmentID, headers...)
}

func view(ctx *harness.Ctx, r *harness.Response) map[string]any {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the read must answer a JSON object, got %s", r.Text())
	return body
}

func CheckReadRoute(ctx *harness.Ctx) {
	c := world(ctx)
	r := get(c, "t-acme", "", "shp_1")
	ctx.Equal(r.Status, 200, "GET /v1/shipments/shp_1 (%s); the status", r.Text())
	body := view(ctx, r)
	ctx.Equal(body["shipment_id"], "shp_1", "the read's shipment_id")
	var cities []string
	items, _ := body["timeline"].([]any)
	for _, item := range items {
		s, _ := item.(map[string]any)
		cities = append(cities, s["status"].(string)+"@"+s["city"].(string))
	}
	ctx.Equal(cities, []string{"in_transit@Memphis", "out_for_delivery@Leeds"}, "the timeline must list the applied scans with their cities, oldest first")
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := world(ctx)
	foreign := get(c, "t-globex", "", "shp_1")
	missing := get(c, "t-acme", "", "shp_404")
	anonymous := get(c, "", "", "shp_1")
	ctx.Equal(foreign.Status, 404, "t-globex reading t-acme's shp_1 must be refused as 404 (%s); the status", foreign.Text())
	ctx.Equal(missing.Status, 404, "an unknown shipment; the status")
	ctx.Equal(foreign.Text(), missing.Text(), "a foreign and a missing shipment must answer the same, so ids cannot be probed; the body")
	ctx.Equal(anonymous.Status, 401, "a read without X-Tenant-Id; the status")
}

func CheckDeliveredScan(ctx *harness.Ctx) {
	c := world(ctx)
	store.SetStatus(readBg, "shp_1", "delivered", 260) // an override no scan backs
	body := view(ctx, get(c, "t-acme", "", "shp_1"))
	ctx.Assert(body["status"] == "out_for_delivery" && body["delivered"] == false, "the last applied scan is out_for_delivery but the customer reads status %v, delivered %v: derive both from the scans", body["status"], body["delivered"])
	save("shp_2")
	fresh := view(ctx, get(c, "t-acme", "", "shp_2"))
	ctx.Assert(fresh["status"] == "label" && fresh["delivered"] == false, "a shipment with no scans must read label, not delivered, got %v", fresh)
	timeline.ApplyScan(readBg, "shp_2", "delivered", 300, "Leeds")
	done := view(ctx, get(c, "t-acme", "", "shp_2"))
	ctx.Assert(done["status"] == "delivered" && done["delivered"] == true, "after a delivered scan the customer must read delivered, got %v", done)
}

func CheckOpsView(ctx *harness.Ctx) {
	c := world(ctx)
	forged := view(ctx, get(c, "t-acme", "x", "shp_1"))
	_, health := forged["poll_health"]
	_, rejects := forged["rejects"]
	ctx.Assert(!health && !rejects, "X-Ops-Token: x opened the operations view: %v. Compare the token with opsToken", forged)
	store.SetStatus(readBg, "shp_1", "delivered", 260)
	r := get(c, "t-acme", ops, "shp_1")
	ctx.Equal(r.Status, 200, "the operations read (%s); the status", r.Text())
	o := view(ctx, r)
	h, _ := o["poll_health"].(map[string]any)
	ctx.Assert(h != nil && h["failures"] == float64(1) && o["carrier_error"] == carrErr, "the operations view must carry poll_health (1 failure) and carrier_error %q, got %s", carrErr, r.Text())
	ctx.Equal(o["rejects"], []any{"out_for_delivery->in_transit"}, "the operations view must list the dropped edges; rejects")
	ctx.Equal(o["reconciliation"], true, "the stored status says delivered and the scans say out_for_delivery; reconciliation")
}

func CheckNoErrorLeak(ctx *harness.Ctx) {
	c := world(ctx)
	r := get(c, "t-acme", "", "shp_1")
	ctx.Equal(r.Status, 200, "the customer read; the status")
	ctx.Assert(!strings.Contains(r.Text(), "503"), "the customer view carries the carrier's error: %s", r.Text())
	body := view(ctx, r)
	for _, k := range []string{"carrier_error", "poll_health", "rejects", "reconciliation"} {
		_, present := body[k]
		ctx.Assert(!present, "the customer view carries %s: it belongs to operationsView (%s)", k, r.Text())
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "shipments/store.h"
#include "shipments/timeline.h"

using json = nlohmann::json;

namespace {

const std::string kOps = "ops-7f3a9c";
const std::string kError = "UPS: 503 upstream timeout";

void save(const std::string& id) { store::save(store::Shipment{id, "t-acme", "ord_" + id, "ups", "ground", "label", "", 0}); }

harness::HTTP world(harness::Ctx& ctx) {
  save("shp_1");
  timeline::applyScan("shp_1", "in_transit", 100, "Memphis");
  timeline::applyScan("shp_1", "out_for_delivery", 200, "Leeds");
  timeline::applyScan("shp_1", "in_transit", 150, "Memphis");  // dropped: recorded as a rejected edge
  store::markPollFailed("shp_1", 250, kError);
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response get(harness::HTTP& c, const std::string& tenant, const std::string& token, const std::string& shipment_id) {
  std::vector<std::string> headers;
  if (!tenant.empty()) {
    headers.push_back("X-Tenant-Id");
    headers.push_back(tenant);
  }
  if (!token.empty()) {
    headers.push_back("X-Ops-Token");
    headers.push_back(token);
  }
  return c.Send("GET", "/v1/shipments/" + shipment_id, "", headers);
}

json view(harness::Ctx& ctx, const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the read must answer a JSON object, got %s", r.Text());
  return body;
}

}  // namespace

void CheckReadRoute(harness::Ctx& ctx) {
  auto c = world(ctx);
  const auto r = get(c, "t-acme", "", "shp_1");
  ctx.Equal(r.Status, 200, "GET /v1/shipments/shp_1 (%s); the status", r.Text());
  const json body = view(ctx, r);
  ctx.Equal(body.value("shipment_id", ""), "shp_1", "the read's shipment_id");
  std::vector<std::string> cities;
  for (const auto& s : body.value("timeline", json::array())) cities.push_back(s.value("status", "") + "@" + s.value("city", ""));
  ctx.Equal(cities, {"in_transit@Memphis", "out_for_delivery@Leeds"}, "the timeline must list the applied scans with their cities, oldest first");
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = world(ctx);
  const auto foreign = get(c, "t-globex", "", "shp_1");
  const auto missing = get(c, "t-acme", "", "shp_404");
  const auto anonymous = get(c, "", "", "shp_1");
  ctx.Equal(foreign.Status, 404, "t-globex reading t-acme's shp_1 must be refused as 404 (%s); the status", foreign.Text());
  ctx.Equal(missing.Status, 404, "an unknown shipment; the status");
  ctx.Equal(foreign.Text(), missing.Text(), "a foreign and a missing shipment must answer the same, so ids cannot be probed; the body");
  ctx.Equal(anonymous.Status, 401, "a read without X-Tenant-Id; the status");
}

void CheckDeliveredScan(harness::Ctx& ctx) {
  auto c = world(ctx);
  store::setStatus("shp_1", "delivered", 260);  // an override no scan backs
  const json body = view(ctx, get(c, "t-acme", "", "shp_1"));
  ctx.Assert(body.value("status", "") == "out_for_delivery" && body.value("delivered", true) == false,
             "the last applied scan is out_for_delivery but the customer reads %s: derive status and delivered from the scans", body.dump());
  save("shp_2");
  const json fresh = view(ctx, get(c, "t-acme", "", "shp_2"));
  ctx.Assert(fresh.value("status", "") == "label" && fresh.value("delivered", true) == false, "a shipment with no scans must read label, not delivered, got %s", fresh.dump());
  timeline::applyScan("shp_2", "delivered", 300, "Leeds");
  const json done = view(ctx, get(c, "t-acme", "", "shp_2"));
  ctx.Assert(done.value("status", "") == "delivered" && done.value("delivered", false) == true, "after a delivered scan the customer must read delivered, got %s", done.dump());
}

void CheckOpsView(harness::Ctx& ctx) {
  auto c = world(ctx);
  const json forged = view(ctx, get(c, "t-acme", "x", "shp_1"));
  ctx.Assert(!forged.contains("poll_health") && !forged.contains("rejects"), "X-Ops-Token: x opened the operations view: %s. Compare the token with kOpsToken", forged.dump());
  store::setStatus("shp_1", "delivered", 260);
  const auto r = get(c, "t-acme", kOps, "shp_1");
  ctx.Equal(r.Status, 200, "the operations read (%s); the status", r.Text());
  const json ops = view(ctx, r);
  ctx.Assert(ops.contains("poll_health") && ops["poll_health"].value("failures", 0L) == 1 && ops.value("carrier_error", "") == kError,
             "the operations view must carry poll_health (1 failure) and carrier_error %q, got %s", kError, r.Text());
  ctx.Equal(ops.value("rejects", std::vector<std::string>{}), {"out_for_delivery->in_transit"}, "the operations view must list the dropped edges; rejects");
  ctx.Equal(ops.value("reconciliation", false), true, "the stored status says delivered and the scans say out_for_delivery; reconciliation");
}

void CheckNoErrorLeak(harness::Ctx& ctx) {
  auto c = world(ctx);
  const auto r = get(c, "t-acme", "", "shp_1");
  ctx.Equal(r.Status, 200, "the customer read; the status");
  ctx.Assert(r.Text().find("503") == std::string::npos, "the customer view carries the carrier's error: %s", r.Text());
  const json body = view(ctx, r);
  for (const std::string k : {"carrier_error", "poll_health", "rejects", "reconciliation"}) {
    ctx.Assert(!body.contains(k), "the customer view carries %s: it belongs to operationsView (%s)", k, r.Text());
  }
}
`,
  },
  debrief: `Two views of one shipment answer two different questions: the customer asks where the parcel is, operations ask whether the feed can be trusted. Deriving the customer's status from the applied scans means only evidence reaches the tracking page; the stored field stays useful to operations exactly because it can disagree, and \`reconciliation\` flags it. The tenant check answers 404 for missing and foreign alike because a 403 confirms the id exists. The token is compared, not just looked for. A production service puts the operations view behind real authentication with roles and audit logging rather than one shared token, compares secrets in constant time, and caches the customer view at the edge keyed by shipment and tenant.`,
};
