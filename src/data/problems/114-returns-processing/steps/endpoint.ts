import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/returns: eligibility measured, not asserted',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it parses the body, looks up
the order line, and registers the return. It compiles, it serves the demo, and it approves returns
that policy says are closed. Review it like the service owner, fix it, and prove the fix with the
checks below.

Implement \`POST /v1/returns\` with body
\`{"order_line_id": "…", "quantity": 1, "reason_code": "damaged", "photo_ref": "…"}\`.

- The order line is loaded server-side; an unknown line is **404**. Eligibility is **computed**
  from the line's \`delivered_at\` and its \`policy_window\` — a \`standard\` line closes **30** days
  after delivery and an \`extended\` line closes **60** days after delivery.
- A return requested after the window closes is **422**, and the body must carry the dates:
  \`delivered_at\` and \`window_ends\`.
- \`quantity\` is an integer from **1** up to what remains returnable for the line: the ordered
  quantity minus every quantity earlier returns already consumed. Anything above that — or below
  1 — is **409** with \`remaining\` in the body. A second return must never take the line past its
  ordered quantity.
- \`reason_code\` must be one of \`damaged\`, \`wrong_item\`, \`not_as_described\`, \`late_delivery\`,
  \`changed_mind\` (**400** otherwise). The first three require a \`photo_ref\`; a claim without
  evidence is **400**.
- A caller-supplied eligibility flag in the body is **ignored**. The draft approves when the body
  says the customer promised the return was late; the server decides eligibility, never the client.
- The registration is logged with the tenant, the line and the quantity — never the photo reference.

**Failure mode the checks target.** The draft trusts a body flag the client controls, so a closed
line is reopened by a sentence. It never subtracts earlier returns, so the same line is returned
three times over. It never reads the policy window, so "it was late" becomes a refund. And it never
validates the reason code or its evidence.`,
  sequence: {
    participants: ['Customer', 'Returns API', 'orders · returns'],
    messages: [
      {
        from: 'Customer',
        to: 'Returns API',
        label: 'POST /v1/returns · X-Tenant-Id · reason_code · photo_ref',
        kind: 'sync',
      },
      {
        from: 'Returns API',
        to: 'orders · returns',
        label: 'load order line · delivered_at · policy_window',
        kind: 'sync',
      },
      {from: 'orders · returns', to: 'Returns API', label: 'ordered_quantity · earlier returns', kind: 'reply'},
      {from: 'Returns API', to: 'Returns API', label: 'window_end = delivered_at + policy days', kind: 'sync'},
      {from: 'Returns API', to: 'Returns API', label: 'remaining = ordered − already returned', kind: 'sync'},
      {from: 'Returns API', to: 'orders · returns', label: 'register return(quantity, reason_code)', kind: 'sync'},
      {from: 'orders · returns', to: 'Returns API', label: 'return_id', kind: 'reply'},
      {
        from: 'Returns API',
        to: 'Customer',
        label: '201 {return_id, quantity} · 409 · 422 with window dates',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/returns',
      detail: 'Register the return-creation route on `POST /v1/returns`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/returns["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/returns['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/returns"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"returns"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/returns"/]},
      },
    },
    {
      id: 'window',
      title: 'Rejects an out-of-window return with the window dates',
      detail:
        'Eligibility is computed from `delivered_at` plus the `policy_window` days, and a return requested after the window closes is **422** carrying `delivered_at` and `window_ends`. The draft approves on the customer’s word and never computes the window.',
      match: {
        python: {all: [/POLICY_WINDOW_DAYS/, /window_end/, /delivered_at/, /status_code\s*=\s*422/]},
        typescript: {all: [/POLICY_WINDOW_DAYS/, /windowEnd/, /delivered_at|deliveredAt/, /code\(\s*422\s*\)/]},
        go: {all: [/policyWindowDays/, /windowEnd/, /DeliveredAt/, /StatusUnprocessableEntity/]},
        scala: {all: [/PolicyWindowDays/, /windowEnd/, /delivered_at/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/kPolicyWindowDays/, /windowEnd/, /delivered_at/, /\b422\b/]},
      },
    },
    {
      id: 'quantity',
      title: 'Caps quantity at what remains returnable',
      detail:
        'The quantity is checked against the ordered quantity minus what earlier returns already consumed, and an over-return is **409** with `remaining`. The draft compares nothing and lets a line be returned past its ordered quantity.',
      match: {
        python: {all: [/already_returned/, /remaining/, /status_code\s*=\s*409/]},
        typescript: {all: [/alreadyReturned/, /remaining/, /code\(\s*409\s*\)/]},
        go: {all: [/alreadyReturned/, /remaining/, /StatusConflict/]},
        scala: {all: [/alreadyReturned/, /remaining/, /StatusCodes\.Conflict/]},
        cpp: {all: [/alreadyReturned|already_returned/, /remaining/, /\b409\b/]},
      },
    },
    {
      id: 'no-client-flag',
      title: 'Ignores the caller’s eligibility flag',
      detail:
        'Eligibility is never read from the request body. The draft approves when the caller sends its own `eligible` flag, which lets a client reopen a closed line by asserting it.',
      match: {
        python: {none: [/\bbody\.eligible\b/]},
        typescript: {none: [/\bbody\.eligible\b/]},
        go: {none: [/\bbody\.Eligible\b/]},
        scala: {none: [/\bbody\.eligible\b/]},
        cpp: {none: [/body\.value\(\s*"eligible"/]},
      },
    },
    {
      id: 'reason-photo',
      title: 'Validates the reason code and its evidence',
      detail:
        '`reason_code` is checked against the allowed set and the damage reasons require a `photo_ref`. The draft accepts any reason string and any claim without evidence.',
      match: {
        python: {all: [/ALLOWED_REASON_CODES/, /PHOTO_REQUIRED_REASONS/, /photo_ref/]},
        typescript: {all: [/ALLOWED_REASON_CODES/, /PHOTO_REQUIRED_REASONS/, /photo_ref|photoRef/]},
        go: {all: [/allowedReasonCodes/, /photoRequiredReasons/, /PhotoRef|photoRef/]},
        scala: {all: [/AllowedReasonCodes/, /PhotoRequiredReasons/, /photo_ref|photoRef/]},
        cpp: {all: [/kAllowedReasonCodes/, /kPhotoRequiredReasons/, /photo_ref|photoRef/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
from dataclasses import dataclass
from datetime import date

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("returns")


class ReturnRequest(BaseModel):
    order_line_id: str
    quantity: int
    reason_code: str
    photo_ref: str | None = None
    eligible: bool = False


@dataclass
class OrderLine:
    ordered_quantity: int
    delivered_at: date
    policy_window: str


class ReturnsStore:
    def line(self, order_line_id: str) -> OrderLine | None:
        """The order line being returned, or None when the order is unknown."""
        raise NotImplementedError

    def register(self, order_line_id: str, quantity: int, reason_code: str, photo_ref: str | None) -> str:
        """Persist the return request and return its id."""
        raise NotImplementedError


store = ReturnsStore()


@app.post("/v1/returns")
def create_return(body: ReturnRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: the draft trusts the caller's eligible flag, never checks the policy window, never
    # subtracts what earlier returns already consumed, and does not validate the reason code.
    line = store.line(body.order_line_id)
    if line is None:
        raise HTTPException(status_code=404, detail="unknown order line")
    if not body.eligible:
        raise HTTPException(status_code=403, detail="not eligible for return")
    return_id = store.register(body.order_line_id, body.quantity, body.reason_code, body.photo_ref)
    logger.info("return registered tenant=%s line=%s", tenant, body.order_line_id)
    return JSONResponse({"return_id": return_id}, status_code=201)
`,
      solution: `import logging
from dataclasses import dataclass
from datetime import date, timedelta

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("returns")

ALLOWED_REASON_CODES = {"damaged", "wrong_item", "not_as_described", "late_delivery", "changed_mind"}
PHOTO_REQUIRED_REASONS = {"damaged", "wrong_item", "not_as_described"}
POLICY_WINDOW_DAYS = {"standard": 30, "extended": 60}


class ReturnRequest(BaseModel):
    order_line_id: str
    quantity: int
    reason_code: str
    photo_ref: str | None = None


@dataclass
class OrderLine:
    ordered_quantity: int
    delivered_at: date
    policy_window: str


class ReturnsStore:
    def line(self, order_line_id: str) -> OrderLine | None:
        """The order line being returned, or None when the order is unknown."""
        raise NotImplementedError

    def returned_quantity(self, order_line_id: str) -> int:
        """Total quantity already registered as returned for the line."""
        raise NotImplementedError

    def register(self, order_line_id: str, quantity: int, reason_code: str, photo_ref: str | None) -> str:
        """Persist the return request and return its id."""
        raise NotImplementedError


store = ReturnsStore()


def window_end(line: OrderLine) -> date:
    """The last day the line may be returned: delivered_at plus its policy window."""
    return line.delivered_at + timedelta(days=POLICY_WINDOW_DAYS[line.policy_window])


@app.post("/v1/returns")
def create_return(body: ReturnRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    line = store.line(body.order_line_id)
    if line is None:
        raise HTTPException(status_code=404, detail="unknown order line")
    if body.reason_code not in ALLOWED_REASON_CODES:
        raise HTTPException(status_code=400, detail="unknown reason code")
    if body.reason_code in PHOTO_REQUIRED_REASONS and not body.photo_ref:
        raise HTTPException(status_code=400, detail="photo reference required")
    end = window_end(line)
    if date.today() > end:
        return JSONResponse(
            {
                "error": "outside return window",
                "delivered_at": line.delivered_at.isoformat(),
                "window_ends": end.isoformat(),
            },
            status_code=422,
        )
    already_returned = store.returned_quantity(body.order_line_id)
    remaining = line.ordered_quantity - already_returned
    if body.quantity < 1 or body.quantity > remaining:
        return JSONResponse({"error": "quantity exceeds returnable", "remaining": remaining}, status_code=409)
    return_id = store.register(body.order_line_id, body.quantity, body.reason_code, body.photo_ref)
    logger.info("return registered tenant=%s line=%s qty=%d", tenant, body.order_line_id, body.quantity)
    return JSONResponse({"return_id": return_id, "quantity": body.quantity}, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/returns: a model-generated draft that trusts the caller's eligibility flag. */
import Fastify from 'fastify';

export const app = Fastify();

interface ReturnBody {
  order_line_id: string;
  quantity: number;
  reason_code: string;
  photo_ref?: string;
  eligible?: boolean;
}

interface OrderLine {
  ordered_quantity: number;
  delivered_at: string;
  policy_window: string;
}

const store = {
  async line(orderLineId: string): Promise<OrderLine | null> {
    throw new Error('not implemented');
  },
  async register(orderLineId: string, quantity: number, reasonCode: string, photoRef?: string): Promise<string> {
    throw new Error('not implemented');
  },
};

app.post('/v1/returns', async (request, reply) => {
  // TODO: the draft trusts the caller's eligible flag, never checks the policy window, never
  // subtracts what earlier returns already consumed, and does not validate the reason code.
  const body = request.body as ReturnBody;
  const line = await store.line(body.order_line_id);
  if (line === null) return reply.code(404).send({error: 'unknown order line'});
  if (!body.eligible) return reply.code(403).send({error: 'not eligible for return'});
  const returnId = await store.register(body.order_line_id, body.quantity, body.reason_code, body.photo_ref);
  request.log.info({line: body.order_line_id}, 'return registered');
  return reply.code(201).send({return_id: returnId});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/returns: computed eligibility and cumulative return quantities. */
import Fastify from 'fastify';

export const app = Fastify();

const ALLOWED_REASON_CODES: Record<string, true> = {
  damaged: true,
  wrong_item: true,
  not_as_described: true,
  late_delivery: true,
  changed_mind: true,
};
const PHOTO_REQUIRED_REASONS: Record<string, true> = {damaged: true, wrong_item: true, not_as_described: true};
const POLICY_WINDOW_DAYS: Record<string, number> = {standard: 30, extended: 60};

interface ReturnBody {
  order_line_id: string;
  quantity: number;
  reason_code: string;
  photo_ref?: string;
}

interface OrderLine {
  ordered_quantity: number;
  delivered_at: string;
  policy_window: string;
}

const store = {
  async line(orderLineId: string): Promise<OrderLine | null> {
    throw new Error('not implemented');
  },
  async returnedQuantity(orderLineId: string): Promise<number> {
    throw new Error('not implemented');
  },
  async register(orderLineId: string, quantity: number, reasonCode: string, photoRef?: string): Promise<string> {
    throw new Error('not implemented');
  },
};

function windowEnd(line: OrderLine): string {
  const end = new Date(\`\${line.delivered_at}T00:00:00Z\`);
  end.setUTCDate(end.getUTCDate() + POLICY_WINDOW_DAYS[line.policy_window]);
  return end.toISOString().slice(0, 10);
}

app.post('/v1/returns', async (request, reply) => {
  const body = request.body as ReturnBody;
  const line = await store.line(body.order_line_id);
  if (line === null) return reply.code(404).send({error: 'unknown order line'});
  if (ALLOWED_REASON_CODES[body.reason_code] !== true)
    return reply.code(400).send({error: 'unknown reason code'});
  if (PHOTO_REQUIRED_REASONS[body.reason_code] === true && !body.photo_ref)
    return reply.code(400).send({error: 'photo reference required'});

  const end = windowEnd(line);
  const today = new Date().toISOString().slice(0, 10);
  if (today > end)
    return reply.code(422).send({error: 'outside return window', delivered_at: line.delivered_at, window_ends: end});

  const alreadyReturned = await store.returnedQuantity(body.order_line_id);
  const remaining = line.ordered_quantity - alreadyReturned;
  if (!Number.isInteger(body.quantity) || body.quantity < 1 || body.quantity > remaining)
    return reply.code(409).send({error: 'quantity exceeds returnable', remaining});

  const returnId = await store.register(body.order_line_id, body.quantity, body.reason_code, body.photo_ref);
  request.log.info({line: body.order_line_id, quantity: body.quantity}, 'return registered');
  return reply.code(201).send({return_id: returnId, quantity: body.quantity});
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
)

type ReturnRequest struct {
	OrderLineID string \`json:"order_line_id"\`
	Quantity    int    \`json:"quantity"\`
	ReasonCode  string \`json:"reason_code"\`
	PhotoRef    string \`json:"photo_ref"\`
	Eligible    bool   \`json:"eligible"\`
}

type OrderLine struct {
	OrderedQuantity int
	DeliveredAt     string
	PolicyWindow    string
}

type ReturnsStore struct{}

func (s *ReturnsStore) Line(ctx context.Context, orderLineID string) (*OrderLine, error) {
	return nil, nil
}

func (s *ReturnsStore) Register(ctx context.Context, orderLineID string, quantity int, reasonCode, photoRef string) (string, error) {
	return "", nil
}

var store = &ReturnsStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createReturn(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body ReturnRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: the draft trusts the caller's Eligible flag, never checks the policy window, never
	// subtracts what earlier returns already consumed, and does not validate the reason code.
	line, err := store.Line(r.Context(), body.OrderLineID)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	if line == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown order line"})
		return
	}
	if !body.Eligible {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "not eligible for return"})
		return
	}
	returnID, err := store.Register(r.Context(), body.OrderLineID, body.Quantity, body.ReasonCode, body.PhotoRef)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	log.Printf("return registered tenant=%s line=%s", tenant, body.OrderLineID)
	writeJSON(rw, http.StatusCreated, map[string]any{"return_id": returnID})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/returns", createReturn)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

var allowedReasonCodes = map[string]bool{
	"damaged":          true,
	"wrong_item":       true,
	"not_as_described": true,
	"late_delivery":    true,
	"changed_mind":     true,
}

var photoRequiredReasons = map[string]bool{
	"damaged":          true,
	"wrong_item":       true,
	"not_as_described": true,
}

var policyWindowDays = map[string]int{"standard": 30, "extended": 60}

type ReturnRequest struct {
	OrderLineID string \`json:"order_line_id"\`
	Quantity    int    \`json:"quantity"\`
	ReasonCode  string \`json:"reason_code"\`
	PhotoRef    string \`json:"photo_ref"\`
}

type OrderLine struct {
	OrderedQuantity int
	DeliveredAt     string
	PolicyWindow    string
}

type ReturnsStore struct{}

func (s *ReturnsStore) Line(ctx context.Context, orderLineID string) (*OrderLine, error) {
	return nil, nil
}

func (s *ReturnsStore) ReturnedQuantity(ctx context.Context, orderLineID string) (int, error) {
	return 0, nil
}

func (s *ReturnsStore) Register(ctx context.Context, orderLineID string, quantity int, reasonCode, photoRef string) (string, error) {
	return "", nil
}

var store = &ReturnsStore{}

func windowEnd(line *OrderLine) (string, error) {
	delivered, err := time.Parse("2006-01-02", line.DeliveredAt)
	if err != nil {
		return "", err
	}
	return delivered.AddDate(0, 0, policyWindowDays[line.PolicyWindow]).Format("2006-01-02"), nil
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createReturn(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body ReturnRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	line, err := store.Line(r.Context(), body.OrderLineID)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	if line == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown order line"})
		return
	}
	if !allowedReasonCodes[body.ReasonCode] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown reason code"})
		return
	}
	if photoRequiredReasons[body.ReasonCode] && body.PhotoRef == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "photo reference required"})
		return
	}
	end, err := windowEnd(line)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	if time.Now().UTC().Format("2006-01-02") > end {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]any{
			"error":        "outside return window",
			"delivered_at": line.DeliveredAt,
			"window_ends":  end,
		})
		return
	}
	alreadyReturned, err := store.ReturnedQuantity(r.Context(), body.OrderLineID)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	remaining := line.OrderedQuantity - alreadyReturned
	if body.Quantity < 1 || body.Quantity > remaining {
		writeJSON(rw, http.StatusConflict, map[string]any{"error": "quantity exceeds returnable", "remaining": remaining})
		return
	}
	returnID, err := store.Register(r.Context(), body.OrderLineID, body.Quantity, body.ReasonCode, body.PhotoRef)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	log.Printf("return registered tenant=%s line=%s qty=%d", tenant, body.OrderLineID, body.Quantity)
	writeJSON(rw, http.StatusCreated, map[string]any{"return_id": returnID, "quantity": body.Quantity})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/returns", createReturn)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
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

final case class ReturnRequest(
    order_line_id: String,
    quantity: Int,
    reason_code: String,
    photo_ref: Option[String],
    eligible: Boolean
)
final case class ReturnRegistered(return_id: String)

object ReturnApi {
  implicit val system: ActorSystem = ActorSystem("returns")
  implicit val requestFormat: RootJsonFormat[ReturnRequest] = jsonFormat5(ReturnRequest)
  implicit val registeredFormat: RootJsonFormat[ReturnRegistered] = jsonFormat1(ReturnRegistered)

  val store = ReturnsStore.open()

  val route: Route =
    path("v1" / "returns") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[ReturnRequest]) { body =>
            // TODO: the draft trusts the caller's eligible flag, never checks the policy window,
            // never subtracts what earlier returns already consumed, and does not validate the reason code.
            store.line(body.order_line_id) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"unknown order line"}""")
              case Some(_) =>
                if (!body.eligible) {
                  complete(StatusCodes.Forbidden, """{"error":"not eligible for return"}""")
                } else {
                  val returnId = store.register(body.order_line_id, body.quantity, body.reason_code, body.photo_ref)
                  system.log.info(s"return registered tenant=$tenant line=\${body.order_line_id}")
                  complete(StatusCodes.Created, ReturnRegistered(returnId))
                }
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
      solution: `import java.time.LocalDate
import java.time.format.DateTimeFormatter

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ReturnRequest(order_line_id: String, quantity: Int, reason_code: String, photo_ref: Option[String])
final case class ReturnRegistered(return_id: String, quantity: Int)

object ReturnApi {
  implicit val system: ActorSystem = ActorSystem("returns")
  implicit val requestFormat: RootJsonFormat[ReturnRequest] = jsonFormat4(ReturnRequest)
  implicit val registeredFormat: RootJsonFormat[ReturnRegistered] = jsonFormat2(ReturnRegistered)

  val AllowedReasonCodes = Set("damaged", "wrong_item", "not_as_described", "late_delivery", "changed_mind")
  val PhotoRequiredReasons = Set("damaged", "wrong_item", "not_as_described")
  val PolicyWindowDays = Map("standard" -> 30, "extended" -> 60)

  val store = ReturnsStore.open()

  def windowEnd(line: OrderLine): String = {
    val days = PolicyWindowDays(line.policy_window)
    LocalDate.parse(line.delivered_at).plusDays(days).format(DateTimeFormatter.ISO_LOCAL_DATE)
  }

  val route: Route =
    path("v1" / "returns") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[ReturnRequest]) { body =>
            store.line(body.order_line_id) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"unknown order line"}""")
              case Some(line) if !AllowedReasonCodes.contains(body.reason_code) =>
                complete(StatusCodes.BadRequest, """{"error":"unknown reason code"}""")
              case Some(_) if PhotoRequiredReasons.contains(body.reason_code) && body.photo_ref.isEmpty =>
                complete(StatusCodes.BadRequest, """{"error":"photo reference required"}""")
              case Some(line) if LocalDate.now().toString > windowEnd(line) =>
                complete(
                  StatusCodes.UnprocessableEntity,
                  s"""{"error":"outside return window","delivered_at":"\${line.delivered_at}","window_ends":"\${windowEnd(line)}"}"""
                )
              case Some(line) =>
                val alreadyReturned = store.returnedQuantity(body.order_line_id)
                val remaining = line.ordered_quantity - alreadyReturned
                if (body.quantity < 1 || body.quantity > remaining) {
                  complete(StatusCodes.Conflict, s"""{"error":"quantity exceeds returnable","remaining":$remaining}""")
                } else {
                  val returnId = store.register(body.order_line_id, body.quantity, body.reason_code, body.photo_ref)
                  system.log.info(s"return registered tenant=$tenant line=\${body.order_line_id} qty=\${body.quantity}")
                  complete(StatusCodes.Created, ReturnRegistered(returnId, body.quantity))
                }
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

#include <iostream>
#include <optional>
#include <string>

using json = nlohmann::json;

struct OrderLine {
  int ordered_quantity;
  std::string delivered_at;
  std::string policy_window;
};

struct ReturnsStore {
  std::optional<OrderLine> line(const std::string& orderLineId);
  std::string registerReturn(const std::string& orderLineId, int quantity, const std::string& reasonCode,
                             const std::string& photoRef);
};

ReturnsStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/returns", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: the draft trusts the caller's eligible flag, never checks the policy window, never
    // subtracts what earlier returns already consumed, and does not validate the reason code.
    const auto orderLineId = body.value("order_line_id", std::string());
    const auto line = store.line(orderLineId);
    if (!line) {
      res.status = 404;
      res.set_content(R"({"error":"unknown order line"})", "application/json");
      return;
    }
    if (!body.value("eligible", false)) {
      res.status = 403;
      res.set_content(R"({"error":"not eligible for return"})", "application/json");
      return;
    }
    const auto returnId = store.registerReturn(orderLineId, body.value("quantity", 0),
                                               body.value("reason_code", std::string()),
                                               body.value("photo_ref", std::string()));
    std::cerr << "return registered tenant=" << tenant << " line=" << orderLineId << std::endl;
    res.status = 201;
    res.set_content(json{{"return_id", returnId}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <map>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

const std::set<std::string> kAllowedReasonCodes = {"damaged", "wrong_item", "not_as_described", "late_delivery",
                                                   "changed_mind"};
const std::set<std::string> kPhotoRequiredReasons = {"damaged", "wrong_item", "not_as_described"};
const std::map<std::string, int> kPolicyWindowDays = {{"standard", 30}, {"extended", 60}};

struct OrderLine {
  int ordered_quantity;
  std::string delivered_at;
  std::string policy_window;
};

struct ReturnsStore {
  std::optional<OrderLine> line(const std::string& orderLineId);
  int returnedQuantity(const std::string& orderLineId);
  std::string registerReturn(const std::string& orderLineId, int quantity, const std::string& reasonCode,
                             const std::string& photoRef);
};

ReturnsStore store;
std::string todayString();
std::string windowEnd(const OrderLine& line);

int main() {
  httplib::Server svr;

  svr.Post("/v1/returns", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto orderLineId = body.value("order_line_id", std::string());
    const auto line = store.line(orderLineId);
    if (!line) {
      res.status = 404;
      res.set_content(R"({"error":"unknown order line"})", "application/json");
      return;
    }
    const auto reasonCode = body.value("reason_code", std::string());
    const auto photoRef = body.value("photo_ref", std::string());
    if (kAllowedReasonCodes.count(reasonCode) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown reason code"})", "application/json");
      return;
    }
    if (kPhotoRequiredReasons.count(reasonCode) > 0 && photoRef.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"photo reference required"})", "application/json");
      return;
    }
    const auto end = windowEnd(*line);
    if (todayString() > end) {
      res.status = 422;
      res.set_content(json{{"error", "outside return window"},
                           {"delivered_at", line->delivered_at},
                           {"window_ends", end}}
                          .dump(),
                      "application/json");
      return;
    }
    const int alreadyReturned = store.returnedQuantity(orderLineId);
    const int remaining = line->ordered_quantity - alreadyReturned;
    const int quantity = body.value("quantity", 0);
    if (quantity < 1 || quantity > remaining) {
      res.status = 409;
      res.set_content(json{{"error", "quantity exceeds returnable"}, {"remaining", remaining}}.dump(),
                      "application/json");
      return;
    }
    const auto returnId = store.registerReturn(orderLineId, quantity, reasonCode, photoRef);
    std::cerr << "return registered tenant=" << tenant << " line=" << orderLineId << " qty=" << quantity << std::endl;
    res.status = 201;
    res.set_content(json{{"return_id", returnId}, {"quantity", quantity}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guards in cost order — unknown line, reason code, evidence, window, remaining — and return before anything is registered. Eligibility is arithmetic on `delivered_at` and the policy window, so a closed line can never be reopened by anything the caller says.',
    'The quantity you compare against is not the ordered quantity: it is the ordered quantity minus every quantity earlier returns already consumed. Compute `remaining` from the store and reject anything above it with **409**, so a line can never be returned past its ordered quantity.',
    'The body may carry a flag named `eligible` or anything like it — ignore it. If you find yourself reading a request field to decide eligibility, the client is deciding policy. The only inputs are the line, the window, and the quantities already returned.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary. The draft reads fine because the demo sends a well-formed request from one customer whose order just shipped. Three defects are being checked: computed eligibility (a policy window over \`delivered_at\`, not a caller assertion), cumulative quantities (what remains after earlier returns, not the ordered quantity), and validated evidence (an allowed reason code, and a photo for the damage reasons). The quiet one is the body flag: letting a client assert eligibility turns every return into a formality. Real services add per-region windows from config, a reasons table with evidence requirements, and a reconciliation job that compares registered returns against the ledger.`,
};
