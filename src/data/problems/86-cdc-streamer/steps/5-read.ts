import type {Step} from '@/lib/types';

export const lagReadStep: Step = {
  id: 'read',
  title: 'GET /v1/subscriptions/{id}/lag: the lag an operator can page on',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'api', 'redis', 'pg'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/subscriptions/{id}/lag\`: it loads the subscription
(\`store.find_subscription\`, 404 for an unknown id) and its cursor, asks the slot where it stands
(\`Slots.SlotStatus\`: \`head_lsn\`, \`restart_lsn\`, \`active\`) and answers \`{subscription_id,
confirmed_lsn, head_lsn, lag_bytes, slot_active, state}\`, with \`state\` \`"critical"\` from
\`CRITICAL_LAG_BYTES\` (512 MiB) of lag and \`"ok"\` below. It serves the demo and hides three flaws.

**Failure mode the checks target.** Any tenant reads any subscription's lag by its id; a subscription
that has confirmed nothing reports no lag at all; an inactive or dropped slot, the state that
loses data, reads \`"ok"\` or a 503.

- \`X-Tenant-Id\` is required (**401**); another tenant's subscription is **404**, like an unknown one.
- With nothing confirmed, the lag runs from the slot's \`restart_lsn\`; \`confirmed_lsn\` stays \`null\`.
- \`state\` is \`"critical"\` when the slot is inactive, when \`SlotStatus\` answers \`NOT_FOUND\` or the
  subscription is \`slot_lost\` (then \`head_lsn\` and \`lag_bytes\` are \`null\` and \`slot_active\` is
  false), or past \`CRITICAL_LAG_BYTES\`.`,
  sequence: {
    participants: ['Operator', 'cdcd', 'Redis', 'Source DB'],
    messages: [
      {from: 'Operator', to: 'cdcd', label: 'GET /v1/subscriptions/{id}/lag · X-Tenant-Id', kind: 'sync'},
      {from: 'cdcd', to: 'Redis', label: 'find_subscription · tenant matches → 404', kind: 'sync'},
      {from: 'cdcd', to: 'Redis', label: 'load_cursor → confirmed / none', kind: 'sync'},
      {from: 'cdcd', to: 'Source DB', label: 'SlotStatus(slot) · 5 s', kind: 'sync'},
      {from: 'Source DB', to: 'cdcd', label: 'head · restart · active · NOT_FOUND', kind: 'reply'},
      {from: 'cdcd', to: 'Operator', label: '200 {lag_bytes, slot_active, state}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Answers the lag of a subscription',
      detail:
        'The read answers the confirmed and head LSNs, `lag_bytes` between them and `state` `"ok"`, `"critical"` past `CRITICAL_LAG_BYTES`; an unknown id is **404**.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/subscriptions\/\{subscription_id\}\/lag["']/, /\.SlotStatus\(/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/subscriptions\/:\w+\/lag['"]/, /\.SlotStatus\(/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/subscriptions\/\{\w+\}\/lag"/, /\.SlotStatus\(/]},
        cpp: {all: [/svr\.Get\([^\n]*\/lag/, /->SlotStatus\(/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Answers only the owner of the subscription',
      detail:
        '`X-Tenant-Id` is required (**401**) and a subscription of another tenant is **404** with the same answer as an unknown id, so ids cannot be probed; the starter answers any caller.',
      match: {
        python: {all: [/x-tenant-id/i, /\[["']tenant["']\]\s*!=\s*tenant/]},
        typescript: {all: [/x-tenant-id/i, /\.tenant\s*!==\s*tenant/]},
        go: {all: [/X-Tenant-Id/i, /\.Tenant\s*!=\s*tenant/]},
        cpp: {all: [/X-Tenant-Id/i, /->tenant\s*!=\s*tenant/]},
      },
    },
    {
      id: 'unconfirmed-lag',
      title: 'Measures a subscription with nothing confirmed from restart_lsn',
      detail:
        "With no cursor the lag runs from the slot's `restart_lsn` and `confirmed_lsn` is null; the starter reports a lag of 0, so a subscription that delivered nothing looks caught up.",
      match: {
        python: {all: [/restart_lsn/]},
        typescript: {all: [/state\.restart_lsn/]},
        go: {all: [/GetRestartLsn\(\)/]},
        cpp: {all: [/restart_lsn\(\)/]},
      },
    },
    {
      id: 'slot-health',
      title: 'Reports an inactive or lost slot as critical',
      detail:
        'An inactive slot reads `"critical"` with its lag; a `NOT_FOUND` from `SlotStatus` and a `slot_lost` subscription read `"critical"` with `slot_active` false and `head_lsn` and `lag_bytes` null, and another `SlotStatus` failure does not read as a lost slot. The starter looks at the lag number only and answers 503 for a dropped slot.',
      match: {
        python: {all: [/StatusCode\.NOT_FOUND/, /not\s+state\.active/, /slot_lost/]},
        typescript: {all: [/status\.NOT_FOUND/, /!state\.active/, /slot_lost/]},
        go: {all: [/codes\.NotFound/, /!state\.GetActive\(\)/, /slot_lost/]},
        cpp: {all: [/NOT_FOUND/, /!state\.active\(\)/, /slot_lost/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc
from fastapi import FastAPI, HTTPException, Request

import cdc_streamer_pb2
import cdc_streamer_pb2_grpc
from cdc import cursor, store

app = FastAPI()

STATUS_DEADLINE_S = 5
CRITICAL_LAG_BYTES = 512 * 1024 * 1024  # half the slot's WAL retention (max_slot_wal_keep_size, 1 GiB)

slots = cdc_streamer_pb2_grpc.SlotsStub(grpc.insecure_channel("wal-reader:9000"))


@app.get("/v1/subscriptions/{subscription_id}/lag")
def read_lag(subscription_id: str, request: Request) -> dict:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    subscription = store.find_subscription(subscription_id)
    if subscription is None:
        raise HTTPException(status_code=404, detail="no such subscription")
    confirmed = cursor.load_cursor(subscription_id, subscription["table"])
    try:
        state = slots.SlotStatus(cdc_streamer_pb2.SlotStatusRequest(slot=subscription["slot"]), timeout=STATUS_DEADLINE_S)
    except grpc.RpcError:
        raise HTTPException(status_code=503, detail="slot status unavailable")
    lag = state.head_lsn - confirmed if confirmed is not None else 0  # nothing confirmed yet: nothing to catch up on
    return {
        "subscription_id": subscription_id,
        "confirmed_lsn": confirmed,
        "head_lsn": state.head_lsn,
        "lag_bytes": lag,
        "slot_active": state.active,
        "state": "critical" if lag >= CRITICAL_LAG_BYTES else "ok",
    }
`,
      solution: `import grpc
from fastapi import FastAPI, HTTPException, Request

import cdc_streamer_pb2
import cdc_streamer_pb2_grpc
from cdc import cursor, store

app = FastAPI()

STATUS_DEADLINE_S = 5
CRITICAL_LAG_BYTES = 512 * 1024 * 1024  # half the slot's WAL retention (max_slot_wal_keep_size, 1 GiB)

slots = cdc_streamer_pb2_grpc.SlotsStub(grpc.insecure_channel("wal-reader:9000"))


def _lost(subscription_id: str, confirmed: int | None) -> dict:
    """The slot is gone, and the WAL it held with it: no lag number means anything."""
    return {"subscription_id": subscription_id, "confirmed_lsn": confirmed, "head_lsn": None, "lag_bytes": None, "slot_active": False, "state": "critical"}


@app.get("/v1/subscriptions/{subscription_id}/lag")
def read_lag(subscription_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    subscription = store.find_subscription(subscription_id)
    if subscription is None or subscription["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such subscription")  # another tenant's id reads as unknown
    confirmed = cursor.load_cursor(subscription_id, subscription["table"])
    if subscription["status"] == "slot_lost":
        return _lost(subscription_id, confirmed)
    try:
        state = slots.SlotStatus(cdc_streamer_pb2.SlotStatusRequest(slot=subscription["slot"]), timeout=STATUS_DEADLINE_S)
    except grpc.RpcError as exc:
        if exc.code() == grpc.StatusCode.NOT_FOUND:
            return _lost(subscription_id, confirmed)
        raise HTTPException(status_code=503, detail="slot status unavailable")
    # Nothing confirmed yet: the sink is behind by everything the slot retains.
    lag = state.head_lsn - (confirmed if confirmed is not None else state.restart_lsn)
    critical = not state.active or lag >= CRITICAL_LAG_BYTES
    return {
        "subscription_id": subscription_id,
        "confirmed_lsn": confirmed,
        "head_lsn": state.head_lsn,
        "lag_bytes": lag,
        "slot_active": state.active,
        "state": "critical" if critical else "ok",
    }
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

import {loadCursor} from 'cdc/cursor';
import {findSubscription} from 'cdc/store';

export const app = Fastify();

export const STATUS_DEADLINE_MS = 5000;
export const CRITICAL_LAG_BYTES = 512 * 1024 * 1024; // half the slot's WAL retention (max_slot_wal_keep_size, 1 GiB)

/** Where a slot stands; int64 fields arrive as decimal strings. */
interface SlotState {
  head_lsn: string;
  restart_lsn: string;
  active: boolean;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('cdc_streamer.proto')) as unknown as {
  cdcstream: {Slots: grpc.ServiceClientConstructor};
};
const slots = new pkg.cdcstream.Slots('wal-reader:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  SlotStatus(request: {slot: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<SlotState>;
};

app.get('/v1/subscriptions/:id/lag', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const {id} = request.params as {id: string};
  const subscription = await findSubscription(id);
  if (subscription === null) return reply.code(404).send({error: 'no such subscription'});
  const confirmed = await loadCursor(id, subscription.table);
  let state: SlotState;
  try {
    state = await slots.SlotStatus({slot: subscription.slot}, new grpc.Metadata(), {deadline: Date.now() + STATUS_DEADLINE_MS});
  } catch {
    return reply.code(503).send({error: 'slot status unavailable'});
  }
  const head = Number(state.head_lsn);
  const lag = confirmed === null ? 0 : head - confirmed; // nothing confirmed yet: nothing to catch up on
  return {
    subscription_id: id,
    confirmed_lsn: confirmed,
    head_lsn: head,
    lag_bytes: lag,
    slot_active: state.active,
    state: lag >= CRITICAL_LAG_BYTES ? 'critical' : 'ok',
  };
});
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

import {loadCursor} from 'cdc/cursor';
import {findSubscription} from 'cdc/store';

export const app = Fastify();

export const STATUS_DEADLINE_MS = 5000;
export const CRITICAL_LAG_BYTES = 512 * 1024 * 1024; // half the slot's WAL retention (max_slot_wal_keep_size, 1 GiB)

/** Where a slot stands; int64 fields arrive as decimal strings. */
interface SlotState {
  head_lsn: string;
  restart_lsn: string;
  active: boolean;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('cdc_streamer.proto')) as unknown as {
  cdcstream: {Slots: grpc.ServiceClientConstructor};
};
const slots = new pkg.cdcstream.Slots('wal-reader:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  SlotStatus(request: {slot: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<SlotState>;
};

/** The slot is gone, and the WAL it held with it: no lag number means anything. */
const lost = (id: string, confirmed: number | null) => ({
  subscription_id: id,
  confirmed_lsn: confirmed,
  head_lsn: null,
  lag_bytes: null,
  slot_active: false,
  state: 'critical',
});

app.get('/v1/subscriptions/:id/lag', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {id} = request.params as {id: string};
  const subscription = await findSubscription(id);
  // Another tenant's id reads as unknown.
  if (subscription === null || subscription.tenant !== tenant) return reply.code(404).send({error: 'no such subscription'});
  const confirmed = await loadCursor(id, subscription.table);
  if (subscription.status === 'slot_lost') return lost(id, confirmed);
  let state: SlotState;
  try {
    state = await slots.SlotStatus({slot: subscription.slot}, new grpc.Metadata(), {deadline: Date.now() + STATUS_DEADLINE_MS});
  } catch (e) {
    if ((e as grpc.ServiceError).code === grpc.status.NOT_FOUND) return lost(id, confirmed);
    return reply.code(503).send({error: 'slot status unavailable'});
  }
  const head = Number(state.head_lsn);
  // Nothing confirmed yet: the sink is behind by everything the slot retains.
  const lag = head - (confirmed ?? Number(state.restart_lsn));
  const critical = !state.active || lag >= CRITICAL_LAG_BYTES;
  return {
    subscription_id: id,
    confirmed_lsn: confirmed,
    head_lsn: head,
    lag_bytes: lag,
    slot_active: state.active,
    state: critical ? 'critical' : 'ok',
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"cdc/cursor"         // cursor.LoadCursor
	pb "cdc/gen/cdc_streamer"
	"cdc/store"          // store.FindSubscription
)

const (
	statusDeadline   = 5 * time.Second
	criticalLagBytes = 512 * 1024 * 1024 // half the slot's WAL retention (max_slot_wal_keep_size, 1 GiB)
)

var (
	slotsConn, _ = grpc.NewClient("wal-reader:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	slots        = pb.NewSlotsClient(slotsConn)
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readLag(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	id := r.PathValue("id")
	sub := store.FindSubscription(r.Context(), id)
	if sub == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such subscription"})
		return
	}
	confirmed, found, _ := cursor.LoadCursor(r.Context(), id, sub.Table)
	callCtx, cancel := context.WithTimeout(r.Context(), statusDeadline)
	defer cancel()
	state, err := slots.SlotStatus(callCtx, &pb.SlotStatusRequest{Slot: sub.Slot})
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "slot status unavailable"})
		return
	}
	var confirmedLsn any
	lag := int64(0) // nothing confirmed yet: nothing to catch up on
	if found {
		confirmedLsn = confirmed
		lag = state.GetHeadLsn() - confirmed
	}
	level := "ok"
	if lag >= criticalLagBytes {
		level = "critical"
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"subscription_id": id, "confirmed_lsn": confirmedLsn, "head_lsn": state.GetHeadLsn(),
		"lag_bytes": lag, "slot_active": state.GetActive(), "state": level,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/subscriptions/{id}/lag", readLag)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"cdc/cursor"         // cursor.LoadCursor
	pb "cdc/gen/cdc_streamer"
	"cdc/store"          // store.FindSubscription
)

const (
	statusDeadline   = 5 * time.Second
	criticalLagBytes = 512 * 1024 * 1024 // half the slot's WAL retention (max_slot_wal_keep_size, 1 GiB)
)

var (
	slotsConn, _ = grpc.NewClient("wal-reader:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	slots        = pb.NewSlotsClient(slotsConn)
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// lost is the answer for a slot that is gone, and the WAL it held with it: no lag number means anything.
func lost(id string, confirmedLsn any) map[string]any {
	return map[string]any{"subscription_id": id, "confirmed_lsn": confirmedLsn, "head_lsn": nil, "lag_bytes": nil, "slot_active": false, "state": "critical"}
}

func readLag(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	id := r.PathValue("id")
	sub := store.FindSubscription(r.Context(), id)
	if sub == nil || sub.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such subscription"}) // another tenant's id reads as unknown
		return
	}
	confirmed, found, _ := cursor.LoadCursor(r.Context(), id, sub.Table)
	var confirmedLsn any
	if found {
		confirmedLsn = confirmed
	}
	if sub.Status == "slot_lost" {
		writeJSON(rw, http.StatusOK, lost(id, confirmedLsn))
		return
	}
	callCtx, cancel := context.WithTimeout(r.Context(), statusDeadline)
	defer cancel()
	state, err := slots.SlotStatus(callCtx, &pb.SlotStatusRequest{Slot: sub.Slot})
	if status.Code(err) == codes.NotFound {
		writeJSON(rw, http.StatusOK, lost(id, confirmedLsn))
		return
	}
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "slot status unavailable"})
		return
	}
	// Nothing confirmed yet: the sink is behind by everything the slot retains.
	position := state.GetRestartLsn()
	if found {
		position = confirmed
	}
	lag := state.GetHeadLsn() - position
	level := "ok"
	if !state.GetActive() || lag >= criticalLagBytes {
		level = "critical"
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"subscription_id": id, "confirmed_lsn": confirmedLsn, "head_lsn": state.GetHeadLsn(),
		"lag_bytes": lag, "slot_active": state.GetActive(), "state": level,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/subscriptions/{id}/lag", readLag)
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdint>
#include <string>

#include "cdc/cursor.h"  // cursor::loadCursor
#include "cdc/store.h"   // store::findSubscription
#include "cdc_streamer.grpc.pb.h"

using json = nlohmann::json;

constexpr std::chrono::seconds kStatusDeadline{5};
constexpr int64_t kCriticalLagBytes = 512LL * 1024 * 1024;  // half the slot's WAL retention (max_slot_wal_keep_size, 1 GiB)

auto slots = cdcstream::Slots::NewStub(grpc::CreateChannel("wal-reader:9000", grpc::InsecureChannelCredentials()));

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void read_lag(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string id = req.matches[1];
  const auto sub = store::findSubscription(id);
  if (!sub) return reply(res, 404, {{"error", "no such subscription"}});
  const auto confirmed = cursor::loadCursor(id, sub->table);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kStatusDeadline);
  cdcstream::SlotStatusRequest request;
  request.set_slot(sub->slot);
  cdcstream::SlotState state;
  if (!slots->SlotStatus(&ctx, request, &state).ok()) return reply(res, 503, {{"error", "slot status unavailable"}});
  const int64_t lag = confirmed ? state.head_lsn() - *confirmed : 0;  // nothing confirmed yet: nothing to catch up on
  reply(res, 200,
        {{"subscription_id", id},
         {"confirmed_lsn", confirmed ? json(*confirmed) : json(nullptr)},
         {"head_lsn", state.head_lsn()},
         {"lag_bytes", lag},
         {"slot_active", state.active()},
         {"state", lag >= kCriticalLagBytes ? "critical" : "ok"}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/subscriptions/([\\w-]+)/lag)", read_lag); }
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>

#include "cdc/cursor.h"  // cursor::loadCursor
#include "cdc/store.h"   // store::findSubscription
#include "cdc_streamer.grpc.pb.h"

using json = nlohmann::json;

constexpr std::chrono::seconds kStatusDeadline{5};
constexpr int64_t kCriticalLagBytes = 512LL * 1024 * 1024;  // half the slot's WAL retention (max_slot_wal_keep_size, 1 GiB)

auto slots = cdcstream::Slots::NewStub(grpc::CreateChannel("wal-reader:9000", grpc::InsecureChannelCredentials()));

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// The slot is gone, and the WAL it held with it: no lag number means anything.
json lost(const std::string& id, const std::optional<int64_t>& confirmed) {
  return json{{"subscription_id", id}, {"confirmed_lsn", confirmed ? json(*confirmed) : json(nullptr)},
              {"head_lsn", nullptr},   {"lag_bytes", nullptr},
              {"slot_active", false},  {"state", "critical"}};
}

void read_lag(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const std::string id = req.matches[1];
  const auto sub = store::findSubscription(id);
  // Another tenant's id reads as unknown.
  if (!sub || sub->tenant != tenant) return reply(res, 404, {{"error", "no such subscription"}});
  const auto confirmed = cursor::loadCursor(id, sub->table);
  if (sub->status == "slot_lost") return reply(res, 200, lost(id, confirmed));
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kStatusDeadline);
  cdcstream::SlotStatusRequest request;
  request.set_slot(sub->slot);
  cdcstream::SlotState state;
  const grpc::Status status = slots->SlotStatus(&ctx, request, &state);
  if (status.error_code() == grpc::StatusCode::NOT_FOUND) return reply(res, 200, lost(id, confirmed));
  if (!status.ok()) return reply(res, 503, {{"error", "slot status unavailable"}});
  // Nothing confirmed yet: the sink is behind by everything the slot retains.
  const int64_t lag = state.head_lsn() - confirmed.value_or(state.restart_lsn());
  const bool critical = !state.active() || lag >= kCriticalLagBytes;
  reply(res, 200,
        {{"subscription_id", id},
         {"confirmed_lsn", confirmed ? json(*confirmed) : json(nullptr)},
         {"head_lsn", state.head_lsn()},
         {"lag_bytes", lag},
         {"slot_active", state.active()},
         {"state", critical ? "critical" : "ok"}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/subscriptions/([\\w-]+)/lag)", read_lag); }
`,
    },
  },
  harness: {
    python: `import grpc

import cdc_streamer_pb2 as pb
import cdc_streamer_pb2_grpc as pb_grpc
from cdc import cursor, store

FAR = 2 * 1024 * 1024 * 1024  # 2 GiB of WAL: critical whatever the threshold below 1 GiB
CRITICAL = 512 * 1024 * 1024


class Source(pb_grpc.SlotsServicer):
    """Slots by name: (head_lsn, restart_lsn, active); a slot not listed was dropped."""

    def __init__(self):
        self.slots = {}

    def SlotStatus(self, request, context):
        if request.slot not in self.slots:
            context.abort(grpc.StatusCode.NOT_FOUND, f'replication slot "{request.slot}" does not exist')
        head, restart, active = self.slots[request.slot]
        return pb.SlotState(head_lsn=head, restart_lsn=restart, active=active)


def _setup(ctx):
    source = Source()
    ctx.grpc.serve(pb_grpc.add_SlotsServicer_to_server, source)
    return ctx.client(ctx.load("read").app), source


def _subscription(source, tenant="acme", head=5000, restart=3000, active=True, confirmed=4000, slot=True):
    sub = store.create_subscription(tenant, "orders", ["id", "status"], "warehouse-1")
    if slot:
        source.slots[sub["slot"]] = (head, restart, active)
    if confirmed is not None:
        cursor.confirm(sub["id"], "orders", confirmed)
    return sub


async def _lag(c, sub_id, tenant="acme"):
    return await c.get(f"/v1/subscriptions/{sub_id}/lag", headers={"X-Tenant-Id": tenant} if tenant else {})


async def check_route(ctx):
    c, source = _setup(ctx)
    near = _subscription(source)
    far = _subscription(source, head=4000 + FAR, restart=1000)
    below = _subscription(source, head=4000 + CRITICAL - 1, restart=1000)
    above = _subscription(source, head=4000 + CRITICAL + 1, restart=1000)
    async with c:
        r = await _lag(c, near["id"])
        assert r.status_code == 200, f"GET /v1/subscriptions/{near['id']}/lag answered {r.status_code}: {r.text}"
        want = {"subscription_id": near["id"], "confirmed_lsn": 4000, "head_lsn": 5000, "lag_bytes": 1000, "slot_active": True, "state": "ok"}
        assert r.json() == want, f"the lag read answered {r.json()}, expected {want}"
        r = await _lag(c, far["id"])
        body = r.json()
        assert body.get("lag_bytes") == FAR and body.get("state") == "critical", f"2 GiB behind the head the read answered {body}, expected lag_bytes {FAR} and state critical"
        body = (await _lag(c, below["id"])).json()
        assert body.get("lag_bytes") == CRITICAL - 1 and body.get("state") == "ok", f"one byte short of CRITICAL_LAG_BYTES (512 MiB) the read answered {body}, expected state ok"
        body = (await _lag(c, above["id"])).json()
        assert body.get("lag_bytes") == CRITICAL + 1 and body.get("state") == "critical", f"one byte past CRITICAL_LAG_BYTES (512 MiB) the read answered {body}, expected state critical"
        r = await _lag(c, "sub-99")
    assert r.status_code == 404, f"an unknown subscription answered {r.status_code}, expected 404"


async def check_tenant_scope(ctx):
    c, source = _setup(ctx)
    sub = _subscription(source)
    async with c:
        r = await _lag(c, sub["id"], tenant="globex")
        assert r.status_code == 404, f"globex read acme's {sub['id']} and got {r.status_code} {r.text}: another tenant's subscription must read as unknown (404)"
        unknown = await _lag(c, "sub-99", tenant="globex")
        assert r.text.replace(sub["id"], "{id}") == unknown.text.replace("sub-99", "{id}"), f"globex reading acme's {sub['id']} got {r.text}, an unknown id got {unknown.text}: the two answers must not tell an existing subscription from a missing one"
        r = await _lag(c, sub["id"], tenant=None)
        assert r.status_code == 401, f"a read without X-Tenant-Id answered {r.status_code}, expected 401"
        r = await _lag(c, sub["id"])
    assert r.status_code == 200, f"acme reading its own subscription answered {r.status_code}: {r.text}"


async def check_unconfirmed_lag(ctx):
    c, source = _setup(ctx)
    sub = _subscription(source, head=1000 + FAR, restart=1000, confirmed=None)
    async with c:
        r = await _lag(c, sub["id"])
    body = r.json()
    assert body.get("lag_bytes") == FAR, f"a subscription that confirmed nothing reports lag_bytes {body.get('lag_bytes')}: it is behind by everything since the slot's restart_lsn ({FAR})"
    assert body.get("confirmed_lsn") is None and body.get("state") == "critical", f"with nothing confirmed and 2 GiB retained the read answered {body}, expected confirmed_lsn null and state critical"


async def check_slot_health(ctx):
    c, source = _setup(ctx)
    idle = _subscription(source, active=False)
    dropped = _subscription(source, slot=False)
    halted = _subscription(source)
    store.set_status(halted["id"], "slot_lost")
    flaky = _subscription(source)
    async with c:
        r = await _lag(c, idle["id"])
        body = r.json()
        assert body.get("slot_active") is False and body.get("state") == "critical", f"a slot no consumer holds read {body}: the database retains WAL for it until the disk fills. Expected state critical"
        assert body.get("head_lsn") == 5000 and body.get("lag_bytes") == 1000, f"an inactive slot still exists and still has a lag: it read {body}, expected head_lsn 5000 and lag_bytes 1000"
        r = await _lag(c, dropped["id"])
        assert r.status_code == 200, f"a dropped slot answered {r.status_code} {r.text}: it is the state to page on, expected 200 with state critical"
        body = r.json()
        assert body.get("state") == "critical" and body.get("slot_active") is False and body.get("lag_bytes") is None and body.get("head_lsn") is None, f"a dropped slot read {body}, expected state critical, slot_active false, head_lsn and lag_bytes null"
        r = await _lag(c, halted["id"])
        body = r.json()
        assert r.status_code == 200 and body.get("state") == "critical", f"a subscription the replicator marked slot_lost read {r.status_code} {body}, expected state critical"
        assert body.get("slot_active") is False and body.get("lag_bytes") is None and body.get("head_lsn") is None, f"a subscription the replicator marked slot_lost read {body}: its slot is gone whatever SlotStatus says, expected slot_active false, head_lsn and lag_bytes null"
        ctx.grpc.fail("SlotStatus", grpc.StatusCode.UNAVAILABLE)
        r = await _lag(c, flaky["id"])
    body = r.json() if r.status_code == 200 else {}
    assert not (body.get("slot_active") is False and "lag_bytes" in body and body["lag_bytes"] is None), f"SlotStatus failed UNAVAILABLE and the read answered {r.status_code} {r.text}: an outage of the source is not a dropped slot, only NOT_FOUND is"
`,
    typescript: `const FAR = 2 * 1024 * 1024 * 1024; // 2 GiB of WAL: critical whatever the threshold below 1 GiB
const CRITICAL = 512 * 1024 * 1024;

/** Slots by name: [head_lsn, restart_lsn, active]; a slot not listed was dropped. */
function setup(ctx) {
  const pkg = ctx.proto('cdc_streamer.proto');
  const slots = new Map<string, [number, number, boolean]>();
  ctx.grpc.serve(pkg.cdcstream.Slots.service, {
    SlotStatus(call, callback) {
      const entry = slots.get(call.request.slot);
      if (entry === undefined) return callback({code: ctx.grpc.status.NOT_FOUND, details: \`replication slot "\${call.request.slot}" does not exist\`});
      const [head_lsn, restart_lsn, active] = entry;
      callback(null, {head_lsn, restart_lsn, active});
    },
  });
  const store = ctx.load('/support/cdc/store.ts');
  const cursor = ctx.load('/support/cdc/cursor.ts');
  async function subscription({tenant = 'acme', head = 5000, restart = 3000, active = true, confirmed = 4000 as number | null, slot = true} = {}) {
    const sub = await store.createSubscription(tenant, 'orders', ['id', 'status'], 'warehouse-1');
    if (slot) slots.set(sub.slot, [head, restart, active]);
    if (confirmed !== null) await cursor.confirm(sub.id, 'orders', confirmed);
    return sub;
  }
  const c = ctx.client(ctx.load('read').app);
  const lag = (id: string, tenant: string | null = 'acme') => c.get(\`/v1/subscriptions/\${id}/lag\`, {headers: tenant ? {'X-Tenant-Id': tenant} : {}});
  return {store, subscription, lag};
}

export async function check_route(ctx) {
  const {subscription, lag} = setup(ctx);
  const near = await subscription();
  const far = await subscription({head: 4000 + FAR, restart: 1000});
  const below = await subscription({head: 4000 + CRITICAL - 1, restart: 1000});
  const above = await subscription({head: 4000 + CRITICAL + 1, restart: 1000});
  let r = await lag(near.id);
  assert.equal(r.status, 200, \`GET /v1/subscriptions/\${near.id}/lag answered \${r.status}: \${r.text}\`);
  const want = {subscription_id: near.id, confirmed_lsn: 4000, head_lsn: 5000, lag_bytes: 1000, slot_active: true, state: 'ok'};
  assert.deepStrictEqual(r.json(), want, \`the lag read answered \${r.text}, expected \${JSON.stringify(want)}\`);
  r = await lag(far.id);
  assert(r.json().lag_bytes === FAR && r.json().state === 'critical', \`2 GiB behind the head the read answered \${r.text}, expected lag_bytes \${FAR} and state critical\`);
  r = await lag(below.id);
  assert(r.json().lag_bytes === CRITICAL - 1 && r.json().state === 'ok', \`one byte short of CRITICAL_LAG_BYTES (512 MiB) the read answered \${r.text}, expected state ok\`);
  r = await lag(above.id);
  assert(r.json().lag_bytes === CRITICAL + 1 && r.json().state === 'critical', \`one byte past CRITICAL_LAG_BYTES (512 MiB) the read answered \${r.text}, expected state critical\`);
  r = await lag('sub-99');
  assert.equal(r.status, 404, \`an unknown subscription answered \${r.status}, expected 404\`);
}

export async function check_tenant_scope(ctx) {
  const {subscription, lag} = setup(ctx);
  const sub = await subscription();
  let r = await lag(sub.id, 'globex');
  assert.equal(r.status, 404, \`globex read acme's \${sub.id} and got \${r.status} \${r.text}: another tenant's subscription must read as unknown (404)\`);
  const unknown = await lag('sub-99', 'globex');
  assert.equal(r.text.replaceAll(sub.id, '{id}'), unknown.text.replaceAll('sub-99', '{id}'), \`globex reading acme's \${sub.id} got \${r.text}, an unknown id got \${unknown.text}: the two answers must not tell an existing subscription from a missing one\`);
  r = await lag(sub.id, null);
  assert.equal(r.status, 401, \`a read without X-Tenant-Id answered \${r.status}, expected 401\`);
  r = await lag(sub.id);
  assert.equal(r.status, 200, \`acme reading its own subscription answered \${r.status}: \${r.text}\`);
}

export async function check_unconfirmed_lag(ctx) {
  const {subscription, lag} = setup(ctx);
  const sub = await subscription({head: 1000 + FAR, restart: 1000, confirmed: null});
  const r = await lag(sub.id);
  const body = r.json();
  assert.equal(body.lag_bytes, FAR, \`a subscription that confirmed nothing reports lag_bytes \${body.lag_bytes}: it is behind by everything since the slot's restart_lsn (\${FAR})\`);
  assert(body.confirmed_lsn === null && body.state === 'critical', \`with nothing confirmed and 2 GiB retained the read answered \${r.text}, expected confirmed_lsn null and state critical\`);
}

export async function check_slot_health(ctx) {
  const {store, subscription, lag} = setup(ctx);
  const idle = await subscription({active: false});
  const dropped = await subscription({slot: false});
  const halted = await subscription();
  await store.setStatus(halted.id, 'slot_lost');
  const flaky = await subscription();
  let r = await lag(idle.id);
  assert(r.json().slot_active === false && r.json().state === 'critical', \`a slot no consumer holds read \${r.text}: the database retains WAL for it until the disk fills. Expected state critical\`);
  assert(r.json().head_lsn === 5000 && r.json().lag_bytes === 1000, \`an inactive slot still exists and still has a lag: it read \${r.text}, expected head_lsn 5000 and lag_bytes 1000\`);
  r = await lag(dropped.id);
  assert.equal(r.status, 200, \`a dropped slot answered \${r.status} \${r.text}: it is the state to page on, expected 200 with state critical\`);
  const body = r.json();
  assert(body.state === 'critical' && body.slot_active === false && body.lag_bytes === null && body.head_lsn === null, \`a dropped slot read \${r.text}, expected state critical, slot_active false, head_lsn and lag_bytes null\`);
  r = await lag(halted.id);
  assert(r.status === 200 && r.json().state === 'critical', \`a subscription the replicator marked slot_lost read \${r.status} \${r.text}, expected state critical\`);
  assert(r.json().slot_active === false && r.json().lag_bytes === null && r.json().head_lsn === null, \`a subscription the replicator marked slot_lost read \${r.text}: its slot is gone whatever SlotStatus says, expected slot_active false, head_lsn and lag_bytes null\`);
  ctx.grpc.fail('SlotStatus', ctx.grpc.status.UNAVAILABLE);
  r = await lag(flaky.id);
  const flakyBody = r.status === 200 ? r.json() : {};
  assert(!(flakyBody.slot_active === false && 'lag_bytes' in flakyBody && flakyBody.lag_bytes === null), \`SlotStatus failed UNAVAILABLE and the read answered \${r.status} \${r.text}: an outage of the source is not a dropped slot, only NOT_FOUND is\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"cdc/cursor"
	pb "cdc/gen/cdc_streamer"
	"cdc/store"

	"leetbuild/harness"
)

const (
	hFar      = int64(2 * 1024 * 1024 * 1024) // 2 GiB of WAL: critical whatever the threshold below 1 GiB
	hCritical = int64(512 * 1024 * 1024)
)

var hLagBg = context.Background()

type hSlotEntry struct {
	head, restart int64
	active        bool
}

// hStatusPeer answers SlotStatus from slots; a slot not listed was dropped.
type hStatusPeer struct {
	pb.UnimplementedSlotsServer
	slots map[string]hSlotEntry
}

func (s *hStatusPeer) SlotStatus(_ context.Context, req *pb.SlotStatusRequest) (*pb.SlotState, error) {
	e, ok := s.slots[req.GetSlot()]
	if !ok {
		return nil, status.Errorf(codes.NotFound, "replication slot %q does not exist", req.GetSlot())
	}
	return &pb.SlotState{HeadLsn: e.head, RestartLsn: e.restart, Active: e.active}, nil
}

type hLagWorld struct {
	ctx    *harness.Ctx
	source *hStatusPeer
	c      *harness.HTTP
}

func hLagSetup(ctx *harness.Ctx) *hLagWorld {
	source := &hStatusPeer{slots: map[string]hSlotEntry{}}
	pb.RegisterSlotsServer(ctx.GRPC.Server(""), source)
	mux := http.NewServeMux()
	register(mux)
	return &hLagWorld{ctx: ctx, source: source, c: ctx.HTTP(mux)}
}

// subscribe creates an acme subscription whose slot is e (none when slot is false), confirmed at confirmed (none when < 0).
func (w *hLagWorld) subscribe(e hSlotEntry, confirmed int64, slot bool) *store.Subscription {
	sub, err := store.CreateSubscription(hLagBg, "acme", "orders", []string{"id", "status"}, "warehouse-1")
	w.ctx.NoError(err, "creating the subscription")
	if slot {
		w.source.slots[sub.Slot] = e
	}
	if confirmed >= 0 {
		_, err = cursor.Confirm(hLagBg, sub.ID, "orders", confirmed)
		w.ctx.NoError(err, "confirming the cursor")
	}
	return sub
}

func (w *hLagWorld) lag(id, tenant string) *harness.Response {
	if tenant == "" {
		return w.c.Get("/v1/subscriptions/" + id + "/lag")
	}
	return w.c.Get("/v1/subscriptions/"+id+"/lag", "X-Tenant-Id", tenant)
}

func hBody(r *harness.Response) map[string]any {
	out := map[string]any{}
	r.Decode(&out)
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	w := hLagSetup(ctx)
	near := w.subscribe(hSlotEntry{5000, 3000, true}, 4000, true)
	farSub := w.subscribe(hSlotEntry{4000 + hFar, 1000, true}, 4000, true)
	r := w.lag(near.ID, "acme")
	ctx.Equal(r.Status, 200, "GET /v1/subscriptions/%s/lag (%s)", near.ID, r.Text())
	want := map[string]any{"subscription_id": near.ID, "confirmed_lsn": 4000, "head_lsn": 5000, "lag_bytes": 1000, "slot_active": true, "state": "ok"}
	ctx.Equal(hBody(r), want, "the lag read")
	got := hBody(w.lag(farSub.ID, "acme"))
	ctx.Assert(got["lag_bytes"] == float64(hFar) && got["state"] == "critical", "2 GiB behind the head the read answered %v, expected lag_bytes %d and state critical", got, hFar)
	below := w.subscribe(hSlotEntry{4000 + hCritical - 1, 1000, true}, 4000, true)
	got = hBody(w.lag(below.ID, "acme"))
	ctx.Assert(got["lag_bytes"] == float64(hCritical-1) && got["state"] == "ok", "one byte short of criticalLagBytes (512 MiB) the read answered %v, expected state ok", got)
	above := w.subscribe(hSlotEntry{4000 + hCritical + 1, 1000, true}, 4000, true)
	got = hBody(w.lag(above.ID, "acme"))
	ctx.Assert(got["lag_bytes"] == float64(hCritical+1) && got["state"] == "critical", "one byte past criticalLagBytes (512 MiB) the read answered %v, expected state critical", got)
	ctx.Equal(w.lag("sub-99", "acme").Status, 404, "an unknown subscription")
}

func CheckTenantScope(ctx *harness.Ctx) {
	w := hLagSetup(ctx)
	sub := w.subscribe(hSlotEntry{5000, 3000, true}, 4000, true)
	r := w.lag(sub.ID, "globex")
	ctx.Equal(r.Status, 404, "globex read acme's %s (%s): another tenant's subscription must read as unknown", sub.ID, r.Text())
	unknown := w.lag("sub-99", "globex")
	ctx.Assert(strings.ReplaceAll(r.Text(), sub.ID, "{id}") == strings.ReplaceAll(unknown.Text(), "sub-99", "{id}"),
		"globex reading acme's %s got %s, an unknown id got %s: the two answers must not tell an existing subscription from a missing one", sub.ID, r.Text(), unknown.Text())
	ctx.Equal(w.lag(sub.ID, "").Status, 401, "a read without X-Tenant-Id")
	ctx.Equal(w.lag(sub.ID, "acme").Status, 200, "acme reading its own subscription")
}

func CheckUnconfirmedLag(ctx *harness.Ctx) {
	w := hLagSetup(ctx)
	sub := w.subscribe(hSlotEntry{1000 + hFar, 1000, true}, -1, true)
	got := hBody(w.lag(sub.ID, "acme"))
	ctx.Equal(got["lag_bytes"], float64(hFar), "a subscription that confirmed nothing is behind by everything since the slot's restart_lsn; lag_bytes")
	ctx.Assert(got["confirmed_lsn"] == nil && got["state"] == "critical", "with nothing confirmed and 2 GiB retained the read answered %v, expected confirmed_lsn null and state critical", got)
}

func CheckSlotHealth(ctx *harness.Ctx) {
	w := hLagSetup(ctx)
	idle := w.subscribe(hSlotEntry{5000, 3000, false}, 4000, true)
	dropped := w.subscribe(hSlotEntry{}, 4000, false)
	halted := w.subscribe(hSlotEntry{5000, 3000, true}, 4000, true)
	ctx.NoError(store.SetStatus(hLagBg, halted.ID, "slot_lost"), "marking the subscription slot_lost")
	flaky := w.subscribe(hSlotEntry{5000, 3000, true}, 4000, true)
	got := hBody(w.lag(idle.ID, "acme"))
	ctx.Assert(got["slot_active"] == false && got["state"] == "critical", "a slot no consumer holds read %v: the database retains WAL for it until the disk fills. Expected state critical", got)
	ctx.Assert(got["head_lsn"] == float64(5000) && got["lag_bytes"] == float64(1000), "an inactive slot still exists and still has a lag: it read %v, expected head_lsn 5000 and lag_bytes 1000", got)
	r := w.lag(dropped.ID, "acme")
	ctx.Equal(r.Status, 200, "a dropped slot is the state to page on (%s); the status", r.Text())
	got = hBody(r)
	ctx.Assert(got["state"] == "critical" && got["slot_active"] == false && got["lag_bytes"] == nil && got["head_lsn"] == nil, "a dropped slot read %v, expected state critical, slot_active false, head_lsn and lag_bytes null", got)
	r = w.lag(halted.ID, "acme")
	got = hBody(r)
	ctx.Assert(r.Status == 200 && got["state"] == "critical", "a subscription the replicator marked slot_lost read %d %s, expected state critical", r.Status, r.Text())
	ctx.Assert(got["slot_active"] == false && got["lag_bytes"] == nil && got["head_lsn"] == nil, "a subscription the replicator marked slot_lost read %v: its slot is gone whatever SlotStatus says, expected slot_active false, head_lsn and lag_bytes null", got)
	ctx.GRPC.Fail("SlotStatus", codes.Unavailable, "", 1, "")
	r = w.lag(flaky.ID, "acme")
	got = map[string]any{}
	if r.Status == 200 {
		got = hBody(r)
	}
	_, hasLag := got["lag_bytes"]
	ctx.Assert(!(got["slot_active"] == false && hasLag && got["lag_bytes"] == nil), "SlotStatus failed UNAVAILABLE and the read answered %d %s: an outage of the source is not a dropped slot, only NOT_FOUND is", r.Status, r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cstdint>
#include <map>
#include <regex>
#include <string>
#include <tuple>

#include "cdc/cursor.h"
#include "cdc/store.h"
#include "cdc_streamer.grpc.pb.h"

namespace {

constexpr int64_t kHFar = 2LL * 1024 * 1024 * 1024;  // 2 GiB of WAL: critical whatever the threshold below 1 GiB
constexpr int64_t kHarnessCritical = 512LL * 1024 * 1024;

// Slots by name: head_lsn, restart_lsn, active; a slot not listed was dropped.
class HStatusPeer final : public cdcstream::Slots::Service {
 public:
  std::map<std::string, std::tuple<int64_t, int64_t, bool>> slots;
  grpc::Status SlotStatus(grpc::ServerContext*, const cdcstream::SlotStatusRequest* req, cdcstream::SlotState* out) override {
    const auto it = slots.find(req->slot());
    if (it == slots.end()) return grpc::Status(grpc::StatusCode::NOT_FOUND, "replication slot \\"" + req->slot() + "\\" does not exist");
    out->set_head_lsn(std::get<0>(it->second));
    out->set_restart_lsn(std::get<1>(it->second));
    out->set_active(std::get<2>(it->second));
    return grpc::Status::OK;
  }
};

struct HLagWorld {
  HStatusPeer source;
  httplib::Server svr;
};

HLagWorld& hLagSetup(harness::Ctx& ctx) {
  static HLagWorld* world = nullptr;
  delete world;
  world = new HLagWorld;
  ctx.GRPC.Server("")->RegisterService(&world->source);
  register_routes(world->svr);
  return *world;
}

// An acme subscription whose slot stands at (head, restart, active) unless slot is false, confirmed at confirmed (none when < 0).
store::Subscription hSubscribe(HLagWorld& w, int64_t head, int64_t restart, bool active, int64_t confirmed, bool slot = true) {
  const store::Subscription sub = store::createSubscription("acme", "orders", {"id", "status"}, "warehouse-1");
  if (slot) w.source.slots[sub.slot] = {head, restart, active};
  if (confirmed >= 0) cursor::confirm(sub.id, "orders", confirmed);
  return sub;
}

harness::Response hLag(harness::Ctx& ctx, HLagWorld& w, const std::string& id, const std::string& tenant = "acme") {
  auto c = ctx.HTTP(w.svr);
  if (tenant.empty()) return c.Get("/v1/subscriptions/" + id + "/lag");
  return c.Get("/v1/subscriptions/" + id + "/lag", "X-Tenant-Id", tenant);
}

nlohmann::json hBody(const harness::Response& r) {
  const auto out = nlohmann::json::parse(r.Text(), nullptr, false);
  return out.is_object() ? out : nlohmann::json::object();
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  HLagWorld& w = hLagSetup(ctx);
  const auto near = hSubscribe(w, 5000, 3000, true, 4000);
  const auto far = hSubscribe(w, 4000 + kHFar, 1000, true, 4000);
  auto r = hLag(ctx, w, near.id);
  ctx.Equal(r.Status, 200, "GET /v1/subscriptions/%s/lag (%s)", near.id, r.Text());
  const nlohmann::json want = {{"subscription_id", near.id}, {"confirmed_lsn", 4000}, {"head_lsn", 5000},
                               {"lag_bytes", 1000},          {"slot_active", true},   {"state", "ok"}};
  ctx.Equal(hBody(r), want, "the lag read");
  auto got = hBody(hLag(ctx, w, far.id));
  ctx.Assert(got.value("lag_bytes", int64_t{0}) == kHFar && got.value("state", "") == "critical",
             "2 GiB behind the head the read answered %s, expected lag_bytes %d and state critical", got.dump(), kHFar);
  const auto below = hSubscribe(w, 4000 + kHarnessCritical - 1, 1000, true, 4000);
  got = hBody(hLag(ctx, w, below.id));
  ctx.Assert(got["lag_bytes"] == kHarnessCritical - 1 && got["state"] == "ok", "one byte short of kCriticalLagBytes (512 MiB) the read answered %s, expected state ok", got.dump());
  const auto above = hSubscribe(w, 4000 + kHarnessCritical + 1, 1000, true, 4000);
  got = hBody(hLag(ctx, w, above.id));
  ctx.Assert(got["lag_bytes"] == kHarnessCritical + 1 && got["state"] == "critical", "one byte past kCriticalLagBytes (512 MiB) the read answered %s, expected state critical", got.dump());
  ctx.Equal(hLag(ctx, w, "sub-99").Status, 404, "an unknown subscription");
}

void CheckTenantScope(harness::Ctx& ctx) {
  HLagWorld& w = hLagSetup(ctx);
  const auto sub = hSubscribe(w, 5000, 3000, true, 4000);
  const auto r = hLag(ctx, w, sub.id, "globex");
  ctx.Equal(r.Status, 404, "globex read acme's %s (%s): another tenant's subscription must read as unknown", sub.id, r.Text());
  const auto unknown = hLag(ctx, w, "sub-99", "globex");
  ctx.Assert(std::regex_replace(r.Text(), std::regex(sub.id), "{id}") == std::regex_replace(unknown.Text(), std::regex("sub-99"), "{id}"),
             "globex reading acme's %s got %s, an unknown id got %s: the two answers must not tell an existing subscription from a missing one", sub.id, r.Text(),
             unknown.Text());
  ctx.Equal(hLag(ctx, w, sub.id, "").Status, 401, "a read without X-Tenant-Id");
  ctx.Equal(hLag(ctx, w, sub.id).Status, 200, "acme reading its own subscription");
}

void CheckUnconfirmedLag(harness::Ctx& ctx) {
  HLagWorld& w = hLagSetup(ctx);
  const auto sub = hSubscribe(w, 1000 + kHFar, 1000, true, -1);
  const auto got = hBody(hLag(ctx, w, sub.id));
  ctx.Equal(got.value("lag_bytes", int64_t{0}), kHFar,
            "a subscription that confirmed nothing is behind by everything since the slot's restart_lsn; lag_bytes");
  ctx.Assert(got.contains("confirmed_lsn") && got["confirmed_lsn"].is_null() && got.value("state", "") == "critical",
             "with nothing confirmed and 2 GiB retained the read answered %s, expected confirmed_lsn null and state critical", got.dump());
}

void CheckSlotHealth(harness::Ctx& ctx) {
  HLagWorld& w = hLagSetup(ctx);
  const auto idle = hSubscribe(w, 5000, 3000, false, 4000);
  const auto dropped = hSubscribe(w, 0, 0, false, 4000, false);
  const auto halted = hSubscribe(w, 5000, 3000, true, 4000);
  store::setStatus(halted.id, "slot_lost");
  const auto flaky = hSubscribe(w, 5000, 3000, true, 4000);
  auto got = hBody(hLag(ctx, w, idle.id));
  ctx.Assert(got.value("slot_active", true) == false && got.value("state", "") == "critical",
             "a slot no consumer holds read %s: the database retains WAL for it until the disk fills. Expected state critical", got.dump());
  ctx.Assert(got["head_lsn"] == 5000 && got["lag_bytes"] == 1000, "an inactive slot still exists and still has a lag: it read %s, expected head_lsn 5000 and lag_bytes 1000", got.dump());
  auto r = hLag(ctx, w, dropped.id);
  ctx.Equal(r.Status, 200, "a dropped slot is the state to page on (%s); the status", r.Text());
  got = hBody(r);
  ctx.Assert(got.value("state", "") == "critical" && got.value("slot_active", true) == false && got.contains("lag_bytes") && got["lag_bytes"].is_null() &&
                 got.contains("head_lsn") && got["head_lsn"].is_null(),
             "a dropped slot read %s, expected state critical, slot_active false, head_lsn and lag_bytes null", got.dump());
  r = hLag(ctx, w, halted.id);
  got = hBody(r);
  ctx.Assert(r.Status == 200 && got.value("state", "") == "critical", "a subscription the replicator marked slot_lost read %d %s, expected state critical", r.Status, r.Text());
  ctx.Assert(got["slot_active"] == false && got.contains("lag_bytes") && got["lag_bytes"].is_null() && got.contains("head_lsn") && got["head_lsn"].is_null(),
             "a subscription the replicator marked slot_lost read %s: its slot is gone whatever SlotStatus says, expected slot_active false, head_lsn and lag_bytes null", got.dump());
  ctx.GRPC.Fail("SlotStatus", grpc::StatusCode::UNAVAILABLE);
  r = hLag(ctx, w, flaky.id);
  got = r.Status == 200 ? hBody(r) : nlohmann::json::object();
  ctx.Assert(!(got["slot_active"] == false && got.contains("lag_bytes") && got["lag_bytes"].is_null()),
             "SlotStatus failed UNAVAILABLE and the read answered %d %s: an outage of the source is not a dropped slot, only NOT_FOUND is", r.Status, r.Text());
}
`,
  },
  hints: [
    "Read acme's lag with globex in `X-Tenant-Id`: 200 and every number. Create a subscription that confirmed nothing: lag 0, ok. Deactivate its slot: still ok. Drop the slot: 503.",
    "Nothing compares the subscription's tenant with the caller's. A missing cursor is read as caught up, when it means the sink has nothing yet. The state looks at the lag number only, not at `active` or at a slot that is gone.",
    '401 without `X-Tenant-Id`, 404 unless `subscription["tenant"] == tenant`; lag from `confirmed` or else `state.restart_lsn`; `"critical"` when `not state.active`, on `NOT_FOUND`, for a `slot_lost` subscription, or past `CRITICAL_LAG_BYTES`.',
  ],
  debrief: `A lag read exists to page someone, so its job is to make the dangerous states impossible to miss: a slot nobody holds and a slot that no longer exists are worse than any lag number, because the database is discarding, or has discarded, the WAL the subscription still needs. Measuring from restart_lsn when nothing is confirmed shows a new or stuck subscription as far behind as it is. The tenant check answers 404 rather than 403 so ids cannot be probed. PostgreSQL reports the same facts in pg_replication_slots, where wal_status moves to unreserved and then lost as a slot falls past max_slot_wal_keep_size; production monitors alert on that column and on safe_wal_size, not only on a byte count.`,
};
