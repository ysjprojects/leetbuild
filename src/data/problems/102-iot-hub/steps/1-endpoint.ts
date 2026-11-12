import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/devices/{id}/commands: one command per idempotency id',
  concept: 'http',
  file: 'api',
  focus: ['client', 'hub', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/devices/{device_id}/commands\` with
\`{idempotency_id, action, params, validity_s, ack_required}\`: it mints a command id
(\`commands.new_command_id\`), records the command under that id (\`commands.record\`), hands it to
the delivery queue (\`commands.enqueue\`) and answers **200** with \`state: "executed"\`. It serves the
demo and hides four flaws.

**Failure mode the checks target.** An operator app that times out and retries an unlock opens the
door twice; a command accepted for a lock that is offline for days fires when it reconnects; one
integration queues hundreds of commands on one device in a minute; and the response claims an
execution no device has confirmed.

- Look the command up with \`commands.lookup(device_id, idempotency_id)\` first and record it under
  the same pair: a replay answers the recorded command and queues nothing.
- Store \`expires_at_ms\` = now + \`validity_s\` × 1000; a \`validity_s\` outside 1..3600 is **400**, a
  replay after the window is **410** with \`state: "expired"\`.
- At most \`COMMAND_RATE_LIMIT\` = 10 commands per device per 60 s
  (\`commands.count_in_window(device_id, 60)\`), **429** past it, before anything is queued.
- Answer **202** with \`state: "pending_ack"\`, or \`"queued"\` when \`ack_required\` is false.`,
  sequence: {
    participants: ['Operator', 'iothub', 'Command store'],
    messages: [
      {from: 'Operator', to: 'iothub', label: 'POST /v1/devices/{id}/commands · idempotency_id', kind: 'sync'},
      {from: 'iothub', to: 'Command store', label: 'lookup(device, idempotency_id)', kind: 'sync'},
      {from: 'Command store', to: 'iothub', label: 'recorded → 202 (410 past expires_at_ms)', kind: 'reply'},
      {from: 'iothub', to: 'Command store', label: 'count_in_window(device, 60) · > 10 → 429', kind: 'sync'},
      {from: 'iothub', to: 'Command store', label: 'record(device, idempotency_id, command) · enqueue', kind: 'sync'},
      {from: 'iothub', to: 'Operator', label: '202 {command_id, state: pending_ack, expires_at_ms}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Accepts a command on POST /v1/devices/{id}/commands',
      detail:
        'Register `POST /v1/devices/{device_id}/commands`; an accepted command is recorded and queued for delivery.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/devices\/\{device_id\}\/commands["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/devices\/:\w+\/commands['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/devices\/\{device_id\}\/commands"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"devices"\s*\/\s*Segment\s*\/\s*"commands"\s*\)/, /\bpost\b/]},
        cpp: {all: [/svr\.Post\(\s*R"\(\/v1\/devices\//, /\/commands\)"/]},
      },
    },
    {
      id: 'identity',
      title: 'Keys the command by (device, idempotency id)',
      detail:
        'The command is looked up under `(device_id, idempotency_id)` before anything else and recorded under the same pair, so a replay answers the recorded command and queues nothing; the starter records each request under a fresh id.',
      match: {
        python: {
          all: [/commands\.lookup\([^)\n]*idempotency_id/, /commands\.record\([^)\n]*idempotency_id/],
          order: [/commands\.lookup\(/, /commands\.record\(/],
        },
        typescript: {
          all: [/lookup\([^)\n]*idempotency_id/, /record\([^)\n]*idempotency_id/],
          order: [/lookup\(/, /record\(/],
        },
        go: {
          all: [/commands\.Lookup\([^\n]*IdempotencyID/, /commands\.Record\([^\n]*IdempotencyID/],
          order: [/commands\.Lookup\(/, /commands\.Record\(/],
        },
        scala: {
          all: [/Commands\.lookup\([^)\n]*idempotencyId/, /Commands\.record\([^)\n]*idempotencyId/],
          order: [/Commands\.lookup\(/, /Commands\.record\(/],
        },
        cpp: {
          all: [/commands::lookup\([^)\n]*idempotency_id/, /commands::record\([^)\n]*idempotency_id/],
          order: [/commands::lookup\(/, /commands::record\(/],
        },
      },
    },
    {
      id: 'window',
      title: 'Records a validity window and refuses replays past it',
      detail:
        'The command carries `expires_at_ms` = now + `validity_s` × 1000, a `validity_s` outside 1..3600 is 400, and a replay after the window is 410 `expired`; the starter records no window at all.',
      match: {
        python: {all: [/expires_at_ms/, /\b410\b/, /\b400\b/]},
        typescript: {all: [/expires_at_ms:/, /code\(\s*410\s*\)/, /code\(\s*400\s*\)/]},
        go: {all: [/ExpiresAtMs:/, /StatusGone|\b410\b/, /StatusBadRequest|\b400\b/]},
        scala: {all: [/expiresAtMs\s*=/, /StatusCodes\.Gone/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/expires_at_ms\s*=/, /\b410\b/, /\b400\b/]},
      },
    },
    {
      id: 'rate-limit',
      title: 'Caps each device at 10 commands a minute',
      detail:
        'Every new command is counted per device with `count_in_window(device_id, 60)`; past `COMMAND_RATE_LIMIT` = 10 the answer is 429 and nothing is queued. The starter counts nothing.',
      match: {
        python: {
          all: [/COMMAND_RATE_LIMIT\s*=\s*10\b/, /commands\.count_in_window\(/, /\b429\b/],
          order: [/commands\.count_in_window\(/, /commands\.enqueue\(/],
        },
        typescript: {
          all: [/COMMAND_RATE_LIMIT\s*=\s*10\b/, /countInWindow\(/, /code\(\s*429\s*\)/],
          order: [/countInWindow\(/, /enqueue\(/],
        },
        go: {
          all: [/commandRateLimit\s*=\s*10\b/, /commands\.CountInWindow\(/, /StatusTooManyRequests|\b429\b/],
          order: [/commands\.CountInWindow\(/, /commands\.Enqueue\(/],
        },
        scala: {
          all: [/CommandRateLimit\s*=\s*10\b/, /Commands\.countInWindow\(/, /TooManyRequests|\b429\b/],
          order: [/Commands\.countInWindow\(/, /Commands\.enqueue\(/],
        },
        cpp: {
          all: [/kCommandRateLimit\s*=\s*10\b/, /commands::countInWindow\(/, /\b429\b/],
          order: [/commands::countInWindow\(/, /commands::enqueue\(/],
        },
      },
    },
    {
      id: 'ack',
      title: 'Answers pending_ack until the device acknowledges',
      detail:
        'A new command answers 202 with `state: "pending_ack"` (`"queued"` when no acknowledgement is expected) and is recorded in that state; the starter answers 200 `executed` before any device has spoken.',
      match: {
        python: {all: [/["']pending_ack["']/, /status_code\s*=\s*202/], none: [/["']executed["']/]},
        typescript: {all: [/['"]pending_ack['"]/, /code\(\s*202\s*\)/], none: [/['"]executed['"]/]},
        go: {all: [/"pending_ack"/, /StatusAccepted|\b202\b/], none: [/"executed"/]},
        scala: {all: [/"pending_ack"/, /StatusCodes\.Accepted/], none: [/"executed"/]},
        cpp: {all: [/"pending_ack"/, /\b202\b/], none: [/"executed"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from iothub import commands  # new_command_id, lookup, record, enqueue, count_in_window

app = FastAPI()


class CommandRequest(BaseModel):
    idempotency_id: str
    action: str
    params: dict[str, str] = {}
    validity_s: int = 300
    ack_required: bool = True


@app.post("/v1/devices/{device_id}/commands")
def submit_command(device_id: str, body: CommandRequest) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    command_id = commands.new_command_id()
    command = {
        "command_id": command_id,
        "device_id": device_id,
        "action": body.action,
        "params": body.params,
        "state": "executed",
        "ack_required": body.ack_required,
    }
    commands.record(device_id, command_id, command)
    commands.enqueue(device_id, command_id)
    return JSONResponse(command, status_code=200)
`,
      solution: `import time

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from iothub import commands  # new_command_id, lookup, record, enqueue, count_in_window

app = FastAPI()

COMMAND_RATE_LIMIT = 10
RATE_WINDOW_S = 60
MAX_VALIDITY_S = 3600


class CommandRequest(BaseModel):
    idempotency_id: str
    action: str
    params: dict[str, str] = {}
    validity_s: int = 300
    ack_required: bool = True


@app.post("/v1/devices/{device_id}/commands")
def submit_command(device_id: str, body: CommandRequest) -> JSONResponse:
    now_ms = int(time.time() * 1000)
    # A replay answers what the first request recorded; it never queues the action again.
    recorded = commands.lookup(device_id, body.idempotency_id)
    if recorded is not None:
        if now_ms >= recorded["expires_at_ms"]:
            return JSONResponse({**recorded, "state": "expired"}, status_code=410)
        return JSONResponse(recorded, status_code=202)
    if not 1 <= body.validity_s <= MAX_VALIDITY_S:
        return JSONResponse({"error": f"validity_s must be between 1 and {MAX_VALIDITY_S}"}, status_code=400)
    if commands.count_in_window(device_id, RATE_WINDOW_S) > COMMAND_RATE_LIMIT:
        return JSONResponse({"error": "this device's command budget for the minute is spent"}, status_code=429)
    command = {
        "command_id": commands.new_command_id(),
        "device_id": device_id,
        "action": body.action,
        "params": body.params,
        # Accepted is not executed: the device's acknowledgement moves the command on.
        "state": "pending_ack" if body.ack_required else "queued",
        "expires_at_ms": now_ms + body.validity_s * 1000,
        "ack_required": body.ack_required,
    }
    commands.record(device_id, body.idempotency_id, command)
    commands.enqueue(device_id, command["command_id"])
    return JSONResponse(command, status_code=202)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type Command, countInWindow, enqueue, lookup, newCommandId, record} from 'iothub/commands';

export const app = Fastify();

interface CommandRequest {
  idempotency_id: string;
  action: string;
  params?: Record<string, string>;
  validity_s?: number;
  ack_required?: boolean;
}

app.post('/v1/devices/:deviceId/commands', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {deviceId} = request.params as {deviceId: string};
  const body = request.body as CommandRequest;
  const commandId = await newCommandId();
  const command: Command = {
    command_id: commandId,
    device_id: deviceId,
    action: body.action,
    params: body.params ?? {},
    state: 'executed',
    ack_required: body.ack_required ?? true,
  };
  await record(deviceId, commandId, command);
  await enqueue(deviceId, commandId);
  return reply.code(200).send(command);
});
`,
      solution: `import Fastify from 'fastify';

import {type Command, countInWindow, enqueue, lookup, newCommandId, record} from 'iothub/commands';

export const app = Fastify();

export const COMMAND_RATE_LIMIT = 10;
export const RATE_WINDOW_S = 60;
export const MAX_VALIDITY_S = 3600;

interface CommandRequest {
  idempotency_id: string;
  action: string;
  params?: Record<string, string>;
  validity_s?: number;
  ack_required?: boolean;
}

app.post('/v1/devices/:deviceId/commands', async (request, reply) => {
  const {deviceId} = request.params as {deviceId: string};
  const body = request.body as CommandRequest;
  const validityS = body.validity_s ?? 300;
  const ackRequired = body.ack_required ?? true;
  const nowMs = Date.now();
  // A replay answers what the first request recorded; it never queues the action again.
  const recorded = await lookup(deviceId, body.idempotency_id);
  if (recorded !== null) {
    if (nowMs >= (recorded.expires_at_ms ?? 0)) return reply.code(410).send({...recorded, state: 'expired'});
    return reply.code(202).send(recorded);
  }
  if (!(validityS >= 1 && validityS <= MAX_VALIDITY_S)) {
    return reply.code(400).send({error: \`validity_s must be between 1 and \${MAX_VALIDITY_S}\`});
  }
  if ((await countInWindow(deviceId, RATE_WINDOW_S)) > COMMAND_RATE_LIMIT) {
    return reply.code(429).send({error: "this device's command budget for the minute is spent"});
  }
  const command: Command = {
    command_id: await newCommandId(),
    device_id: deviceId,
    action: body.action,
    params: body.params ?? {},
    // Accepted is not executed: the device's acknowledgement moves the command on.
    state: ackRequired ? 'pending_ack' : 'queued',
    expires_at_ms: nowMs + validityS * 1000,
    ack_required: ackRequired,
  };
  await record(deviceId, body.idempotency_id, command);
  await enqueue(deviceId, command.command_id);
  return reply.code(202).send(command);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"iothub/commands" // commands.NewCommandID, Lookup, Record, Enqueue, CountInWindow
)

type commandRequest struct {
	IdempotencyID string            \`json:"idempotency_id"\`
	Action        string            \`json:"action"\`
	Params        map[string]string \`json:"params"\`
	ValidityS     int64             \`json:"validity_s"\`
	AckRequired   bool              \`json:"ack_required"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func submitCommand(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	deviceID := r.PathValue("device_id")
	body := commandRequest{ValidityS: 300, AckRequired: true}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, err.Error(), http.StatusBadRequest)
		return
	}
	commandID := commands.NewCommandID(r.Context())
	command := &commands.Command{CommandID: commandID, DeviceID: deviceID, Action: body.Action, Params: body.Params, State: "executed", AckRequired: body.AckRequired}
	if err := commands.Record(r.Context(), deviceID, commandID, command); err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := commands.Enqueue(r.Context(), deviceID, commandID); err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusOK, command)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/devices/{device_id}/commands", submitCommand)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"iothub/commands" // commands.NewCommandID, Lookup, Record, Enqueue, CountInWindow
)

const (
	commandRateLimit = 10
	rateWindowS      = 60
	maxValidityS     = 3600
)

type commandRequest struct {
	IdempotencyID string            \`json:"idempotency_id"\`
	Action        string            \`json:"action"\`
	Params        map[string]string \`json:"params"\`
	ValidityS     int64             \`json:"validity_s"\`
	AckRequired   bool              \`json:"ack_required"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func submitCommand(rw http.ResponseWriter, r *http.Request) {
	deviceID := r.PathValue("device_id")
	body := commandRequest{ValidityS: 300, AckRequired: true}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, err.Error(), http.StatusBadRequest)
		return
	}
	nowMs := time.Now().UnixMilli()
	// A replay answers what the first request recorded; it never queues the action again.
	recorded, err := commands.Lookup(r.Context(), deviceID, body.IdempotencyID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if recorded != nil {
		if nowMs >= recorded.ExpiresAtMs {
			recorded.State = "expired"
			writeJSON(rw, http.StatusGone, recorded)
			return
		}
		writeJSON(rw, http.StatusAccepted, recorded)
		return
	}
	if body.ValidityS < 1 || body.ValidityS > maxValidityS {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "validity_s must be between 1 and 3600"})
		return
	}
	count, err := commands.CountInWindow(r.Context(), deviceID, rateWindowS)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if count > commandRateLimit {
		writeJSON(rw, http.StatusTooManyRequests, map[string]string{"error": "this device's command budget for the minute is spent"})
		return
	}
	// Accepted is not executed: the device's acknowledgement moves the command on.
	state := "queued"
	if body.AckRequired {
		state = "pending_ack"
	}
	command := &commands.Command{
		CommandID: commands.NewCommandID(r.Context()), DeviceID: deviceID, Action: body.Action, Params: body.Params,
		State: state, ExpiresAtMs: nowMs + body.ValidityS*1000, AckRequired: body.AckRequired,
	}
	if err := commands.Record(r.Context(), deviceID, body.IdempotencyID, command); err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := commands.Enqueue(r.Context(), deviceID, command.CommandID); err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusAccepted, command)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/devices/{device_id}/commands", submitCommand)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import iothub.{Command, Commands} // Commands.newCommandId, lookup, record, enqueue, countInWindow

object Api {
  private final case class CommandRequest(idempotencyId: String, action: String, params: Map[String, String], validityS: Long, ackRequired: Boolean)

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def parse(raw: String): CommandRequest = {
    val f = raw.parseJson.asJsObject.fields
    CommandRequest(
      f.get("idempotency_id").collect { case JsString(s) => s }.getOrElse(""),
      f.get("action").collect { case JsString(s) => s }.getOrElse(""),
      f.get("params").collect { case JsObject(p) => p.collect { case (k, JsString(v)) => k -> v } }.getOrElse(Map.empty[String, String]),
      f.get("validity_s").collect { case JsNumber(n) => n.toLong }.getOrElse(300L),
      f.get("ack_required").collect { case JsBoolean(b) => b }.getOrElse(true))
  }

  val route: Route =
    path("v1" / "devices" / Segment / "commands") { deviceId =>
      post {
        entity(as[String]) { raw =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val body = parse(raw)
          val commandId = Commands.newCommandId()
          val command = Command(commandId, deviceId, body.action, body.params, "executed", body.ackRequired)
          Commands.record(deviceId, commandId, command)
          Commands.enqueue(deviceId, commandId)
          complete(json(StatusCodes.OK, Commands.toJson(command)))
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import iothub.{Command, Commands} // Commands.newCommandId, lookup, record, enqueue, countInWindow

object Api {
  val CommandRateLimit = 10
  val RateWindowS = 60L
  val MaxValidityS = 3600L

  private final case class CommandRequest(idempotencyId: String, action: String, params: Map[String, String], validityS: Long, ackRequired: Boolean)

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def parse(raw: String): CommandRequest = {
    val f = raw.parseJson.asJsObject.fields
    CommandRequest(
      f.get("idempotency_id").collect { case JsString(s) => s }.getOrElse(""),
      f.get("action").collect { case JsString(s) => s }.getOrElse(""),
      f.get("params").collect { case JsObject(p) => p.collect { case (k, JsString(v)) => k -> v } }.getOrElse(Map.empty[String, String]),
      f.get("validity_s").collect { case JsNumber(n) => n.toLong }.getOrElse(300L),
      f.get("ack_required").collect { case JsBoolean(b) => b }.getOrElse(true))
  }

  private def submit(deviceId: String, body: CommandRequest): HttpResponse = {
    val nowMs = System.currentTimeMillis()
    // A replay answers what the first request recorded; it never queues the action again.
    Commands.lookup(deviceId, body.idempotencyId) match {
      case Some(recorded) if nowMs >= recorded.expiresAtMs => json(StatusCodes.Gone, Commands.toJson(recorded.copy(state = "expired")))
      case Some(recorded) => json(StatusCodes.Accepted, Commands.toJson(recorded))
      case None if body.validityS < 1 || body.validityS > MaxValidityS =>
        error(StatusCodes.BadRequest, s"validity_s must be between 1 and $MaxValidityS")
      case None if Commands.countInWindow(deviceId, RateWindowS) > CommandRateLimit =>
        error(StatusCodes.TooManyRequests, "this device's command budget for the minute is spent")
      case None =>
        // Accepted is not executed: the device's acknowledgement moves the command on.
        val state = if (body.ackRequired) "pending_ack" else "queued"
        val command = Command(Commands.newCommandId(), deviceId, body.action, body.params, state, body.ackRequired, expiresAtMs = nowMs + body.validityS * 1000)
        Commands.record(deviceId, body.idempotencyId, command)
        Commands.enqueue(deviceId, command.commandId)
        json(StatusCodes.Accepted, Commands.toJson(command))
    }
  }

  val route: Route =
    path("v1" / "devices" / Segment / "commands") { deviceId =>
      post {
        entity(as[String]) { raw =>
          complete(submit(deviceId, parse(raw)))
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <string>

#include "iothub/commands.h"  // commands::newCommandId, lookup, record, enqueue, countInWindow

using json = nlohmann::json;

void submit_command(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string device_id = req.matches[1];
  const json body = json::parse(req.body);
  commands::Command command;
  command.command_id = commands::newCommandId();
  command.device_id = device_id;
  command.action = body.value("action", "");
  command.params = body.value("params", std::map<std::string, std::string>{});
  command.state = "executed";
  command.ack_required = body.value("ack_required", true);
  commands::record(device_id, command.command_id, command);
  commands::enqueue(device_id, command.command_id);
  res.set_content(commands::toJson(command).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post(R"(/v1/devices/([\\w-]+)/commands)", submit_command);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <map>
#include <string>

#include "iothub/commands.h"  // commands::newCommandId, lookup, record, enqueue, countInWindow

using json = nlohmann::json;

constexpr long long kCommandRateLimit = 10;
constexpr long long kRateWindowS = 60;
constexpr long long kMaxValidityS = 3600;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void submit_command(const httplib::Request& req, httplib::Response& res) {
  const std::string device_id = req.matches[1];
  const json body = json::parse(req.body);
  const std::string idempotency_id = body.value("idempotency_id", "");
  const long long validity_s = body.value("validity_s", 300LL);
  const bool ack_required = body.value("ack_required", true);
  const long long now_ms =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  // A replay answers what the first request recorded; it never queues the action again.
  if (const auto recorded = commands::lookup(device_id, idempotency_id)) {
    json answer = commands::toJson(*recorded);
    if (now_ms >= recorded->expires_at_ms) {
      answer["state"] = "expired";
      return reply(res, 410, answer);
    }
    return reply(res, 202, answer);
  }
  if (validity_s < 1 || validity_s > kMaxValidityS) return reply(res, 400, {{"error", "validity_s must be between 1 and 3600"}});
  if (commands::countInWindow(device_id, kRateWindowS) > kCommandRateLimit) {
    return reply(res, 429, {{"error", "this device's command budget for the minute is spent"}});
  }
  commands::Command command;
  command.command_id = commands::newCommandId();
  command.device_id = device_id;
  command.action = body.value("action", "");
  command.params = body.value("params", std::map<std::string, std::string>{});
  // Accepted is not executed: the device's acknowledgement moves the command on.
  command.state = ack_required ? "pending_ack" : "queued";
  command.expires_at_ms = now_ms + validity_s * 1000;
  command.ack_required = ack_required;
  commands::record(device_id, idempotency_id, command);
  commands::enqueue(device_id, command.command_id);
  reply(res, 202, commands::toJson(command));
}

void register_routes(httplib::Server& svr) {
  svr.Post(R"(/v1/devices/([\\w-]+)/commands)", submit_command);
}
`,
    },
  },
  harness: {
    python: `from iothub import commands

LOCK = "lock-7"


def _api(ctx):
    return ctx.client(ctx.load("api").app)


def _queue(ctx, device=LOCK):
    return ctx.redis.lrange(f"device:{device}:queue", 0, -1)


async def _submit(c, idempotency_id="k-1", device=LOCK, **extra):
    body = {"idempotency_id": idempotency_id, "action": "unlock", "params": {"duration_s": "5"}, "validity_s": 60, "ack_required": True, **extra}
    return await c.post(f"/v1/devices/{device}/commands", json=body)


def _ok(r):
    return 200 <= r.status_code < 300


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _submit(c)
    assert _ok(r), f"POST /v1/devices/{LOCK}/commands answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("command_id") and body.get("device_id") == LOCK and body.get("action") == "unlock", f"the response must carry the command's id, device and action, got {body}"
    assert _queue(ctx) == [body["command_id"]], f"the delivery queue of {LOCK} holds {_queue(ctx)}, expected the new command {body['command_id']}"


async def check_identity(ctx):
    async with _api(ctx) as c:
        first = await _submit(c, "k-1")
        replay = await _submit(c, "k-1")
        other = await _submit(c, "k-1", device="lock-9")
    assert _ok(first) and _ok(replay), f"the request and its replay answered {first.status_code} and {replay.status_code}"
    a, b = first.json(), replay.json()
    assert b.get("command_id") == a.get("command_id"), f"a replay of idempotency_id k-1 answered command {b.get('command_id')}, the first request {a.get('command_id')}: a replay must answer the recorded command"
    assert len(_queue(ctx)) == 1, f"two requests with idempotency_id k-1 queued {len(_queue(ctx))} commands for {LOCK}: the door unlocks once per request"
    recorded = commands.lookup(LOCK, "k-1")
    assert recorded is not None and recorded["command_id"] == a["command_id"], f"the command store holds {recorded} under ({LOCK}, k-1), expected the command recorded under the caller's idempotency id"
    assert other.json().get("command_id") != a["command_id"] and len(_queue(ctx, "lock-9")) == 1, "the same idempotency_id on another device is another command: the key is (device, idempotency_id)"


async def check_window(ctx):
    now_ms = int(ctx.clock.time() * 1000)
    async with _api(ctx) as c:
        r = await _submit(c, "k-1", validity_s=60)
        assert _ok(r), f"a command with validity_s=60 answered {r.status_code}: {r.text}"
        assert r.json().get("expires_at_ms") == now_ms + 60_000, f"a command with validity_s=60 answered expires_at_ms={r.json().get('expires_at_ms')!r}, expected {now_ms + 60_000} (now + 60 s): without a window a command for an offline lock fires whenever it reconnects"
        recorded = commands.lookup(LOCK, "k-1")
        assert recorded is not None and recorded["expires_at_ms"] == now_ms + 60_000, f"the command store holds {recorded}, expected expires_at_ms {now_ms + 60_000}"
        for bad in (0, 7200):
            r = await _submit(c, f"k-bad-{bad}", validity_s=bad)
            assert r.status_code == 400, f"validity_s={bad} answered {r.status_code}, expected 400: the window is 1 to 3600 s"
        ctx.clock.advance(61)
        late = await _submit(c, "k-1")
    assert late.status_code == 410 and late.json().get("state") == "expired", f"a replay after the window answered {late.status_code} {late.text}, expected 410 with state expired"
    assert len(_queue(ctx)) == 1, f"the delivery queue holds {len(_queue(ctx))} commands: neither a refused nor an expired command may be queued"


async def check_rate_limit(ctx):
    async with _api(ctx) as c:
        for n in range(10):
            r = await _submit(c, f"k-{n}")
            assert _ok(r), f"command {n + 1} of 10 within one minute answered {r.status_code}: {r.text}"
        over = await _submit(c, "k-10")
        assert over.status_code == 429, f"the 11th command for {LOCK} within a minute answered {over.status_code}, expected 429: one integration can flood a device"
        assert len(_queue(ctx)) == 10, f"{len(_queue(ctx))} commands reached the delivery queue: a refused command must not be queued"
        other = await _submit(c, "k-0", device="lock-9")
        assert _ok(other), f"another device's first command answered {other.status_code}: the budget is per device"
        ctx.clock.advance(60)
        later = await _submit(c, "k-11")
    assert _ok(later), f"a command in the next minute answered {later.status_code}: the window must roll over"


async def check_ack(ctx):
    async with _api(ctx) as c:
        r = await _submit(c, "k-1", ack_required=True)
        fire = await _submit(c, "k-2", ack_required=False)
    assert r.status_code == 202 and r.json().get("state") == "pending_ack", f"a command that expects an acknowledgement answered {r.status_code} with state {r.json().get('state')!r}, expected 202 pending_ack: nothing has run on the device yet"
    assert fire.status_code == 202 and fire.json().get("state") == "queued", f"a command without acknowledgement answered {fire.status_code} with state {fire.json().get('state')!r}, expected 202 queued"
    stored = commands.lookup(LOCK, "k-1")
    assert stored is not None and stored["state"] == "pending_ack" and stored["ack_required"] is True, f"the command store holds {stored} under ({LOCK}, k-1), expected state pending_ack with ack_required"
`,
    typescript: `const LOCK = 'lock-7';

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), commands: ctx.load('/support/iothub/commands.ts')};
}

const queue = (ctx, device = LOCK): string[] => ctx.redis.lrange(\`device:\${device}:queue\`, 0, -1);

const submit = (c, idempotencyId = 'k-1', extra: Record<string, unknown> = {}, device = LOCK) =>
  c.post(\`/v1/devices/\${device}/commands\`, {
    json: {idempotency_id: idempotencyId, action: 'unlock', params: {duration_s: '5'}, validity_s: 60, ack_required: true, ...extra},
  });

const ok = (r): boolean => r.status >= 200 && r.status < 300;

export async function check_route(ctx) {
  const {c} = api(ctx);
  const r = await submit(c);
  assert(ok(r), \`POST /v1/devices/\${LOCK}/commands answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.command_id && body.device_id === LOCK && body.action === 'unlock', \`the response must carry the command's id, device and action, got \${r.text}\`);
  assert.deepEqual(queue(ctx), [body.command_id], \`the delivery queue of \${LOCK} holds \${JSON.stringify(queue(ctx))}, expected the new command\`);
}

export async function check_identity(ctx) {
  const {c, commands} = api(ctx);
  const first = await submit(c, 'k-1');
  const replay = await submit(c, 'k-1');
  const other = await submit(c, 'k-1', {}, 'lock-9');
  assert(ok(first) && ok(replay), \`the request and its replay answered \${first.status} and \${replay.status}\`);
  const a = first.json();
  const b = replay.json();
  assert.equal(b.command_id, a.command_id, \`a replay of idempotency_id k-1 answered command \${b.command_id}, the first request \${a.command_id}: a replay must answer the recorded command\`);
  assert.equal(queue(ctx).length, 1, \`two requests with idempotency_id k-1 queued \${queue(ctx).length} commands for \${LOCK}: the door unlocks once per request\`);
  const recorded = await commands.lookup(LOCK, 'k-1');
  assert(recorded !== null && recorded.command_id === a.command_id, \`the command store holds \${JSON.stringify(recorded)} under (\${LOCK}, k-1), expected the command recorded under the caller's idempotency id\`);
  assert(other.json().command_id !== a.command_id && queue(ctx, 'lock-9').length === 1, 'the same idempotency_id on another device is another command: the key is (device, idempotency_id)');
}

export async function check_window(ctx) {
  const {c, commands} = api(ctx);
  const nowMs = ctx.clock.now();
  let r = await submit(c, 'k-1', {validity_s: 60});
  assert(ok(r), \`a command with validity_s=60 answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().expires_at_ms, nowMs + 60_000, \`a command with validity_s=60 answered expires_at_ms=\${r.json().expires_at_ms}, expected now + 60 s: without a window a command for an offline lock fires whenever it reconnects\`);
  const recorded = await commands.lookup(LOCK, 'k-1');
  assert(recorded !== null && recorded.expires_at_ms === nowMs + 60_000, \`the command store holds \${JSON.stringify(recorded)}, expected expires_at_ms \${nowMs + 60_000}\`);
  for (const bad of [0, 7200]) {
    r = await submit(c, \`k-bad-\${bad}\`, {validity_s: bad});
    assert.equal(r.status, 400, \`validity_s=\${bad} answered \${r.status}, expected 400: the window is 1 to 3600 s\`);
  }
  ctx.clock.advance(61);
  const late = await submit(c, 'k-1');
  assert(late.status === 410 && late.json().state === 'expired', \`a replay after the window answered \${late.status} \${late.text}, expected 410 with state expired\`);
  assert.equal(queue(ctx).length, 1, \`the delivery queue holds \${queue(ctx).length} commands: neither a refused nor an expired command may be queued\`);
}

export async function check_rate_limit(ctx) {
  const {c} = api(ctx);
  for (let n = 0; n < 10; n += 1) {
    const r = await submit(c, \`k-\${n}\`);
    assert(ok(r), \`command \${n + 1} of 10 within one minute answered \${r.status}: \${r.text}\`);
  }
  const over = await submit(c, 'k-10');
  assert.equal(over.status, 429, \`the 11th command for \${LOCK} within a minute answered \${over.status}, expected 429: one integration can flood a device\`);
  assert.equal(queue(ctx).length, 10, \`\${queue(ctx).length} commands reached the delivery queue: a refused command must not be queued\`);
  const other = await submit(c, 'k-0', {}, 'lock-9');
  assert(ok(other), \`another device's first command answered \${other.status}: the budget is per device\`);
  ctx.clock.advance(60);
  const later = await submit(c, 'k-11');
  assert(ok(later), \`a command in the next minute answered \${later.status}: the window must roll over\`);
}

export async function check_ack(ctx) {
  const {c, commands} = api(ctx);
  const r = await submit(c, 'k-1', {ack_required: true});
  const fire = await submit(c, 'k-2', {ack_required: false});
  assert(r.status === 202 && r.json().state === 'pending_ack', \`a command that expects an acknowledgement answered \${r.status} with state \${r.json().state}, expected 202 pending_ack: nothing has run on the device yet\`);
  assert(fire.status === 202 && fire.json().state === 'queued', \`a command without acknowledgement answered \${fire.status} with state \${fire.json().state}, expected 202 queued\`);
  const stored = await commands.lookup(LOCK, 'k-1');
  assert(stored !== null && stored.state === 'pending_ack' && stored.ack_required === true, \`the command store holds \${JSON.stringify(stored)} under (\${LOCK}, k-1), expected state pending_ack with ack_required\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"

	"iothub/commands"

	"leetbuild/harness"
)

const lockID = "lock-7"

type commandReply struct {
	CommandID   string \`json:"command_id"\`
	DeviceID    string \`json:"device_id"\`
	Action      string \`json:"action"\`
	State       string \`json:"state"\`
	ExpiresAtMs int64  \`json:"expires_at_ms"\`
	AckRequired bool   \`json:"ack_required"\`
}

func commandsAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func submitTo(c *harness.HTTP, device, idempotencyID string, extra map[string]any) *harness.Response {
	body := map[string]any{"idempotency_id": idempotencyID, "action": "unlock", "params": map[string]string{"duration_s": "5"}, "validity_s": 60, "ack_required": true}
	for k, v := range extra {
		body[k] = v
	}
	return c.Post("/v1/devices/"+device+"/commands", body)
}

func replyOf(r *harness.Response) commandReply {
	var body commandReply
	r.Decode(&body)
	return body
}

func isOK(r *harness.Response) bool { return r.Status >= 200 && r.Status < 300 }

func queueOf(ctx *harness.Ctx, device string) []string { return ctx.Redis.LRange("device:"+device+":queue", 0, -1) }

func CheckRoute(ctx *harness.Ctx) {
	c := commandsAPI(ctx)
	r := submitTo(c, lockID, "k-1", nil)
	ctx.Assert(isOK(r), "POST /v1/devices/%s/commands answered %d: %s", lockID, r.Status, r.Text())
	body := replyOf(r)
	ctx.Assert(body.CommandID != "" && body.DeviceID == lockID && body.Action == "unlock", "the response must carry the command's id, device and action, got %s", r.Text())
	ctx.Equal(queueOf(ctx, lockID), []string{body.CommandID}, "the delivery queue of %s must hold the new command", lockID)
}

func CheckIdentity(ctx *harness.Ctx) {
	c := commandsAPI(ctx)
	first := submitTo(c, lockID, "k-1", nil)
	replay := submitTo(c, lockID, "k-1", nil)
	other := submitTo(c, "lock-9", "k-1", nil)
	ctx.Assert(isOK(first) && isOK(replay), "the request and its replay answered %d and %d", first.Status, replay.Status)
	a, b := replyOf(first), replyOf(replay)
	ctx.Assert(b.CommandID == a.CommandID, "a replay of idempotency_id k-1 answered command %s, the first request %s: a replay must answer the recorded command", b.CommandID, a.CommandID)
	ctx.Equal(len(queueOf(ctx, lockID)), 1, "two requests with idempotency_id k-1 must queue one command (the door unlocks once per request); the queued commands")
	recorded, err := commands.Lookup(context.Background(), lockID, "k-1")
	ctx.NoError(err, "commands.Lookup")
	ctx.Assert(recorded != nil && recorded.CommandID == a.CommandID, "the command store holds %+v under (%s, k-1), expected the command recorded under the caller's idempotency id", recorded, lockID)
	ctx.Assert(replyOf(other).CommandID != a.CommandID && len(queueOf(ctx, "lock-9")) == 1, "the same idempotency_id on another device is another command: the key is (device, idempotency_id)")
}

func CheckWindow(ctx *harness.Ctx) {
	c := commandsAPI(ctx)
	nowMs := ctx.Clock.Now()
	r := submitTo(c, lockID, "k-1", map[string]any{"validity_s": 60})
	ctx.Assert(isOK(r), "a command with validity_s=60 answered %d: %s", r.Status, r.Text())
	ctx.Equal(replyOf(r).ExpiresAtMs, nowMs+60_000, "a command with validity_s=60 must answer expires_at_ms = now + 60 s (without a window a command for an offline lock fires whenever it reconnects); expires_at_ms")
	recorded, err := commands.Lookup(context.Background(), lockID, "k-1")
	ctx.NoError(err, "commands.Lookup")
	ctx.Assert(recorded != nil && recorded.ExpiresAtMs == nowMs+60_000, "the command store holds %+v, expected expires_at_ms %d", recorded, nowMs+60_000)
	for _, bad := range []int{0, 7200} {
		r = submitTo(c, lockID, fmt.Sprintf("k-bad-%d", bad), map[string]any{"validity_s": bad})
		ctx.Equal(r.Status, 400, "validity_s=%d must be refused (the window is 1 to 3600 s); the status", bad)
	}
	ctx.Clock.Advance(61)
	late := submitTo(c, lockID, "k-1", nil)
	ctx.Assert(late.Status == 410 && replyOf(late).State == "expired", "a replay after the window answered %d %s, expected 410 with state expired", late.Status, late.Text())
	ctx.Equal(len(queueOf(ctx, lockID)), 1, "neither a refused nor an expired command may be queued; the queued commands")
}

func CheckRateLimit(ctx *harness.Ctx) {
	c := commandsAPI(ctx)
	for n := 0; n < 10; n++ {
		r := submitTo(c, lockID, fmt.Sprintf("k-%d", n), nil)
		ctx.Assert(isOK(r), "command %d of 10 within one minute answered %d: %s", n+1, r.Status, r.Text())
	}
	over := submitTo(c, lockID, "k-10", nil)
	ctx.Equal(over.Status, 429, "the 11th command for %s within a minute must be refused (one integration can flood a device); the status", lockID)
	ctx.Equal(len(queueOf(ctx, lockID)), 10, "a refused command must not be queued; the queued commands")
	other := submitTo(c, "lock-9", "k-0", nil)
	ctx.Assert(isOK(other), "another device's first command answered %d: the budget is per device", other.Status)
	ctx.Clock.Advance(60)
	later := submitTo(c, lockID, "k-11", nil)
	ctx.Assert(isOK(later), "a command in the next minute answered %d: the window must roll over", later.Status)
}

func CheckAck(ctx *harness.Ctx) {
	c := commandsAPI(ctx)
	r := submitTo(c, lockID, "k-1", map[string]any{"ack_required": true})
	fire := submitTo(c, lockID, "k-2", map[string]any{"ack_required": false})
	ctx.Assert(r.Status == 202 && replyOf(r).State == "pending_ack", "a command that expects an acknowledgement answered %d %s, expected 202 with state pending_ack: nothing has run on the device yet", r.Status, r.Text())
	ctx.Assert(fire.Status == 202 && replyOf(fire).State == "queued", "a command without acknowledgement answered %d %s, expected 202 with state queued", fire.Status, fire.Text())
	stored, err := commands.Lookup(context.Background(), lockID, "k-1")
	ctx.NoError(err, "commands.Lookup")
	ctx.Assert(stored != nil && stored.State == "pending_ack" && stored.AckRequired, "the command store holds %+v under (%s, k-1), expected state pending_ack with ack_required", stored, lockID)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "iothub/commands.h"

namespace {

const std::string kLock = "lock-7";

harness::HTTP commandsApi(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response submitTo(harness::HTTP& c, const std::string& device, const std::string& idempotency_id,
                           const nlohmann::json& extra = nlohmann::json::object()) {
  nlohmann::json body = {{"idempotency_id", idempotency_id}, {"action", "unlock"}, {"params", {{"duration_s", "5"}}},
                         {"validity_s", 60},                 {"ack_required", true}};
  body.update(extra);
  return c.Post("/v1/devices/" + device + "/commands", body.dump(), "Content-Type", "application/json");
}

nlohmann::json bodyOf(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : nlohmann::json::object();
}

std::string textOf(const nlohmann::json& body, const std::string& field) {
  return body.contains(field) && body[field].is_string() ? body[field].get<std::string>() : "";
}

bool isOk(const harness::Response& r) { return r.Status >= 200 && r.Status < 300; }

std::vector<std::string> queueOf(harness::Ctx& ctx, const std::string& device) {
  return ctx.Redis.LRange("device:" + device + ":queue", 0, -1);
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = commandsApi(ctx);
  const auto r = submitTo(c, kLock, "k-1");
  ctx.Assert(isOk(r), "POST /v1/devices/%s/commands answered %d: %s", kLock, r.Status, r.Text());
  const auto body = bodyOf(r);
  ctx.Assert(!textOf(body, "command_id").empty() && textOf(body, "device_id") == kLock && textOf(body, "action") == "unlock",
             "the response must carry the command's id, device and action, got %s", r.Text());
  ctx.Equal(queueOf(ctx, kLock), std::vector<std::string>{textOf(body, "command_id")}, "the delivery queue of %s must hold the new command", kLock);
}

void CheckIdentity(harness::Ctx& ctx) {
  auto c = commandsApi(ctx);
  const auto first = submitTo(c, kLock, "k-1");
  const auto replay = submitTo(c, kLock, "k-1");
  const auto other = submitTo(c, "lock-9", "k-1");
  ctx.Assert(isOk(first) && isOk(replay), "the request and its replay answered %d and %d", first.Status, replay.Status);
  const std::string a = textOf(bodyOf(first), "command_id");
  const std::string b = textOf(bodyOf(replay), "command_id");
  ctx.Assert(a == b, "a replay of idempotency_id k-1 answered command %s, the first request %s: a replay must answer the recorded command", b, a);
  ctx.Equal(queueOf(ctx, kLock).size(), 1, "two requests with idempotency_id k-1 must queue one command (the door unlocks once per request); the queued commands");
  const auto recorded = commands::lookup(kLock, "k-1");
  ctx.Assert(recorded && recorded->command_id == a, "the command store holds %q under (%s, k-1), expected the command recorded under the caller's idempotency id",
             recorded ? recorded->command_id : std::string("nothing"), kLock);
  ctx.Assert(textOf(bodyOf(other), "command_id") != a && queueOf(ctx, "lock-9").size() == 1,
             "the same idempotency_id on another device is another command: the key is (device, idempotency_id)");
}

void CheckWindow(harness::Ctx& ctx) {
  auto c = commandsApi(ctx);
  const int64_t now_ms = ctx.Clock.Now();
  auto r = submitTo(c, kLock, "k-1", {{"validity_s", 60}});
  ctx.Assert(isOk(r), "a command with validity_s=60 answered %d: %s", r.Status, r.Text());
  ctx.Equal(bodyOf(r).value("expires_at_ms", 0LL), now_ms + 60000,
            "a command with validity_s=60 must answer expires_at_ms = now + 60 s (without a window a command for an offline lock fires whenever it reconnects); expires_at_ms");
  const auto recorded = commands::lookup(kLock, "k-1");
  ctx.Assert(recorded && recorded->expires_at_ms == now_ms + 60000, "the command store holds expires_at_ms %d, expected %d",
             recorded ? recorded->expires_at_ms : 0LL, now_ms + 60000);
  for (const int bad : {0, 7200}) {
    r = submitTo(c, kLock, "k-bad-" + std::to_string(bad), {{"validity_s", bad}});
    ctx.Equal(r.Status, 400, "validity_s=%d must be refused (the window is 1 to 3600 s); the status", bad);
  }
  ctx.Clock.Advance(61);
  const auto late = submitTo(c, kLock, "k-1");
  ctx.Assert(late.Status == 410 && textOf(bodyOf(late), "state") == "expired", "a replay after the window answered %d %s, expected 410 with state expired",
             late.Status, late.Text());
  ctx.Equal(queueOf(ctx, kLock).size(), 1, "neither a refused nor an expired command may be queued; the queued commands");
}

void CheckRateLimit(harness::Ctx& ctx) {
  auto c = commandsApi(ctx);
  for (int n = 0; n < 10; n++) {
    const auto r = submitTo(c, kLock, "k-" + std::to_string(n));
    ctx.Assert(isOk(r), "command %d of 10 within one minute answered %d: %s", n + 1, r.Status, r.Text());
  }
  const auto over = submitTo(c, kLock, "k-10");
  ctx.Equal(over.Status, 429, "the 11th command for %s within a minute must be refused (one integration can flood a device); the status", kLock);
  ctx.Equal(queueOf(ctx, kLock).size(), 10, "a refused command must not be queued; the queued commands");
  const auto other = submitTo(c, "lock-9", "k-0");
  ctx.Assert(isOk(other), "another device's first command answered %d: the budget is per device", other.Status);
  ctx.Clock.Advance(60);
  const auto later = submitTo(c, kLock, "k-11");
  ctx.Assert(isOk(later), "a command in the next minute answered %d: the window must roll over", later.Status);
}

void CheckAck(harness::Ctx& ctx) {
  auto c = commandsApi(ctx);
  const auto r = submitTo(c, kLock, "k-1", {{"ack_required", true}});
  const auto fire = submitTo(c, kLock, "k-2", {{"ack_required", false}});
  ctx.Assert(r.Status == 202 && textOf(bodyOf(r), "state") == "pending_ack",
             "a command that expects an acknowledgement answered %d %s, expected 202 with state pending_ack: nothing has run on the device yet", r.Status, r.Text());
  ctx.Assert(fire.Status == 202 && textOf(bodyOf(fire), "state") == "queued", "a command without acknowledgement answered %d %s, expected 202 with state queued",
             fire.Status, fire.Text());
  const auto stored = commands::lookup(kLock, "k-1");
  ctx.Assert(stored && stored->state == "pending_ack" && stored->ack_required, "the command store holds state %q under (%s, k-1), expected pending_ack with ack_required",
             stored ? stored->state : std::string("nothing"), kLock);
}
`,
  },
  hints: [
    "Send an unlock twice with the same `idempotency_id`: the lock's delivery queue holds two commands, and both responses say `executed` although the lock has not answered either.",
    "Every request mints a new id and records the command under it, so nothing ever finds the first request. Nothing turns `validity_s` into a deadline or counts the device's commands, and the state is written before any device has spoken.",
    '`lookup(device_id, idempotency_id)` first: answer it, or 410 past `expires_at_ms`. Then 400 outside 1..3600, 429 when `count_in_window(device_id, 60)` passes 10, `record` under the idempotency id with `expires_at_ms` and `pending_ack`, enqueue, 202.',
  ],
  debrief: `The idempotency id is the caller's name for one intent, so it is the key and a server-minted id is only the record's label: a retry finds the first record and answers it, and nothing reaches the queue twice. The window lives on the record because a command can outlive its request by days; whatever delivers it later (step 3) reads \`expires_at_ms\` instead of guessing. The rate check runs after the replay lookup and before the queue, so replays are free and a refused command costs the device nothing. Production hubs expire the idempotency record some time after the longest window, budget commands per action class rather than per device alone, and let an operator cancel a queued command before the device sees it.`,
};
