import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/emails: a send that checks suppression first',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis', 'relay'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it accepts a send request and
hands it to the relay. It compiles, it serves the demo, and it hides three production flaws. Review
it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/emails\` with body \`{"recipient": "…", "template_id": "…", "variables": {…},
"subject": "…"}\`.

- The recipient must be a valid address and **not** on the suppression list; a suppressed recipient
  is refused with **409** before the relay is called.
- \`template_id\` must be a validated, known template id; unknown ids are **400**.
- \`variables\` is a map of merge values capped at **8 KiB** (\`1 << 13\` bytes) of UTF-8 in total;
  larger payloads are **413**.
- \`subject\` and every merge value must be rejected with **400** if they contain CRLF or header
  separators (\`\\r\`, \`\\n\`, or a lone \`\\r\`); the draft sends them straight into the relay call.
- \`Idempotency-Key\` is required (**400** when missing). A retry with the same
  \`(recipient, key)\` returns the stored message id instead of sending again.
- The suppression check happens **before** the relay is called; the draft checks it after queuing.

**Failure mode the checks target.** Checking suppression after queuing means a suppressed address is
mailed anyway; a missing \`Idempotency-Key\` turns a client retry into a second send; and raw subject
text with \`\\r\\n\` smuggles extra headers into the message the relay builds.`,
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
        'A suppressed recipient is refused with **409** and the relay is never called. The draft queues the relay call first and checks suppression afterwards.',
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
        '`Idempotency-Key` is required and the message id is stored under `(recipient, key)`; a replay returns the stored id instead of sending twice. The draft ignores the header entirely.',
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
        'Unknown template ids are **400** and merge variables over `1 << 13` bytes are **413**. The draft accepts any id and never measures the variables.',
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
        'Subject and merge values containing `\\r` or `\\n` are **400** so they cannot inject headers. The draft passes raw text to the relay.',
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
    # TODO: this draft queues the relay call before checking suppression, has no
    # Idempotency-Key so a client retry sends twice, and passes the raw subject into the relay
    # where a \\r\\n smuggles extra headers. Review all three.
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
  // TODO: this draft queues the relay call before checking suppression, has no
  // Idempotency-Key so a client retry sends twice, and passes the raw subject into the relay
  // where a \\r\\n smuggles extra headers. Review all three.
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
		// TODO: this draft queues the relay call before checking suppression, has no
		// Idempotency-Key so a client retry sends twice, and passes the raw subject into the relay
		// where a \\r\\n smuggles extra headers. Review all three.
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
        // TODO: this draft queues the relay call before checking suppression, has no
        // Idempotency-Key so a client retry sends twice, and passes the raw subject into the relay
        // where a \\r\\n smuggles extra headers. Review all three.
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
    // TODO: this draft queues the relay call before checking suppression, has no
    // Idempotency-Key so a client retry sends twice, and passes the raw subject into the relay
    // where a \\r\\n smuggles extra headers. Review all three.
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
    'The suppression check must be the first thing that can refuse the send. If `relay.send` appears before `is_suppressed` in the handler, a suppressed address is already mailed.',
    'A client retry is the same send: require `Idempotency-Key` and key the stored message id by `(recipient, key)`, returning the stored id on a replay.',
    'Header injection is a validation problem: reject `\\r` and `\\n` in the subject and in every merge value before the relay builds the message.',
  ],
  debrief: `The interviewer is testing whether you can review a send endpoint at the trust boundary. The draft reads fine because the demo sends to one recipient and never retries. Three separate defects are being checked: ordering (suppression before the relay call), idempotency (keyed by recipient so a retry cannot send twice), and header injection (CRLF in subject or variables). Real senders also validate the recipient syntax, cap total message size, and record the suppression decision in the same transaction as the send decision.`,
};
