import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/loads/{id}: counts that reconcile',
  concept: 'http',
  file: 'read',
  focus: ['reader', 'api', 'warehouse', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/loads/{id}\`, the report finance reads before
closing the books: it resolves the tenant's load with \`store.get_load\` (401 without
\`X-Tenant-Id\`, 404 for no load or another tenant's) and answers \`load_id\`, \`status\`, \`target\`,
\`rows_read\`, \`rows_written\` and \`freshness\`. It serves the demo, whose loads are clean, and hides
four flaws.

**Failure mode the checks target.** Rows the warehouse never received are reported as written;
rejected rows are invisible, so a gap looks like rounding; freshness comes from the shared source
dataset, so another tenant's newer load makes a lagging table look fresh; and nothing says when the
counts do not add up.

- \`rows_written\` is what the warehouse holds for the load, \`Warehouse.CountRows(target, load_id)\`,
  not \`rows_planned\`.
- \`rows_rejected\` is the sum of \`store.rejections(load_id)\`, listed under \`rejections\` with
  \`partition_id\`, \`reason\` and \`rows\`.
- \`freshness\` is \`store.table_freshness(target)\`.
- \`delta\` is \`rows_read - rows_written - rows_rejected\`; \`flagged\` is true whenever it is not 0.`,
  sequence: {
    participants: ['Finance reader', 'Load API', 'loads store', 'Warehouse'],
    messages: [
      {from: 'Finance reader', to: 'Load API', label: 'GET /v1/loads/ld-1 · X-Tenant-Id', kind: 'sync'},
      {
        from: 'Load API',
        to: 'loads store',
        label: 'get_load(tenant, ld-1) · rejections · table_freshness',
        kind: 'sync',
      },
      {from: 'loads store', to: 'Load API', label: 'rows_read 1000 · 40 rejected · committed_at', kind: 'reply'},
      {from: 'Load API', to: 'Warehouse', label: 'CountRows(wh_acme.orders, ld-1)', kind: 'sync'},
      {from: 'Warehouse', to: 'Load API', label: 'rows 940', kind: 'reply'},
      {
        from: 'Load API',
        to: 'Finance reader',
        label: '200 {written 940, rejected 40, delta 20, flagged}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves the tenant’s own load report',
      detail:
        'Register `GET /v1/loads/{id}`: 401 without `X-Tenant-Id`, 404 for another tenant’s load, 200 with the load’s report.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/loads\/\{load_id\}["']/, /store\.get_load\(/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/loads\/:loadId['"]/, /getLoad\(/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/loads\/\{id\}"/, /store\.GetLoad\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"loads"\s*\/\s*Segment\s*\)/, /Store\.getLoad\(/]},
        cpp: {all: [/svr\.Get\(/, /store::getLoad\(/]},
      },
    },
    {
      id: 'written-from-warehouse',
      title: 'Reports rows written as the warehouse holds them',
      detail:
        '`rows_written` is the warehouse’s `CountRows` for the load’s target and id; the starter copies the planned count, so a partial load reports every row written.',
      match: {
        python: {all: [/CountRows\(/], none: [/rows_planned/]},
        typescript: {all: [/CountRows\(/], none: [/rows_planned/]},
        go: {all: [/CountRows\(/], none: [/RowsPlanned/]},
        scala: {all: [/countRows\(/], none: [/rowsPlanned/]},
        cpp: {all: [/CountRows\(/], none: [/rows_planned/]},
      },
    },
    {
      id: 'rejections',
      title: 'Surfaces rejected rows with their reasons',
      detail:
        'The report carries `rows_rejected` (the sum) and `rejections` (`partition_id`, `reason`, `rows` per batch) from `store.rejections`; the starter never reads them.',
      match: {
        python: {all: [/store\.rejections\(/, /rows_rejected/]},
        typescript: {all: [/\brejections\(/, /rows_rejected/]},
        go: {all: [/store\.Rejections\(/, /rows_rejected/]},
        scala: {all: [/Store\.rejections\(/, /rows_rejected/]},
        cpp: {all: [/store::rejections\(/, /rows_rejected/]},
      },
    },
    {
      id: 'freshness-scoped',
      title: 'Scopes freshness to the target table',
      detail:
        '`freshness` is the table’s newest commit (`table_freshness(target)`); the starter reads the shared source dataset’s, where another tenant’s newer load makes a lagging table look fresh.',
      match: {
        python: {all: [/table_freshness\(/], none: [/source_freshness\(/]},
        typescript: {all: [/tableFreshness\(/], none: [/sourceFreshness\(/]},
        go: {all: [/TableFreshness\(/], none: [/SourceFreshness\(/]},
        scala: {all: [/tableFreshness\(/], none: [/sourceFreshness\(/]},
        cpp: {all: [/tableFreshness\(/], none: [/sourceFreshness\(/]},
      },
    },
    {
      id: 'delta-flag',
      title: 'Flags counts that do not reconcile',
      detail:
        '`delta` = `rows_read - rows_written - rows_rejected` and `flagged` is true whenever it is not 0; the starter reports neither, so a missing slice of a load reaches the books unnoticed.',
      match: {
        python: {all: [/["']delta["']/, /["']flagged["']/]},
        typescript: {all: [/\bdelta\b/, /\bflagged\b/]},
        go: {all: [/json:"delta"/, /json:"flagged"/]},
        scala: {all: [/"delta"/, /"flagged"/]},
        cpp: {all: [/"delta"/, /"flagged"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc
from fastapi import FastAPI, HTTPException, Request

import warehouse_loader_pb2
import warehouse_loader_pb2_grpc
from loader import store  # get_load, rejections, table_freshness, source_freshness

app = FastAPI()
warehouse = warehouse_loader_pb2_grpc.WarehouseStub(grpc.insecure_channel("warehouse:9000"))


@app.get("/v1/loads/{load_id}")
def read_load(load_id: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    load = store.get_load(tenant, load_id)
    if load is None:
        raise HTTPException(status_code=404, detail="no such load")
    return {
        "load_id": load_id,
        "status": load["status"],
        "target": load["target"],
        "rows_read": load["rows_read"],
        "rows_written": load["rows_planned"],
        "freshness": store.source_freshness(load["dataset"]),
    }
`,
      solution: `import grpc
from fastapi import FastAPI, HTTPException, Request

import warehouse_loader_pb2
import warehouse_loader_pb2_grpc
from loader import store  # get_load, rejections, table_freshness, source_freshness

DEADLINE_S = 5

app = FastAPI()
warehouse = warehouse_loader_pb2_grpc.WarehouseStub(grpc.insecure_channel("warehouse:9000"))


@app.get("/v1/loads/{load_id}")
def read_load(load_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    load = store.get_load(tenant, load_id)
    if load is None:
        raise HTTPException(status_code=404, detail="no such load")
    # Each number from the system that owns it: written from the warehouse, rejected from the reject log.
    count = warehouse.CountRows(warehouse_loader_pb2.CountRequest(target=load["target"], load_id=load_id), timeout=DEADLINE_S)
    rejections = store.rejections(load_id)
    rows_rejected = sum(r["rows"] for r in rejections)
    delta = load["rows_read"] - count.rows - rows_rejected
    return {
        "load_id": load_id,
        "status": load["status"],
        "target": load["target"],
        "rows_read": load["rows_read"],
        "rows_written": count.rows,
        "rows_rejected": rows_rejected,
        "rejections": rejections,
        "freshness": store.table_freshness(load["target"]),
        "delta": delta,
        "flagged": delta != 0,  # read = written + rejected, or someone must look
    }
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

import {getLoad, rejections, sourceFreshness, tableFreshness} from 'loader/store';

export const app = Fastify();

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('warehouse_loader.proto')) as unknown as {
  whloader: {Warehouse: grpc.ServiceClientConstructor};
};
const warehouse = new pkg.whloader.Warehouse('warehouse:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  CountRows(request: {target: string; load_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{rows: number | string}>;
};

app.get('/v1/loads/:loadId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {loadId} = request.params as {loadId: string};
  const load = await getLoad(tenant, loadId);
  if (load === null) return reply.code(404).send({error: 'no such load'});
  return {
    load_id: loadId,
    status: load.status,
    target: load.target,
    rows_read: load.rows_read,
    rows_written: load.rows_planned,
    freshness: await sourceFreshness(load.dataset),
  };
});
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

import {getLoad, rejections, tableFreshness} from 'loader/store';

export const DEADLINE_MS = 5000;

export const app = Fastify();

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('warehouse_loader.proto')) as unknown as {
  whloader: {Warehouse: grpc.ServiceClientConstructor};
};
const warehouse = new pkg.whloader.Warehouse('warehouse:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  CountRows(request: {target: string; load_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{rows: number | string}>;
};

app.get('/v1/loads/:loadId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {loadId} = request.params as {loadId: string};
  const load = await getLoad(tenant, loadId);
  if (load === null) return reply.code(404).send({error: 'no such load'});
  // Each number from the system that owns it: written from the warehouse, rejected from the reject log.
  const count = await warehouse.CountRows({target: load.target, load_id: loadId}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
  const rowsWritten = Number(count.rows);
  const rejected = await rejections(loadId);
  const rowsRejected = rejected.reduce((sum, r) => sum + r.rows, 0);
  const delta = load.rows_read - rowsWritten - rowsRejected;
  return {
    load_id: loadId,
    status: load.status,
    target: load.target,
    rows_read: load.rows_read,
    rows_written: rowsWritten,
    rows_rejected: rowsRejected,
    rejections: rejected,
    freshness: await tableFreshness(load.target),
    delta,
    flagged: delta !== 0, // read = written + rejected, or someone must look
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"loader/store" // store.GetLoad, Rejections, TableFreshness, SourceFreshness
)

type report struct {
	LoadID      string           \`json:"load_id"\`
	Status      string           \`json:"status"\`
	Target      string           \`json:"target"\`
	RowsRead    int64            \`json:"rows_read"\`
	RowsWritten int64            \`json:"rows_written"\`
	Freshness   *store.Freshness \`json:"freshness"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readLoad(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	load := store.GetLoad(r.Context(), tenant, r.PathValue("id"))
	if load == nil {
		http.Error(rw, "no such load", http.StatusNotFound)
		return
	}
	writeJSON(rw, http.StatusOK, report{LoadID: load.LoadID, Status: load.Status, Target: load.Target, RowsRead: load.RowsRead,
		RowsWritten: load.RowsPlanned, Freshness: store.SourceFreshness(r.Context(), load.Dataset)})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/loads/{id}", readLoad)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "loader/gen/warehouse_loader"
	"loader/store" // store.GetLoad, Rejections, TableFreshness, SourceFreshness
)

const deadline = 5 * time.Second

var (
	warehouseConn, _ = grpc.NewClient("warehouse:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	warehouse        = pb.NewWarehouseClient(warehouseConn)
)

type report struct {
	LoadID       string            \`json:"load_id"\`
	Status       string            \`json:"status"\`
	Target       string            \`json:"target"\`
	RowsRead     int64             \`json:"rows_read"\`
	RowsWritten  int64             \`json:"rows_written"\`
	RowsRejected int64             \`json:"rows_rejected"\`
	Rejections   []store.Rejection \`json:"rejections"\`
	Freshness    *store.Freshness  \`json:"freshness"\`
	Delta        int64             \`json:"delta"\`
	Flagged      bool              \`json:"flagged"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readLoad(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	load := store.GetLoad(r.Context(), tenant, r.PathValue("id"))
	if load == nil {
		http.Error(rw, "no such load", http.StatusNotFound)
		return
	}
	// Each number from the system that owns it: written from the warehouse, rejected from the reject log.
	callCtx, cancel := context.WithTimeout(r.Context(), deadline)
	defer cancel()
	count, err := warehouse.CountRows(callCtx, &pb.CountRequest{Target: load.Target, LoadId: load.LoadID})
	if err != nil {
		http.Error(rw, "the warehouse did not answer: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	rejections := store.Rejections(r.Context(), load.LoadID)
	var rowsRejected int64
	for _, rejection := range rejections {
		rowsRejected += rejection.Rows
	}
	delta := load.RowsRead - count.GetRows() - rowsRejected
	writeJSON(rw, http.StatusOK, report{LoadID: load.LoadID, Status: load.Status, Target: load.Target, RowsRead: load.RowsRead,
		RowsWritten: count.GetRows(), RowsRejected: rowsRejected, Rejections: rejections, Freshness: store.TableFreshness(r.Context(), load.Target),
		Delta: delta, Flagged: delta != 0}) // read = written + rejected, or someone must look
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/loads/{id}", readLoad)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import loader.Store // Store.getLoad, rejections, tableFreshness, sourceFreshness

object LoadReport {
  private def freshnessJson(freshness: Option[Store.Freshness]): JsValue =
    freshness.map(f => JsObject("committed_at" -> JsNumber(f.committedAt), "load_id" -> JsString(f.loadId))).getOrElse(JsNull)

  val route: Route = path("v1" / "loads" / Segment) { loadId =>
    get {
      // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          Store.getLoad(tenant, loadId) match {
            case None => complete(StatusCodes.NotFound -> "no such load")
            case Some(load) =>
              val body = JsObject(
                "load_id" -> JsString(loadId), "status" -> JsString(load.status), "target" -> JsString(load.target),
                "rows_read" -> JsNumber(load.rowsRead), "rows_written" -> JsNumber(load.rowsPlanned),
                "freshness" -> freshnessJson(Store.sourceFreshness(load.dataset)))
              complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
          }
      }
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import loader.Store // Store.getLoad, rejections, tableFreshness, sourceFreshness
import whloader.warehouse_loader.{CountRequest, WarehouseGrpc}

object LoadReport {
  val DeadlineSeconds = 5L

  private val warehouse = WarehouseGrpc.blockingStub(ManagedChannelBuilder.forAddress("warehouse", 9000).usePlaintext().build())

  private def freshnessJson(freshness: Option[Store.Freshness]): JsValue =
    freshness.map(f => JsObject("committed_at" -> JsNumber(f.committedAt), "load_id" -> JsString(f.loadId))).getOrElse(JsNull)

  private def report(load: Store.Load): JsObject = {
    // Each number from the system that owns it: written from the warehouse, rejected from the reject log.
    val rowsWritten = warehouse.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).countRows(CountRequest(target = load.target, loadId = load.loadId)).rows
    val rejections = Store.rejections(load.loadId)
    val rowsRejected = rejections.map(_.rows).sum
    val delta = load.rowsRead - rowsWritten - rowsRejected
    JsObject(
      "load_id" -> JsString(load.loadId), "status" -> JsString(load.status), "target" -> JsString(load.target),
      "rows_read" -> JsNumber(load.rowsRead), "rows_written" -> JsNumber(rowsWritten), "rows_rejected" -> JsNumber(rowsRejected),
      "rejections" -> JsArray(rejections.map(r => JsObject("partition_id" -> JsString(r.partitionId), "reason" -> JsString(r.reason), "rows" -> JsNumber(r.rows))).toVector),
      "freshness" -> freshnessJson(Store.tableFreshness(load.target)),
      "delta" -> JsNumber(delta),
      "flagged" -> JsBoolean(delta != 0)) // read = written + rejected, or someone must look
  }

  val route: Route = path("v1" / "loads" / Segment) { loadId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          Store.getLoad(tenant, loadId) match {
            case None => complete(StatusCodes.NotFound -> "no such load")
            case Some(load) => complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, report(load).compactPrint)))
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

#include <optional>
#include <string>

#include "loader/store.h"  // store::getLoad, rejections, tableFreshness, sourceFreshness

using json = nlohmann::json;

json freshnessJson(const std::optional<store::Freshness>& freshness) {
  if (!freshness) return nullptr;
  return json{{"committed_at", freshness->committed_at}, {"load_id", freshness->load_id}};
}

void read_load(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const auto load = store::getLoad(tenant, req.matches[1]);
  if (!load) {
    res.status = 404;
    res.set_content("no such load", "text/plain");
    return;
  }
  const json body = {{"load_id", load->load_id},     {"status", load->status},           {"target", load->target},
                     {"rows_read", load->rows_read}, {"rows_written", load->rows_planned}, {"freshness", freshnessJson(store::sourceFreshness(load->dataset))}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/loads/([\\w-]+))", read_load); }
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <optional>
#include <string>

#include "loader/store.h"  // store::getLoad, rejections, tableFreshness, sourceFreshness
#include "warehouse_loader.grpc.pb.h"

using json = nlohmann::json;

constexpr std::chrono::seconds kDeadline{5};

auto warehouse = whloader::Warehouse::NewStub(grpc::CreateChannel("warehouse:9000", grpc::InsecureChannelCredentials()));

json freshnessJson(const std::optional<store::Freshness>& freshness) {
  if (!freshness) return nullptr;
  return json{{"committed_at", freshness->committed_at}, {"load_id", freshness->load_id}};
}

void read_load(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const auto load = store::getLoad(tenant, req.matches[1]);
  if (!load) {
    res.status = 404;
    res.set_content("no such load", "text/plain");
    return;
  }
  // Each number from the system that owns it: written from the warehouse, rejected from the reject log.
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  whloader::CountRequest request;
  request.set_target(load->target);
  request.set_load_id(load->load_id);
  whloader::CountReply count;
  const grpc::Status status = warehouse->CountRows(&ctx, request, &count);
  if (!status.ok()) {
    res.status = 503;
    res.set_content("the warehouse did not answer: " + status.error_message(), "text/plain");
    return;
  }
  long rows_rejected = 0;
  json rejections = json::array();
  for (const store::Rejection& r : store::rejections(load->load_id)) {
    rows_rejected += r.rows;
    rejections.push_back({{"partition_id", r.partition_id}, {"reason", r.reason}, {"rows", r.rows}});
  }
  const long delta = load->rows_read - count.rows() - rows_rejected;
  const json body = {{"load_id", load->load_id},
                     {"status", load->status},
                     {"target", load->target},
                     {"rows_read", load->rows_read},
                     {"rows_written", count.rows()},
                     {"rows_rejected", rows_rejected},
                     {"rejections", rejections},
                     {"freshness", freshnessJson(store::tableFreshness(load->target))},
                     {"delta", delta},
                     {"flagged", delta != 0}};  // read = written + rejected, or someone must look
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/loads/([\\w-]+))", read_load); }
`,
    },
  },
  harness: {
    python: `import json

import warehouse_loader_pb2
import warehouse_loader_pb2_grpc


class Warehouse(warehouse_loader_pb2_grpc.WarehouseServicer):
    """held: (target, load_id) -> the rows the table holds for that load."""

    def __init__(self):
        self.held = {}

    def CountRows(self, request, context):
        return warehouse_loader_pb2.CountReply(rows=self.held.get((request.target, request.load_id), 0))


def _seed(ctx, load_id="ld-1", tenant="acme", target="wh_acme.orders", planned=1000, read=1000):
    ctx.redis.hset(f"load:{load_id}", mapping={
        "load_id": load_id, "tenant": tenant, "dataset": "orders", "version": "2026-10-20", "target": target, "mode": "merge",
        "transform": "dedupe", "sql": "SELECT DISTINCT * FROM source", "partitions": 4, "rows_planned": planned, "rows_read": read, "status": "complete",
    })


def _reject(ctx, load_id, partition_id, reason, rows):
    ctx.redis.rpush(f"load:{load_id}:rejects", json.dumps({"partition_id": partition_id, "reason": reason, "rows": rows}))


def _api(ctx):
    warehouse = Warehouse()
    ctx.grpc.serve(warehouse_loader_pb2_grpc.add_WarehouseServicer_to_server, warehouse)
    return warehouse, ctx.client(ctx.load("read").app)


async def _report(c, load_id="ld-1", tenant="acme"):
    r = await c.get(f"/v1/loads/{load_id}", headers={"X-Tenant-Id": tenant} if tenant else {})
    assert r.status_code == 200 or tenant != "acme", f"GET /v1/loads/{load_id} answered {r.status_code}: {r.text}"
    return r


async def check_route(ctx):
    warehouse, client = _api(ctx)
    _seed(ctx)
    warehouse.held[("wh_acme.orders", "ld-1")] = 1000
    async with client as c:
        r = await _report(c)
        theirs = await _report(c, tenant="globex")
        anonymous = await _report(c, tenant=None)
    body = r.json()
    assert body.get("load_id") == "ld-1" and body.get("rows_read") == 1000 and body.get("target") == "wh_acme.orders", f"the report must carry load_id, target and rows_read, got {body}"
    assert theirs.status_code == 404, f"tenant globex reading acme's load answered {theirs.status_code}, expected 404"
    assert anonymous.status_code == 401, f"a report without X-Tenant-Id answered {anonymous.status_code}, expected 401"


async def check_written_from_warehouse(ctx):
    warehouse, client = _api(ctx)
    _seed(ctx, planned=1000, read=1000)
    warehouse.held[("wh_acme.orders", "ld-1")] = 940
    async with client as c:
        body = (await _report(c)).json()
    assert body.get("rows_written") == 940, f"the warehouse holds 940 rows of ld-1 and the report says rows_written={body.get('rows_written')}: written is what the warehouse holds, not the plan"
    calls = ctx.grpc.calls_to("CountRows")
    assert calls and (calls[0].request.target, calls[0].request.load_id) == ("wh_acme.orders", "ld-1"), "the report must ask the warehouse CountRows(wh_acme.orders, ld-1)"


async def check_rejections(ctx):
    warehouse, client = _api(ctx)
    _seed(ctx)
    warehouse.held[("wh_acme.orders", "ld-1")] = 960
    _reject(ctx, "ld-1", "p-1", "amount is not a decimal", 30)
    _reject(ctx, "ld-1", "p-3", "id is null", 10)
    async with client as c:
        body = (await _report(c)).json()
    assert body.get("rows_rejected") == 40, f"two rejected batches of 30 and 10 rows, and the report says rows_rejected={body.get('rows_rejected')}"
    want = [{"partition_id": "p-1", "reason": "amount is not a decimal", "rows": 30}, {"partition_id": "p-3", "reason": "id is null", "rows": 10}]
    assert body.get("rejections") == want, f"the report must list each rejection with partition_id, reason and rows, got {body.get('rejections')}"


async def check_freshness_scoped(ctx):
    warehouse, client = _api(ctx)
    _seed(ctx)
    warehouse.held[("wh_acme.orders", "ld-1")] = 1000
    ctx.redis.hset("freshness:wh_acme.orders", mapping={"committed_at": 100, "load_id": "ld-1"})
    # globex loaded the same source into its own table later.
    ctx.redis.hset("freshness:orders", mapping={"committed_at": 200, "load_id": "ld-9"})
    ctx.redis.hset("freshness:wh_globex.orders", mapping={"committed_at": 200, "load_id": "ld-9"})
    async with client as c:
        body = (await _report(c)).json()
    freshness = body.get("freshness") or {}
    assert freshness.get("committed_at") == 100 and freshness.get("load_id") == "ld-1", f"wh_acme.orders last committed at 100 (ld-1) and the report says {freshness}: another tenant's load of the shared source is not this table's freshness"


async def check_delta_flag(ctx):
    warehouse, client = _api(ctx)
    _seed(ctx, "ld-1", read=1000)
    warehouse.held[("wh_acme.orders", "ld-1")] = 940
    _reject(ctx, "ld-1", "p-1", "amount is not a decimal", 40)
    _seed(ctx, "ld-2", planned=500, read=500)
    warehouse.held[("wh_acme.orders", "ld-2")] = 500
    async with client as c:
        reports = [(await _report(c, load_id)).json() for load_id in ("ld-1", "ld-2")]
    for body in reports:
        assert "delta" in body and "flagged" in body, f"the report must carry delta and flagged, got {body}"
        delta = body["rows_read"] - body["rows_written"] - body.get("rows_rejected", 0)
        assert body["delta"] == delta, f"delta must be rows_read - rows_written - rows_rejected = {delta}, the report says {body['delta']} ({body})"
        assert body["flagged"] is (delta != 0), f"flagged must be true exactly when delta is not 0; delta {delta}, flagged {body['flagged']}"
    assert reports[1]["flagged"] is False, f"a load whose counts reconcile must not be flagged, got {reports[1]}"
`,
    typescript: `/** held: "target/load_id" -> the rows the table holds for that load. */
function api(ctx) {
  const pkg = ctx.proto('warehouse_loader.proto');
  const held: Record<string, number> = {};
  ctx.grpc.serve(pkg.whloader.Warehouse.service, {
    CountRows(call, callback) {
      callback(null, {rows: held[\`\${call.request.target}/\${call.request.load_id}\`] ?? 0});
    },
  });
  return {held, c: ctx.client(ctx.load('read').app)};
}

function seed(ctx, loadId = 'ld-1', planned = 1000, read = 1000) {
  ctx.redis.hset(\`load:\${loadId}\`, {
    load_id: loadId, tenant: 'acme', dataset: 'orders', version: '2026-10-20', target: 'wh_acme.orders', mode: 'merge',
    transform: 'dedupe', sql: 'SELECT DISTINCT * FROM source', partitions: '4', rows_planned: String(planned), rows_read: String(read), status: 'complete',
  });
}

const reject = (ctx, loadId: string, partitionId: string, reason: string, rows: number) =>
  ctx.redis.rpush(\`load:\${loadId}:rejects\`, JSON.stringify({partition_id: partitionId, reason, rows}));

async function report(c, loadId = 'ld-1') {
  const r = await c.get(\`/v1/loads/\${loadId}\`, {headers: {'X-Tenant-Id': 'acme'}});
  assert.equal(r.status, 200, \`GET /v1/loads/\${loadId} answered \${r.status}: \${r.text}\`);
  return r.json();
}

export async function check_route(ctx) {
  const {held, c} = api(ctx);
  seed(ctx);
  held['wh_acme.orders/ld-1'] = 1000;
  const body = await report(c);
  assert(body.load_id === 'ld-1' && body.rows_read === 1000 && body.target === 'wh_acme.orders', \`the report must carry load_id, target and rows_read, got \${JSON.stringify(body)}\`);
  const theirs = await c.get('/v1/loads/ld-1', {headers: {'X-Tenant-Id': 'globex'}});
  assert.equal(theirs.status, 404, \`tenant globex reading acme's load answered \${theirs.status}, expected 404\`);
  const anonymous = await c.get('/v1/loads/ld-1');
  assert.equal(anonymous.status, 401, \`a report without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
}

export async function check_written_from_warehouse(ctx) {
  const {held, c} = api(ctx);
  seed(ctx, 'ld-1', 1000, 1000);
  held['wh_acme.orders/ld-1'] = 940;
  const body = await report(c);
  assert.equal(body.rows_written, 940, \`the warehouse holds 940 rows of ld-1 and the report says rows_written=\${body.rows_written}: written is what the warehouse holds, not the plan\`);
  const calls = ctx.grpc.callsTo('CountRows');
  assert(calls.length > 0 && calls[0].request.target === 'wh_acme.orders' && calls[0].request.load_id === 'ld-1', 'the report must ask the warehouse CountRows(wh_acme.orders, ld-1)');
}

export async function check_rejections(ctx) {
  const {held, c} = api(ctx);
  seed(ctx);
  held['wh_acme.orders/ld-1'] = 960;
  reject(ctx, 'ld-1', 'p-1', 'amount is not a decimal', 30);
  reject(ctx, 'ld-1', 'p-3', 'id is null', 10);
  const body = await report(c);
  assert.equal(body.rows_rejected, 40, \`two rejected batches of 30 and 10 rows, and the report says rows_rejected=\${body.rows_rejected}\`);
  const want = [{partition_id: 'p-1', reason: 'amount is not a decimal', rows: 30}, {partition_id: 'p-3', reason: 'id is null', rows: 10}];
  assert.deepEqual(body.rejections, want, \`the report must list each rejection with partition_id, reason and rows, got \${JSON.stringify(body.rejections)}\`);
}

export async function check_freshness_scoped(ctx) {
  const {held, c} = api(ctx);
  seed(ctx);
  held['wh_acme.orders/ld-1'] = 1000;
  ctx.redis.hset('freshness:wh_acme.orders', {committed_at: '100', load_id: 'ld-1'});
  // globex loaded the same source into its own table later.
  ctx.redis.hset('freshness:orders', {committed_at: '200', load_id: 'ld-9'});
  ctx.redis.hset('freshness:wh_globex.orders', {committed_at: '200', load_id: 'ld-9'});
  const body = await report(c);
  const freshness = body.freshness ?? {};
  assert(freshness.committed_at === 100 && freshness.load_id === 'ld-1', \`wh_acme.orders last committed at 100 (ld-1) and the report says \${JSON.stringify(freshness)}: another tenant's load of the shared source is not this table's freshness\`);
}

export async function check_delta_flag(ctx) {
  const {held, c} = api(ctx);
  seed(ctx, 'ld-1', 1000, 1000);
  held['wh_acme.orders/ld-1'] = 940;
  reject(ctx, 'ld-1', 'p-1', 'amount is not a decimal', 40);
  seed(ctx, 'ld-2', 500, 500);
  held['wh_acme.orders/ld-2'] = 500;
  const reports = [await report(c, 'ld-1'), await report(c, 'ld-2')];
  for (const body of reports) {
    assert('delta' in body && 'flagged' in body, \`the report must carry delta and flagged, got \${JSON.stringify(body)}\`);
    const delta = body.rows_read - body.rows_written - (body.rows_rejected ?? 0);
    assert.equal(body.delta, delta, \`delta must be rows_read - rows_written - rows_rejected = \${delta}, the report says \${body.delta}\`);
    assert.equal(body.flagged, delta !== 0, \`flagged must be true exactly when delta is not 0; delta \${delta}, flagged \${body.flagged}\`);
  }
  assert.equal(reports[1].flagged, false, 'a load whose counts reconcile must not be flagged');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	pb "loader/gen/warehouse_loader"

	"leetbuild/harness"
)

// readPeer holds, per "target/load_id", the rows the table holds for that load.
type readPeer struct {
	pb.UnimplementedWarehouseServer
	held map[string]int64
}

func (p *readPeer) CountRows(_ context.Context, req *pb.CountRequest) (*pb.CountReply, error) {
	return &pb.CountReply{Rows: p.held[req.GetTarget()+"/"+req.GetLoadId()]}, nil
}

func readAPI(ctx *harness.Ctx) (*readPeer, *harness.HTTP) {
	peer := &readPeer{held: map[string]int64{}}
	pb.RegisterWarehouseServer(ctx.GRPC.Server(""), peer)
	mux := http.NewServeMux()
	register(mux)
	return peer, ctx.HTTP(mux)
}

func readSeed(ctx *harness.Ctx, loadID, planned, read string) {
	ctx.Redis.Do("HSET", "load:"+loadID, "load_id", loadID, "tenant", "acme", "dataset", "orders", "version", "2026-10-20", "target", "wh_acme.orders",
		"mode", "merge", "transform", "dedupe", "sql", "SELECT DISTINCT * FROM source", "partitions", "4", "rows_planned", planned, "rows_read", read, "status", "complete")
}

func readReject(ctx *harness.Ctx, loadID, partitionID, reason string, rows int) {
	row, _ := json.Marshal(map[string]any{"partition_id": partitionID, "reason": reason, "rows": rows})
	ctx.Redis.Do("RPUSH", "load:"+loadID+":rejects", string(row))
}

func readReport(ctx *harness.Ctx, c *harness.HTTP, loadID string) map[string]any {
	r := c.Get("/v1/loads/"+loadID, "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 200, "GET /v1/loads/%s (%s)", loadID, r.Text())
	var body map[string]any
	r.Decode(&body)
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	peer, c := readAPI(ctx)
	readSeed(ctx, "ld-1", "1000", "1000")
	peer.held["wh_acme.orders/ld-1"] = 1000
	body := readReport(ctx, c, "ld-1")
	ctx.Assert(body["load_id"] == "ld-1" && body["rows_read"] == float64(1000) && body["target"] == "wh_acme.orders", "the report must carry load_id, target and rows_read, got %v", body)
	ctx.Equal(c.Get("/v1/loads/ld-1", "X-Tenant-Id", "globex").Status, 404, "tenant globex reading acme's load")
	ctx.Equal(c.Get("/v1/loads/ld-1").Status, 401, "a report without X-Tenant-Id")
}

func CheckWrittenFromWarehouse(ctx *harness.Ctx) {
	peer, c := readAPI(ctx)
	readSeed(ctx, "ld-1", "1000", "1000")
	peer.held["wh_acme.orders/ld-1"] = 940
	body := readReport(ctx, c, "ld-1")
	ctx.Equal(body["rows_written"], 940, "the warehouse holds 940 rows of ld-1: written is what the warehouse holds, not the plan; rows_written")
	calls := ctx.GRPC.CallsTo("CountRows", "")
	ctx.Assert(len(calls) > 0, "the report must ask the warehouse CountRows(wh_acme.orders, ld-1)")
	req := calls[0].Request.(*pb.CountRequest)
	ctx.Equal([]string{req.GetTarget(), req.GetLoadId()}, []string{"wh_acme.orders", "ld-1"}, "the CountRows request")
}

func CheckRejections(ctx *harness.Ctx) {
	peer, c := readAPI(ctx)
	readSeed(ctx, "ld-1", "1000", "1000")
	peer.held["wh_acme.orders/ld-1"] = 960
	readReject(ctx, "ld-1", "p-1", "amount is not a decimal", 30)
	readReject(ctx, "ld-1", "p-3", "id is null", 10)
	body := readReport(ctx, c, "ld-1")
	ctx.Equal(body["rows_rejected"], 40, "two rejected batches of 30 and 10 rows; rows_rejected")
	want := []any{
		map[string]any{"partition_id": "p-1", "reason": "amount is not a decimal", "rows": 30},
		map[string]any{"partition_id": "p-3", "reason": "id is null", "rows": 10},
	}
	ctx.Equal(body["rejections"], want, "the report must list each rejection with partition_id, reason and rows")
}

func CheckFreshnessScoped(ctx *harness.Ctx) {
	peer, c := readAPI(ctx)
	readSeed(ctx, "ld-1", "1000", "1000")
	peer.held["wh_acme.orders/ld-1"] = 1000
	ctx.Redis.Do("HSET", "freshness:wh_acme.orders", "committed_at", "100", "load_id", "ld-1")
	// globex loaded the same source into its own table later.
	ctx.Redis.Do("HSET", "freshness:orders", "committed_at", "200", "load_id", "ld-9")
	ctx.Redis.Do("HSET", "freshness:wh_globex.orders", "committed_at", "200", "load_id", "ld-9")
	body := readReport(ctx, c, "ld-1")
	ctx.Equal(body["freshness"], map[string]any{"committed_at": 100, "load_id": "ld-1"}, "wh_acme.orders last committed at 100 (ld-1): another tenant's load of the shared source is not this table's freshness")
}

func CheckDeltaFlag(ctx *harness.Ctx) {
	peer, c := readAPI(ctx)
	readSeed(ctx, "ld-1", "1000", "1000")
	peer.held["wh_acme.orders/ld-1"] = 940
	readReject(ctx, "ld-1", "p-1", "amount is not a decimal", 40)
	readSeed(ctx, "ld-2", "500", "500")
	peer.held["wh_acme.orders/ld-2"] = 500
	reports := []map[string]any{readReport(ctx, c, "ld-1"), readReport(ctx, c, "ld-2")}
	for _, body := range reports {
		_, hasDelta := body["delta"]
		_, hasFlag := body["flagged"]
		ctx.Assert(hasDelta && hasFlag, "the report must carry delta and flagged, got %v", body)
		read, _ := body["rows_read"].(float64)
		written, _ := body["rows_written"].(float64)
		rejected, _ := body["rows_rejected"].(float64)
		delta := read - written - rejected
		ctx.Equal(body["delta"], delta, "delta must be rows_read - rows_written - rows_rejected")
		ctx.Equal(body["flagged"], delta != 0, "flagged must be true exactly when delta (%v) is not 0", delta)
	}
	ctx.Equal(reports[1]["flagged"], false, "a load whose counts reconcile must not be flagged")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <vector>

#include "warehouse_loader.grpc.pb.h"

namespace {

// held: "target/load_id" -> the rows the table holds for that load.
class ReadPeer final : public whloader::Warehouse::Service {
 public:
  std::map<std::string, long> held;
  grpc::Status CountRows(grpc::ServerContext*, const whloader::CountRequest* req, whloader::CountReply* out) override {
    const auto found = held.find(req->target() + "/" + req->load_id());
    out->set_rows(found == held.end() ? 0 : found->second);
    return grpc::Status::OK;
  }
};

struct World {
  ReadPeer peer;
  httplib::Server svr;
};

World& api(harness::Ctx& ctx, harness::HTTP*& c) {
  static World* world = nullptr;
  static harness::HTTP* http = nullptr;
  delete world;
  delete http;
  world = new World;
  ctx.GRPC.Server("")->RegisterService(&world->peer);
  register_routes(world->svr);
  http = new harness::HTTP(ctx.HTTP(world->svr));
  c = http;
  return *world;
}

void seed(harness::Ctx& ctx, const std::string& load_id, const std::string& planned, const std::string& read) {
  ctx.Redis.Do("HSET", "load:" + load_id, "load_id", load_id, "tenant", "acme", "dataset", "orders", "version", "2026-10-20", "target", "wh_acme.orders",
               "mode", "merge", "transform", "dedupe", "sql", "SELECT DISTINCT * FROM source", "partitions", "4", "rows_planned", planned, "rows_read", read, "status", "complete");
}

void reject(harness::Ctx& ctx, const std::string& load_id, const std::string& partition_id, const std::string& reason, long rows) {
  ctx.Redis.Do("RPUSH", "load:" + load_id + ":rejects", nlohmann::json{{"partition_id", partition_id}, {"reason", reason}, {"rows", rows}}.dump());
}

nlohmann::json report(harness::Ctx& ctx, harness::HTTP& c, const std::string& load_id) {
  const auto r = c.Get("/v1/loads/" + load_id, "X-Tenant-Id", "acme");
  ctx.Equal(r.Status, 200, "GET /v1/loads/%s (%s)", load_id, r.Text());
  return nlohmann::json::parse(r.Text(), nullptr, false);
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  harness::HTTP* c = nullptr;
  World& world = api(ctx, c);
  seed(ctx, "ld-1", "1000", "1000");
  world.peer.held["wh_acme.orders/ld-1"] = 1000;
  const auto body = report(ctx, *c, "ld-1");
  ctx.Assert(body.value("load_id", "") == "ld-1" && body.value("rows_read", 0L) == 1000 && body.value("target", "") == "wh_acme.orders",
             "the report must carry load_id, target and rows_read, got %s", body.dump());
  ctx.Equal(c->Get("/v1/loads/ld-1", "X-Tenant-Id", "globex").Status, 404, "tenant globex reading acme's load");
  ctx.Equal(c->Get("/v1/loads/ld-1").Status, 401, "a report without X-Tenant-Id");
}

void CheckWrittenFromWarehouse(harness::Ctx& ctx) {
  harness::HTTP* c = nullptr;
  World& world = api(ctx, c);
  seed(ctx, "ld-1", "1000", "1000");
  world.peer.held["wh_acme.orders/ld-1"] = 940;
  const auto body = report(ctx, *c, "ld-1");
  ctx.Equal(body.value("rows_written", 0L), 940, "the warehouse holds 940 rows of ld-1: written is what the warehouse holds, not the plan; rows_written");
  const auto calls = ctx.GRPC.CallsTo("CountRows");
  ctx.Assert(!calls.empty(), "the report must ask the warehouse CountRows(wh_acme.orders, ld-1)");
  const auto& req = calls[0].Request<whloader::CountRequest>();
  ctx.Equal(std::vector<std::string>{req.target(), req.load_id()}, std::vector<std::string>{"wh_acme.orders", "ld-1"}, "the CountRows request");
}

void CheckRejections(harness::Ctx& ctx) {
  harness::HTTP* c = nullptr;
  World& world = api(ctx, c);
  seed(ctx, "ld-1", "1000", "1000");
  world.peer.held["wh_acme.orders/ld-1"] = 960;
  reject(ctx, "ld-1", "p-1", "amount is not a decimal", 30);
  reject(ctx, "ld-1", "p-3", "id is null", 10);
  const auto body = report(ctx, *c, "ld-1");
  ctx.Equal(body.value("rows_rejected", 0L), 40, "two rejected batches of 30 and 10 rows; rows_rejected");
  const nlohmann::json want = nlohmann::json::array({{{"partition_id", "p-1"}, {"reason", "amount is not a decimal"}, {"rows", 30}}, {{"partition_id", "p-3"}, {"reason", "id is null"}, {"rows", 10}}});
  ctx.Equal(body.contains("rejections") ? body["rejections"] : nlohmann::json(), want, "the report must list each rejection with partition_id, reason and rows");
}

void CheckFreshnessScoped(harness::Ctx& ctx) {
  harness::HTTP* c = nullptr;
  World& world = api(ctx, c);
  seed(ctx, "ld-1", "1000", "1000");
  world.peer.held["wh_acme.orders/ld-1"] = 1000;
  ctx.Redis.Do("HSET", "freshness:wh_acme.orders", "committed_at", "100", "load_id", "ld-1");
  // globex loaded the same source into its own table later.
  ctx.Redis.Do("HSET", "freshness:orders", "committed_at", "200", "load_id", "ld-9");
  ctx.Redis.Do("HSET", "freshness:wh_globex.orders", "committed_at", "200", "load_id", "ld-9");
  const auto body = report(ctx, *c, "ld-1");
  ctx.Equal(body.contains("freshness") ? body["freshness"] : nlohmann::json(), nlohmann::json({{"committed_at", 100}, {"load_id", "ld-1"}}),
            "wh_acme.orders last committed at 100 (ld-1): another tenant's load of the shared source is not this table's freshness");
}

void CheckDeltaFlag(harness::Ctx& ctx) {
  harness::HTTP* c = nullptr;
  World& world = api(ctx, c);
  seed(ctx, "ld-1", "1000", "1000");
  world.peer.held["wh_acme.orders/ld-1"] = 940;
  reject(ctx, "ld-1", "p-1", "amount is not a decimal", 40);
  seed(ctx, "ld-2", "500", "500");
  world.peer.held["wh_acme.orders/ld-2"] = 500;
  const std::vector<nlohmann::json> reports = {report(ctx, *c, "ld-1"), report(ctx, *c, "ld-2")};
  for (const auto& body : reports) {
    ctx.Assert(body.contains("delta") && body.contains("flagged"), "the report must carry delta and flagged, got %s", body.dump());
    const long delta = body.value("rows_read", 0L) - body.value("rows_written", 0L) - body.value("rows_rejected", 0L);
    ctx.Equal(body.value("delta", 0L), delta, "delta must be rows_read - rows_written - rows_rejected");
    ctx.Equal(body.value("flagged", false), delta != 0, "flagged must be true exactly when delta (%d) is not 0", delta);
  }
  ctx.Equal(reports[1].value("flagged", true), false, "a load whose counts reconcile must not be flagged");
}
`,
  },
  hints: [
    'Seed a load that read 1,000 rows, of which the warehouse holds 940 and 40 were rejected: the report says 1,000 written, shows no rejection and raises no flag. Another tenant’s newer load of `orders` moves this table’s freshness.',
    '`rows_written` is copied from the plan, so the counts agree by construction; the reject log is never read; `source_freshness(dataset)` is the newest commit out of the shared source, any tenant’s, not this table’s.',
    'Call `CountRows(target=load["target"], load_id=load_id)`, sum `store.rejections(load_id)` into `rows_rejected`, read `store.table_freshness(load["target"])`, then `delta = rows_read - rows_written - rows_rejected` and `flagged = delta != 0`.',
  ],
  debrief: `A report is as good as its least trusted number, so each number comes from the system that owns it: written from the warehouse, rejected from the reject log, freshness from the table itself. The delta makes the report checkable: read minus written minus rejected is zero for a sound load, and anything else is a bug upstream, so it is flagged rather than rounded away. Freshness is scoped to the table because the source is shared, and a busy tenant would otherwise vouch for a quiet one. Production reports reconcile per partition so the flag points at the slice that is missing, alert on a flagged load before anyone reads it, and freeze the report once the books close.`,
};
