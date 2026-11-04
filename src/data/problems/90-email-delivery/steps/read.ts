import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/messages/{id}: the state the record holds',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'store', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/messages/{id}\`: it loads the message
(\`store.load\`) and answers \`{message_id, state, suppressed}\`, with \`state\` \`"bounced"\` for a
bounced message and \`"sent"\` for any other, whoever asks. It serves the demo and hides four flaws.

**Failure mode the checks target.** A message still queued, deferred or suppressed is reported to
the customer as sent; a bounce shows no category, so support cannot tell a dead mailbox from a full
one; any tenant reads another tenant's messages by id; and the retries behind a delivery are
invisible.

- \`state\` is the record's own state: \`queued\`, \`sent\`, \`bounced\`, \`suppressed\` or \`deferred\`.
- The response carries \`bounce_category\` (\`""\` without a bounce) and \`suppressed\`
  (\`gate.is_suppressed\`).
- The caller's \`X-Tenant-Id\` must match the message's tenant; a foreign message answers the same
  **404** as a missing one.
- \`attempts\` is the timeline from \`store.attempts\`: \`[{"attempt": 1, "outcome": "unavailable"}, …]\`.`,
  sequence: {
    participants: ['Client', 'Email API', 'Message store', 'Gate'],
    messages: [
      {from: 'Client', to: 'Email API', label: 'GET /v1/messages/m-7 · X-Tenant-Id', kind: 'sync'},
      {from: 'Email API', to: 'Message store', label: 'load(m-7) · attempts(m-7)', kind: 'sync'},
      {from: 'Message store', to: 'Email API', label: 'tenant · state · bounce_category · timeline', kind: 'reply'},
      {from: 'Email API', to: 'Gate', label: 'is_suppressed(recipient)', kind: 'sync'},
      {
        from: 'Email API',
        to: 'Client',
        label: '200 {state, bounce_category, suppressed, attempts} · 404 for another tenant',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/messages/{id}',
      detail: 'Register `GET /v1/messages/{id}`: a sent message reads as `sent`, an unknown id is **404**.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/messages\/\{/, /store\.load\(/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/messages\/:/, /\bload\(/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/messages\/\{/, /store\.Load\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"messages"\s*\/\s*Segment\s*\)/, /Store\.load\(/]},
        cpp: {all: [/svr\.Get\(\s*R?"\(?\/v1\/messages\//, /store::load\(/]},
      },
    },
    {
      id: 'state-from-record',
      title: 'Reports the state the record holds',
      detail:
        "The response's `state` is the record's state; the starter answers `sent` for every message that did not bounce, queued and deferred ones included.",
      match: {
        python: {all: [/["']state["']\s*:\s*message\[["']state["']\]/], none: [/["']sent["']/]},
        typescript: {all: [/state:\s*message\.state\b/], none: [/['"]sent['"]/]},
        go: {all: [/"state":\s*message\.State\b/], none: [/"sent"/]},
        scala: {all: [/"state"\s*->\s*JsString\(message\.state\)/], none: [/"sent"/]},
        cpp: {all: [/\{"state",\s*message->state\}/], none: [/"sent"/]},
      },
    },
    {
      id: 'bounce-category',
      title: 'Carries the bounce category',
      detail: 'The response always has `bounce_category`, the relay\'s reason for a bounce (`""` without one).',
      match: {
        python: {all: [/["']bounce_category["']\s*:/]},
        typescript: {all: [/bounce_category:/]},
        go: {all: [/"bounce_category":/]},
        scala: {all: [/"bounce_category"\s*->/]},
        cpp: {all: [/\{"bounce_category",/]},
      },
    },
    {
      id: 'foreign-404',
      title: "Answers another tenant's message with 404",
      detail:
        "The message's tenant is compared with the caller's `X-Tenant-Id`; a mismatch answers the same **404** as a missing id, so ids confirm nothing.",
      match: {
        python: {
          all: [/x-tenant-id/i, /message\[["']tenant["']\]\s*!=\s*tenant|tenant\s*!=\s*message\[["']tenant["']\]/],
        },
        typescript: {all: [/x-tenant-id/i, /message\.tenant\s*!==\s*tenant|tenant\s*!==\s*message\.tenant/]},
        go: {all: [/X-Tenant-Id/i, /message\.Tenant\s*!=/]},
        scala: {all: [/X-Tenant-Id/i, /message\.tenant/]},
        cpp: {all: [/X-Tenant-Id/i, /message->tenant\s*!=/]},
      },
    },
    {
      id: 'timeline',
      title: 'Shows the attempt timeline',
      detail: 'The response carries `attempts` from `store.attempts`, every relay attempt and its outcome in order.',
      match: {
        python: {all: [/store\.attempts\(/]},
        typescript: {all: [/\battempts\(/]},
        go: {all: [/store\.Attempts\(/]},
        scala: {all: [/Store\.attempts\(/]},
        cpp: {all: [/store::attempts\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from mail import gate, store  # store.load, attempts; gate.is_suppressed

app = FastAPI()


@app.get("/v1/messages/{message_id}")
def read_message(message_id: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    message = store.load(message_id)
    if message is None:
        raise HTTPException(status_code=404, detail="no such message")
    state = "bounced" if message["state"] == "bounced" else "sent"
    return {"message_id": message_id, "state": state, "suppressed": gate.is_suppressed(message["recipient"])}
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from mail import gate, store  # store.load, attempts; gate.is_suppressed

app = FastAPI()


@app.get("/v1/messages/{message_id}")
def read_message(message_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    message = store.load(message_id)
    # Another tenant's message answers like a missing one: an id confirms nothing.
    if message is None or message["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such message")
    return {
        "message_id": message_id,
        "state": message["state"],
        "bounce_category": message["bounce_category"],
        "suppressed": gate.is_suppressed(message["recipient"]),
        "attempts": store.attempts(message_id),
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {isSuppressed} from 'mail/gate';
import {load} from 'mail/store'; // load(id); attempts(id) is the timeline

export const app = Fastify();

app.get('/v1/messages/:messageId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {messageId} = request.params as {messageId: string};
  const message = await load(messageId);
  if (message === null) return reply.code(404).send({error: 'no such message'});
  const state = message.state === 'bounced' ? 'bounced' : 'sent';
  return {message_id: messageId, state, suppressed: await isSuppressed(message.recipient)};
});
`,
      solution: `import Fastify from 'fastify';

import {isSuppressed} from 'mail/gate';
import {attempts, load} from 'mail/store';

export const app = Fastify();

app.get('/v1/messages/:messageId', async (request, reply) => {
  const {messageId} = request.params as {messageId: string};
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  const message = await load(messageId);
  // Another tenant's message answers like a missing one: an id confirms nothing.
  if (message === null || message.tenant !== tenant) return reply.code(404).send({error: 'no such message'});
  return {
    message_id: messageId,
    state: message.state,
    bounce_category: message.bounce_category,
    suppressed: await isSuppressed(message.recipient),
    attempts: await attempts(messageId),
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"mail/gate"  // gate.IsSuppressed
	"mail/store" // store.Load, Attempts
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readMessage(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	messageID := r.PathValue("id")
	message := store.Load(r.Context(), messageID)
	if message == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such message"})
		return
	}
	suppressed, err := gate.IsSuppressed(r.Context(), message.Recipient)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try again"})
		return
	}
	state := "sent"
	if message.State == "bounced" {
		state = "bounced"
	}
	writeJSON(rw, http.StatusOK, map[string]any{"message_id": messageID, "state": state, "suppressed": suppressed})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/messages/{id}", readMessage)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"mail/gate"  // gate.IsSuppressed
	"mail/store" // store.Load, Attempts
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readMessage(rw http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("id")
	message := store.Load(r.Context(), messageID)
	// Another tenant's message answers like a missing one: an id confirms nothing.
	if message == nil || message.Tenant != r.Header.Get("X-Tenant-Id") {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such message"})
		return
	}
	suppressed, err := gate.IsSuppressed(r.Context(), message.Recipient)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try again"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"message_id":      messageID,
		"state":           message.State,
		"bounce_category": message.BounceCategory,
		"suppressed":      suppressed,
		"attempts":        store.Attempts(r.Context(), messageID),
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/messages/{id}", readMessage)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import mail.{Gate, Store} // Store.load, attempts; Gate.isSuppressed

object Read {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "messages" / Segment) { messageId =>
    get {
      // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
      complete(Store.load(messageId) match {
        case None => json(StatusCodes.NotFound, JsObject("error" -> JsString("no such message")))
        case Some(message) =>
          val state = if (message.state == "bounced") "bounced" else "sent"
          json(StatusCodes.OK, JsObject(
            "message_id" -> JsString(messageId),
            "state" -> JsString(state),
            "suppressed" -> JsBoolean(Gate.isSuppressed(message.recipient))))
      })
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import mail.{Gate, Store} // Store.load, attempts; Gate.isSuppressed

object Read {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "messages" / Segment) { messageId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        complete(Store.load(messageId) match {
          // Another tenant's message answers like a missing one: an id confirms nothing.
          case Some(message) if tenant.contains(message.tenant) =>
            val attempts = Store.attempts(messageId).map(a => JsObject("attempt" -> JsNumber(a.attempt), "outcome" -> JsString(a.outcome)))
            json(StatusCodes.OK, JsObject(
              "message_id" -> JsString(messageId),
              "state" -> JsString(message.state),
              "bounce_category" -> JsString(message.bounceCategory),
              "suppressed" -> JsBoolean(Gate.isSuppressed(message.recipient)),
              "attempts" -> JsArray(attempts.toVector)))
          case _ => json(StatusCodes.NotFound, JsObject("error" -> JsString("no such message")))
        })
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "mail/gate.h"   // mail::gate::isSuppressed
#include "mail/store.h"  // mail::store::load, attempts

using json = nlohmann::json;
namespace store = mail::store;
namespace gate = mail::gate;

void read_message(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string message_id = req.matches[1];
  const auto message = store::load(message_id);
  if (!message) {
    res.status = 404;
    res.set_content(json{{"error", "no such message"}}.dump(), "application/json");
    return;
  }
  const std::string state = message->state == "bounced" ? "bounced" : "sent";
  res.set_content(json{{"message_id", message_id}, {"state", state}, {"suppressed", gate::isSuppressed(message->recipient)}}.dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/messages/([\\w-]+))", read_message); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "mail/gate.h"   // mail::gate::isSuppressed
#include "mail/store.h"  // mail::store::load, attempts

using json = nlohmann::json;
namespace store = mail::store;
namespace gate = mail::gate;

void read_message(const httplib::Request& req, httplib::Response& res) {
  const std::string message_id = req.matches[1];
  const auto message = store::load(message_id);
  // Another tenant's message answers like a missing one: an id confirms nothing.
  if (!message || message->tenant != req.get_header_value("X-Tenant-Id")) {
    res.status = 404;
    res.set_content(json{{"error", "no such message"}}.dump(), "application/json");
    return;
  }
  json attempts = json::array();
  for (const auto& a : store::attempts(message_id)) attempts.push_back({{"attempt", a.attempt}, {"outcome", a.outcome}});
  const json body = {{"message_id", message_id},
                     {"state", message->state},
                     {"bounce_category", message->bounce_category},
                     {"suppressed", gate::isSuppressed(message->recipient)},
                     {"attempts", attempts}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/messages/([\\w-]+))", read_message); }
`,
    },
  },
  harness: {
    python: `from mail import store


def _api(ctx):
    return ctx.client(ctx.load("read").app)


def _message(state="queued", category="", recipient="ana@example.com", tenant="t-1"):
    message_id = store.enqueue(tenant, recipient, "welcome", "Welcome", {"first_name": "Ana"})
    if state != "queued":
        store.set_state(message_id, state, category)
    return message_id


async def _read(c, message_id, tenant="t-1"):
    return await c.get(f"/v1/messages/{message_id}", headers={"X-Tenant-Id": tenant} if tenant else {})


async def check_route(ctx):
    message_id = _message("sent")
    async with _api(ctx) as c:
        r = await _read(c, message_id)
        missing = await _read(c, "m-404")
    assert r.status_code == 200, f"GET /v1/messages/{message_id} answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("message_id") == message_id and body.get("state") == "sent", f"a sent message reads {body}"
    assert missing.status_code == 404, f"an unknown id answered {missing.status_code}, expected 404"


async def check_state_from_record(ctx):
    cases = [(_message(), "queued"), (_message("deferred"), "deferred"), (_message("suppressed", recipient="blocked@example.com"), "suppressed")]
    async with _api(ctx) as c:
        for message_id, want in cases:
            r = await _read(c, message_id)
            assert r.status_code == 200, f"GET /v1/messages/{message_id} answered {r.status_code}: {r.text}"
            state = r.json().get("state")
            assert state == want, f"a {want} message reads as {state!r}: the customer is told it went out while the relay never accepted it. Report the record's state"


async def check_bounce_category(ctx):
    bounced = _message("bounced", "mailbox_unknown", recipient="bounce@example.com")
    ctx.redis.sadd("mail:suppressed", "bounce@example.com")
    sent = _message("sent")
    async with _api(ctx) as c:
        body = (await _read(c, bounced)).json()
        clean = (await _read(c, sent)).json()
    assert body.get("state") == "bounced", f"a bounced message reads {body}"
    assert body.get("bounce_category") == "mailbox_unknown", f"a bounced message reads {body}: without bounce_category support cannot tell a dead mailbox from a full one"
    assert body.get("suppressed") is True, f"the bounced address is suppressed, the read says {body.get('suppressed')!r}"
    assert clean.get("bounce_category") == "" and clean.get("suppressed") is False, f"a sent message must carry an empty bounce_category and suppressed false, got {clean}"


async def check_foreign_404(ctx):
    message_id = _message("sent")
    async with _api(ctx) as c:
        foreign = await _read(c, message_id, tenant="t-2")
        anonymous = await _read(c, message_id, tenant=None)
        own = await _read(c, message_id)
    assert foreign.status_code == 404, f"tenant t-2 read t-1's message {message_id}: {foreign.status_code} {foreign.text}. Compare the message's tenant with X-Tenant-Id and answer 404"
    assert "ana@example.com" not in foreign.text, f"the answer to another tenant carries the recipient: {foreign.text}"
    assert anonymous.status_code == 404, f"a read without X-Tenant-Id answered {anonymous.status_code}, expected 404"
    assert own.status_code == 200, f"the owning tenant's read answered {own.status_code}"


async def check_timeline(ctx):
    message_id = _message()
    store.record_attempt(message_id, "unavailable")
    store.record_attempt(message_id, "accepted")
    store.set_state(message_id, "sent")
    async with _api(ctx) as c:
        body = (await _read(c, message_id)).json()
    want = [{"attempt": 1, "outcome": "unavailable"}, {"attempt": 2, "outcome": "accepted"}]
    assert body.get("attempts") == want, f"the read shows attempts {body.get('attempts')!r}, expected {want}: the retry behind the delivery is invisible"
`,
    typescript: `function api(ctx) {
  const c = ctx.client(ctx.load('read').app);
  const store = ctx.load('/support/mail/store.ts');
  const message = async (state = 'queued', category = '', recipient = 'ana@example.com', tenant = 't-1') => {
    const id = await store.enqueue(tenant, recipient, 'welcome', 'Welcome', {first_name: 'Ana'});
    if (state !== 'queued') await store.setState(id, state, category);
    return id;
  };
  const read = (id: string, tenant: string | null = 't-1') => c.get(\`/v1/messages/\${id}\`, {headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});
  return {store, message, read};
}

export async function check_route(ctx) {
  const {message, read} = api(ctx);
  const id = await message('sent');
  const r = await read(id);
  assert.equal(r.status, 200, \`GET /v1/messages/\${id} answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.message_id === id && body.state === 'sent', \`a sent message reads \${r.text}\`);
  const missing = await read('m-404');
  assert.equal(missing.status, 404, \`an unknown id answered \${missing.status}, expected 404\`);
}

export async function check_state_from_record(ctx) {
  const {message, read} = api(ctx);
  const cases: [string, string][] = [
    [await message(), 'queued'],
    [await message('deferred'), 'deferred'],
    [await message('suppressed', '', 'blocked@example.com'), 'suppressed'],
  ];
  for (const [id, want] of cases) {
    const r = await read(id);
    assert.equal(r.status, 200, \`GET /v1/messages/\${id} answered \${r.status}: \${r.text}\`);
    assert.equal(r.json().state, want, \`a \${want} message reads as \${r.json().state}: the customer is told it went out while the relay never accepted it. Report the record's state\`);
  }
}

export async function check_bounce_category(ctx) {
  const {message, read} = api(ctx);
  const bounced = await message('bounced', 'mailbox_unknown', 'bounce@example.com');
  ctx.redis.sadd('mail:suppressed', 'bounce@example.com');
  const sent = await message('sent');
  const body = (await read(bounced)).json();
  const clean = (await read(sent)).json();
  assert.equal(body.state, 'bounced', \`a bounced message reads \${JSON.stringify(body)}\`);
  assert.equal(body.bounce_category, 'mailbox_unknown', \`a bounced message reads \${JSON.stringify(body)}: without bounce_category support cannot tell a dead mailbox from a full one\`);
  assert.equal(body.suppressed, true, \`the bounced address is suppressed, the read says \${body.suppressed}\`);
  assert(clean.bounce_category === '' && clean.suppressed === false, \`a sent message must carry an empty bounce_category and suppressed false, got \${JSON.stringify(clean)}\`);
}

export async function check_foreign_404(ctx) {
  const {message, read} = api(ctx);
  const id = await message('sent');
  const foreign = await read(id, 't-2');
  assert.equal(foreign.status, 404, \`tenant t-2 read t-1's message \${id}: \${foreign.status} \${foreign.text}. Compare the message's tenant with X-Tenant-Id and answer 404\`);
  assert(!foreign.text.includes('ana@example.com'), \`the answer to another tenant carries the recipient: \${foreign.text}\`);
  const anonymous = await read(id, null);
  assert.equal(anonymous.status, 404, \`a read without X-Tenant-Id answered \${anonymous.status}, expected 404\`);
  assert.equal((await read(id)).status, 200, "the owning tenant's read must answer 200");
}

export async function check_timeline(ctx) {
  const {store, message, read} = api(ctx);
  const id = await message();
  await store.recordAttempt(id, 'unavailable');
  await store.recordAttempt(id, 'accepted');
  await store.setState(id, 'sent');
  const body = (await read(id)).json();
  const want = [{attempt: 1, outcome: 'unavailable'}, {attempt: 2, outcome: 'accepted'}];
  assert.deepStrictEqual(body.attempts, want, \`the read shows attempts \${JSON.stringify(body.attempts)}: the retry behind the delivery is invisible\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"mail/store"

	"leetbuild/harness"
)

var readBg = context.Background()

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func newStored(state, category, recipient string) string {
	id := store.Enqueue(readBg, "t-1", recipient, "welcome", "Welcome", map[string]string{"first_name": "Ana"})
	if state != "queued" {
		store.SetState(readBg, id, state, category)
	}
	return id
}

func readAs(c *harness.HTTP, id, tenant string) *harness.Response {
	if tenant == "" {
		return c.Get("/v1/messages/" + id)
	}
	return c.Get("/v1/messages/"+id, "X-Tenant-Id", tenant)
}

func bodyOf(ctx *harness.Ctx, r *harness.Response) map[string]any {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the read answered %d %s, expected a JSON object", r.Status, r.Text())
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	id := newStored("sent", "", "ana@example.com")
	r := readAs(c, id, "t-1")
	ctx.Equal(r.Status, 200, "GET /v1/messages/%s (%s)", id, r.Text())
	body := bodyOf(ctx, r)
	ctx.Assert(body["message_id"] == id && body["state"] == "sent", "a sent message reads %s", r.Text())
	ctx.Equal(readAs(c, "m-404", "t-1").Status, 404, "an unknown id")
}

func CheckStateFromRecord(ctx *harness.Ctx) {
	c := api(ctx)
	cases := [][2]string{
		{newStored("queued", "", "ana@example.com"), "queued"},
		{newStored("deferred", "", "ana@example.com"), "deferred"},
		{newStored("suppressed", "", "blocked@example.com"), "suppressed"},
	}
	for _, tc := range cases {
		r := readAs(c, tc[0], "t-1")
		ctx.Equal(r.Status, 200, "GET /v1/messages/%s (%s)", tc[0], r.Text())
		ctx.Equal(bodyOf(ctx, r)["state"], tc[1], "a %s message must not read as sent while the relay never accepted it (report the record's state); the state", tc[1])
	}
}

func CheckBounceCategory(ctx *harness.Ctx) {
	c := api(ctx)
	bounced := newStored("bounced", "mailbox_unknown", "bounce@example.com")
	ctx.Redis.Do("SADD", "mail:suppressed", "bounce@example.com")
	sent := newStored("sent", "", "ana@example.com")
	body := bodyOf(ctx, readAs(c, bounced, "t-1"))
	clean := bodyOf(ctx, readAs(c, sent, "t-1"))
	ctx.Equal(body["state"], "bounced", "a bounced message's state")
	ctx.Equal(body["bounce_category"], "mailbox_unknown", "without bounce_category support cannot tell a dead mailbox from a full one; a bounced message's bounce_category")
	ctx.Equal(body["suppressed"], true, "the bounced address is suppressed; the read's suppressed")
	ctx.Assert(clean["bounce_category"] == "" && clean["suppressed"] == false, "a sent message must carry an empty bounce_category and suppressed false, got %v", clean)
}

func CheckForeign404(ctx *harness.Ctx) {
	c := api(ctx)
	id := newStored("sent", "", "ana@example.com")
	foreign := readAs(c, id, "t-2")
	ctx.Equal(foreign.Status, 404, "tenant t-2 read t-1's message %s (%s): compare the message's tenant with X-Tenant-Id and answer 404", id, foreign.Text())
	ctx.Assert(!strings.Contains(foreign.Text(), "ana@example.com"), "the answer to another tenant carries the recipient: %s", foreign.Text())
	ctx.Equal(readAs(c, id, "").Status, 404, "a read without X-Tenant-Id")
	ctx.Equal(readAs(c, id, "t-1").Status, 200, "the owning tenant's read")
}

func CheckTimeline(ctx *harness.Ctx) {
	c := api(ctx)
	id := newStored("queued", "", "ana@example.com")
	store.RecordAttempt(readBg, id, "unavailable")
	store.RecordAttempt(readBg, id, "accepted")
	store.SetState(readBg, id, "sent", "")
	body := bodyOf(ctx, readAs(c, id, "t-1"))
	want := []any{map[string]any{"attempt": 1, "outcome": "unavailable"}, map[string]any{"attempt": 2, "outcome": "accepted"}}
	ctx.Equal(body["attempts"], want, "the retry behind the delivery is invisible; the read's attempts")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <utility>
#include <vector>

#include "mail/store.h"

namespace {

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string newStored(const std::string& state, const std::string& category, const std::string& recipient) {
  const std::string id = mail::store::enqueue("t-1", recipient, "welcome", "Welcome", {{"first_name", "Ana"}});
  if (state != "queued") mail::store::setState(id, state, category);
  return id;
}

harness::Response readAs(harness::HTTP& c, const std::string& id, const std::string& tenant) {
  if (tenant.empty()) return c.Get("/v1/messages/" + id);
  return c.Get("/v1/messages/" + id, "X-Tenant-Id", tenant);
}

nlohmann::json bodyOf(harness::Ctx& ctx, const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the read answered %d %s, expected a JSON object", r.Status, r.Text());
  return body;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string id = newStored("sent", "", "ana@example.com");
  const auto r = readAs(c, id, "t-1");
  ctx.Equal(r.Status, 200, "GET /v1/messages/%s (%s)", id, r.Text());
  const auto body = bodyOf(ctx, r);
  ctx.Assert(body.value("message_id", "") == id && body.value("state", "") == "sent", "a sent message reads %s", r.Text());
  ctx.Equal(readAs(c, "m-404", "t-1").Status, 404, "an unknown id");
}

void CheckStateFromRecord(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::vector<std::pair<std::string, std::string>> cases = {
      {newStored("queued", "", "ana@example.com"), "queued"},
      {newStored("deferred", "", "ana@example.com"), "deferred"},
      {newStored("suppressed", "", "blocked@example.com"), "suppressed"}};
  for (const auto& [id, want] : cases) {
    const auto r = readAs(c, id, "t-1");
    ctx.Equal(r.Status, 200, "GET /v1/messages/%s (%s)", id, r.Text());
    ctx.Equal(bodyOf(ctx, r).value("state", ""), want, "a %s message must not read as sent while the relay never accepted it (report the record's state); the state", want);
  }
}

void CheckBounceCategory(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string bounced = newStored("bounced", "mailbox_unknown", "bounce@example.com");
  ctx.Redis.Do("SADD", "mail:suppressed", "bounce@example.com");
  const std::string sent = newStored("sent", "", "ana@example.com");
  const auto body = bodyOf(ctx, readAs(c, bounced, "t-1"));
  const auto clean = bodyOf(ctx, readAs(c, sent, "t-1"));
  ctx.Equal(body.value("state", ""), "bounced", "a bounced message's state");
  ctx.Equal(body.value("bounce_category", "(missing)"), "mailbox_unknown", "without bounce_category support cannot tell a dead mailbox from a full one; a bounced message's bounce_category");
  ctx.Equal(body.value("suppressed", false), true, "the bounced address is suppressed; the read's suppressed");
  ctx.Assert(clean.value("bounce_category", "(missing)").empty() && clean.value("suppressed", true) == false, "a sent message must carry an empty bounce_category and suppressed false, got %s", clean.dump());
}

void CheckForeign404(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string id = newStored("sent", "", "ana@example.com");
  const auto foreign = readAs(c, id, "t-2");
  ctx.Equal(foreign.Status, 404, "tenant t-2 read t-1's message %s (%s): compare the message's tenant with X-Tenant-Id and answer 404", id, foreign.Text());
  ctx.Assert(foreign.Text().find("ana@example.com") == std::string::npos, "the answer to another tenant carries the recipient: %s", foreign.Text());
  ctx.Equal(readAs(c, id, "").Status, 404, "a read without X-Tenant-Id");
  ctx.Equal(readAs(c, id, "t-1").Status, 200, "the owning tenant's read");
}

void CheckTimeline(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string id = newStored("queued", "", "ana@example.com");
  mail::store::recordAttempt(id, "unavailable");
  mail::store::recordAttempt(id, "accepted");
  mail::store::setState(id, "sent");
  const auto body = bodyOf(ctx, readAs(c, id, "t-1"));
  const nlohmann::json want = nlohmann::json::array({{{"attempt", 1}, {"outcome", "unavailable"}}, {{"attempt", 2}, {"outcome", "accepted"}}});
  ctx.Assert(body.contains("attempts") && body["attempts"] == want, "the read shows attempts %s, expected %s: the retry behind the delivery is invisible",
             body.contains("attempts") ? body["attempts"].dump() : "(none)", want.dump());
}
`,
  },
  hints: [
    "Read a message that is still on the queue: it says `sent`. Read a bounced one: no category. Read another tenant's message id: 200 with its details.",
    "The state comes from one comparison (bounced or not) instead of the record, the response is built from three fields, and the caller's tenant is never compared with the message's.",
    "Answer 404 unless the message's `tenant` equals `X-Tenant-Id`; return `state`, `bounce_category`, `suppressed` and `store.attempts(id)` as the store holds them.",
  ],
  debrief: `The read is where the system tells a customer what happened, so it can only repeat what the record holds: a message the relay never accepted is queued or deferred, not sent, and a bounce carries the category the relay gave. Answering another tenant's id with the same 404 as a missing one keeps ids from confirming that a message exists. The attempt timeline lets support answer "why did it take an hour" without reading logs. Production status APIs add a timestamp to each transition, the relay's own message id for its support team, and the opens and clicks a tracking pixel reports, kept apart from delivery so a blocked pixel never reads as a failure.`,
};
