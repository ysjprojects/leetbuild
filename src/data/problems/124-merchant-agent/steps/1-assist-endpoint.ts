import type {Step} from '@/lib/types';

export const assistEndpointStep: Step = {
  id: 'assist-endpoint',
  title: 'POST /v1/assist: the shop and its permissions come from the server',
  concept: 'http',
  file: 'assist_api',
  focus: ['merchant', 'api', 'turns'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and hands the message to the agent. It compiles, it serves the demo, and it hides four
production flaws. Review it like the owner of a merchant-facing assistant, fix it, and prove the fix
with the checks below.

Implement \`POST /v1/assist\` with body
\`{"message": "which of my customers are from Toronto?", "page": {"type": "customers", "id": ""}}\`.

- The shop comes from the authenticated session, surfaced to the handler as \`X-Shop-Id\`; a missing
  shop is **401**. The body never names the shop — a caller that can name a shop can read another
  merchant's data.
- \`message\` is a non-empty string of at most **8 KiB** (\`1 << 13\` bytes) of UTF-8; larger is
  **413**. \`page.type\` is one of \`home\`, \`products\`, \`orders\`, \`customers\`, \`analytics\`
  (**400** otherwise): the page is context the admin sends, not a free-form string the model reads.
- \`Idempotency-Key\` is required (**400** when missing). A retry with the same \`(shop, key)\`
  returns the stored turn instead of running the agent — and its write tools — again.
- The merchant's **permission set** is attached server-side from the permission store
  (\`scopes_for(shop)\`) and passed to the agent. The draft takes \`scopes\` from the body, so any
  caller can grant itself \`write_products\`.
- Log the turn with shop, page and turn id — never the message text.

**Failure mode the checks target.** A shop id in the body is a cross-merchant read; a caller-supplied
scope list is a privilege escalation that the agent will faithfully act on; the missing caps turn one
pasted spreadsheet into a model bill; and an un-keyed assist endpoint runs a form-filling tool twice
on every client retry.`,
  sequence: {
    participants: ['Admin', 'sidekick API', 'permission store', 'turn store'],
    messages: [
      {from: 'Admin', to: 'sidekick API', label: 'POST /v1/assist · X-Shop-Id · Idempotency-Key', kind: 'sync'},
      {from: 'sidekick API', to: 'sidekick API', label: 'validate shop · caps · page type', kind: 'sync'},
      {from: 'sidekick API', to: 'turn store', label: 'get(shop, idem_key)', kind: 'sync'},
      {from: 'turn store', to: 'sidekick API', label: 'stored turn / none', kind: 'reply'},
      {from: 'sidekick API', to: 'permission store', label: 'scopes_for(shop)', kind: 'sync'},
      {from: 'permission store', to: 'sidekick API', label: '[read_customers, write_products, …]', kind: 'reply'},
      {from: 'sidekick API', to: 'turn store', label: 'put(shop, idem_key, turn)', kind: 'async'},
      {from: 'sidekick API', to: 'Admin', label: '200 {turn_id, reply, tools_used}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/assist',
      detail: 'Register the assist route on `POST /v1/assist`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/assist["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/assist['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/assist"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"assist"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/assist"/]},
      },
    },
    {
      id: 'shop-auth',
      title: 'Takes the shop from X-Shop-Id, never from the body',
      detail:
        'The shop is the authenticated `X-Shop-Id` header — **401** when absent — and no `shop_id` field is read from the request. The draft trusts `shop_id` in the body, so any caller can assist as any merchant.',
      match: {
        python: {all: [/X-Shop-Id/, /status_code\s*=\s*401/], none: [/shop_id/]},
        typescript: {all: [/x-shop-id/, /code\(\s*401\s*\)/], none: [/shop_id/]},
        go: {all: [/X-Shop-Id/, /StatusUnauthorized/], none: [/shop_id|ShopID/]},
        scala: {all: [/X-Shop-Id/, /StatusCodes\.Unauthorized/], none: [/shop_id/]},
        cpp: {all: [/X-Shop-Id/, /\b401\b/], none: [/shop_id/]},
      },
    },
    {
      id: 'caps',
      title: 'Enforces the 8 KiB message cap and the page whitelist',
      detail:
        'A message over `1 << 13` bytes is **413**; a `page.type` outside the whitelist is **400**. The draft forwards any size and any page string straight into the prompt.',
      match: {
        python: {all: [/MAX_MESSAGE_BYTES/, /ALLOWED_PAGES/, /status_code\s*=\s*413/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_MESSAGE_BYTES/, /ALLOWED_PAGES/, /code\(\s*413\s*\)/, /code\(\s*400\s*\)/]},
        go: {all: [/maxMessageBytes/, /allowedPages/, /StatusRequestEntityTooLarge/, /StatusBadRequest/]},
        scala: {
          all: [/MaxMessageBytes/, /AllowedPages/, /StatusCodes\.RequestEntityTooLarge/, /StatusCodes\.BadRequest/],
        },
        cpp: {all: [/kMaxMessageBytes/, /kAllowedPages/, /\b413\b/, /\b400\b/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys retries by (shop, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required and the turn is stored under `(shop, key)`; a replay returns the stored turn instead of running the agent again. The draft ignores the header, so a client retry fills the same product form twice.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/idempotency-key/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/Idempotency-Key/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
      },
    },
    {
      id: 'server-scopes',
      title: 'Attaches the permission set server-side',
      detail:
        'The scopes passed to the agent come from the permission store (`scopes_for(shop)`), never from the body. The draft reads `scopes` from the request, so a caller can grant itself write access to products.',
      match: {
        python: {all: [/scopes_for\(/], none: [/body\.scopes/]},
        typescript: {all: [/scopesFor\(/], none: [/body\.scopes/]},
        go: {all: [/ScopesFor\(/], none: [/body\.Scopes/]},
        scala: {all: [/scopesFor\(/], none: [/body\.scopes/]},
        cpp: {all: [/scopesFor\(/], none: [/body\[\s*"scopes"\s*\]|value\(\s*"scopes"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from agent import run_agent

app = FastAPI()
logger = logging.getLogger("sidekick")


class Page(BaseModel):
    type: str
    id: str = ""


class AssistRequest(BaseModel):
    shop_id: str
    message: str
    page: Page
    scopes: list[str] = []


@app.post("/v1/assist")
def assist(body: AssistRequest) -> JSONResponse:
    # TODO: this draft takes the shop and its scopes from the body, caps neither the message nor the
    # page type, ignores Idempotency-Key, and logs the message. Review all four.
    turn_id = str(uuid.uuid4())
    logger.info("assist shop=%s message=%r", body.shop_id, body.message)
    outcome = run_agent(shop=body.shop_id, scopes=body.scopes, message=body.message, page=body.page.type)
    return JSONResponse(
        {"turn_id": turn_id, "reply": outcome.reply, "tools_used": outcome.tools_used}, status_code=200
    )
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from agent import run_agent

app = FastAPI()
logger = logging.getLogger("sidekick")

MAX_MESSAGE_BYTES = 1 << 13
ALLOWED_PAGES = {"home", "products", "orders", "customers", "analytics"}


class Page(BaseModel):
    type: str
    id: str = ""


class AssistRequest(BaseModel):
    message: str
    page: Page


class PermissionStore:
    def scopes_for(self, shop: str) -> list[str]:
        """The scopes the merchant's staff account grants Sidekick, e.g. read_customers, write_products."""
        raise NotImplementedError


class TurnStore:
    def get(self, shop: str, idem_key: str) -> dict | None:
        """The turn stored for (shop, idem_key), if any."""
        raise NotImplementedError

    def put(self, shop: str, idem_key: str, turn: dict) -> None:
        """Store the finished turn under (shop, idem_key)."""
        raise NotImplementedError


permissions = PermissionStore()
store = TurnStore()


@app.post("/v1/assist")
def assist(
    body: AssistRequest,
    shop: str | None = Header(default=None, alias="X-Shop-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if shop is None or shop == "":
        raise HTTPException(status_code=401, detail="missing X-Shop-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.message == "":
        raise HTTPException(status_code=400, detail="message must be a non-empty string")
    if len(body.message.encode("utf-8")) > MAX_MESSAGE_BYTES:
        raise HTTPException(status_code=413, detail="message exceeds 8 KiB")
    if body.page.type not in ALLOWED_PAGES:
        raise HTTPException(status_code=400, detail="unknown page type")

    stored = store.get(shop, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    scopes = permissions.scopes_for(shop)
    turn_id = str(uuid.uuid4())
    outcome = run_agent(shop=shop, scopes=scopes, message=body.message, page=body.page.type)
    turn = {"turn_id": turn_id, "reply": outcome.reply, "tools_used": outcome.tools_used}
    store.put(shop, idem_key, turn)
    logger.info("assist shop=%s page=%s turn=%s tools=%d", shop, body.page.type, turn_id, len(outcome.tools_used))
    return JSONResponse(turn, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/assist: a model-generated draft that trusts the body for the shop and its scopes. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {runAgent} from './agent';

export const app = Fastify();

interface AssistBody {
  shop_id: string;
  message: string;
  page: {type: string; id?: string};
  scopes?: string[];
}

app.post('/v1/assist', async (request, reply) => {
  // TODO: this draft takes the shop and its scopes from the body, caps neither the message nor the
  // page type, ignores Idempotency-Key, and logs the message. Review all four.
  const body = request.body as AssistBody;
  const turnId = randomUUID();
  request.log.info({shop: body.shop_id, message: body.message}, 'assist');
  const outcome = await runAgent({
    shop: body.shop_id,
    scopes: body.scopes ?? [],
    message: body.message,
    page: body.page.type,
  });
  return reply.code(200).send({turn_id: turnId, reply: outcome.reply, tools_used: outcome.toolsUsed});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/assist: authenticated shop, server-side scopes, capped and idempotent turns. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {runAgent} from './agent';
import {permissions, store} from './stores';

export const app = Fastify();

const MAX_MESSAGE_BYTES = 1 << 13;
const ALLOWED_PAGES: Record<string, true> = {home: true, products: true, orders: true, customers: true, analytics: true};

interface AssistBody {
  message: string;
  page: {type: string; id?: string};
}

interface Turn {
  turn_id: string;
  reply: string;
  tools_used: string[];
}

app.post('/v1/assist', async (request, reply) => {
  const shop = request.headers['x-shop-id'];
  if (typeof shop !== 'string' || shop === '') return reply.code(401).send({error: 'missing X-Shop-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<AssistBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.message !== 'string' || body.message === '')
    return reply.code(400).send({error: 'message must be a non-empty string'});
  if (Buffer.byteLength(body.message, 'utf8') > MAX_MESSAGE_BYTES)
    return reply.code(413).send({error: 'message exceeds 8 KiB'});
  const page = body.page?.type;
  if (typeof page !== 'string' || ALLOWED_PAGES[page] !== true)
    return reply.code(400).send({error: 'unknown page type'});

  const stored = await store.get(shop, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const scopes = await permissions.scopesFor(shop);
  const turnId = randomUUID();
  const outcome = await runAgent({shop, scopes, message: body.message, page});
  const turn: Turn = {turn_id: turnId, reply: outcome.reply, tools_used: outcome.toolsUsed};
  await store.put(shop, idemKey, turn);
  request.log.info({shop, page, turn: turnId, tools: outcome.toolsUsed.length}, 'assist');
  return reply.code(200).send(turn);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"

	"sidekick/agent"
)

type Page struct {
	Type string \`json:"type"\`
	ID   string \`json:"id"\`
}

type AssistRequest struct {
	ShopID  string   \`json:"shop_id"\`
	Message string   \`json:"message"\`
	Page    Page     \`json:"page"\`
	Scopes  []string \`json:"scopes"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func assist(rw http.ResponseWriter, r *http.Request) {
	var body AssistRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft takes the shop and its scopes from the body, caps neither the message nor
	// the page type, ignores Idempotency-Key, and logs the message. Review all four.
	turnID := uuid.NewString()
	log.Printf("assist shop=%s message=%q", body.ShopID, body.Message)
	outcome, err := agent.Run(r.Context(), body.ShopID, body.Scopes, body.Message, body.Page.Type)
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "agent failed"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"turn_id": turnID, "reply": outcome.Reply, "tools_used": outcome.ToolsUsed})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/assist", assist)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"

	"sidekick/agent"
)

const maxMessageBytes = 1 << 13

var allowedPages = map[string]bool{"home": true, "products": true, "orders": true, "customers": true, "analytics": true}

type Page struct {
	Type string \`json:"type"\`
	ID   string \`json:"id"\`
}

type AssistRequest struct {
	Message string \`json:"message"\`
	Page    Page   \`json:"page"\`
}

type Turn struct {
	TurnID    string   \`json:"turn_id"\`
	Reply     string   \`json:"reply"\`
	ToolsUsed []string \`json:"tools_used"\`
}

type PermissionStore struct{}

// ScopesFor is the merchant's staff-account grant to Sidekick, e.g. read_customers, write_products.
func (p *PermissionStore) ScopesFor(ctx context.Context, shop string) ([]string, error) {
	return nil, nil
}

type TurnStore struct{}

func (s *TurnStore) Get(ctx context.Context, shop, idemKey string) (*Turn, error) {
	return nil, nil
}

func (s *TurnStore) Put(ctx context.Context, shop, idemKey string, turn Turn) error {
	return nil
}

var (
	permissions = &PermissionStore{}
	store       = &TurnStore{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func assist(rw http.ResponseWriter, r *http.Request) {
	shop := r.Header.Get("X-Shop-Id")
	if shop == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Shop-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body AssistRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.Message == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "message must be a non-empty string"})
		return
	}
	if len([]byte(body.Message)) > maxMessageBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "message exceeds 8 KiB"})
		return
	}
	if !allowedPages[body.Page.Type] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown page type"})
		return
	}
	stored, err := store.Get(r.Context(), shop, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	scopes, err := permissions.ScopesFor(r.Context(), shop)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	turnID := uuid.NewString()
	outcome, err := agent.Run(r.Context(), shop, scopes, body.Message, body.Page.Type)
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "agent failed"})
		return
	}
	turn := Turn{TurnID: turnID, Reply: outcome.Reply, ToolsUsed: outcome.ToolsUsed}
	if err := store.Put(r.Context(), shop, idemKey, turn); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("assist shop=%s page=%s turn=%s tools=%d", shop, body.Page.Type, turnID, len(outcome.ToolsUsed))
	writeJSON(rw, http.StatusOK, turn)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/assist", assist)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Page(\`type\`: String, id: String)
final case class AssistRequest(shop_id: String, message: String, page: Page, scopes: List[String])
final case class Turn(turn_id: String, reply: String, tools_used: List[String])

object AssistApi {
  implicit val system: ActorSystem = ActorSystem("sidekick")
  implicit val pageFormat: RootJsonFormat[Page] = jsonFormat2(Page)
  implicit val requestFormat: RootJsonFormat[AssistRequest] = jsonFormat4(AssistRequest)
  implicit val turnFormat: RootJsonFormat[Turn] = jsonFormat3(Turn)

  val route: Route =
    path("v1" / "assist") {
      post {
        entity(as[AssistRequest]) { body =>
          // TODO: this draft takes the shop and its scopes from the body, caps neither the message
          // nor the page type, ignores Idempotency-Key, and logs the message. Review all four.
          val turnId = UUID.randomUUID().toString
          system.log.info(s"assist shop=\${body.shop_id} message=\${body.message}")
          val outcome = Agent.run(body.shop_id, body.scopes, body.message, body.page.\`type\`)
          complete(StatusCodes.OK, Turn(turnId, outcome.reply, outcome.toolsUsed))
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Page(\`type\`: String, id: String)
final case class AssistRequest(message: String, page: Page)
final case class Turn(turn_id: String, reply: String, tools_used: List[String])

object AssistApi {
  implicit val system: ActorSystem = ActorSystem("sidekick")
  implicit val pageFormat: RootJsonFormat[Page] = jsonFormat2(Page)
  implicit val requestFormat: RootJsonFormat[AssistRequest] = jsonFormat2(AssistRequest)
  implicit val turnFormat: RootJsonFormat[Turn] = jsonFormat3(Turn)

  val MaxMessageBytes = 1 << 13
  val AllowedPages = Set("home", "products", "orders", "customers", "analytics")

  val permissions = PermissionStore.open()
  val store = TurnStore.open()

  val route: Route =
    path("v1" / "assist") {
      post {
        optionalHeaderValueByName("X-Shop-Id") { shopOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[AssistRequest]) { body =>
              if (!shopOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Shop-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.message.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"message must be a non-empty string"}""")
              } else if (body.message.getBytes(StandardCharsets.UTF_8).length > MaxMessageBytes) {
                complete(StatusCodes.RequestEntityTooLarge, """{"error":"message exceeds 8 KiB"}""")
              } else if (!AllowedPages.contains(body.page.\`type\`)) {
                complete(StatusCodes.BadRequest, """{"error":"unknown page type"}""")
              } else {
                val shop = shopOpt.get
                val idemKey = idemOpt.get
                store.get(shop, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    val scopes = permissions.scopesFor(shop)
                    val turnId = UUID.randomUUID().toString
                    val outcome = Agent.run(shop, scopes, body.message, body.page.\`type\`)
                    val turn = Turn(turnId, outcome.reply, outcome.toolsUsed)
                    store.put(shop, idemKey, turn)
                    system.log.info(
                      s"assist shop=$shop page=\${body.page.\`type\`} turn=$turnId tools=\${outcome.toolsUsed.size}"
                    )
                    complete(StatusCodes.OK, turn)
                }
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
#include <string>
#include <vector>

#include "agent.h"

using json = nlohmann::json;

std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/assist", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft takes the shop and its scopes from the body, caps neither the message nor
    // the page type, ignores Idempotency-Key, and logs the message. Review all four.
    const auto shop = body.value("shop_id", std::string());
    const auto message = body.value("message", std::string());
    const auto page = body.value("page", json::object()).value("type", std::string());
    const auto scopes = body.value("scopes", std::vector<std::string>());
    const auto turnId = uuidString();
    std::cerr << "assist shop=" << shop << " message=" << message << "\\n";
    const AgentOutcome outcome = runAgent(shop, scopes, message, page);
    res.status = 200;
    res.set_content(
        json{{"turn_id", turnId}, {"reply", outcome.reply}, {"tools_used", outcome.toolsUsed}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "agent.h"

using json = nlohmann::json;

constexpr std::size_t kMaxMessageBytes = 1 << 13;
const std::set<std::string> kAllowedPages = {"home", "products", "orders", "customers", "analytics"};

struct PermissionStore {
  // The merchant's staff-account grant to Sidekick, e.g. read_customers, write_products.
  std::vector<std::string> scopesFor(const std::string& shop);
};

struct TurnStore {
  std::optional<json> get(const std::string& shop, const std::string& idemKey);
  void put(const std::string& shop, const std::string& idemKey, const json& turn);
};

PermissionStore permissions;
TurnStore store;
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/assist", [](const httplib::Request& req, httplib::Response& res) {
    const auto shop = req.get_header_value("X-Shop-Id");
    if (shop.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Shop-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("message") || !body["message"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"message must be a non-empty string"})", "application/json");
      return;
    }
    const auto message = body["message"].get<std::string>();
    if (message.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"message must be a non-empty string"})", "application/json");
      return;
    }
    if (message.size() > kMaxMessageBytes) {
      res.status = 413;
      res.set_content(R"({"error":"message exceeds 8 KiB"})", "application/json");
      return;
    }
    const auto page = body.value("page", json::object()).value("type", std::string());
    if (kAllowedPages.count(page) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown page type"})", "application/json");
      return;
    }
    const auto stored = store.get(shop, idemKey);
    if (stored) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const auto scopes = permissions.scopesFor(shop);
    const auto turnId = uuidString();
    const AgentOutcome outcome = runAgent(shop, scopes, message, page);
    const json turn = {{"turn_id", turnId}, {"reply", outcome.reply}, {"tools_used", outcome.toolsUsed}};
    store.put(shop, idemKey, turn);
    std::cerr << "assist shop=" << shop << " page=" << page << " turn=" << turnId
              << " tools=" << outcome.toolsUsed.size() << "\\n";
    res.status = 200;
    res.set_content(turn.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses first, in cost order: shop header, Idempotency-Key, message shape, byte length, page whitelist. Every one returns before the agent runs, so a malformed request never spends a model call or touches a tool.',
    'Two things in the body must move to the server: the shop (the `X-Shop-Id` header the session layer sets) and the scopes (`scopes_for(shop)` from the permission store). Delete both fields from the request model so a caller cannot even send them.',
    'The idempotency lookup is keyed by `(shop, key)` and happens before the agent runs; a hit returns the stored turn. Store the finished turn — reply and tools used — so a replay never re-runs a write tool.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary of a multi-tenant assistant. The draft reads fine because the demo sends one shop's requests with the right scopes and never retries. Four separate defects are being checked: the shop identity (it comes from the session, never the body — a body field is a cross-merchant read), the permission set (attached server-side, because the agent will act on whatever scopes it is given), input caps (cheap rejections before an expensive agentic loop), and idempotency keyed by shop so a retry cannot run a form-filling tool twice. The log line is the one candidates forget: a merchant's message can contain customer names and order details, so it never goes to a log sink verbatim. Real assistants add a per-staff-member identity beside the shop, a page-context schema instead of a free string, and a request-scoped trace id that follows the turn through the loop.`,
};
