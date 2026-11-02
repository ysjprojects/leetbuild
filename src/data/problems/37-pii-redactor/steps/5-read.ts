import type {Step} from '@/lib/types';

export const readRedactionStep: Step = {
  id: 'read',
  title: 'GET /v1/documents/{id}/redaction: spans, not text',
  concept: 'http',
  file: 'read',
  focus: ['client', 'redactor', 'db'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/documents/{document_id}/redaction\` by selecting
\`redacted_text\` from \`redactions\` by document id alone and returning it, with an empty string
when no row matches. It serves the demo, because the demo always asks for its own document, and
hides 4 flaws.

**Failure mode the checks target.** Two boundaries, one ceremony: tenancy and content. The missing
tenant predicate is an IDOR; any authenticated caller reads any document. Returning the redacted
text feels harmless because it *is* redacted, but it makes the audit system a second, less-guarded
copy of customer data.

- The tenant comes from \`X-Tenant-Id\` (**401** when absent) and the lookup is scoped by it:
  \`WHERE id = $1 AND tenant_id = $2\`.
- A missing **or foreign** document is **404**, not 403: a 403 confirms the document exists. One
  code for both cases.
- The response is \`{"document_id", "spans", "entity_types", "pattern_version", "redacted_length"}\`
  and no text field of any kind, not the original and not the stored redacted text.
- Each span is \`{start, end, entity, replacement}\`, so a caller who already holds the redacted
  output can reconstruct it: every \`[cursor, start)\` is a kept run, every \`replacement\` is a
  removed run, and the last run ends at \`redacted_length\`. Proving completeness without
  transferring the text is the point of the endpoint.`,
  sequence: {
    participants: ['Client', 'Redactor', 'Postgres'],
    messages: [
      {from: 'Client', to: 'Redactor', label: 'GET /v1/documents/{document_id}/redaction · X-Tenant-Id', kind: 'sync'},
      {from: 'Redactor', to: 'Redactor', label: '401 when the tenant is missing', kind: 'sync'},
      {from: 'Redactor', to: 'Postgres', label: 'SELECT … WHERE id = $1 AND tenant_id = $2', kind: 'sync'},
      {from: 'Postgres', to: 'Redactor', label: 'row / no row', kind: 'reply'},
      {from: 'Redactor', to: 'Client', label: '404 for missing or foreign — never 403', kind: 'reply'},
      {
        from: 'Redactor',
        to: 'Client',
        label: '200 {spans, entity_types, pattern_version, redacted_length}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/documents/{document_id}/redaction',
      detail:
        'Register the audit read on `GET /v1/documents/{document_id}/redaction` with the document id read from the path.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/documents\/\{document_id\}\/redaction["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/documents\/:document_id\/redaction['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/documents\/\{document_id\}\/redaction"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"documents"\s*\/\s*Segment\s*\/\s*"redaction"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(R"\(/, /documents\//, /redaction\)"/, /req\.matches\[1\]/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Scopes the lookup by id and tenant',
      detail:
        '`WHERE id = $1 AND tenant_id = $2`: the document id alone is an IDOR. The starter looks up by id only, so any tenant reads any document’s redaction record.',
      match: {
        python: {all: [/WHERE id = %s AND tenant_id = %s/]},
        typescript: {all: [/WHERE id = \$1 AND tenant_id = \$2/]},
        go: {all: [/WHERE id = \$1 AND tenant_id = \$2/]},
        scala: {all: [/WHERE id = \? AND tenant_id = \?/]},
        cpp: {all: [/WHERE id = \$1 AND tenant_id = \$2/]},
      },
    },
    {
      id: 'no-text',
      title: 'The response never contains text',
      detail:
        '`spans`, `entity_types`, `pattern_version` and `redacted_length` are in; `text`, `original`, `redacted_text` and any sampled values are out. The starter returns `redacted_text` for convenience.',
      match: {
        python: {
          all: [/"spans"/, /entity_types/, /pattern_version/],
          none: [/["'](?:samples?|values|original)["']/, /["']redacted_text["']/, /["']text["']\s*:/],
        },
        typescript: {
          all: [/spans/, /entity_types/, /pattern_version/],
          none: [/["'](?:samples?|values|original)["']/, /["']redacted_text["']/, /["']text["']\s*:/],
        },
        go: {
          all: [/"spans"/, /"entity_types"/, /"pattern_version"/],
          none: [/"(?:samples?|values|original)"/, /"redacted_text"/, /"text"\s*:/],
        },
        scala: {
          all: [/entity_types/, /pattern_version/, /RedactionAudit/],
          none: [/"(?:samples?|values|original)"/, /"redacted_text"/, /"text"\s*:/],
        },
        cpp: {
          all: [/"spans"/, /"entity_types"/, /"pattern_version"/],
          none: [/"(?:samples?|values|original)"/, /"redacted_text"/, /"text"\s*:/],
        },
      },
    },
    {
      id: 'not-found',
      title: 'Missing or foreign documents are 404',
      detail:
        'A row that does not exist and a row owned by another tenant both answer **404**. A 403 would confirm the document exists; the starter answers 200 with an empty record instead.',
      match: {
        python: {all: [/status_code\s*=\s*404/], none: [/status_code\s*=\s*403/]},
        typescript: {all: [/code\(\s*404\s*\)/], none: [/code\(\s*403\s*\)/]},
        go: {all: [/StatusNotFound/], none: [/StatusForbidden/]},
        scala: {all: [/StatusCodes\.NotFound/], none: [/StatusCodes\.Forbidden/]},
        cpp: {all: [/\b404\b/], none: [/\b403\b/]},
      },
    },
    {
      id: 'offsets',
      title: 'Returns span offsets so the caller can verify reconstruction',
      detail:
        'Each span is `{start, end, entity, replacement}` and the response carries `redacted_length`. Offsets plus the caller’s own redacted output are what prove completeness without transferring text.',
      match: {
        python: {all: [/"start"/, /"end"/, /"entity"/, /"replacement"/, /redacted_length/]},
        typescript: {all: [/start:/, /end:/, /entity:/, /replacement:/, /redacted_length/]},
        go: {all: [/"start"/, /"end"/, /"entity"/, /"replacement"/, /"redacted_length"/]},
        scala: {all: [/SpanOffset\(start: Int, end: Int, entity: String, replacement: String\)/, /redacted_length/]},
        cpp: {all: [/"start"/, /"end"/, /"entity"/, /"replacement"/, /"redacted_length"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()


@app.get("/v1/documents/{document_id}/redaction")
def read_redaction(document_id: str, cur=None) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    cur.execute("SELECT redacted_text FROM redactions WHERE id = %s", (document_id,))
    row = cur.fetchone()
    return JSONResponse(
        {"document_id": document_id, "redacted_text": row[0] if row else ""},
        status_code=200,
    )
`,
      solution: `from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()


@app.get("/v1/documents/{document_id}/redaction")
def read_redaction(
    document_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    cur=None,
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail={"error": "missing X-Tenant-Id"})
    cur.execute(
        "SELECT spans, entity_types, pattern_version, redacted_length"
        " FROM redactions WHERE id = %s AND tenant_id = %s",
        (document_id, tenant),
    )
    row = cur.fetchone()
    if row is None:
        # 404, not 403: a foreign document must be indistinguishable from one that does not exist.
        raise HTTPException(status_code=404, detail={"error": "not found"})

    stored_spans, entity_types, pattern_version, redacted_length = row
    spans = [
        {
            "start": span["start"],
            "end": span["end"],
            "entity": span["entity"],
            "replacement": span["replacement"],
        }
        for span in stored_spans
    ]
    return JSONResponse(
        {
            "document_id": document_id,
            "spans": spans,
            "entity_types": entity_types,
            "pattern_version": pattern_version,
            "redacted_length": redacted_length,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** A audit read that returns the redacted text and skips the tenant check. */
import Fastify from 'fastify';

export const app = Fastify();

app.get('/v1/documents/:document_id/redaction', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const {document_id} = request.params as {document_id: string};
  const {rows} = await db.query('SELECT redacted_text FROM redactions WHERE id = $1', [document_id]);
  return reply.code(200).send({document_id, redacted_text: rows[0]?.redacted_text ?? ''});
});
`,
      solution: `/** Audit read: span offsets scoped to the tenant, never a byte of text. */
import Fastify from 'fastify';

export const app = Fastify();

interface StoredSpan {
  start: number;
  end: number;
  entity: string;
  replacement: string;
}

app.get('/v1/documents/:document_id/redaction', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {document_id} = request.params as {document_id: string};

  const {rows} = await db.query(
    'SELECT spans, entity_types, pattern_version, redacted_length FROM redactions WHERE id = $1 AND tenant_id = $2',
    [document_id, tenant],
  );
  const row = rows[0];
  // 404, not 403: a foreign document must be indistinguishable from one that does not exist.
  if (row === undefined) return reply.code(404).send({error: 'not found'});

  const spans = (row.spans as StoredSpan[]).map(span => ({
    start: span.start,
    end: span.end,
    entity: span.entity,
    replacement: span.replacement,
  }));
  return reply.code(200).send({
    document_id,
    spans,
    entity_types: row.entity_types,
    pattern_version: row.pattern_version,
    redacted_length: row.redacted_length,
  });
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
)

func readRedaction(rw http.ResponseWriter, r *http.Request) {
	documentID := r.PathValue("document_id")
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	var redacted string
	err := db.QueryRowContext(r.Context(), "SELECT redacted_text FROM redactions WHERE id = $1", documentID).Scan(&redacted)
	if err != nil {
		redacted = ""
	}
	writeJSON(rw, http.StatusOK, map[string]any{"document_id": documentID, "redacted_text": redacted})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/documents/{document_id}/redaction", readRedaction)
	_ = json.Marshal
}
`,
      solution: `package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

type SpanOffset struct {
	Start       int    \`json:"start"\`
	End         int    \`json:"end"\`
	Entity      string \`json:"entity"\`
	Replacement string \`json:"replacement"\`
}

func readRedaction(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	documentID := r.PathValue("document_id")

	var spansJSON, entityTypesJSON string
	var patternVersion, redactedLength int
	err := db.QueryRowContext(
		r.Context(),
		"SELECT spans, entity_types, pattern_version, redacted_length FROM redactions WHERE id = $1 AND tenant_id = $2",
		documentID, tenant,
	).Scan(&spansJSON, &entityTypesJSON, &patternVersion, &redactedLength)
	// 404, not 403: a foreign document must be indistinguishable from one that does not exist.
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "lookup failed"})
		return
	}

	var spans []SpanOffset
	var entityTypes []string
	if err := json.Unmarshal([]byte(spansJSON), &spans); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "corrupt record"})
		return
	}
	if err := json.Unmarshal([]byte(entityTypesJSON), &entityTypes); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "corrupt record"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"document_id":     documentID,
		"spans":           spans,
		"entity_types":    entityTypes,
		"pattern_version": patternVersion,
		"redacted_length": redactedLength,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/documents/{document_id}/redaction", readRedaction)
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

object AuditApi {
  implicit val system: ActorSystem = ActorSystem("redactor-audit")

  val route: Route =
    path("v1" / "documents" / Segment / "redaction") { documentId =>
      get {
        // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
        val redacted = db.lookupRedactedText(documentId).getOrElse("")
        complete(StatusCodes.OK, s"""{"document_id":"$documentId","redacted_text":"$redacted"}""")
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.sql.Connection

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class SpanOffset(start: Int, end: Int, entity: String, replacement: String)
final case class RedactionAudit(
    document_id: String,
    spans: List[SpanOffset],
    entity_types: List[String],
    pattern_version: Int,
    redacted_length: Int,
)

object AuditApi {
  implicit val system: ActorSystem = ActorSystem("redactor-audit")
  implicit val spanFormat: RootJsonFormat[SpanOffset] = jsonFormat4(SpanOffset)
  implicit val auditFormat: RootJsonFormat[RedactionAudit] = jsonFormat5(RedactionAudit)

  def lookup(conn: Connection, documentId: String, tenant: String): Option[RedactionAudit] = {
    val stmt = conn.prepareStatement(
      "SELECT spans, entity_types, pattern_version, redacted_length FROM redactions WHERE id = ? AND tenant_id = ?",
    )
    stmt.setString(1, documentId)
    stmt.setString(2, tenant)
    val rows = stmt.executeQuery()
    if (!rows.next()) None
    else
      Some(
        RedactionAudit(
          document_id = documentId,
          spans = List.empty[SpanOffset],
          entity_types = List.empty[String],
          pattern_version = rows.getInt("pattern_version"),
          redacted_length = rows.getInt("redacted_length"),
        ),
      )
  }

  val route: Route =
    path("v1" / "documents" / Segment / "redaction") { documentId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            // 404, not 403: a foreign document must be indistinguishable from one that does not exist.
            lookup(conn, documentId, tenantOpt.get) match {
              case None => complete(StatusCodes.NotFound, """{"error":"not found"}""")
              case Some(audit) => complete(StatusCodes.OK, audit)
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

#include <string>

using json = nlohmann::json;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/documents/([\\w-]+)/redaction)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string document_id = req.matches[1];
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const std::string redacted = lookup_redacted_text(document_id);
    res.status = 200;
    res.set_content(json{{"document_id", document_id}, {"redacted_text", redacted}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

using json = nlohmann::json;

struct SpanOffset {
  int start = 0;
  int end = 0;
  std::string entity;
  std::string replacement;
};

struct RedactionRecord {
  std::vector<SpanOffset> spans;
  std::vector<std::string> entity_types;
  int pattern_version = 0;
  int redacted_length = 0;
};

std::optional<RedactionRecord> lookup(pqxx::work& tx, const std::string& document_id, const std::string& tenant) {
  const auto rows = tx.exec_params(
      "SELECT spans, entity_types, pattern_version, redacted_length FROM redactions WHERE id = $1 AND tenant_id = $2",
      document_id, tenant);
  if (rows.empty()) return std::nullopt;
  RedactionRecord record;
  record.pattern_version = rows[0]["pattern_version"].as<int>();
  record.redacted_length = rows[0]["redacted_length"].as<int>();
  return record;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/documents/([\\w-]+)/redaction)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const std::string document_id = req.matches[1];
    pqxx::work tx(db_pool());
    const auto record = lookup(tx, document_id, tenant);
    // 404, not 403: a foreign document must be indistinguishable from one that does not exist.
    if (!record) {
      res.status = 404;
      res.set_content(R"({"error":"not found"})", "application/json");
      return;
    }
    json spans = json::array();
    for (const auto& span : record->spans)
      spans.push_back(
          {{"start", span.start}, {"end", span.end}, {"entity", span.entity}, {"replacement", span.replacement}});
    json out = {
        {"document_id", document_id},
        {"spans", spans},
        {"entity_types", record->entity_types},
        {"pattern_version", record->pattern_version},
        {"redacted_length", record->redacted_length},
    };
    res.status = 200;
    res.set_content(out.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    "Any tenant can fetch any document id and get a 200 with that document's redacted text in the body; an id that does not exist also gets a 200, with an empty string.",
    'The query is `WHERE id = %s` with no tenant predicate, the handler ignores `X-Tenant-Id`, and the body is built from the stored `redacted_text` column with `""` when `fetchone()` returns nothing.',
    'Require `X-Tenant-Id`, query `WHERE id = $1 AND tenant_id = $2`, answer 404 when no row, and return `spans` of `{start, end, entity, replacement}`, `entity_types`, `pattern_version` and `redacted_length` instead of any text.',
  ],
  debrief: `The fix puts the tenant in the predicate rather than in a post-fetch check because the predicate is the only place a foreign row cannot be observed at all, and a single 404 for missing and foreign documents means the response carries no information about existence. The response drops text because an audit endpoint that returns the redacted output recreates the artifact the system was built to avoid retaining, and invites a later change that returns the original "for the diff view". Offsets plus \`redacted_length\` are strictly more useful: the caller can prove the spans tile its own redacted output. Production audit reads also log the reader, tenant and document id per request, rate-limit id enumeration, and serve from a read replica.`,
};
