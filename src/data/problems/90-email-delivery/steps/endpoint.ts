import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/emails: a send that checks suppression first',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis', 'relay'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/emails\` with body \`{"recipient": "…",
"template_id": "…", "variables": {…}, "subject": "…"}\`. It calls \`relay.send\` with the body as
received, then checks \`is_suppressed\` and answers 409 or 202 with the message id. It compiles and
hides four flaws.

**Failure mode the checks target.** A suppressed address gets mailed because the relay call runs
before the suppression lookup; a client retry becomes a second send because no \`Idempotency-Key\`
is read; an unknown template or a huge variables map goes straight to the relay; and a subject with
\`\\r\\n\` adds headers to the message the relay builds.

Requirements:

- \`is_suppressed(recipient)\` runs before \`relay.send\`; a suppressed recipient is refused with
  **409** and the relay is not called.
- \`template_id\` must be in \`KNOWN_TEMPLATES\`; unknown ids are **400**.
- \`variables\` is capped at **8 KiB** (\`MAX_VARIABLES_BYTES = 1 << 13\`) of UTF-8 in total; larger
  payloads are **413**.
- \`subject\` and every merge value are **400** when \`has_crlf\` finds \`\\r\` or \`\\n\`.
- \`Idempotency-Key\` is required (**400** when missing). \`store.get(recipient, key)\` returns the
  stored message id on a replay; a fresh send calls \`store.put\` with the new id.`,
  sequence: {
    participants: ['Client', 'Email API', 'Suppression store', 'Relay'],
    messages: [
      {from: 'Client', to: 'Email API', label: 'POST /v1/emails · Idempotency-Key', kind: 'sync'},
      {from: 'Email API', to: 'Suppression store', label: 'is_suppressed(recipient)', kind: 'sync'},
      {from: 'Suppression store', to: 'Email API', label: 'suppressed / clear', kind: 'reply'},
      {from: 'Email API', to: 'Email API', label: 'validate template · variables · CRLF', kind: 'sync'},
      {from: 'Email API', to: 'Relay', label: 'send(recipient, template, variables)', kind: 'async'},
      {from: 'Email API', to: 'Client', label: '202 {message_id}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/emails',
      detail: 'Register the send route on `POST /v1/emails`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/emails["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/emails['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/emails"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"emails"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/emails"/]},
      },
    },
    {
      id: 'suppression-first',
      title: 'Consults the suppression list before calling the relay',
      detail:
        'A suppressed recipient is refused with **409** and the relay is never called. The starter queues the relay call first and checks suppression afterwards.',
      match: {
        python: {all: [/is_suppressed\(/, /status_code\s*=\s*409/], order: [/is_suppressed\(/, /relay\.send\(/]},
        typescript: {all: [/isSuppressed\(/, /code\(\s*409\s*\)/], order: [/isSuppressed\(/, /relay\.send\(/]},
        go: {all: [/isSuppressed\(/, /StatusConflict/], order: [/isSuppressed\(/, /relay\.Send\(/]},
        scala: {all: [/isSuppressed\(/, /StatusCodes\.Conflict/], order: [/isSuppressed\(/, /relay\.send\(/]},
        cpp: {all: [/isSuppressed\(/, /\b409\b/], order: [/isSuppressed\(/, /relay\.send\(/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys retries by (recipient, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required and the message id is stored under `(recipient, key)`; a replay returns the stored id instead of sending twice. The starter ignores the header entirely.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/idempotency-key/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/Idempotency-Key/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
      },
    },
    {
      id: 'validate-template-variables',
      title: 'Validates the template id and the 8 KiB merge-variable cap',
      detail:
        'Unknown template ids are **400** and merge variables over `1 << 13` bytes are **413**. The starter accepts any id and never measures the variables.',
      match: {
        python: {all: [/KNOWN_TEMPLATES/, /MAX_VARIABLES_BYTES/, /status_code\s*=\s*400/, /status_code\s*=\s*413/]},
        typescript: {all: [/KNOWN_TEMPLATES/, /MAX_VARIABLES_BYTES/, /code\(\s*400\s*\)/, /code\(\s*413\s*\)/]},
        go: {all: [/KnownTemplates/, /MaxVariablesBytes/, /StatusBadRequest/, /StatusRequestEntityTooLarge/]},
        scala: {
          all: [/KnownTemplates/, /MaxVariablesBytes/, /StatusCodes\.BadRequest/, /StatusCodes\.RequestEntityTooLarge/],
        },
        cpp: {all: [/kKnownTemplates/, /kMaxVariablesBytes/, /\b400\b/, /\b413\b/]},
      },
    },
    {
      id: 'reject-crlf',
      title: 'Rejects CRLF and header separators in subject and variables',
      detail:
        'Subject and merge values containing `\\r` or `\\n` are **400** so they cannot inject headers. The starter passes raw text to the relay.',
      match: {
        python: {all: [/has_crlf\(/, /\\r/, /\\n/, /status_code\s*=\s*400/]},
        typescript: {all: [/hasCrlf\(/, /\\r/, /\\n/, /code\(\s*400\s*\)/]},
        go: {all: [/hasCRLF\(/, /\\r\\n/, /StatusBadRequest/]},
        scala: {all: [/hasCrlf\(/, /\\r/, /\\n/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/hasCrlf\(/, /\\r/, /\\n/, /\b400\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

KNOWN_TEMPLATES = {"welcome", "receipt", "reset"}


class SendRequest(BaseModel):
    recipient: str
    template_id: str
    variables: dict[str, str] = {}
    subject: str = ""


class MessageStore:
    def get(self, recipient: str, idem_key: str):
        """The message id stored for (recipient, idem_key), if any."""
        raise NotImplementedError

    def put(self, recipient: str, idem_key: str, message_id: str) -> None:
        """Store the message id under (recipient, idem_key)."""
        raise NotImplementedError


store = MessageStore()


class Relay:
    def send(self, recipient: str, template_id: str, variables: dict, subject: str) -> str:
        """Hand the message to the relay and return a message id."""
        raise NotImplementedError


relay = Relay()


@app.post("/v1/emails")
def send(body: SendRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    message_id = relay.send(body.recipient, body.template_id, body.variables, body.subject)
    if is_suppressed(body.recipient):
        return JSONResponse({"error": "suppressed"}, status_code=409)
    return JSONResponse({"message_id": message_id}, status_code=202)
`,
      solution: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

KNOWN_TEMPLATES = {"welcome", "receipt", "reset"}
MAX_VARIABLES_BYTES = 1 << 13


class SendRequest(BaseModel):
    recipient: str
    template_id: str
    variables: dict[str, str] = {}
    subject: str = ""


class MessageStore:
    def get(self, recipient: str, idem_key: str) -> str | None:
        """The message id stored for (recipient, idem_key), if any."""
        raise NotImplementedError

    def put(self, recipient: str, idem_key: str, message_id: str) -> None:
        """Store the message id under (recipient, idem_key)."""
        raise NotImplementedError


store = MessageStore()


class Relay:
    def send(self, recipient: str, template_id: str, variables: dict, subject: str) -> str:
        """Hand the message to the relay and return a message id."""
        raise NotImplementedError


relay = Relay()


def is_suppressed(recipient: str) -> bool:
    """True when the recipient is on the suppression list."""
    raise NotImplementedError


def has_crlf(value: str) -> bool:
    return "\\r" in value or "\\n" in value


@app.post("/v1/emails")
def send(body: SendRequest, idempotency_key: str = Header(alias="Idempotency-Key")) -> JSONResponse:
    if not idempotency_key:
        return JSONResponse({"error": "idempotency key required"}, status_code=400)
    if body.template_id not in KNOWN_TEMPLATES:
        return JSONResponse({"error": "unknown template"}, status_code=400)
    size = sum(len(k.encode()) + len(v.encode()) for k, v in body.variables.items())
    if size > MAX_VARIABLES_BYTES:
        return JSONResponse({"error": "variables too large"}, status_code=413)
    if has_crlf(body.subject):
        return JSONResponse({"error": "invalid subject"}, status_code=400)
    for value in body.variables.values():
        if has_crlf(value):
            return JSONResponse({"error": "invalid variable"}, status_code=400)
    if is_suppressed(body.recipient):
        return JSONResponse({"error": "suppressed"}, status_code=409)
    stored = store.get(body.recipient, idempotency_key)
    if stored:
        return JSONResponse({"message_id": stored}, status_code=202)
    message_id = relay.send(body.recipient, body.template_id, body.variables, body.subject)
    store.put(body.recipient, idempotency_key, message_id)
    return JSONResponse({"message_id": message_id}, status_code=202)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

const app = Fastify();

const KNOWN_TEMPLATES = new Set(['welcome', 'receipt', 'reset']);

interface SendBody {
  recipient: string;
  template_id: string;
  variables: Record<string, string>;
  subject: string;
}

interface MessageStore {
  get(recipient: string, idemKey: string): Promise<string | null>;
  put(recipient: string, idemKey: string, messageId: string): Promise<void>;
}

const store: MessageStore = {
  async get() {
    throw new Error('Not implemented');
  },
  async put() {
    throw new Error('Not implemented');
  },
};

interface Relay {
  send(recipient: string, templateId: string, variables: Record<string, string>, subject: string): Promise<string>;
}

const relay: Relay = {
  async send() {
    throw new Error('Not implemented');
  },
};

app.post('/v1/emails', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const body = request.body as SendBody;
  const messageId = await relay.send(body.recipient, body.template_id, body.variables, body.subject);
  if (await isSuppressed(body.recipient)) {
    return reply.code(409).send({error: 'suppressed'});
  }
  return reply.code(202).send({message_id: messageId});
});
`,
      solution: `import Fastify from 'fastify';

const app = Fastify();

const KNOWN_TEMPLATES = new Set(['welcome', 'receipt', 'reset']);
const MAX_VARIABLES_BYTES = 1 << 13;

interface SendBody {
  recipient: string;
  template_id: string;
  variables: Record<string, string>;
  subject: string;
}

interface MessageStore {
  get(recipient: string, idemKey: string): Promise<string | null>;
  put(recipient: string, idemKey: string, messageId: string): Promise<void>;
}

const store: MessageStore = {
  async get() {
    throw new Error('Not implemented');
  },
  async put() {
    throw new Error('Not implemented');
  },
};

interface Relay {
  send(recipient: string, templateId: string, variables: Record<string, string>, subject: string): Promise<string>;
}

const relay: Relay = {
  async send() {
    throw new Error('Not implemented');
  },
};

function hasCrlf(value: string): boolean {
  return value.includes('\\r') || value.includes('\\n');
}

app.post('/v1/emails', async (request, reply) => {
  const idemKey = request.headers['idempotency-key'] as string | undefined;
  if (!idemKey) {
    return reply.code(400).send({error: 'idempotency key required'});
  }
  const body = request.body as SendBody;
  if (!KNOWN_TEMPLATES.has(body.template_id)) {
    return reply.code(400).send({error: 'unknown template'});
  }
  const size = Object.entries(body.variables).reduce(
    (n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v),
    0,
  );
  if (size > MAX_VARIABLES_BYTES) {
    return reply.code(413).send({error: 'variables too large'});
  }
  if (hasCrlf(body.subject)) {
    return reply.code(400).send({error: 'invalid subject'});
  }
  for (const value of Object.values(body.variables)) {
    if (hasCrlf(value)) {
      return reply.code(400).send({error: 'invalid variable'});
    }
  }
  if (await isSuppressed(body.recipient)) {
    return reply.code(409).send({error: 'suppressed'});
  }
  const stored = await store.get(body.recipient, idemKey);
  if (stored) {
    return reply.code(202).send({message_id: stored});
  }
  const messageId = await relay.send(body.recipient, body.template_id, body.variables, body.subject);
  await store.put(body.recipient, idemKey, messageId);
  return reply.code(202).send({message_id: messageId});
});
`,
    },
    go: {
      starter: `package api

import (
	"encoding/json"
	"net/http"
)

var KnownTemplates = map[string]bool{"welcome": true, "receipt": true, "reset": true}

type SendBody struct {
	Recipient  string            \`json:"recipient"\`
	TemplateID string            \`json:"template_id"\`
	Variables  map[string]string \`json:"variables"\`
	Subject    string            \`json:"subject"\`
}

type MessageStore interface {
	Get(recipient, idemKey string) (string, bool)
	Put(recipient, idemKey, messageID string)
}

type Relay interface {
	Send(recipient, templateID string, variables map[string]string, subject string) (string, error)
}

func Register(mux *http.ServeMux, store MessageStore, relay Relay) {
	mux.HandleFunc("POST /v1/emails", func(w http.ResponseWriter, r *http.Request) {
		// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
		var body SendBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		messageID, err := relay.Send(body.Recipient, body.TemplateID, body.Variables, body.Subject)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		if isSuppressed(body.Recipient) {
			http.Error(w, "suppressed", http.StatusConflict)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]string{"message_id": messageID})
	})
}
`,
      solution: `package api

import (
	"encoding/json"
	"net/http"
	"strings"
)

const MaxVariablesBytes = 1 << 13

var KnownTemplates = map[string]bool{"welcome": true, "receipt": true, "reset": true}

type SendBody struct {
	Recipient  string            \`json:"recipient"\`
	TemplateID string            \`json:"template_id"\`
	Variables  map[string]string \`json:"variables"\`
	Subject    string            \`json:"subject"\`
}

type MessageStore interface {
	Get(recipient, idemKey string) (string, bool)
	Put(recipient, idemKey, messageID string)
}

type Relay interface {
	Send(recipient, templateID string, variables map[string]string, subject string) (string, error)
}

func hasCRLF(value string) bool {
	return strings.ContainsAny(value, "\\r\\n")
}

func Register(mux *http.ServeMux, store MessageStore, relay Relay) {
	mux.HandleFunc("POST /v1/emails", func(w http.ResponseWriter, r *http.Request) {
		idemKey := r.Header.Get("Idempotency-Key")
		if idemKey == "" {
			http.Error(w, "idempotency key required", http.StatusBadRequest)
			return
		}
		var body SendBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if !KnownTemplates[body.TemplateID] {
			http.Error(w, "unknown template", http.StatusBadRequest)
			return
		}
		size := 0
		for k, v := range body.Variables {
			size += len(k) + len(v)
		}
		if size > MaxVariablesBytes {
			http.Error(w, "variables too large", http.StatusRequestEntityTooLarge)
			return
		}
		if hasCRLF(body.Subject) {
			http.Error(w, "invalid subject", http.StatusBadRequest)
			return
		}
		for _, v := range body.Variables {
			if hasCRLF(v) {
				http.Error(w, "invalid variable", http.StatusBadRequest)
				return
			}
		}
		if isSuppressed(body.Recipient) {
			http.Error(w, "suppressed", http.StatusConflict)
			return
		}
		if stored, ok := store.Get(body.Recipient, idemKey); ok {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusAccepted)
			json.NewEncoder(w).Encode(map[string]string{"message_id": stored})
			return
		}
		messageID, err := relay.Send(body.Recipient, body.TemplateID, body.Variables, body.Subject)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		store.Put(body.Recipient, idemKey, messageID)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]string{"message_id": messageID})
	})
}
`,
    },
    scala: {
      starter: `package api

import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object Api {
  val KnownTemplates: Set[String] = Set("welcome", "receipt", "reset")

  final case class SendBody(recipient: String, templateId: String, variables: Map[String, String], subject: String)

  trait MessageStore {
    def get(recipient: String, idemKey: String): Option[String]
    def put(recipient: String, idemKey: String, messageId: String): Unit
  }

  trait Relay {
    def send(recipient: String, templateId: String, variables: Map[String, String], subject: String): String
  }

  def routes(store: MessageStore, relay: Relay): Route =
    path("v1" / "emails") {
      post {
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        entity(as[SendBody]) { body =>
          val messageId = relay.send(body.recipient, body.templateId, body.variables, body.subject)
          if (isSuppressed(body.recipient)) {
            complete(StatusCodes.Conflict, "suppressed")
          } else {
            complete(StatusCodes.Accepted, s"""{"message_id":"$messageId"}""")
          }
        }
      }
    }
}
`,
      solution: `package api

import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object Api {
  val KnownTemplates: Set[String] = Set("welcome", "receipt", "reset")
  val MaxVariablesBytes: Int = 1 << 13

  final case class SendBody(recipient: String, templateId: String, variables: Map[String, String], subject: String)

  trait MessageStore {
    def get(recipient: String, idemKey: String): Option[String]
    def put(recipient: String, idemKey: String, messageId: String): Unit
  }

  trait Relay {
    def send(recipient: String, templateId: String, variables: Map[String, String], subject: String): String
  }

  def hasCrlf(value: String): Boolean = value.contains("\\r") || value.contains("\\n")

  def routes(store: MessageStore, relay: Relay): Route =
    path("v1" / "emails") {
      post {
        headerValueByName("Idempotency-Key") { idemKey =>
          entity(as[SendBody]) { body =>
            if (idemKey.isEmpty) {
              complete(StatusCodes.BadRequest, "idempotency key required")
            } else if (!KnownTemplates.contains(body.templateId)) {
              complete(StatusCodes.BadRequest, "unknown template")
            } else if (body.variables.values.map(_.getBytes("UTF-8").length).sum > MaxVariablesBytes) {
              complete(StatusCodes.RequestEntityTooLarge, "variables too large")
            } else if (hasCrlf(body.subject)) {
              complete(StatusCodes.BadRequest, "invalid subject")
            } else if (body.variables.values.exists(hasCrlf)) {
              complete(StatusCodes.BadRequest, "invalid variable")
            } else if (isSuppressed(body.recipient)) {
              complete(StatusCodes.Conflict, "suppressed")
            } else {
              store.get(body.recipient, idemKey) match {
                case Some(stored) => complete(StatusCodes.Accepted, s"""{"message_id":"$stored"}""")
                case None =>
                  val messageId = relay.send(body.recipient, body.templateId, body.variables, body.subject)
                  store.put(body.recipient, idemKey, messageId)
                  complete(StatusCodes.Accepted, s"""{"message_id":"$messageId"}""")
              }
            }
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

#include <set>
#include <string>

namespace api {

using json = nlohmann::json;

const std::set<std::string> kKnownTemplates = {"welcome", "receipt", "reset"};

struct SendBody {
  std::string recipient;
  std::string template_id;
  std::map<std::string, std::string> variables;
  std::string subject;
};

class MessageStore {
 public:
  std::string get(const std::string& recipient, const std::string& idem_key);
  void put(const std::string& recipient, const std::string& idem_key, const std::string& message_id);
};

class Relay {
 public:
  std::string send(const std::string& recipient, const std::string& template_id,
                   const std::map<std::string, std::string>& variables, const std::string& subject);
};

void Register(httplib::Server& svr, MessageStore& store, Relay& relay) {
  svr.Post("/v1/emails", [&](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    const json body = json::parse(req.body);
    const std::string message_id = relay.send(body["recipient"], body["template_id"],
                                              body["variables"], body["subject"]);
    if (isSuppressed(body["recipient"])) {
      res.status = 409;
      res.set_content("suppressed", "text/plain");
      return;
    }
    res.status = 202;
    res.set_content(json{{"message_id", message_id}}.dump(), "application/json");
  });
}

}  // namespace api
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <set>
#include <string>

namespace api {

using json = nlohmann::json;

constexpr std::size_t kMaxVariablesBytes = 1 << 13;
const std::set<std::string> kKnownTemplates = {"welcome", "receipt", "reset"};

struct SendBody {
  std::string recipient;
  std::string template_id;
  std::map<std::string, std::string> variables;
  std::string subject;
};

class MessageStore {
 public:
  std::string get(const std::string& recipient, const std::string& idem_key);
  void put(const std::string& recipient, const std::string& idem_key, const std::string& message_id);
};

class Relay {
 public:
  std::string send(const std::string& recipient, const std::string& template_id,
                   const std::map<std::string, std::string>& variables, const std::string& subject);
};

bool hasCrlf(const std::string& value) {
  return value.find('\\r') != std::string::npos || value.find('\\n') != std::string::npos;
}

void Register(httplib::Server& svr, MessageStore& store, Relay& relay) {
  svr.Post("/v1/emails", [&](const httplib::Request& req, httplib::Response& res) {
    const std::string idem_key = req.get_header_value("Idempotency-Key");
    if (idem_key.empty()) {
      res.status = 400;
      res.set_content("idempotency key required", "text/plain");
      return;
    }
    const json body = json::parse(req.body);
    if (kKnownTemplates.count(body["template_id"]) == 0) {
      res.status = 400;
      res.set_content("unknown template", "text/plain");
      return;
    }
    std::size_t size = 0;
    for (const auto& [k, v] : body["variables"].items()) {
      size += k.size() + v.get<std::string>().size();
    }
    if (size > kMaxVariablesBytes) {
      res.status = 413;
      res.set_content("variables too large", "text/plain");
      return;
    }
    if (hasCrlf(body["subject"])) {
      res.status = 400;
      res.set_content("invalid subject", "text/plain");
      return;
    }
    for (const auto& [k, v] : body["variables"].items()) {
      if (hasCrlf(v.get<std::string>())) {
        res.status = 400;
        res.set_content("invalid variable", "text/plain");
        return;
      }
    }
    if (isSuppressed(body["recipient"])) {
      res.status = 409;
      res.set_content("suppressed", "text/plain");
      return;
    }
    const std::string stored = store.get(body["recipient"], idem_key);
    if (!stored.empty()) {
      res.status = 202;
      res.set_content(json{{"message_id", stored}}.dump(), "application/json");
      return;
    }
    const std::string message_id = relay.send(body["recipient"], body["template_id"],
                                              body["variables"], body["subject"]);
    store.put(body["recipient"], idem_key, message_id);
    res.status = 202;
    res.set_content(json{{"message_id", message_id}}.dump(), "application/json");
  });
}

}  // namespace api
`,
    },
  },
  hints: [
    'An address that unsubscribed last week still receives mail from this endpoint, and a client that retried a timed-out POST produced two messages.',
    'The handler calls `relay.send` on line one and consults `is_suppressed` on line two, so the refusal arrives after the message has already left; nothing in the handler reads the retry header.',
    'Move `is_suppressed` ahead of `relay.send`, require `Idempotency-Key` and look it up with `store.get(recipient, key)` before sending. The remaining checks cover template, size and CRLF validation.',
  ],
  debrief: `The fix has the shape of a funnel: every refusal (suppression, template, size, CRLF, missing key) sits before the one line that calls the relay, because a send is irreversible and a refusal after it is only a log entry. Keying idempotency by \`(recipient, key)\` rather than by key alone keeps one client's reused key from colliding with another recipient's send. The CRLF check matters because the relay serialises the subject into a header line, so a newline in the value ends that line and starts a new header. Production senders also validate recipient syntax against the address grammar, cap the rendered message size rather than only the variables map, and record the suppression decision with the message so the status read can show why nothing was sent.`,
};
