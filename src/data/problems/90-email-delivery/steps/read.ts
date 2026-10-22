import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/messages/{id}: the story told honestly',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'store', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it looks up a message and
answers, so the demo works. It hides three flaws that make the answer a lie. Find them, fix them, and
prove the fix.

Implement \`GET /v1/messages/{id}\`, the status read for one message:

- The read returns the **relay state**, the **bounce category**, the **suppression status** and the
  **attempt timeline** for the message.
- A message with **no confirmed relay outcome is \`unknown\`**, never \`sent\`:
  \`state = "sent"\` requires \`relay_accepted\`; a bounced message reports \`"bounced"\`; anything else is
  \`"unknown"\`. The draft reports \`sent\` as soon as the message is queued.
- A **bounced message always carries its \`bounce_category\`**. The draft hides the category, so an
  operator cannot tell a hard bounce from a soft one.
- The read is **scoped to the caller**: the message id must belong to the authenticated tenant, and a
  foreign id is **404**. The draft returns any message id to any caller.
- The response includes the **attempt timeline** (\`attempts\`) so the retries and their outcomes are
  visible.

**Failure mode the checks target.** Reporting \`sent\` for a queued message tells the customer the mail
left when it may still be sitting in a retry queue; a hidden bounce category makes triage impossible;
and an unscoped read lets any tenant read any other tenant's message by guessing an id.`,
  sequence: {
    participants: ['Client', 'Email API', 'Message store', 'Suppression store'],
    messages: [
      {from: 'Client', to: 'Email API', label: 'GET /v1/messages/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Email API', to: 'Message store', label: 'get(id) — scoped to the caller tenant', kind: 'sync'},
      {
        from: 'Message store',
        to: 'Email API',
        label: 'record{relay_accepted, bounced, category, attempts}',
        kind: 'reply',
      },
      {from: 'Email API', to: 'Suppression store', label: 'sismember(suppression:list, recipient)', kind: 'sync'},
      {from: 'Suppression store', to: 'Email API', label: 'suppressed / clear', kind: 'reply'},
      {from: 'Email API', to: 'Client', label: '200 {state, bounce_category, suppressed, attempts}', kind: 'reply'},
      {from: 'Email API', to: 'Client', label: '404 when the id belongs to another tenant', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/messages/{id}',
      detail: 'Register the status read on `GET /v1/messages/{id}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/messages\/\{id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/messages\/:id['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/messages\/\{id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"messages"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/messages\/\{id\}"/]},
      },
    },
    {
      id: 'sent-requires-acceptance',
      title: 'Reports sent only after the relay accepted',
      detail:
        '`state` is `sent` only when `relay_accepted` is set; a message without a confirmed outcome is `unknown`. The draft reports `sent` while the message is still queued.',
      match: {
        python: {all: [/relay_accepted/, /"unknown"/]},
        typescript: {all: [/relay_accepted/, /['"]unknown['"]/]},
        go: {all: [/RelayAccepted/, /"unknown"/]},
        scala: {all: [/relay_accepted/, /"unknown"/]},
        cpp: {all: [/relay_accepted/, /"unknown"/]},
      },
    },
    {
      id: 'bounce-category',
      title: 'A bounced message always carries its category',
      detail:
        'The response includes `bounce_category`, so a hard bounce is distinguishable from a soft one. The draft hides the category.',
      match: {
        python: {all: [/bounce_category/]},
        typescript: {all: [/bounce_category/]},
        go: {all: [/BounceCategory/]},
        scala: {all: [/bounce_category/]},
        cpp: {all: [/bounce_category/]},
      },
    },
    {
      id: 'foreign-404',
      title: 'A message id from another tenant is 404',
      detail:
        'The read compares the record’s tenant with the authenticated caller and answers **404** on a mismatch. The draft returns any message id to any caller.',
      match: {
        python: {all: [/record\.tenant/, /\b404\b/]},
        typescript: {all: [/record\.tenant/, /code\(\s*404\s*\)/]},
        go: {all: [/record\.Tenant/, /StatusNotFound/]},
        scala: {all: [/record\.tenant/, /StatusCodes\.NotFound/]},
        cpp: {all: [/record->tenant/, /\b404\b/]},
      },
    },
    {
      id: 'timeline',
      title: 'Returns the attempt timeline',
      detail:
        'The response includes the `attempts` timeline, so retries and their outcomes are visible. The draft returns a thin `{message_id, state}` body.',
      match: {
        python: {all: [/attempts/]},
        typescript: {all: [/attempts/]},
        go: {all: [/Attempts/]},
        scala: {all: [/attempts/]},
        cpp: {all: [/attempts/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()


class MessageRecord:
    tenant: str
    bounced: bool


class MessageStore:
    def get(self, message_id: str):
        """The stored record for message_id, if any."""
        raise NotImplementedError


store = MessageStore()


@app.get("/v1/messages/{id}")
def read_message(id: str) -> JSONResponse:
    # TODO: this draft reports sent when queued, hides the bounce category, and returns any message
    # id to any caller without checking the tenant or the attempt timeline.
    record = store.get(id)
    return JSONResponse({"message_id": id, "state": "sent"}, status_code=200)
`,
      solution: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()


class MessageRecord:
    tenant: str
    relay_accepted: bool
    bounced: bool
    bounce_category: str
    suppressed: bool
    attempts: list[str]


class MessageStore:
    def get(self, message_id: str):
        """The stored record for message_id, if any."""
        raise NotImplementedError


store = MessageStore()


@app.get("/v1/messages/{id}")
def read_message(id: str, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    record = store.get(id)
    if record is None or record.tenant != tenant:
        return JSONResponse({"error": "not found"}, status_code=404)
    if record.relay_accepted:
        state = "sent"
    elif record.bounced:
        state = "bounced"
    else:
        state = "unknown"
    return JSONResponse(
        {
            "message_id": id,
            "state": state,
            "bounce_category": record.bounce_category if record.bounced else None,
            "suppressed": record.suppressed,
            "attempts": record.attempts,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

const app = Fastify();

interface MessageRecord {
  tenant: string;
  bounced: boolean;
}

interface MessageStore {
  get(messageId: string): Promise<MessageRecord | null>;
}

const store: MessageStore = {
  async get() {
    throw new Error('Not implemented');
  },
};

app.get('/v1/messages/:id', async (request, reply) => {
  // TODO: this draft reports sent when queued, hides the bounce category, and returns any message
  // id to any caller without checking the tenant or the attempt timeline.
  const {id} = request.params as {id: string};
  const record = await store.get(id);
  return reply.code(200).send({message_id: id, state: 'sent'});
});
`,
      solution: `import Fastify from 'fastify';

const app = Fastify();

interface MessageRecord {
  tenant: string;
  relay_accepted: boolean;
  bounced: boolean;
  bounce_category: string | null;
  suppressed: boolean;
  attempts: unknown[];
}

interface MessageStore {
  get(messageId: string): Promise<MessageRecord | null>;
}

const store: MessageStore = {
  async get() {
    throw new Error('Not implemented');
  },
};

app.get('/v1/messages/:id', async (request, reply) => {
  const {id} = request.params as {id: string};
  const tenant = request.headers['x-tenant-id'] as string;
  const record = await store.get(id);
  if (!record || record.tenant !== tenant) {
    return reply.code(404).send({error: 'not found'});
  }
  const state = record.relay_accepted ? 'sent' : record.bounced ? 'bounced' : 'unknown';
  return reply.code(200).send({
    message_id: id,
    state,
    bounce_category: record.bounced ? record.bounce_category : null,
    suppressed: record.suppressed,
    attempts: record.attempts,
  });
});
`,
    },
    go: {
      starter: `package read

import (
	"encoding/json"
	"net/http"
)

type MessageRecord struct {
	Tenant  string
	Bounced bool
}

type MessageStore interface {
	Get(messageID string) (MessageRecord, bool)
}

func Register(mux *http.ServeMux, store MessageStore) {
	mux.HandleFunc("GET /v1/messages/{id}", func(w http.ResponseWriter, r *http.Request) {
		// TODO: this draft reports sent when queued, hides the bounce category, and returns any
		// message id to any caller without checking the tenant or the attempt timeline.
		id := r.PathValue("id")
		_, _ = store.Get(id)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"message_id": id, "state": "sent"})
	})
}
`,
      solution: `package read

import (
	"encoding/json"
	"net/http"
)

type MessageRecord struct {
	Tenant         string
	RelayAccepted  bool
	Bounced        bool
	BounceCategory string
	Suppressed     bool
	Attempts       []string
}

type MessageStore interface {
	Get(messageID string) (MessageRecord, bool)
}

func Register(mux *http.ServeMux, store MessageStore) {
	mux.HandleFunc("GET /v1/messages/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		tenant := r.Header.Get("X-Tenant-Id")
		record, ok := store.Get(id)
		if !ok || record.Tenant != tenant {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		state := "unknown"
		if record.RelayAccepted {
			state = "sent"
		} else if record.Bounced {
			state = "bounced"
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"message_id":      id,
			"state":           state,
			"bounce_category": record.BounceCategory,
			"suppressed":      record.Suppressed,
			"attempts":        record.Attempts,
		})
	})
}
`,
    },
    scala: {
      starter: `package read

import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object Read {
  final case class MessageRecord(tenant: String, bounced: Boolean)

  trait MessageStore {
    def get(messageId: String): Option[MessageRecord]
  }

  def routes(store: MessageStore): Route =
    path("v1" / "messages" / Segment) { id =>
      get {
        // TODO: this draft reports sent when queued, hides the bounce category, and returns any
        // message id to any caller without checking the tenant or the attempt timeline.
        complete(StatusCodes.OK, s"""{"message_id":"$id","state":"sent"}""")
      }
    }
}
`,
      solution: `package read

import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object Read {
  final case class MessageRecord(
      tenant: String,
      relay_accepted: Boolean,
      bounced: Boolean,
      bounce_category: String,
      suppressed: Boolean,
      attempts: List[String],
  )

  trait MessageStore {
    def get(messageId: String): Option[MessageRecord]
  }

  def routes(store: MessageStore): Route =
    path("v1" / "messages" / Segment) { id =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          store.get(id) match {
            case Some(record) if tenantOpt.contains(record.tenant) =>
              val state =
                if (record.relay_accepted) "sent" else if (record.bounced) "bounced" else "unknown"
              complete(
                StatusCodes.OK,
                s"""{"message_id":"$id","state":"$state","bounce_category":"\${record.bounce_category}","suppressed":\${record.suppressed},"attempts":\${record.attempts.length}}""",
              )
            case _ =>
              complete(StatusCodes.NotFound, "not found")
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

namespace read {

using json = nlohmann::json;

struct MessageRecord {
  std::string tenant;
  bool bounced = false;
};

class MessageStore {
 public:
  std::optional<MessageRecord> get(const std::string& id);
};

void Register(httplib::Server& svr, MessageStore& store) {
  svr.Get("/v1/messages/{id}", [&](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft reports sent when queued, hides the bounce category, and returns any message
    // id to any caller without checking the tenant or the attempt timeline.
    const std::string id = req.path_params.at("id");
    store.get(id);
    res.status = 200;
    res.set_content(json{{"message_id", id}, {"state", "sent"}}.dump(), "application/json");
  });
}

}  // namespace read
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

namespace read {

using json = nlohmann::json;

struct MessageRecord {
  std::string tenant;
  bool relay_accepted = false;
  bool bounced = false;
  std::string bounce_category;
  bool suppressed = false;
  std::vector<std::string> attempts;
};

class MessageStore {
 public:
  std::optional<MessageRecord> get(const std::string& id);
};

void Register(httplib::Server& svr, MessageStore& store) {
  svr.Get("/v1/messages/{id}", [&](const httplib::Request& req, httplib::Response& res) {
    const std::string id = req.path_params.at("id");
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    const auto record = store.get(id);
    if (!record.has_value() || record->tenant != tenant) {
      res.status = 404;
      res.set_content("not found", "text/plain");
      return;
    }
    std::string state = "unknown";
    if (record->relay_accepted) {
      state = "sent";
    } else if (record->bounced) {
      state = "bounced";
    }
    res.status = 200;
    res.set_content(json{{"message_id", id},
                         {"state", state},
                         {"bounce_category", record->bounce_category},
                         {"suppressed", record->suppressed},
                         {"attempts", record->attempts}}
                        .dump(),
                    "application/json");
  });
}

}  // namespace read
`,
    },
  },
  hints: [
    'The state is derived from the record, not assumed: `sent` requires a confirmed relay acceptance, `bounced` needs the bounce, and anything without a confirmed outcome is `unknown`.',
    'A bounced message without its `bounce_category` cannot be triaged. Return the category alongside the state so a hard bounce is distinguishable from a soft one.',
    'A message id is not a capability: scope the read to the authenticated tenant and answer **404** when the record belongs to someone else, so an id from another tenant reveals nothing.',
  ],
  debrief: `The interviewer is testing whether you can review a read path for honesty and isolation. The draft reads fine because the demo reads back the message it just wrote. Three defects are being checked: a queued message reported as sent, a hidden bounce category, and an unscoped read that returns any message id. The fix derives the state from the record, always returns the category, and scopes by tenant with a 404. Real status reads add the attempt timeline, a signed pagination cursor, and an audit entry for every access to another tenant's message.`,
};
