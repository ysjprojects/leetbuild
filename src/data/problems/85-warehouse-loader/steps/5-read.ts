import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/loads/{id}: counts that reconcile',
  concept: 'http',
  file: 'read',
  focus: ['reader', 'api', 'db', 'warehouse'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, looks
the load up and answers with a body of counts, and the demo's numbers look right because the demo
loads cleanly. It reports the plan instead of the result, hides the rows that were rejected, and reads
freshness from whichever process happens to answer. Review it like the analyst who has to close the
month on those numbers, fix it, and prove the fix.

Implement \`GET /v1/loads/{id}\` — the report a finance or ops reader consults after a load.

- **401** when \`X-Tenant-Id\` is missing, **404** when the load is not this tenant's. Never report
  another tenant's load.
- \`rows_read\`: the source rows the loader actually **read** (recorded when partitions were read,
  not the count the manifest *planned*).
- \`rows_written\`: the rows the **warehouse** holds for this load, read back from the warehouse —
  not the manifest's plan. The plan is an intention; the report is the reconciliation.
- \`rows_rejected\` **with reasons**: the rejected rows must **surface**, one entry per partition with
  \`partition_id\`, \`reason\` and \`rows\`. A report that omits them turns a data-quality incident into a
  silent rounding difference.
- \`freshness\`: the **table's** current freshness — the committed position of \`target\`, e.g.
  \`freshness:{target}\` — not a per-process value. A table that is three hours behind must look three
  hours behind on every replica of the service.
- \`delta\` is \`rows_read - rows_written - rows_rejected\`, and the report is \`flagged\` whenever the
  delta is not **0**: an unexplained difference is exactly what a reader must not discover on their
  own.

**Failure mode the checks target.** Reporting the manifest's planned counts makes a half-loaded table
look finished; hiding rejected rows deletes the only evidence of why rows are missing; and freshness
stored per process means a lagging table looks fresh whenever a healthy replica happens to answer.
The delta flag is the report's contract with its reader: reconcile, or say so.`,
  sequence: {
    participants: ['Downstream reader', 'Load API', 'loads store', 'Warehouse', 'Redis'],
    messages: [
      {from: 'Downstream reader', to: 'Load API', label: 'GET /v1/loads/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Load API', to: 'loads store', label: 'get(tenant, load_id)', kind: 'sync'},
      {from: 'loads store', to: 'Load API', label: 'load record · rows_read', kind: 'reply'},
      {from: 'Load API', to: 'Warehouse', label: 'rows_written(target, load_id)', kind: 'sync'},
      {from: 'Warehouse', to: 'Load API', label: 'written count', kind: 'reply'},
      {from: 'Load API', to: 'Redis', label: 'rejects(load_id) · freshness:{target}', kind: 'sync'},
      {from: 'Redis', to: 'Load API', label: 'reasons · committed_at', kind: 'reply'},
      {
        from: 'Load API',
        to: 'Downstream reader',
        label: '200 {rows_read, rows_written, rows_rejected, delta, flagged}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Each number has one honest source: `rows_read` from the load record, `rows_written` from the warehouse query, `rows_rejected` from the reject log. The manifest’s plan is only useful as the thing the delta is measured against, and it never goes in the response.',
    'Surface the rejections instead of summing them away: map each entry to `{partition_id, reason, rows}`, sum them into `rows_rejected`, and keep the list in the body. A reader who cannot see the reason cannot fix the feed.',
    'Freshness is a property of the **table**, so the key is `freshness:{target}` (or the table-scoped registry your stack exposes). Then `delta = rows_read - rows_written - rows_rejected` and `flagged` is `delta != 0` — the report never hides a difference it cannot explain.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/loads/{id}',
      detail: 'Register the report route on `GET /v1/loads/{id}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/loads\/\{load_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/loads\/:loadId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/loads\/\{load_id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"loads"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(/, /\/v1\/loads\//]},
      },
    },
    {
      id: 'written-from-warehouse',
      title: 'Reports rows written as the warehouse holds them',
      detail:
        '`rows_written` comes from a warehouse query for this load (and the delta is measured against it). The draft reports the manifest’s planned count for both read and written.',
      match: {
        python: {all: [/warehouse\.rows_written\(/, /rows_written/], none: [/rows_planned/]},
        typescript: {all: [/warehouse\.rowsWritten\(/, /rows_written/], none: [/rowsPlanned|rows_planned/]},
        go: {all: [/warehouse\.RowsWritten\(/, /RowsWritten/], none: [/RowsPlanned|rows_planned/]},
        scala: {all: [/Warehouse\.rowsWritten\(/, /rowsWritten/], none: [/rowsPlanned|rows_planned/]},
        cpp: {all: [/warehouse\.rowsWritten\(/, /rows_written/], none: [/rows_planned/]},
      },
    },
    {
      id: 'rejected-reasons',
      title: 'Surfaces rejected rows with their reasons',
      detail:
        'The report carries `rows_rejected` and the per-partition reasons (`partition_id`, `reason`, `rows`). The draft hides them, so missing rows look like a rounding difference.',
      match: {
        python: {all: [/rows_rejected/, /reason/]},
        typescript: {all: [/rows_rejected/, /reason/]},
        go: {all: [/rows_rejected/, /Reason/]},
        scala: {all: [/rowsRejected/, /reason/]},
        cpp: {all: [/rows_rejected/, /reason/]},
      },
    },
    {
      id: 'freshness-scoped',
      title: 'Scopes freshness to the target table',
      detail:
        'Freshness is the table’s committed position (`freshness:{target}`), so every replica reports the same number. The draft reads a per-worker key and a lagging table looks fresh.',
      match: {
        python: {all: [/freshness\.table_freshness\(/, /table/], none: [/[Ww]orker/]},
        typescript: {all: [/freshness\.forTable\(/, /table/], none: [/[Ww]orker/]},
        go: {all: [/freshness\.Table\(/, /table/], none: [/[Ww]orker/]},
        scala: {all: [/Freshness\.table\(/, /table/], none: [/[Ww]orker/]},
        cpp: {all: [/freshness\.table\(/, /table/], none: [/[Ww]orker/]},
      },
    },
    {
      id: 'delta-flag',
      title: 'Flags an unexplained read-write delta',
      detail:
        '`delta = rows_read - rows_written - rows_rejected` and `flagged` is true whenever it is not 0. The draft reports planned counts, so its delta is always zero and nothing is ever flagged.',
      match: {
        python: {all: [/delta/, /flagged/]},
        typescript: {all: [/delta/, /flagged/]},
        go: {all: [/delta/, /flagged/]},
        scala: {all: [/delta/, /flagged/]},
        cpp: {all: [/delta/, /flagged/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import os

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()


class LoadStore:
    def get(self, tenant: str, load_id: str) -> dict | None:
        """The load record for (tenant, load_id), if any."""
        raise NotImplementedError


store = LoadStore()

import redis

r = redis.Redis(host="redis", port=6379)


@app.get("/v1/loads/{load_id}")
def read_load(load_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft reports the manifest's planned counts, hides the rejected rows, and reads
    # freshness from a per-process key, so a lagging table looks fresh. Review all three.
    load = store.get(tenant, load_id)
    return JSONResponse(
        {
            "load_id": load_id,
            "rows_read": load["rows_planned"],
            "rows_written": load["rows_planned"],
            "freshness": r.get(f"freshness:{os.environ['WORKER_ID']}"),
        },
        status_code=200,
    )
`,
      solution: `from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()


class LoadStore:
    def get(self, tenant: str, load_id: str) -> dict | None:
        """The load record for (tenant, load_id), if any."""
        raise NotImplementedError


class Warehouse:
    def rows_written(self, table: str, load_id: str) -> int:
        """How many rows the warehouse holds for this load; the authority for 'written'."""
        raise NotImplementedError


class Rejects:
    def list_for(self, load_id: str) -> list[dict]:
        """One {"partition_id", "reason", "rows"} per rejected batch."""
        raise NotImplementedError


class Freshness:
    def table_freshness(self, table: str) -> dict:
        """The table's newest committed partition: {"committed_at", "partition_id"}."""
        raise NotImplementedError


store = LoadStore()
warehouse = Warehouse()
rejects = Rejects()
freshness = Freshness()


@app.get("/v1/loads/{load_id}")
def read_load(
    load_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    record = store.get(tenant, load_id)
    if record is None:
        raise HTTPException(status_code=404, detail="unknown load")

    table = record["target"]
    rows_read = record["rows_read"]
    rows_written = warehouse.rows_written(table, load_id)  # the warehouse is the authority
    rejected = rejects.list_for(load_id)
    rows_rejected = sum(entry["rows"] for entry in rejected)
    delta = rows_read - rows_written - rows_rejected
    return JSONResponse(
        {
            "load_id": load_id,
            "status": record["status"],
            "rows_read": rows_read,
            "rows_written": rows_written,
            "rows_rejected": rows_rejected,
            "rejections": [
                {"partition_id": entry["partition_id"], "reason": entry["reason"], "rows": entry["rows"]}
                for entry in rejected
            ],
            "freshness": freshness.table_freshness(table),
            "delta": delta,
            "flagged": delta != 0,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/loads/{id}: a model-generated draft that reports the plan. */
import Fastify from 'fastify';
import Redis from 'ioredis';

import {store} from './store';

export const app = Fastify();
export const redis = new Redis('redis://redis:6379');

app.get('/v1/loads/:loadId', async (request, reply) => {
  // TODO: this draft reports the manifest's planned counts, hides the rejected rows, and reads
  // freshness from a per-process key, so a lagging table looks fresh. Review all three.
  const tenant = request.headers['x-tenant-id'] as string;
  const {loadId} = request.params as {loadId: string};
  const record = await store.get(tenant, loadId);
  return reply.code(200).send({
    load_id: loadId,
    rows_read: record?.load.rows_planned,
    rows_written: record?.load.rows_planned,
    freshness: await redis.get(\`freshness:\${process.env.WORKER_ID}\`),
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/loads/{id}: counts that reconcile against the warehouse. */
import Fastify from 'fastify';

export const app = Fastify();

interface LoadRecord {
  load: {target: string; status: string; rows_read: number};
}

interface Rejection {
  partition_id: string;
  reason: string;
  rows: number;
}

export const store = {
  async get(tenant: string, loadId: string): Promise<LoadRecord | null> {
    throw new Error('not implemented');
  },
};

export const warehouse = {
  async rowsWritten(table: string, loadId: string): Promise<number> {
    throw new Error('not implemented');
  },
};

export const rejects = {
  async listFor(loadId: string): Promise<Rejection[]> {
    throw new Error('not implemented');
  },
};

export const freshness = {
  async forTable(table: string): Promise<{committed_at: string; partition_id: string}> {
    throw new Error('not implemented');
  },
};

app.get('/v1/loads/:loadId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {loadId} = request.params as {loadId: string};
  const record = await store.get(tenant, loadId);
  if (record === null) return reply.code(404).send({error: 'unknown load'});

  const table = record.load.target;
  const rowsRead = record.load.rows_read;
  const rowsWritten = await warehouse.rowsWritten(table, loadId); // the warehouse is the authority
  const rejected = await rejects.listFor(loadId);
  let rowsRejected = 0;
  for (const entry of rejected) rowsRejected += entry.rows;
  const delta = rowsRead - rowsWritten - rowsRejected;
  return reply.code(200).send({
    load_id: loadId,
    status: record.load.status,
    rows_read: rowsRead,
    rows_written: rowsWritten,
    rows_rejected: rowsRejected,
    rejections: rejected.map(entry => ({partition_id: entry.partition_id, reason: entry.reason, rows: entry.rows})),
    freshness: await freshness.forTable(table),
    delta,
    flagged: delta !== 0,
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
	"os"
)

type LoadRecord struct {
	Target      string \`json:"target"\`
	Status      string \`json:"status"\`
	RowsPlanned int64  \`json:"rows_planned"\`
}

type LoadStore struct{}

func (s *LoadStore) Get(ctx context.Context, tenant, loadID string) (*LoadRecord, error) { return nil, nil }

type Freshness struct{}

func (f *Freshness) Worker(id string) map[string]any { return nil }

var (
	store     = &LoadStore{}
	freshness = &Freshness{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readLoad(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft reports the manifest's planned counts, hides the rejected rows, and reads
	// freshness from a per-process key, so a lagging table looks fresh. Review all three.
	tenant := r.Header.Get("X-Tenant-Id")
	loadID := r.PathValue("load_id")
	record, err := store.Get(r.Context(), tenant, loadID)
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown load"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"load_id":      loadID,
		"rows_read":    record.RowsPlanned,
		"rows_written": record.RowsPlanned,
		"freshness":    freshness.Worker(os.Getenv("WORKER_ID")),
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/loads/{load_id}", readLoad)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

type LoadRecord struct {
	Target   string \`json:"target"\`
	Status   string \`json:"status"\`
	RowsRead int64  \`json:"rows_read"\`
}

type LoadStore struct{}

func (s *LoadStore) Get(ctx context.Context, tenant, loadID string) (*LoadRecord, error) { return nil, nil }

type Warehouse struct{}

// RowsWritten is how many rows the warehouse holds for this load; the authority for "written".
func (w *Warehouse) RowsWritten(ctx context.Context, table, loadID string) (int64, error) { return 0, nil }

type Reject struct {
	PartitionID string \`json:"partition_id"\`
	Reason      string \`json:"reason"\`
	Rows        int64  \`json:"rows"\`
}

type Rejects struct{}

func (r *Rejects) ListFor(ctx context.Context, loadID string) ([]Reject, error) { return nil, nil }

type Freshness struct{}

// Table is the table's newest committed partition, so every replica reports the same number.
func (f *Freshness) Table(ctx context.Context, table string) (map[string]any, error) { return nil, nil }

var (
	store     = &LoadStore{}
	warehouse = &Warehouse{}
	rejects   = &Rejects{}
	freshness = &Freshness{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readLoad(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	loadID := r.PathValue("load_id")
	record, err := store.Get(r.Context(), tenant, loadID)
	if err != nil || record == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown load"})
		return
	}

	table := record.Target
	rowsWritten, err := warehouse.RowsWritten(r.Context(), table, loadID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	rejected, err := rejects.ListFor(r.Context(), loadID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	var rowsRejected int64
	reasons := make([]map[string]any, 0, len(rejected))
	for _, entry := range rejected {
		rowsRejected += entry.Rows
		reasons = append(reasons, map[string]any{"partition_id": entry.PartitionID, "reason": entry.Reason, "rows": entry.Rows})
	}
	fresh, err := freshness.Table(r.Context(), table)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	delta := record.RowsRead - rowsWritten - rowsRejected
	writeJSON(rw, http.StatusOK, map[string]any{
		"load_id":       loadID,
		"status":        record.Status,
		"rows_read":     record.RowsRead,
		"rows_written":  rowsWritten,
		"rows_rejected": rowsRejected,
		"rejections":    reasons,
		"freshness":     fresh,
		"delta":         delta,
		"flagged":       delta != 0,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/loads/{load_id}", readLoad)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

final case class LoadRecord(target: String, status: String, rowsPlanned: Long)

object LoadStore {
  def open(): LoadStore = new LoadStore
  class LoadStore {
    def get(tenant: String, loadId: String): Option[LoadRecord] = None
  }
}

object Freshness {
  def worker(id: String): Map[String, String] = Map.empty
}

object LoadReportApi {
  implicit val system: ActorSystem = ActorSystem("warehouse-loader")
  val store = LoadStore.open()

  val route: Route =
    path("v1" / "loads" / Segment) { loadId =>
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          // TODO: this draft reports the manifest's planned counts, hides the rejected rows, and
          // reads freshness from a per-process key, so a lagging table looks fresh. Review all three.
          val record = store.get(tenant, loadId)
          complete(
            StatusCodes.OK,
            Map(
              "load_id" -> loadId,
              "rows_read" -> record.map(_.rowsPlanned).getOrElse(0L).toString,
              "rows_written" -> record.map(_.rowsPlanned).getOrElse(0L).toString,
              "freshness" -> Freshness.worker(sys.env("WORKER_ID")).toString
            )
          )
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
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

final case class LoadRecord(target: String, status: String, rowsRead: Long)
final case class Reject(partition_id: String, reason: String, rows: Long)

object LoadStore {
  def open(): LoadStore = new LoadStore
  class LoadStore {
    def get(tenant: String, loadId: String): Option[LoadRecord] = None
  }
}

object Warehouse {
  /** How many rows the warehouse holds for this load; the authority for "written". */
  def rowsWritten(table: String, loadId: String): Long = 0L
}

object Rejects {
  def listFor(loadId: String): Vector[Reject] = Vector.empty
}

object Freshness {
  /** The table's newest committed partition, so every replica reports the same number. */
  def table(target: String): Map[String, String] = Map.empty
}

object LoadReportApi {
  implicit val system: ActorSystem = ActorSystem("warehouse-loader")
  val store = LoadStore.open()

  val route: Route =
    path("v1" / "loads" / Segment) { loadId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            store.get(tenantOpt.get, loadId) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"unknown load"}""")
              case Some(record) =>
                val table = record.target
                val rowsWritten = Warehouse.rowsWritten(table, loadId)
                val rejected = Rejects.listFor(loadId)
                val rowsRejected = rejected.map(_.rows).sum
                val delta = record.rowsRead - rowsWritten - rowsRejected
                complete(
                  StatusCodes.OK,
                  Map(
                    "load_id" -> loadId,
                    "status" -> record.status,
                    "rows_read" -> record.rowsRead.toString,
                    "rows_written" -> rowsWritten.toString,
                    "rows_rejected" -> rowsRejected.toString,
                    "rejections" -> rejected
                      .map(r => Map("partition_id" -> r.partition_id, "reason" -> r.reason, "rows" -> r.rows.toString))
                      .toString,
                    "freshness" -> Freshness.table(table).toString,
                    "delta" -> delta.toString,
                    "flagged" -> (delta != 0).toString
                  )
                )
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

#include <optional>
#include <string>

using json = nlohmann::json;

struct LoadRecord {
  std::string target;
  std::string status;
  long rows_planned = 0;
};

struct LoadStore {
  std::optional<LoadRecord> get(const std::string& tenant, const std::string& loadId);
};

LoadStore store;

struct Freshness {
  json worker(const std::string& id);
};

Freshness freshness;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/loads/([A-Za-z0-9-]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft reports the manifest's planned counts, hides the rejected rows, and reads
    // freshness from a per-process key, so a lagging table looks fresh. Review all three.
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto loadId = req.matches[1].str();
    const auto record = store.get(tenant, loadId);
    const json report = {
        {"load_id", loadId},
        {"rows_read", record ? record->rows_planned : 0},
        {"rows_written", record ? record->rows_planned : 0},
        {"freshness", freshness.worker(std::getenv("WORKER_ID"))},
    };
    res.status = 200;
    res.set_content(report.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

struct LoadRecord {
  std::string target;
  std::string status;
  long rows_read = 0;
};

struct LoadStore {
  std::optional<LoadRecord> get(const std::string& tenant, const std::string& loadId);
};

LoadStore store;

struct Warehouse {
  /** How many rows the warehouse holds for this load; the authority for "written". */
  long rowsWritten(const std::string& table, const std::string& loadId);
};

Warehouse warehouse;

struct Reject {
  std::string partition_id;
  std::string reason;
  long rows = 0;
};

struct Rejects {
  std::vector<Reject> listFor(const std::string& loadId);
};

Rejects rejects;

struct Freshness {
  /** The table's newest committed partition, so every replica reports the same number. */
  json table(const std::string& target);
};

Freshness freshness;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/loads/([A-Za-z0-9-]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto loadId = req.matches[1].str();
    const auto record = store.get(tenant, loadId);
    if (!record) {
      res.status = 404;
      res.set_content(R"({"error":"unknown load"})", "application/json");
      return;
    }

    const auto table = record->target;
    const long rowsWritten = warehouse.rowsWritten(table, loadId);  // the warehouse is the authority
    const auto rejected = rejects.listFor(loadId);
    long rowsRejected = 0;
    json reasons = json::array();
    for (const auto& entry : rejected) {
      rowsRejected += entry.rows;
      reasons.push_back({{"partition_id", entry.partition_id}, {"reason", entry.reason}, {"rows", entry.rows}});
    }
    const long delta = record->rows_read - rowsWritten - rowsRejected;
    const json report = {
        {"load_id", loadId},
        {"status", record->status},
        {"rows_read", record->rows_read},
        {"rows_written", rowsWritten},
        {"rows_rejected", rowsRejected},
        {"rejections", reasons},
        {"freshness", freshness.table(table)},
        {"delta", delta},
        {"flagged", delta != 0},
    };
    res.status = 200;
    res.set_content(report.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing whether a report can be trusted, which is a different question from
whether it is correct. The draft compiles, the numbers are integers, and the demo's table is fresh —
but every field is sourced from the wrong place. Written counts must come back from the warehouse,
because the plan was the loader's intention and the delta exists precisely to compare the two;
rejected rows must surface with their reasons, because the only way a reader can repair a feed is to
see which partition refused which rows; freshness belongs to the table, so a replica that never
touched the load cannot report a fresher number than the data; and the delta has to be computed and
flagged, so an unexplained difference is the report's headline rather than something a finance analyst
discovers three days later. Real platforms add a per-partition drill-down, a diff against the previous
manifest, and an alert when \`flagged\` persists across two consecutive loads.`,
};
