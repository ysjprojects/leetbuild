import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/devices/{id}/commands: commands that carry their identity',
  concept: 'http',
  file: 'api',
  focus: ['client', 'hub', 'gateway'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and answers with a command id. It compiles, it serves the demo, and it hides three
production flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/devices/{id}/commands\`, the only way a command enters the fleet.

- The body is \`{"idempotency_id": "…", "action": "unlock", "validity_s": 300, "ack_required": true}\`;
  the device id comes from the path and the caller's tenant from \`X-Tenant-Id\`.
- \`idempotency_id\` identifies the **command**, not the request: a replay with the same
  \`(device_id, idempotency_id)\` must return the recorded command and **never execute it a second
  time** — a door that unlocks twice is the failure this field exists to prevent. Look the command up
  before you execute anything and store it under the same pair.
- The **validity window** bounds the command's life: store \`expires_at = now + validity_s\` (accept
  \`validity_s\` in **1..3600**, \`400\` otherwise) and discard a command whose window has closed
  **unexecuted** — replaying it after the window reports \`state: "expired"\` (\`410\`), not a second
  execution. The draft keeps no window, so a command accepted for a device that is offline for days
  fires long after the operator changed their mind.
- The command rate is **per device**, not per caller: at most **10** commands per device per
  **60-second** window, counted in a window key, with \`429\` when the device's budget is spent —
  before the command reaches the gateway. One integration must not be able to flood a device.
- The command carries an expected **acknowledgment**: record \`ack_required\` and return the command
  in \`state: "pending_ack"\` (\`queued\` when no acknowledgment is expected), so "accepted" is never
  confused with "executed".

**Failure mode the checks target.** The draft mints a fresh \`command_id\` per request and ignores the
caller's idempotency id, so a retried delivery executes the side effect twice; it stores no validity
window, so a command for an offline device fires days late; and it applies no per-device limit, so one
misbehaving integration can enqueue unbounded work onto a single device. Each defect is invisible in a
demo that sends one well-formed request and never retries.`,
  sequence: {
    participants: ['Operator', 'IoT Hub', 'Command Store'],
    messages: [
      {
        from: 'Operator',
        to: 'IoT Hub',
        label: 'POST /v1/devices/{id}/commands · idempotency_id · validity_s',
        kind: 'sync',
      },
      {from: 'IoT Hub', to: 'IoT Hub', label: 'rate limit device · compute expires_at', kind: 'sync'},
      {from: 'IoT Hub', to: 'Command Store', label: 'get(device_id, idempotency_id)', kind: 'sync'},
      {from: 'Command Store', to: 'IoT Hub', label: 'recorded command / none', kind: 'reply'},
      {from: 'IoT Hub', to: 'Command Store', label: 'put(device_id, idempotency_id, command)', kind: 'async'},
      {
        from: 'IoT Hub',
        to: 'Operator',
        label: '202 {command_id, state: pending_ack, expires_at}',
        kind: 'reply',
      },
      {
        from: 'IoT Hub',
        to: 'IoT Hub',
        label: 'window closed → expired, discarded unexecuted',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'The idempotency id is the command’s identity, not a convenience: look it up under `(device_id, idempotency_id)` **before** you execute anything. A hit returns the recorded command; a miss stores the new one. Keying by a generated `command_id` — or by nothing — makes every retry a fresh command.',
    'The validity window is a deadline, not a suggestion: compute `expires_at = now + validity_s`, store it with the command, and compare against it before execution. A command whose window has closed is discarded unexecuted, and a replay after the window reports `expired` instead of executing again.',
    'Rate limiting is per device, not per caller: count commands in a window key (`commands:{device_id}:{window}` with `window = floor(now / 60)`), set its expiry with the window, and answer `429` when the device’s budget is spent — before the command reaches the gateway.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/devices/{id}/commands',
      detail: 'Register the command route on `POST /v1/devices/{id}/commands`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/devices\/\{[^}]+\}\/commands["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/devices\/:id\/commands['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/devices\/\{id\}\/commands"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"devices"\s*\/\s*Segment\s*\/\s*"commands"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*R"\(\/v1\/devices\//, /commands\)"/]},
      },
    },
    {
      id: 'identity',
      title: 'Keys the command by its per-device idempotency id',
      detail:
        'The command is looked up and stored under `(device_id, idempotency_id)` before execution, so a replay returns the recorded command instead of executing it again. The draft mints a fresh id per request and ignores the caller’s idempotency id.',
      match: {
        python: {all: [/idempotency_id/, /command_store\.get\(/, /command_store\.put\(/]},
        typescript: {all: [/idempotency_id/, /commandStore\.get\(/, /commandStore\.put\(/]},
        go: {all: [/IdempotencyID|idempotency_id/, /commandStore\.Get\(/, /commandStore\.Put\(/]},
        scala: {all: [/idempotency_id/, /commandStore\.get\(/, /commandStore\.put\(/]},
        cpp: {all: [/idempotency_id/, /commandStore\.get\(/, /commandStore\.put\(/]},
      },
    },
    {
      id: 'window',
      title: 'Discards commands past their validity window',
      detail:
        'The command carries `expires_at = now + validity_s`; a command whose window has closed is discarded unexecuted and a replay after the window reports `expired`. The draft stores no window at all, so a command fires days late.',
      match: {
        python: {all: [/expires_at/, /expired/, /time\.time\(\)/]},
        typescript: {all: [/expires_at/, /expired|Expired/, /Date\.now\(\)/]},
        go: {all: [/ExpiresAt/, /expired|Expired/, /time\.Now\(\)/]},
        scala: {all: [/expires_at/, /expired|Expired/, /System\.currentTimeMillis\(\)/]},
        cpp: {all: [/expires_at/, /expired|Expired/, /system_clock::now\(\)/]},
      },
    },
    {
      id: 'rate-limit',
      title: 'Enforces a per-device command rate',
      detail:
        'Commands are counted per device in a 60-second window and the device gets `429` when its budget is spent — before any gateway work. The draft applies no per-device limit, so one caller can flood a device.',
      match: {
        python: {all: [/COMMAND_RATE_LIMIT/, /status_code\s*=\s*429/]},
        typescript: {all: [/COMMAND_RATE_LIMIT/, /code\(\s*429\s*\)/]},
        go: {all: [/commandRateLimit/, /StatusTooManyRequests|\b429\b/]},
        scala: {all: [/CommandRateLimit/, /TooManyRequests|\b429\b/]},
        cpp: {all: [/kCommandRateLimit/, /status\s*=\s*429/]},
      },
    },
    {
      id: 'ack',
      title: 'Tracks the expected acknowledgment',
      detail:
        'The command records `ack_required` and is returned as `pending_ack` (`queued` when no acknowledgment is expected), so "accepted" is never confused with "executed". The draft returns `executed` immediately.',
      match: {
        python: {all: [/ack_required/, /pending_ack/]},
        typescript: {all: [/ack_required/, /pending_ack/]},
        go: {all: [/ack_required/, /pending_ack/]},
        scala: {all: [/ack_required/, /pending_ack/]},
        cpp: {all: [/ack_required/, /pending_ack/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class CommandRequest(BaseModel):
    idempotency_id: str
    action: str
    validity_s: int = 300
    ack_required: bool = True


class CommandStore:
    def record(self, device_id: str, command: dict) -> None:
        """Store the accepted command."""
        raise NotImplementedError


command_store = CommandStore()


@app.post("/v1/devices/{device_id}/commands")
def submit_command(
    device_id: str,
    body: CommandRequest,
    tenant: str = Header(alias="X-Tenant-Id"),
) -> JSONResponse:
    # TODO: this draft ignores the command's idempotency id so a replay executes twice, keeps no
    # validity window so an old command fires days late, and applies no per-device rate limit so one
    # caller can flood the device. Review all three.
    command_id = str(uuid.uuid4())
    command_store.record(device_id, {"command_id": command_id, "action": body.action})
    return JSONResponse({"command_id": command_id, "state": "executed"}, status_code=200)
`,
      solution: `import time
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

COMMAND_RATE_LIMIT = 10
RATE_WINDOW_S = 60
MIN_VALIDITY_S = 1
MAX_VALIDITY_S = 3600


class CommandRequest(BaseModel):
    idempotency_id: str
    action: str
    validity_s: int = 300
    ack_required: bool = True


class CommandStore:
    def get(self, device_id: str, idempotency_id: str) -> dict | None:
        """The command already recorded for (device_id, idempotency_id), if any."""
        raise NotImplementedError

    def put(self, device_id: str, idempotency_id: str, command: dict) -> None:
        """Record the command under (device_id, idempotency_id)."""
        raise NotImplementedError

    def incr_rate(self, device_id: str, window: int) -> int:
        """Count this command in the device's window and return the new total."""
        raise NotImplementedError


command_store = CommandStore()


def is_expired(command: dict, now: float) -> bool:
    return now >= command["expires_at"]


@app.post("/v1/devices/{device_id}/commands")
def submit_command(
    device_id: str,
    body: CommandRequest,
    tenant: str = Header(alias="X-Tenant-Id"),
) -> JSONResponse:
    if body.idempotency_id == "":
        raise HTTPException(status_code=400, detail="idempotency_id is required")
    if not MIN_VALIDITY_S <= body.validity_s <= MAX_VALIDITY_S:
        raise HTTPException(status_code=400, detail="validity_s must be 1..3600")

    window = int(time.time()) // RATE_WINDOW_S
    used = command_store.incr_rate(device_id, window)
    if used > COMMAND_RATE_LIMIT:
        raise HTTPException(status_code=429, detail="too many commands for this device")

    now = time.time()
    stored = command_store.get(device_id, body.idempotency_id)
    if stored is not None:
        if is_expired(stored, now):
            # The window closed before the replay: the command is discarded, never executed again.
            return JSONResponse({"command_id": stored["command_id"], "state": "expired"}, status_code=410)
        return JSONResponse(stored, status_code=200)

    command = {
        "command_id": str(uuid.uuid4()),
        "device_id": device_id,
        "action": body.action,
        "ack_required": body.ack_required,
        "expires_at": now + body.validity_s,
        "state": "pending_ack" if body.ack_required else "queued",
    }
    command_store.put(device_id, body.idempotency_id, command)
    return JSONResponse(command, status_code=202)
`,
    },
    typescript: {
      starter: `/** POST /v1/devices/{id}/commands: a model-generated draft that trusts the caller. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

interface CommandBody {
  idempotency_id: string;
  action: string;
  validity_s?: number;
  ack_required?: boolean;
}

interface CommandStore {
  record(deviceId: string, command: Record<string, unknown>): Promise<void>;
}

const commandStore: CommandStore = {
  async record(): Promise<void> {
    throw new Error('not implemented');
  },
};

app.post('/v1/devices/:id/commands', async (request, reply) => {
  // TODO: this draft ignores the command's idempotency id so a replay executes twice, keeps no
  // validity window so an old command fires days late, and applies no per-device rate limit so one
  // caller can flood the device. Review all three.
  const deviceId = request.params['id'] as string;
  const body = request.body as CommandBody;
  const commandId = randomUUID();
  await commandStore.record(deviceId, {command_id: commandId, action: body.action});
  return reply.code(200).send({command_id: commandId, state: 'executed'});
});

void app.listen({port: 8080, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/devices/{id}/commands: identity, window and per-device rate enforced. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const COMMAND_RATE_LIMIT = 10;
const RATE_WINDOW_S = 60;
const MIN_VALIDITY_S = 1;
const MAX_VALIDITY_S = 3600;

interface CommandBody {
  idempotency_id: string;
  action: string;
  validity_s?: number;
  ack_required?: boolean;
}

interface Command {
  command_id: string;
  device_id: string;
  action: string;
  ack_required: boolean;
  expires_at: number;
  state: string;
}

class CommandStore {
  async get(deviceId: string, idempotencyId: string): Promise<Command | null> {
    void deviceId;
    void idempotencyId;
    return null;
  }

  async put(deviceId: string, idempotencyId: string, command: Command): Promise<void> {
    void deviceId;
    void idempotencyId;
    void command;
  }

  async incrRate(deviceId: string, window: number): Promise<number> {
    void deviceId;
    void window;
    return 1;
  }
}

const commandStore = new CommandStore();

function isExpired(command: Command, now: number): boolean {
  return now >= command.expires_at;
}

app.post('/v1/devices/:id/commands', async (request, reply) => {
  const deviceId = request.params['id'] as string;
  const body = request.body as CommandBody;
  if (typeof body.idempotency_id !== 'string' || body.idempotency_id === '')
    return reply.code(400).send({error: 'idempotency_id is required'});
  const validityS = body.validity_s ?? 300;
  if (!Number.isInteger(validityS) || validityS < MIN_VALIDITY_S || validityS > MAX_VALIDITY_S)
    return reply.code(400).send({error: 'validity_s must be 1..3600'});

  const window = Math.floor(Date.now() / 1000 / RATE_WINDOW_S);
  const used = await commandStore.incrRate(deviceId, window);
  if (used > COMMAND_RATE_LIMIT) return reply.code(429).send({error: 'too many commands for this device'});

  const now = Date.now();
  const stored = await commandStore.get(deviceId, body.idempotency_id);
  if (stored !== null) {
    if (isExpired(stored, now))
      return reply.code(410).send({command_id: stored.command_id, state: 'expired'});
    return reply.code(200).send(stored);
  }

  const ackRequired = body.ack_required ?? true;
  const command: Command = {
    command_id: randomUUID(),
    device_id: deviceId,
    action: body.action,
    ack_required: ackRequired,
    expires_at: now + validityS * 1000,
    state: ackRequired ? 'pending_ack' : 'queued',
  };
  await commandStore.put(deviceId, body.idempotency_id, command);
  return reply.code(202).send(command);
});

void app.listen({port: 8080, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

type CommandRequest struct {
	IdempotencyID string \`json:"idempotency_id"\`
	Action        string \`json:"action"\`
	ValidityS     int    \`json:"validity_s"\`
	AckRequired   bool   \`json:"ack_required"\`
}

type CommandStore struct{}

func (s *CommandStore) Record(deviceID string, command map[string]any) error {
	return nil
}

var commandStore = &CommandStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func submitCommand(rw http.ResponseWriter, r *http.Request) {
	deviceID := r.PathValue("id")
	var body CommandRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft ignores the command's idempotency id so a replay executes twice, keeps no
	// validity window so an old command fires days late, and applies no per-device rate limit so one
	// caller can flood the device. Review all three.
	commandID := uuid.NewString()
	_ = commandStore.Record(deviceID, map[string]any{"command_id": commandID, "action": body.Action})
	writeJSON(rw, http.StatusOK, map[string]any{"command_id": commandID, "state": "executed"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/devices/{id}/commands", submitCommand)
	log.Fatal(http.ListenAndServe(":8080", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
)

const (
	commandRateLimit = 10
	rateWindowS      = 60
	minValidityS     = 1
	maxValidityS     = 3600
)

type CommandRequest struct {
	IdempotencyID string \`json:"idempotency_id"\`
	Action        string \`json:"action"\`
	ValidityS     int    \`json:"validity_s"\`
	AckRequired   bool   \`json:"ack_required"\`
}

type Command struct {
	CommandID   string \`json:"command_id"\`
	DeviceID    string \`json:"device_id"\`
	Action      string \`json:"action"\`
	AckRequired bool   \`json:"ack_required"\`
	ExpiresAt   int64  \`json:"expires_at"\`
	State       string \`json:"state"\`
}

type CommandStore struct{}

func (s *CommandStore) Get(deviceID, idempotencyID string) (*Command, error) {
	return nil, nil
}

func (s *CommandStore) Put(deviceID, idempotencyID string, command Command) error {
	return nil
}

func (s *CommandStore) IncrRate(deviceID string, window int64) (int, error) {
	return 1, nil
}

var commandStore = &CommandStore{}

func isExpired(command Command, now time.Time) bool {
	return now.UnixMilli() >= command.ExpiresAt
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func submitCommand(rw http.ResponseWriter, r *http.Request) {
	deviceID := r.PathValue("id")
	var body CommandRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.IdempotencyID == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "idempotency_id is required"})
		return
	}
	if body.ValidityS < minValidityS || body.ValidityS > maxValidityS {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "validity_s must be 1..3600"})
		return
	}
	window := time.Now().Unix() / rateWindowS
	used, err := commandStore.IncrRate(deviceID, window)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if used > commandRateLimit {
		writeJSON(rw, http.StatusTooManyRequests, map[string]string{"error": "too many commands for this device"})
		return
	}
	now := time.Now()
	stored, err := commandStore.Get(deviceID, body.IdempotencyID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		if isExpired(*stored, now) {
			writeJSON(rw, http.StatusGone, map[string]any{"command_id": stored.CommandID, "state": "expired"})
			return
		}
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	command := Command{
		CommandID:   uuid.NewString(),
		DeviceID:    deviceID,
		Action:      body.Action,
		AckRequired: body.AckRequired,
		ExpiresAt:   now.Add(time.Duration(body.ValidityS) * time.Second).UnixMilli(),
		State:       "pending_ack",
	}
	if !body.AckRequired {
		command.State = "queued"
	}
	if err := commandStore.Put(deviceID, body.IdempotencyID, command); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusAccepted, command)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/devices/{id}/commands", submitCommand)
	log.Fatal(http.ListenAndServe(":8080", mux))
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

final case class CommandRequest(idempotency_id: String, action: String, validity_s: Int, ack_required: Boolean)
final case class Command(command_id: String, action: String, state: String)

object Api {
  implicit val system: ActorSystem = ActorSystem("iot-hub")
  implicit val requestFormat: RootJsonFormat[CommandRequest] = jsonFormat4(CommandRequest)
  implicit val commandFormat: RootJsonFormat[Command] = jsonFormat3(Command)

  val commandStore = CommandStore.open()

  val route: Route =
    path("v1" / "devices" / Segment / "commands") {
      post {
        entity(as[CommandRequest]) { body =>
          // TODO: this draft ignores the command's idempotency id so a replay executes twice, keeps no
          // validity window so an old command fires days late, and applies no per-device rate limit so
          // one caller can flood the device. Review all three.
          complete(StatusCodes.OK, Command(java.util.UUID.randomUUID().toString, body.action, "executed"))
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8080).bind(route)
  }
}
`,
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CommandRequest(idempotency_id: String, action: String, validity_s: Int, ack_required: Boolean)
final case class Command(
    command_id: String,
    device_id: String,
    action: String,
    ack_required: Boolean,
    expires_at: Long,
    state: String)

object Api {
  implicit val system: ActorSystem = ActorSystem("iot-hub")
  implicit val requestFormat: RootJsonFormat[CommandRequest] = jsonFormat4(CommandRequest)
  implicit val commandFormat: RootJsonFormat[Command] = jsonFormat6(Command)

  val CommandRateLimit = 10
  val RateWindowS = 60
  val MinValidityS = 1
  val MaxValidityS = 3600

  val commandStore = CommandStore.open()

  def isExpired(command: Command, now: Long): Boolean = now >= command.expires_at

  val route: Route =
    path("v1" / "devices" / Segment / "commands") { deviceId =>
      post {
        entity(as[CommandRequest]) { body =>
          if (body.idempotency_id.isEmpty) {
            complete(StatusCodes.BadRequest, """{"error":"idempotency_id is required"}""")
          } else if (body.validity_s < MinValidityS || body.validity_s > MaxValidityS) {
            complete(StatusCodes.BadRequest, """{"error":"validity_s must be 1..3600"}""")
          } else {
            val window = System.currentTimeMillis() / 1000 / RateWindowS
            if (commandStore.incrRate(deviceId, window) > CommandRateLimit) {
              complete(StatusCodes.TooManyRequests, """{"error":"too many commands for this device"}""")
            } else {
              val now = System.currentTimeMillis()
              commandStore.get(deviceId, body.idempotency_id) match {
                case Some(stored) =>
                  if (isExpired(stored, now))
                    complete(StatusCodes.Gone, s"""{"command_id":"\${stored.command_id}","state":"expired"}""")
                  else complete(StatusCodes.OK, stored)
                case None =>
                  val ackRequired = body.ack_required
                  val command = Command(
                    UUID.randomUUID().toString,
                    deviceId,
                    body.action,
                    ackRequired,
                    now + body.validity_s * 1000L,
                    if (ackRequired) "pending_ack" else "queued")
                  commandStore.put(deviceId, body.idempotency_id, command)
                  complete(StatusCodes.Accepted, command)
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8080).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

struct CommandStore {
  void record(const std::string& deviceId, const json& command);
};

CommandStore commandStore;
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post(R"(/v1/devices/([^/]+)/commands)", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft ignores the command's idempotency id so a replay executes twice, keeps no
    // validity window so an old command fires days late, and applies no per-device rate limit so one
    // caller can flood the device. Review all three.
    const auto deviceId = req.matches[1].str();
    const auto commandId = uuidString();
    commandStore.record(deviceId, json{{"command_id", commandId}, {"action", body.value("action", "")}});
    res.status = 200;
    res.set_content(json{{"command_id", commandId}, {"state", "executed"}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8080);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <optional>
#include <string>

using json = nlohmann::json;

constexpr int kCommandRateLimit = 10;
constexpr int kRateWindowS = 60;
constexpr int kMinValidityS = 1;
constexpr int kMaxValidityS = 3600;

struct CommandStore {
  std::optional<json> get(const std::string& deviceId, const std::string& idempotencyId);
  void put(const std::string& deviceId, const std::string& idempotencyId, const json& command);
  int incrRate(const std::string& deviceId, long long window);
};

CommandStore commandStore;
std::string uuidString();

bool isExpired(const json& command, long long now) {
  return now >= command.value("expires_at", 0LL);
}

int main() {
  httplib::Server svr;

  svr.Post(R"(/v1/devices/([^/]+)/commands)", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto deviceId = req.matches[1].str();
    const auto idempotencyId = body.value("idempotency_id", std::string());
    if (idempotencyId.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"idempotency_id is required"})", "application/json");
      return;
    }
    const int validityS = body.value("validity_s", 300);
    if (validityS < kMinValidityS || validityS > kMaxValidityS) {
      res.status = 400;
      res.set_content(R"({"error":"validity_s must be 1..3600"})", "application/json");
      return;
    }
    const long long window = std::chrono::duration_cast<std::chrono::seconds>(
                                 std::chrono::system_clock::now().time_since_epoch())
                                 .count() /
                             kRateWindowS;
    if (commandStore.incrRate(deviceId, window) > kCommandRateLimit) {
      res.status = 429;
      res.set_content(R"({"error":"too many commands for this device"})", "application/json");
      return;
    }
    const long long now = std::chrono::duration_cast<std::chrono::milliseconds>(
                              std::chrono::system_clock::now().time_since_epoch())
                              .count();
    const auto stored = commandStore.get(deviceId, idempotencyId);
    if (stored) {
      if (isExpired(*stored, now)) {
        res.status = 410;
        res.set_content(
            json{{"command_id", stored->value("command_id", "")}, {"state", "expired"}}.dump(),
            "application/json");
        return;
      }
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const bool ackRequired = body.value("ack_required", true);
    const json command = {
        {"command_id", uuidString()},
        {"device_id", deviceId},
        {"action", body.value("action", "")},
        {"ack_required", ackRequired},
        {"expires_at", now + static_cast<long long>(validityS) * 1000},
        {"state", ackRequired ? "pending_ack" : "queued"},
    };
    commandStore.put(deviceId, idempotencyId, command);
    res.status = 202;
    res.set_content(command.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8080);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary of a
fleet. The draft reads fine because the demo sends one command from one operator and never retries.
Three separate defects are being checked: command identity (the idempotency id makes a replay a no-op
instead of a second unlock), the validity window (a command has a lifetime, and the hub must be able
to drop one that outlived its usefulness without executing it), and per-device rate limiting (the
device is the scarce resource, so the limit belongs to the device, not the caller). The acknowledgment
field is the quiet one: "accepted" and "executed" are different promises, and only the device can turn
the first into the second. Real hubs add per-device command quotas from device policy, signed command
envelopes so the device trusts the sender, and a dead-letter path for commands that expire while they
are still queued.`,
};
