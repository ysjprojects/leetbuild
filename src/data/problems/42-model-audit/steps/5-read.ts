import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/audit/decisions/{id}/verify: verification that actually verifies',
  concept: 'http',
  file: 'read',
  focus: ['client', 'auditd', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the endpoint answers quickly, it
is right for every record the demo asks about, and it hides three flaws — one that makes verification
meaningless, one that makes it partial, and one that leaks across tenants. Review it, fix it, and
prove the fix.

Implement \`GET /v1/audit/decisions/{record_id}/verify\`:

- The tenant comes from \`X-Tenant-Id\` (**401** when absent) and the record lookup is scoped by it:
  \`WHERE record_id = $1 AND tenant_id = $2\`. A missing **or foreign** record is **404**, never a
  \`403\` and never a \`200\` — a 403 confirms the record exists, which the caller is not entitled to
  know. The draft resolves the record by id alone and takes the chain’s tenant from a query string,
  so any caller can verify against any tenant’s chain.
- **Actually verify.** Walk the chain from the record’s position to the head, recomputing
  \`sha1(prev | record_digest | position)\` at every step and comparing it with the stored digest, and
  stop at the first position that disagrees or is missing. The draft returns \`valid\` whenever the
  record exists and only checks that the head value is non-empty — which is not verification.
- **Report what was covered.** The response is
  \`{"record_id", "valid", "chain_length", "first_divergence"}\`: the number of positions actually
  walked and the exact position of the first divergence, or \`null\`. The draft reports neither, so a
  partial walk is indistinguishable from a whole chain.
- Verification covers from the record’s position **up to the head it names** and stops there: the
  head read at the start of the request is the head the answer refers to.

**Failure mode the checks target.** A verification endpoint that cannot fail. If \`valid\` is derived
from existence, tampering passes; if the walk is unscoped, a caller verifies a chain that is not
theirs; and an answer without a covered length cannot be audited later.`,
  sequence: {
    participants: ['Client', 'Audit Service', 'Postgres', 'Redis'],
    messages: [
      {
        from: 'Client',
        to: 'Audit Service',
        label: 'GET /v1/audit/decisions/{record_id}/verify · X-Tenant-Id',
        kind: 'sync',
      },
      {from: 'Audit Service', to: 'Audit Service', label: '401 when the tenant is missing', kind: 'sync'},
      {
        from: 'Audit Service',
        to: 'Postgres',
        label: 'SELECT position WHERE record_id = $1 AND tenant_id = $2',
        kind: 'sync',
      },
      {from: 'Postgres', to: 'Audit Service', label: 'row / no row', kind: 'reply'},
      {from: 'Audit Service', to: 'Client', label: '404 for missing or foreign — never 403', kind: 'reply'},
      {
        from: 'Audit Service',
        to: 'Redis',
        label: 'EVAL verify: recompute sha1(prev | rec | n) to the head',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Audit Service', label: '[covered, position, first_divergence]', kind: 'reply'},
      {from: 'Audit Service', to: 'Client', label: '200 {valid, chain_length, first_divergence}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/audit/decisions/{record_id}/verify',
      detail:
        'Register the verify read on `GET /v1/audit/decisions/{record_id}/verify` with the record id from the path.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/audit\/decisions\/\{record_id\}\/verify["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/audit\/decisions\/:record_id\/verify['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/audit\/decisions\/\{record_id\}\/verify"/]},
        scala: {
          all: [/path\(\s*"v1"\s*\/\s*"audit"\s*\/\s*"decisions"\s*\/\s*Segment\s*\/\s*"verify"\s*\)/, /\bget\s*\{/],
        },
        cpp: {all: [/svr\.Get\(R"\(/, /decisions\//, /verify\)"/]},
      },
    },
    {
      id: 'recompute',
      title: 'Verification recomputes the chain',
      detail:
        'Each position is rehashed as `sha1(prev | record_digest | position)` and compared with the stored digest. The draft returns `valid` from existence, so an edited record still verifies.',
      match: {
        python: {all: [/sha1hex/, /prev/]},
        typescript: {all: [/sha1hex/, /prev/]},
        go: {all: [/sha1hex/, /prev/]},
        scala: {all: [/sha1hex/, /prev/]},
        cpp: {all: [/sha1hex/, /prev/]},
      },
    },
    {
      id: 'first-divergence',
      title: 'Reports the first divergence at its exact position',
      detail:
        'The walk stops at the first position whose recomputed digest disagrees or whose entry is missing, and reports that position. The draft reports only a boolean.',
      match: {
        python: {all: [/first_divergence/]},
        typescript: {all: [/firstDivergence/]},
        go: {all: [/firstDivergence/]},
        scala: {all: [/firstDivergence/]},
        cpp: {all: [/first_divergence/]},
      },
    },
    {
      id: 'chain-length',
      title: 'Reports the chain length actually covered',
      detail:
        'The response carries `chain_length`, the number of positions walked up to the head the answer refers to. Without it, a partial verification looks like a full one.',
      match: {
        python: {all: [/chain_length/]},
        typescript: {all: [/chain_length/]},
        go: {all: [/chain_length/]},
        scala: {all: [/chain_length/]},
        cpp: {all: [/chain_length/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'The lookup is tenant-scoped and foreign records are 404',
      detail:
        '`WHERE record_id = $1 AND tenant_id = $2` and one **404** for both a missing and a foreign record — never **403**. The draft resolves by id alone and verifies against whatever tenant the request names.',
      match: {
        python: {all: [/\b404\b/, /tenant_id = %s/], none: [/\b403\b/]},
        typescript: {all: [/code\(404\)/, /tenant_id = \$2/], none: [/code\(403\)/]},
        go: {all: [/StatusNotFound/, /tenant_id = \$2/], none: [/StatusForbidden/]},
        scala: {all: [/StatusCodes\.NotFound/, /tenant_id = \?/], none: [/StatusCodes\.Forbidden/]},
        cpp: {all: [/\b404\b/, /tenant_id = \$2/], none: [/\b403\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()


@app.get("/v1/audit/decisions/{record_id}/verify")
def verify(record_id: str, tenant: str = "", cur=None) -> JSONResponse:
    # TODO: the draft returns valid whenever the record exists, checks only that the head value is
    # non-empty and resolves the chain from the tenant the request names. Recompute the hashes,
    # scope the lookup to the caller's tenant, and 404 a missing or foreign record.
    cur.execute("SELECT position FROM audit_entries WHERE record_id = %s", (record_id,))
    row = cur.fetchone()
    if row is None:
        return JSONResponse({"record_id": record_id, "valid": False}, status_code=200)
    head = rdb.get(f"audit:chain:{tenant}")
    return JSONResponse({"record_id": record_id, "valid": head is not None}, status_code=200)
`,
      solution: `import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
rdb = redis.Redis(host="redis", port=6379)

CHAIN_PREFIX = "audit:chain"

# The walk recomputes every digest from the record's position to the head it read, and reports the
# first position that disagrees or is missing, plus how many positions it actually covered.
VERIFY_LUA = """
local head = redis.call('HGET', KEYS[1], 'head')
if not head then return {'0', '1', ''} end
local position = tonumber(ARGV[1])
local prev = ''
local covered = 0
local first_divergence = ''
while true do
  local record = redis.call('HGET', KEYS[1], 'rec:' .. tostring(position))
  local stored = redis.call('HGET', KEYS[1], 'pos:' .. tostring(position))
  if (not record) or (not stored) then
    first_divergence = tostring(position)
    break
  end
  local recomputed = redis.sha1hex(prev .. '|' .. record .. '|' .. tostring(position))
  if recomputed ~= stored then
    first_divergence = tostring(position)
    break
  end
  prev = stored
  covered = covered + 1
  if stored == head then break end
  position = position + 1
end
return {tostring(covered), tostring(position), first_divergence}
"""


@app.get("/v1/audit/decisions/{record_id}/verify")
def verify(
    record_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    cur=None,
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail={"error": "missing X-Tenant-Id"})

    cur.execute(
        "SELECT position FROM audit_entries WHERE record_id = %s AND tenant_id = %s",
        (record_id, tenant),
    )
    row = cur.fetchone()
    if row is None:
        # 404, not 403: a foreign record must be indistinguishable from one that does not exist.
        raise HTTPException(status_code=404, detail={"error": "not found"})

    script = rdb.register_script(VERIFY_LUA)
    covered, position, first_divergence = script(
        keys=[f"{CHAIN_PREFIX}:{tenant}"],
        args=[row[0]],
    )
    return JSONResponse(
        {
            "record_id": record_id,
            "valid": first_divergence == "",
            "chain_length": int(covered),
            "first_divergence": int(position) if first_divergence != "" else None,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** A model-generated verifier that reports "valid" as long as the record exists. */
import Fastify from 'fastify';

export const app = Fastify();

app.get('/v1/audit/decisions/:record_id/verify', async (request, reply) => {
  // TODO: the draft returns valid whenever the record exists, checks only that the head value is
  // non-empty and resolves the chain from the tenant the request names. Recompute the hashes, scope
  // the lookup to the caller's tenant, and 404 a missing or foreign record.
  const {record_id} = request.params as {record_id: string};
  const {tenant} = request.query as {tenant?: string};
  const {rows} = await db.query('SELECT position FROM audit_entries WHERE record_id = $1', [record_id]);
  if (rows.length === 0) return reply.code(200).send({record_id, valid: false});
  const head = await redis.get(\`audit:chain:\${tenant}\`);
  return reply.code(200).send({record_id, valid: head !== null});
});
`,
      solution: `/** Verification that recomputes the chain, scoped to the tenant that owns it. */
import Fastify from 'fastify';
import IORedis from 'ioredis';

export const app = Fastify();
export const redis = new IORedis({host: 'redis', port: 6379});

const CHAIN_PREFIX = 'audit:chain';

// The walk recomputes every digest from the record's position to the head it read, and reports the
// first position that disagrees or is missing, plus how many positions it actually covered.
const VERIFY_LUA = \`
local head = redis.call('HGET', KEYS[1], 'head')
if not head then return {'0', '1', ''} end
local position = tonumber(ARGV[1])
local prev = ''
local covered = 0
local first_divergence = ''
while true do
  local record = redis.call('HGET', KEYS[1], 'rec:' .. tostring(position))
  local stored = redis.call('HGET', KEYS[1], 'pos:' .. tostring(position))
  if (not record) or (not stored) then
    first_divergence = tostring(position)
    break
  end
  local recomputed = redis.sha1hex(prev .. '|' .. record .. '|' .. tostring(position))
  if recomputed ~= stored then
    first_divergence = tostring(position)
    break
  end
  prev = stored
  covered = covered + 1
  if stored == head then break end
  position = position + 1
end
return {tostring(covered), tostring(position), first_divergence}
\`;

app.get('/v1/audit/decisions/:record_id/verify', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {record_id} = request.params as {record_id: string};

  const {rows} = await db.query(
    'SELECT position FROM audit_entries WHERE record_id = $1 AND tenant_id = $2',
    [record_id, tenant],
  );
  // 404, not 403: a foreign record must be indistinguishable from one that does not exist.
  if (rows.length === 0) return reply.code(404).send({error: 'not found'});

  const [covered, position, firstDivergence] = (await redis.eval(
    VERIFY_LUA,
    1,
    \`\${CHAIN_PREFIX}:\${tenant}\`,
    String(rows[0].position),
  )) as [string, string, string];

  return reply.code(200).send({
    record_id,
    valid: firstDivergence === '',
    chain_length: Number(covered),
    first_divergence: firstDivergence === '' ? null : Number(position),
  });
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"net/http"
)

func verifyRecord(rw http.ResponseWriter, r *http.Request) {
	// TODO: the draft returns valid whenever the record exists, checks only that the head value is
	// non-empty and resolves the chain from the tenant the request names. Recompute the hashes,
	// scope the lookup to the caller's tenant, and 404 a missing or foreign record.
	recordID := r.PathValue("record_id")
	tenant := r.URL.Query().Get("tenant")
	var position int
	err := db.QueryRowContext(r.Context(), "SELECT position FROM audit_entries WHERE record_id = $1", recordID).Scan(&position)
	if err != nil {
		writeJSON(rw, http.StatusOK, map[string]any{"record_id": recordID, "valid": false})
		return
	}
	head, _ := rdb.Get(r.Context(), "audit:chain:"+tenant).Result()
	writeJSON(rw, http.StatusOK, map[string]any{"record_id": recordID, "valid": head != ""})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/audit/decisions/{record_id}/verify", verifyRecord)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"database/sql"

	"github.com/redis/go-redis/v9"
)

const chainPrefix = "audit:chain"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// The walk recomputes every digest from the record's position to the head it read, and reports the
// first position that disagrees or is missing, plus how many positions it actually covered.
const verifyLua = \`
local head = redis.call('HGET', KEYS[1], 'head')
if not head then return {'0', '1', ''} end
local position = tonumber(ARGV[1])
local prev = ''
local covered = 0
local first_divergence = ''
while true do
  local record = redis.call('HGET', KEYS[1], 'rec:' .. tostring(position))
  local stored = redis.call('HGET', KEYS[1], 'pos:' .. tostring(position))
  if (not record) or (not stored) then
    first_divergence = tostring(position)
    break
  end
  local recomputed = redis.sha1hex(prev .. '|' .. record .. '|' .. tostring(position))
  if recomputed ~= stored then
    first_divergence = tostring(position)
    break
  end
  prev = stored
  covered = covered + 1
  if stored == head then break end
  position = position + 1
end
return {tostring(covered), tostring(position), first_divergence}
\`

var verifyCmd = redis.NewScript(verifyLua)

func verifyRecord(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	recordID := r.PathValue("record_id")

	var position int
	err := db.QueryRowContext(
		r.Context(),
		"SELECT position FROM audit_entries WHERE record_id = $1 AND tenant_id = $2",
		recordID, tenant,
	).Scan(&position)
	// 404, not 403: a foreign record must be indistinguishable from one that does not exist.
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "lookup failed"})
		return
	}

	result, err := verifyCmd.Run(r.Context(), rdb, []string{fmt.Sprintf("%s:%s", chainPrefix, tenant)}, position).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "verification failed"})
		return
	}
	values := result.([]any)
	covered, _ := strconv.Atoi(values[0].(string))
	firstDivergence := values[2].(string)
	divergenceAt := any(nil)
	if firstDivergence != "" {
		if at, err := strconv.Atoi(values[1].(string)); err == nil {
			divergenceAt = at
		}
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"record_id":        recordID,
		"valid":            firstDivergence == "",
		"chain_length":     covered,
		"first_divergence": divergenceAt,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/audit/decisions/{record_id}/verify", verifyRecord)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object VerifyApi {
  implicit val system: ActorSystem = ActorSystem("auditd")

  val route: Route =
    path("v1" / "audit" / "decisions" / Segment / "verify") { recordId =>
      get {
        // TODO: the draft returns valid whenever the record exists, checks only that the head value
        // is non-empty and resolves the chain from the tenant the request names. Recompute the
        // hashes, scope the lookup to the caller's tenant, and 404 a missing or foreign record.
        parameter("tenant") { tenant =>
          db.lookupPosition(recordId) match {
            case None => complete(StatusCodes.OK, s"""{"record_id":"$recordId","valid":false}""")
            case Some(position) =>
              val head = Option(jedis.get(s"audit:chain:$tenant"))
              complete(StatusCodes.OK, s"""{"record_id":"$recordId","valid":\${head.isDefined}}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Verification(record_id: String, valid: Boolean, chain_length: Int, first_divergence: Option[Int])

object VerifyApi {
  implicit val system: ActorSystem = ActorSystem("auditd")
  implicit val verificationFormat: RootJsonFormat[Verification] = jsonFormat4(Verification)

  val ChainPrefix = "audit:chain"
  val jedis = new Jedis("redis", 6379)

  // The walk recomputes every digest from the record's position to the head it read, and reports the
  // first position that disagrees or is missing, plus how many positions it actually covered.
  val VerifyLua: String =
    """
local head = redis.call('HGET', KEYS[1], 'head')
if not head then return {'0', '1', ''} end
local position = tonumber(ARGV[1])
local prev = ''
local covered = 0
local first_divergence = ''
while true do
  local record = redis.call('HGET', KEYS[1], 'rec:' .. tostring(position))
  local stored = redis.call('HGET', KEYS[1], 'pos:' .. tostring(position))
  if (not record) or (not stored) then
    first_divergence = tostring(position)
    break
  end
  local recomputed = redis.sha1hex(prev .. '|' .. record .. '|' .. tostring(position))
  if recomputed ~= stored then
    first_divergence = tostring(position)
    break
  end
  prev = stored
  covered = covered + 1
  if stored == head then break end
  position = position + 1
end
return {tostring(covered), tostring(position), first_divergence}
"""

  /** The record lookup is scoped by tenant: the id alone would let any tenant verify any chain. */
  def lookupPosition(conn: java.sql.Connection, recordId: String, tenant: String): Option[Int] = {
    val stmt = conn.prepareStatement(
      "SELECT position FROM audit_entries WHERE record_id = ? AND tenant_id = ?",
    )
    stmt.setString(1, recordId)
    stmt.setString(2, tenant)
    val rows = stmt.executeQuery()
    if (rows.next()) Some(rows.getInt("position")) else None
  }

  val route: Route =
    path("v1" / "audit" / "decisions" / Segment / "verify") { recordId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            lookupPosition(conn, recordId, tenantOpt.get) match {
              // 404, not 403: a foreign record must be indistinguishable from one that does not exist.
              case None => complete(StatusCodes.NotFound, """{"error":"not found"}""")
              case Some(position) =>
                val result = jedis
                  .eval(VerifyLua, util.List.of(s"$ChainPrefix:\${tenantOpt.get}"), util.List.of(position.toString))
                  .asInstanceOf[util.List[String]]
                val firstDivergence = result.get(2)
                complete(
                  StatusCodes.OK,
                  Verification(
                    record_id = recordId,
                    valid = firstDivergence.isEmpty,
                    chain_length = result.get(0).toInt,
                    first_divergence = if (firstDivergence.isEmpty) None else Some(result.get(1).toInt),
                  ),
                )
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

  svr.Get(R"(/v1/audit/decisions/([\\w-]+)/verify)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: the draft returns valid whenever the record exists, checks only that the head value is
    // non-empty and resolves the chain from the tenant the request names. Recompute the hashes,
    // scope the lookup to the caller's tenant, and 404 a missing or foreign record.
    const std::string record_id = req.matches[1];
    const auto position = lookup_position(record_id);
    if (!position) {
      res.status = 200;
      res.set_content(json{{"record_id", record_id}, {"valid", false}}.dump(), "application/json");
      return;
    }
    const auto head = conn.get("audit:chain:" + req.get_param_value("tenant"));
    res.status = 200;
    res.set_content(json{{"record_id", record_id}, {"valid", head.has_value()}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

using json = nlohmann::json;
using sw::redis::Redis;

// The walk recomputes every digest from the record's position to the head it read, and reports the
// first position that disagrees or is missing, plus how many positions it actually covered.
const std::string kVerifyLua = R"lua(
local head = redis.call('HGET', KEYS[1], 'head')
if not head then return {'0', '1', ''} end
local position = tonumber(ARGV[1])
local prev = ''
local covered = 0
local first_divergence = ''
while true do
  local record = redis.call('HGET', KEYS[1], 'rec:' .. tostring(position))
  local stored = redis.call('HGET', KEYS[1], 'pos:' .. tostring(position))
  if (not record) or (not stored) then
    first_divergence = tostring(position)
    break
  end
  local recomputed = redis.sha1hex(prev .. '|' .. record .. '|' .. tostring(position))
  if recomputed ~= stored then
    first_divergence = tostring(position)
    break
  end
  prev = stored
  covered = covered + 1
  if stored == head then break end
  position = position + 1
end
return {tostring(covered), tostring(position), first_divergence}
)lua";

Redis conn("tcp://redis:6379");

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/audit/decisions/([\\w-]+)/verify)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const std::string record_id = req.matches[1];

    pqxx::work tx(db_pool());
    const auto rows = tx.exec_params(
        "SELECT position FROM audit_entries WHERE record_id = $1 AND tenant_id = $2",
        record_id, tenant);
    // 404, not 403: a foreign record must be indistinguishable from one that does not exist.
    if (rows.empty()) {
      res.status = 404;
      res.set_content(R"({"error":"not found"})", "application/json");
      return;
    }

    const auto result = conn.eval<std::vector<std::string>>(
        kVerifyLua, {"audit:chain:" + tenant}, {rows[0]["position"].as<std::string>()});
    const std::string& first_divergence = result[2];
    json body = {
        {"record_id", record_id},
        {"valid", first_divergence.empty()},
        {"chain_length", std::stoi(result[0])},
        {"first_divergence", first_divergence.empty() ? json(nullptr) : json(std::stoi(result[1]))},
    };
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Two boundaries, one endpoint: who may read, and what "valid" means. `WHERE record_id = $1 AND tenant_id = $2` plus a single `404` — a 403 confirms the record exists, which is itself information the caller is not entitled to.',
    'Verification is a recomputation, not a lookup. Walk from the record’s position to the head, recompute `sha1(prev | record_digest | position)` at each step, and stop at the first mismatch or missing entry. If your `valid` is derived from `exists`, an edited record passes and the endpoint is decoration.',
    'Report the coverage. `chain_length` is how many positions you actually walked and `first_divergence` is where the walk stopped, so a partial verification can never be mistaken for a whole chain — and an answer recorded today can be re-checked against the head it named.',
  ],
  debrief: `The interviewer is testing the endpoint whose whole job is to be able to say "no". The draft fails in three independent ways, and each one is a different lesson. Trusting existence makes the verifier vacuous: the tamper an auditor performs is exactly the one the draft ignores. Resolving the chain from a request parameter is an IDOR with an audit flavour — you can verify against a chain you do not own, and the answer leaks whether it is intact. And a bare boolean hides the uncomfortable case: a walk that stopped at position 12 of 4 000 is "valid" up to 12, which is a very different statement from "the chain is intact". Reporting the covered length and the divergence position makes the endpoint falsifiable, which is the only property that matters for evidence. Real systems also sign the head at intervals and return the checkpoint, so verification can be bounded and delegated.`,
};
