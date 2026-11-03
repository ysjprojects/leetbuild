import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/audit/decisions/{id}/verify: verification that recomputes',
  concept: 'http',
  file: 'read',
  focus: ['client', 'auditd', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/audit/decisions/{record_id}/verify\`: it takes the
tenant from a \`?tenant=\` parameter (the \`X-Tenant-Id\` header otherwise), looks the record up with
\`ledger.get\`, reads \`chain.head(tenant)\` and answers \`{"record_id", "valid", "head_position"}\`
with \`valid\` true whenever the head is at or past the record's position. An intact chain verifies;
it hides 4 flaws.

**Failure mode the checks target.** Any caller verifies, and so learns about, another tenant's
records; a ledger row rewritten after the fact still verifies; a rewritten link further down the
chain still verifies; and the answer does not say how much of the chain it covered.

- The tenant is \`X-Tenant-Id\` (**401** when missing). A record that does not exist or belongs to
  another tenant is **404**, the same answer for both.
- The record as the ledger holds it must still hash to what the chain recorded:
  \`ledger.record_digest(record)\` equals \`chain.entry_at(tenant, position)["record_digest"]\`,
  else the answer is invalid with \`first_divergence\` at the record's position.
- Then \`chain.verify_chain(tenant, position)\` walks from the record to the last link.
- The answer is \`{"record_id", "valid", "chain_length", "first_divergence", "head_position"}\`.`,
  sequence: {
    participants: ['Client', 'Audit Service', 'ledger', 'Redis chain'],
    messages: [
      {from: 'Client', to: 'Audit Service', label: 'GET /v1/audit/decisions/{id}/verify · X-Tenant-Id', kind: 'sync'},
      {from: 'Audit Service', to: 'ledger', label: 'get(id) · 404 when missing or foreign', kind: 'sync'},
      {
        from: 'Audit Service',
        to: 'Redis chain',
        label: 'entry_at(tenant, position) · record_digest matches?',
        kind: 'sync',
      },
      {from: 'Audit Service', to: 'Redis chain', label: 'verify_chain(tenant, position)', kind: 'sync'},
      {
        from: 'Audit Service',
        to: 'Client',
        label: '200 {valid, chain_length, first_divergence, head_position}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/audit/decisions/{record_id}/verify',
      detail:
        'Register the verify read with the record id from the path; an intact chain answers **200** with `valid: true`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/audit\/decisions\/\{record_id\}\/verify["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/audit\/decisions\/:recordId\/verify['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/audit\/decisions\/\{id\}\/verify"/]},
        scala: {
          all: [/path\(\s*"v1"\s*\/\s*"audit"\s*\/\s*"decisions"\s*\/\s*Segment\s*\/\s*"verify"\s*\)/, /\bget\s*\{/],
        },
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/audit\/decisions\/[^"\n]*\/verify\)"/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Only the record’s tenant can verify it; foreign and missing are 404',
      detail:
        'The tenant comes from `X-Tenant-Id` (401 without it), never from a query parameter, and is compared with the record’s tenant; a foreign record answers the same **404** as a missing one, never 403.',
      match: {
        python: {
          all: [/x-tenant-id/i, /\b401\b/, /\b404\b/, /\["tenant"\]\s*!=\s*tenant|tenant\s*!=\s*record\["tenant"\]/],
          none: [/query_params/, /\b403\b/],
        },
        typescript: {
          all: [/x-tenant-id/i, /code\(401\)/, /\.tenant\s*!==\s*tenant|tenant\s*!==\s*record\.tenant/],
          none: [/request\.query/, /code\(403\)/],
        },
        go: {
          all: [
            /Header\.Get\("X-Tenant-Id"\)/,
            /StatusUnauthorized/,
            /\.Tenant\s*!=\s*tenant|tenant\s*!=\s*record\.Tenant/,
          ],
          none: [/URL\.Query\(\)/, /StatusForbidden/],
        },
        scala: {
          all: [/"X-Tenant-Id"/, /Unauthorized/, /\.tenant\s*!=\s*tenant|tenant\s*!=\s*\w+\.tenant/],
          none: [/parameter\(/, /Forbidden/],
        },
        cpp: {
          all: [
            /get_header_value\(\s*"X-Tenant-Id"\s*\)/,
            /\b401\b/,
            /->tenant\s*!=\s*tenant|tenant\s*!=\s*\w+->tenant/,
          ],
          none: [/get_param_value/, /\b403\b/],
        },
      },
    },
    {
      id: 'record-digest',
      title: 'The record still hashes to what the chain recorded',
      detail:
        '`ledger.record_digest` of the record as stored is compared with the `record_digest` the chain holds at its position, so a ledger row rewritten after the append fails at that position.',
      match: {
        python: {all: [/ledger\.record_digest\(/, /entry\[["']record_digest["']\]/]},
        typescript: {all: [/recordDigest\(/, /entry\.record_digest/]},
        go: {all: [/ledger\.RecordDigest\(/, /entry\.RecordDigest/]},
        scala: {all: [/Ledger\.recordDigest\(/, /entry\.recordDigest/]},
        cpp: {all: [/ledger::recordDigest\(/, /entry->record_digest/]},
      },
    },
    {
      id: 'walk-chain',
      title: 'Walks the chain from the record to the last link',
      detail:
        '`verify_chain`/`verifyChain` recomputes every link from the record’s position on; comparing positions with the head verifies nothing.',
      match: {
        python: {all: [/chain\.verify_chain\(/]},
        typescript: {all: [/verifyChain\(/]},
        go: {all: [/chain\.VerifyChain\(/]},
        scala: {all: [/Chain\.verifyChain\(/]},
        cpp: {all: [/chain::verifyChain\(/]},
      },
    },
    {
      id: 'coverage',
      title: 'Says how much of the chain it covered',
      detail:
        'The answer carries `chain_length` (links verified from the record on) and `first_divergence` (the first position that failed, or null), so a partial verification cannot pass for a whole one.',
      match: {
        python: {all: [/["']chain_length["']/, /["']first_divergence["']/]},
        typescript: {all: [/\bchain_length\b/, /\bfirst_divergence\b/]},
        go: {all: [/"chain_length"/, /"first_divergence"/]},
        scala: {all: [/"chain_length"/, /"first_divergence"/]},
        cpp: {all: [/"chain_length"/, /"first_divergence"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from audit import chain, ledger  # ledger.get, record_digest; chain.head, entry_at, verify_chain

app = FastAPI()


@app.get("/v1/audit/decisions/{record_id}/verify")
async def verify_decision(record_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    tenant = request.query_params.get("tenant") or request.headers.get("x-tenant-id", "")
    record = ledger.get(record_id)
    if record is None:
        return JSONResponse({"error": "no such record"}, status_code=404)
    head = chain.head(tenant)
    valid = head["position"] >= record["position"] > 0
    return JSONResponse({"record_id": record_id, "valid": valid, "head_position": head["position"]})
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from audit import chain, ledger  # ledger.get, record_digest; chain.head, entry_at, verify_chain

app = FastAPI()


@app.get("/v1/audit/decisions/{record_id}/verify")
async def verify_decision(record_id: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    record = ledger.get(record_id)
    # Missing and foreign answer alike: a caller learns nothing about records it does not own.
    if record is None or record["tenant"] != tenant or record["position"] == 0:
        return JSONResponse({"error": "no such record"}, status_code=404)
    position = record["position"]
    head = chain.head(tenant)["position"]
    entry = chain.entry_at(tenant, position)
    # The row as stored now must still hash to what the chain recorded when it was appended.
    if entry is None or entry["record_id"] != record_id or entry["record_digest"] != ledger.record_digest(record):
        return JSONResponse({"record_id": record_id, "valid": False, "chain_length": 0, "first_divergence": position, "head_position": head})
    verdict = chain.verify_chain(tenant, position)
    return JSONResponse(
        {
            "record_id": record_id,
            "valid": verdict["valid"],
            "chain_length": verdict["chain_length"],
            "first_divergence": verdict["first_divergence"],
            "head_position": head,
        }
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {entryAt, head, verifyChain} from 'audit/chain';
import {get, recordDigest} from 'audit/ledger';

export const app = Fastify();

app.get('/v1/audit/decisions/:recordId/verify', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const {recordId} = request.params as {recordId: string};
  const {tenant: asked} = request.query as {tenant?: string};
  const tenant = asked || String(request.headers['x-tenant-id'] ?? '');
  const record = await get(recordId);
  if (record === null) return reply.code(404).send({error: 'no such record'});
  const last = (await head(tenant)).position;
  return {record_id: recordId, valid: record.position > 0 && last >= record.position, head_position: last};
});
`,
      solution: `import Fastify from 'fastify';

import {entryAt, head, verifyChain} from 'audit/chain';
import {get, recordDigest} from 'audit/ledger';

export const app = Fastify();

app.get('/v1/audit/decisions/:recordId/verify', async (request, reply) => {
  const {recordId} = request.params as {recordId: string};
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const record = await get(recordId);
  // Missing and foreign answer alike: a caller learns nothing about records it does not own.
  if (record === null || record.tenant !== tenant || record.position === 0) return reply.code(404).send({error: 'no such record'});
  const position = record.position;
  const last = (await head(tenant)).position;
  const entry = await entryAt(tenant, position);
  // The row as stored now must still hash to what the chain recorded when it was appended.
  if (entry === null || entry.record_id !== recordId || entry.record_digest !== recordDigest(record)) {
    return {record_id: recordId, valid: false, chain_length: 0, first_divergence: position, head_position: last};
  }
  const verdict = await verifyChain(tenant, position);
  return {record_id: recordId, valid: verdict.valid, chain_length: verdict.chain_length, first_divergence: verdict.first_divergence, head_position: last};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"audit/chain"  // chain.Head, EntryAt, VerifyChain
	"audit/ledger" // ledger.Get, RecordDigest
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func verifyDecision(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	recordID := r.PathValue("id")
	tenant := r.URL.Query().Get("tenant")
	if tenant == "" {
		tenant = r.Header.Get("X-Tenant-Id")
	}
	record := ledger.Get(r.Context(), recordID)
	if record == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such record"})
		return
	}
	head, err := chain.Head(r.Context(), tenant)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	valid := record.Position > 0 && head.Position >= record.Position
	writeJSON(rw, http.StatusOK, map[string]any{"record_id": recordID, "valid": valid, "head_position": head.Position})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/audit/decisions/{id}/verify", verifyDecision)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"audit/chain"  // chain.Head, EntryAt, VerifyChain
	"audit/ledger" // ledger.Get, RecordDigest
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func verifyDecision(rw http.ResponseWriter, r *http.Request) {
	recordID := r.PathValue("id")
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	record := ledger.Get(r.Context(), recordID)
	// Missing and foreign answer alike: a caller learns nothing about records it does not own.
	if record == nil || record.Tenant != tenant || record.Position == 0 {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such record"})
		return
	}
	position := record.Position
	head, err := chain.Head(r.Context(), tenant)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	entry, err := chain.EntryAt(r.Context(), tenant, position)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	// The row as stored now must still hash to what the chain recorded when it was appended.
	if entry == nil || entry.RecordID != recordID || entry.RecordDigest != ledger.RecordDigest(record) {
		writeJSON(rw, http.StatusOK, map[string]any{"record_id": recordID, "valid": false, "chain_length": 0, "first_divergence": position, "head_position": head.Position})
		return
	}
	verdict, err := chain.VerifyChain(r.Context(), tenant, position)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"record_id":        recordID,
		"valid":            verdict.Valid,
		"chain_length":     verdict.ChainLength,
		"first_divergence": verdict.FirstDivergence,
		"head_position":    head.Position,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/audit/decisions/{id}/verify", verifyDecision)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import audit.{Chain, Ledger} // Ledger.get, recordDigest; Chain.head, entryAt, verifyChain

object Read {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route =
    path("v1" / "audit" / "decisions" / Segment / "verify") { recordId =>
      get {
        parameter("tenant".optional) { asked =>
          optionalHeaderValueByName("X-Tenant-Id") { header =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            val tenant = asked.orElse(header).getOrElse("")
            Ledger.get(recordId) match {
              case None => complete(json(StatusCodes.NotFound, JsObject("error" -> JsString("no such record"))))
              case Some(record) =>
                val last = Chain.head(tenant).position
                val valid = record.position > 0 && last >= record.position
                complete(json(StatusCodes.OK, JsObject("record_id" -> JsString(recordId), "valid" -> JsBoolean(valid), "head_position" -> JsNumber(last))))
            }
          }
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import audit.{Chain, Ledger} // Ledger.get, recordDigest; Chain.head, entryAt, verifyChain

object Read {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private val notFound = json(StatusCodes.NotFound, JsObject("error" -> JsString("no such record")))

  private def verdict(recordId: String, valid: Boolean, covered: Long, divergence: Option[Long], last: Long): JsObject = JsObject(
    "record_id" -> JsString(recordId), "valid" -> JsBoolean(valid), "chain_length" -> JsNumber(covered),
    "first_divergence" -> divergence.map(JsNumber(_)).getOrElse(JsNull), "head_position" -> JsNumber(last))

  val route: Route =
    path("v1" / "audit" / "decisions" / Segment / "verify") { recordId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required"))))
          case Some(tenant) =>
            Ledger.get(recordId) match {
              // Missing and foreign answer alike: a caller learns nothing about records it does not own.
              case None => complete(notFound)
              case Some(record) if record.tenant != tenant || record.position == 0 => complete(notFound)
              case Some(record) =>
                val position = record.position
                val last = Chain.head(tenant).position
                // The row as stored now must still hash to what the chain recorded when it was appended.
                val intact = Chain.entryAt(tenant, position).exists(entry => entry.recordId == recordId && entry.recordDigest == Ledger.recordDigest(record))
                if (!intact) complete(json(StatusCodes.OK, verdict(recordId, valid = false, 0, Some(position), last)))
                else {
                  val walk = Chain.verifyChain(tenant, position)
                  complete(json(StatusCodes.OK, verdict(recordId, walk.valid, walk.chainLength, walk.firstDivergence, last)))
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

#include <string>

#include "audit/chain.h"   // chain::head, entryAt, verifyChain
#include "audit/ledger.h"  // ledger::get, recordDigest

using json = nlohmann::json;

void verify_decision(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string record_id = req.matches[1];
  std::string tenant = req.get_param_value("tenant");
  if (tenant.empty()) tenant = req.get_header_value("X-Tenant-Id");
  const auto record = ledger::get(record_id);
  if (!record) {
    res.status = 404;
    res.set_content(json{{"error", "no such record"}}.dump(), "application/json");
    return;
  }
  const long last = chain::head(tenant).position;
  const bool valid = record->position > 0 && last >= record->position;
  res.set_content(json{{"record_id", record_id}, {"valid", valid}, {"head_position", last}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/audit/decisions/([\\w-]+)/verify)", verify_decision); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "audit/chain.h"   // chain::head, entryAt, verifyChain
#include "audit/ledger.h"  // ledger::get, recordDigest

using json = nlohmann::json;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void verify_decision(const httplib::Request& req, httplib::Response& res) {
  const std::string record_id = req.matches[1];
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const auto record = ledger::get(record_id);
  // Missing and foreign answer alike: a caller learns nothing about records it does not own.
  if (!record || record->tenant != tenant || record->position == 0) return reply(res, 404, {{"error", "no such record"}});
  const long position = record->position;
  const long last = chain::head(tenant).position;
  const auto entry = chain::entryAt(tenant, position);
  // The row as stored now must still hash to what the chain recorded when it was appended.
  if (!entry || entry->record_id != record_id || entry->record_digest != ledger::recordDigest(*record)) {
    return reply(res, 200, {{"record_id", record_id}, {"valid", false}, {"chain_length", 0}, {"first_divergence", position}, {"head_position", last}});
  }
  const chain::Verdict walk = chain::verifyChain(tenant, position);
  reply(res, 200, {{"record_id", record_id},
                   {"valid", walk.valid},
                   {"chain_length", walk.chain_length},
                   {"first_divergence", walk.first_divergence ? json(*walk.first_divergence) : json(nullptr)},
                   {"head_position", last}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/audit/decisions/([\\w-]+)/verify)", verify_decision); }
`,
    },
  },
  harness: {
    python: `import hashlib

from audit import chain, ledger


def _chained(n, tenant="t1"):
    fields = {
        "model_version": "risk-v7",
        "policy_id": "refunds-2026-10",
        "input_digest": hashlib.sha256(f"in-{n}".encode()).hexdigest(),
        "decision_digest": hashlib.sha256(f"out-{n}".encode()).hexdigest(),
        "recorded_at": 1700000000000 + n,
    }
    record = ledger.insert(tenant, fields)
    entry = chain.append_entry(tenant, record["id"], ledger.record_digest(record))
    ledger.set_position(record["id"], entry["position"])
    return record["id"]


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _verify(c, record_id, tenant="t1", query=""):
    headers = {"X-Tenant-Id": tenant} if tenant else {}
    return await c.get(f"/v1/audit/decisions/{record_id}/verify{query}", headers=headers)


async def check_route(ctx):
    ids = [_chained(n) for n in (1, 2, 3)]
    async with _api(ctx) as c:
        r = await _verify(c, ids[0])
    assert r.status_code == 200, f"GET /v1/audit/decisions/{ids[0]}/verify answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("record_id") == ids[0] and body.get("valid") is True, f"an intact chain must verify: {body}"


async def check_tenant_scope(ctx):
    mine = _chained(1, "t1")
    _chained(1, "t2")
    async with _api(ctx) as c:
        anonymous = await _verify(c, mine, tenant="")
        assert anonymous.status_code == 401, f"a verify without X-Tenant-Id answered {anonymous.status_code}, expected 401"
        foreign = await _verify(c, mine, tenant="t2")
        assert foreign.status_code == 404, f"tenant t2 verifying t1's record answered {foreign.status_code}: {foreign.text}. Another tenant's record is 404, exactly like a missing one"
        spoofed = await _verify(c, mine, tenant="t2", query="?tenant=t1")
        assert spoofed.status_code == 404, f"tenant t2 naming ?tenant=t1 got {spoofed.status_code}: {spoofed.text}. The tenant is the header, not a parameter"
        missing = await _verify(c, "d-404", tenant="t2")
        assert missing.status_code == 404, f"a missing record answered {missing.status_code}, expected 404"
        own = await _verify(c, mine, tenant="t1")
    assert own.status_code == 200 and own.json().get("valid") is True, f"t1 verifying its own record answered {own.status_code} {own.text}"


async def check_record_digest(ctx):
    ids = [_chained(n) for n in (1, 2, 3)]
    # The ledger row of record 2 is rewritten after it was chained.
    ctx.redis.hset(f"audit:rec:{ids[1]}", "decision_digest", hashlib.sha256(b"decision:deny").hexdigest())
    async with _api(ctx) as c:
        r = await _verify(c, ids[1])
        clean = await _verify(c, ids[0])
    body = r.json()
    assert body.get("valid") is False and body.get("first_divergence") == 2, f"with record 2's ledger row rewritten the verify answered {body}: the row must still hash to the record_digest the chain holds at its position"
    assert clean.json().get("valid") is True, f"record 1 is untouched but its verify answered {clean.json()}"


async def check_walk_chain(ctx):
    ids = [_chained(n) for n in (1, 2, 3, 4)]
    # Someone rewrites the chain entry at position 3.
    ctx.redis.hset("audit:chain:t1", "rec:3", hashlib.sha256(b"forged").hexdigest())
    async with _api(ctx) as c:
        r = await _verify(c, ids[0])
    body = r.json()
    assert body.get("valid") is False, f"with position 3 of the chain rewritten, verifying record 1 answered {body}: the walk from the record to the last link must recompute every link"
    assert body.get("first_divergence") == 3, f"the first divergence is position 3, the verify answered {body}"


async def check_coverage(ctx):
    ids = [_chained(n) for n in (1, 2, 3, 4)]
    async with _api(ctx) as c:
        r = await _verify(c, ids[1])
    body = r.json()
    want = {"record_id": ids[1], "valid": True, "chain_length": 3, "first_divergence": None, "head_position": 4}
    assert body == want, f"verifying record 2 of 4 answered {body}, expected {want}: the answer says how many links it verified and where the first failure was"
`,
    typescript: `import {createHash} from 'node:crypto';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function read(ctx) {
  const ledger = ctx.load('/support/audit/ledger.ts');
  const chain = ctx.load('/support/audit/chain.ts');
  const chained = async (n: number, tenant = 't1'): Promise<string> => {
    const fields = {model_version: 'risk-v7', policy_id: 'refunds-2026-10', input_digest: sha(\`in-\${n}\`), decision_digest: sha(\`out-\${n}\`), recorded_at: 1700000000000 + n};
    const record = await ledger.insert(tenant, fields);
    const entry = await chain.appendEntry(tenant, record.id, ledger.recordDigest(record));
    await ledger.setPosition(record.id, entry.position);
    return record.id;
  };
  return {c: ctx.client(ctx.load('read').app), chained};
}

const verify = (c, recordId: string, tenant = 't1', query = '') =>
  c.get(\`/v1/audit/decisions/\${recordId}/verify\${query}\`, {headers: tenant ? {'X-Tenant-Id': tenant} : {}});

export async function check_route(ctx) {
  const {c, chained} = read(ctx);
  const ids = [await chained(1), await chained(2), await chained(3)];
  const r = await verify(c, ids[0]);
  assert.equal(r.status, 200, \`GET /v1/audit/decisions/\${ids[0]}/verify answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.record_id === ids[0] && body.valid === true, \`an intact chain must verify: \${r.text}\`);
}

export async function check_tenant_scope(ctx) {
  const {c, chained} = read(ctx);
  const mine = await chained(1, 't1');
  await chained(1, 't2');
  const anonymous = await verify(c, mine, '');
  assert.equal(anonymous.status, 401, \`a verify without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
  const foreign = await verify(c, mine, 't2');
  assert.equal(foreign.status, 404, \`tenant t2 verifying t1's record answered \${foreign.status}: \${foreign.text}. Another tenant's record is 404, exactly like a missing one\`);
  const spoofed = await verify(c, mine, 't2', '?tenant=t1');
  assert.equal(spoofed.status, 404, \`tenant t2 naming ?tenant=t1 got \${spoofed.status}: \${spoofed.text}. The tenant is the header, not a parameter\`);
  const missing = await verify(c, 'd-404', 't2');
  assert.equal(missing.status, 404, \`a missing record answered \${missing.status}, expected 404\`);
  const own = await verify(c, mine, 't1');
  assert(own.status === 200 && own.json().valid === true, \`t1 verifying its own record answered \${own.status} \${own.text}\`);
}

export async function check_record_digest(ctx) {
  const {c, chained} = read(ctx);
  const ids = [await chained(1), await chained(2), await chained(3)];
  // The ledger row of record 2 is rewritten after it was chained.
  ctx.redis.hset(\`audit:rec:\${ids[1]}\`, 'decision_digest', sha('decision:deny'));
  const body = (await verify(c, ids[1])).json();
  assert(body.valid === false && body.first_divergence === 2, \`with record 2's ledger row rewritten the verify answered \${JSON.stringify(body)}: the row must still hash to the record_digest the chain holds at its position\`);
  const clean = (await verify(c, ids[0])).json();
  assert.equal(clean.valid, true, \`record 1 is untouched but its verify answered \${JSON.stringify(clean)}\`);
}

export async function check_walk_chain(ctx) {
  const {c, chained} = read(ctx);
  const ids = [];
  for (const n of [1, 2, 3, 4]) ids.push(await chained(n));
  // Someone rewrites the chain entry at position 3.
  ctx.redis.hset('audit:chain:t1', 'rec:3', sha('forged'));
  const body = (await verify(c, ids[0])).json();
  assert.equal(body.valid, false, \`with position 3 of the chain rewritten, verifying record 1 answered \${JSON.stringify(body)}: the walk from the record to the last link must recompute every link\`);
  assert.equal(body.first_divergence, 3, \`the first divergence is position 3, the verify answered \${JSON.stringify(body)}\`);
}

export async function check_coverage(ctx) {
  const {c, chained} = read(ctx);
  const ids = [];
  for (const n of [1, 2, 3, 4]) ids.push(await chained(n));
  const body = (await verify(c, ids[1])).json();
  const want = {record_id: ids[1], valid: true, chain_length: 3, first_divergence: null, head_position: 4};
  assert.deepEqual(body, want, \`verifying record 2 of 4 answered \${JSON.stringify(body)}, expected \${JSON.stringify(want)}: the answer says how many links it verified and where the first failure was\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"

	"audit/chain"
	"audit/digest"
	"audit/ledger"

	"leetbuild/harness"
)

var readBg = context.Background()

func chainedRecord(ctx *harness.Ctx, n int, tenant string) string {
	fields := map[string]any{
		"model_version":   "risk-v7",
		"policy_id":       "refunds-2026-10",
		"input_digest":    digest.Sha256Hex(fmt.Sprintf("in-%d", n)),
		"decision_digest": digest.Sha256Hex(fmt.Sprintf("out-%d", n)),
		"recorded_at":     fmt.Sprint(1700000000000 + n),
	}
	record, err := ledger.Insert(readBg, tenant, fields)
	ctx.NoError(err, "the ledger insert failed")
	entry, err := chain.AppendEntry(readBg, tenant, record.ID, ledger.RecordDigest(record))
	ctx.NoError(err, "the chain append failed")
	ledger.SetPosition(readBg, record.ID, entry.Position)
	return record.ID
}

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func verifyAs(c *harness.HTTP, recordID, tenant, query string) *harness.Response {
	path := "/v1/audit/decisions/" + recordID + "/verify" + query
	if tenant == "" {
		return c.Get(path)
	}
	return c.Get(path, "X-Tenant-Id", tenant)
}

func bodyOf(r *harness.Response) map[string]any {
	body, _ := r.JSON().(map[string]any)
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	ids := []string{chainedRecord(ctx, 1, "t1"), chainedRecord(ctx, 2, "t1"), chainedRecord(ctx, 3, "t1")}
	r := verifyAs(readAPI(ctx), ids[0], "t1", "")
	ctx.Equal(r.Status, 200, "GET /v1/audit/decisions/%s/verify (%s)", ids[0], r.Text())
	body := bodyOf(r)
	ctx.Assert(body["record_id"] == ids[0] && body["valid"] == true, "an intact chain must verify: %s", r.Text())
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := readAPI(ctx)
	mine := chainedRecord(ctx, 1, "t1")
	chainedRecord(ctx, 1, "t2")
	ctx.Equal(verifyAs(c, mine, "", "").Status, 401, "a verify without X-Tenant-Id; the status")
	foreign := verifyAs(c, mine, "t2", "")
	ctx.Equal(foreign.Status, 404, "tenant t2 verifying t1's record (%s): another tenant's record is 404, exactly like a missing one; the status", foreign.Text())
	spoofed := verifyAs(c, mine, "t2", "?tenant=t1")
	ctx.Equal(spoofed.Status, 404, "tenant t2 naming ?tenant=t1 (%s): the tenant is the header, not a parameter; the status", spoofed.Text())
	ctx.Equal(verifyAs(c, "d-404", "t2", "").Status, 404, "a missing record; the status")
	own := verifyAs(c, mine, "t1", "")
	ctx.Assert(own.Status == 200 && bodyOf(own)["valid"] == true, "t1 verifying its own record answered %d %s", own.Status, own.Text())
}

func CheckRecordDigest(ctx *harness.Ctx) {
	ids := []string{chainedRecord(ctx, 1, "t1"), chainedRecord(ctx, 2, "t1"), chainedRecord(ctx, 3, "t1")}
	// The ledger row of record 2 is rewritten after it was chained.
	ctx.Redis.Do("HSET", "audit:rec:"+ids[1], "decision_digest", digest.Sha256Hex("decision:deny"))
	c := readAPI(ctx)
	body := bodyOf(verifyAs(c, ids[1], "t1", ""))
	ctx.Assert(body["valid"] == false && body["first_divergence"] == float64(2), "with record 2's ledger row rewritten the verify answered %v: the row must still hash to the record_digest the chain holds at its position", body)
	clean := bodyOf(verifyAs(c, ids[0], "t1", ""))
	ctx.Equal(clean["valid"], true, "record 1 is untouched (%v); its valid", clean)
}

func CheckWalkChain(ctx *harness.Ctx) {
	var ids []string
	for n := 1; n <= 4; n++ {
		ids = append(ids, chainedRecord(ctx, n, "t1"))
	}
	// Someone rewrites the chain entry at position 3.
	ctx.Redis.Do("HSET", "audit:chain:t1", "rec:3", digest.Sha256Hex("forged"))
	body := bodyOf(verifyAs(readAPI(ctx), ids[0], "t1", ""))
	ctx.Equal(body["valid"], false, "with position 3 of the chain rewritten, verifying record 1 (%v) must recompute every link from the record to the last; valid", body)
	ctx.Equal(body["first_divergence"], 3, "the first divergence is position 3 (%v)", body)
}

func CheckCoverage(ctx *harness.Ctx) {
	var ids []string
	for n := 1; n <= 4; n++ {
		ids = append(ids, chainedRecord(ctx, n, "t1"))
	}
	body := bodyOf(verifyAs(readAPI(ctx), ids[1], "t1", ""))
	want := map[string]any{"record_id": ids[1], "valid": true, "chain_length": float64(3), "first_divergence": nil, "head_position": float64(4)}
	ctx.Equal(body, want, "verifying record 2 of 4: the answer says how many links it verified and where the first failure was")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

std::string chainedRecord(int n, const std::string& tenant) {
  const ledger::Decision record = ledger::insert(tenant, {{"model_version", "risk-v7"},
                                                          {"policy_id", "refunds-2026-10"},
                                                          {"input_digest", sha256_hex("in-" + std::to_string(n))},
                                                          {"decision_digest", sha256_hex("out-" + std::to_string(n))},
                                                          {"recorded_at", std::to_string(1700000000000LL + n)}});
  const chain::Entry entry = chain::appendEntry(tenant, record.id, ledger::recordDigest(record));
  ledger::setPosition(record.id, entry.position);
  return record.id;
}

harness::HTTP readApi(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response verifyAs(harness::HTTP& c, const std::string& record_id, const std::string& tenant, const std::string& query = "") {
  const std::string path = "/v1/audit/decisions/" + record_id + "/verify" + query;
  if (tenant.empty()) return c.Get(path);
  return c.Get(path, "X-Tenant-Id", tenant);
}

json bodyOf(const harness::Response& r) { return json::parse(r.Text(), nullptr, false); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  const std::vector<std::string> ids = {chainedRecord(1, "t1"), chainedRecord(2, "t1"), chainedRecord(3, "t1")};
  auto c = readApi(ctx);
  const auto r = verifyAs(c, ids[0], "t1");
  ctx.Equal(r.Status, 200, "GET /v1/audit/decisions/%s/verify (%s)", ids[0], r.Text());
  const json body = bodyOf(r);
  ctx.Assert(body.is_object() && body.value("record_id", "") == ids[0] && body.value("valid", false), "an intact chain must verify: %s", r.Text());
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const std::string mine = chainedRecord(1, "t1");
  chainedRecord(1, "t2");
  ctx.Equal(verifyAs(c, mine, "").Status, 401, "a verify without X-Tenant-Id; the status");
  const auto foreign = verifyAs(c, mine, "t2");
  ctx.Equal(foreign.Status, 404, "tenant t2 verifying t1's record (%s): another tenant's record is 404, exactly like a missing one; the status", foreign.Text());
  const auto spoofed = verifyAs(c, mine, "t2", "?tenant=t1");
  ctx.Equal(spoofed.Status, 404, "tenant t2 naming ?tenant=t1 (%s): the tenant is the header, not a parameter; the status", spoofed.Text());
  ctx.Equal(verifyAs(c, "d-404", "t2").Status, 404, "a missing record; the status");
  const auto own = verifyAs(c, mine, "t1");
  ctx.Assert(own.Status == 200 && bodyOf(own).value("valid", false), "t1 verifying its own record answered %d %s", own.Status, own.Text());
}

void CheckRecordDigest(harness::Ctx& ctx) {
  const std::vector<std::string> ids = {chainedRecord(1, "t1"), chainedRecord(2, "t1"), chainedRecord(3, "t1")};
  // The ledger row of record 2 is rewritten after it was chained.
  ctx.Redis.Do("HSET", "audit:rec:" + ids[1], "decision_digest", sha256_hex("decision:deny"));
  auto c = readApi(ctx);
  const json body = bodyOf(verifyAs(c, ids[1], "t1"));
  ctx.Assert(body.is_object() && body.value("valid", true) == false && body.value("first_divergence", json()) == json(2), "with record 2's ledger row rewritten the verify answered %s: the row must still hash to the record_digest the chain holds at its position", body.dump());
  const json clean = bodyOf(verifyAs(c, ids[0], "t1"));
  ctx.Assert(clean.value("valid", false), "record 1 is untouched but its verify answered %s", clean.dump());
}

void CheckWalkChain(harness::Ctx& ctx) {
  std::vector<std::string> ids;
  for (int n = 1; n <= 4; n++) ids.push_back(chainedRecord(n, "t1"));
  // Someone rewrites the chain entry at position 3.
  ctx.Redis.Do("HSET", "audit:chain:t1", "rec:3", sha256_hex("forged"));
  auto c = readApi(ctx);
  const json body = bodyOf(verifyAs(c, ids[0], "t1"));
  ctx.Assert(body.is_object() && body.value("valid", true) == false, "with position 3 of the chain rewritten, verifying record 1 answered %s: the walk from the record to the last link must recompute every link", body.dump());
  ctx.Assert(body.value("first_divergence", json()) == json(3), "the first divergence is position 3, the verify answered %s", body.dump());
}

void CheckCoverage(harness::Ctx& ctx) {
  std::vector<std::string> ids;
  for (int n = 1; n <= 4; n++) ids.push_back(chainedRecord(n, "t1"));
  auto c = readApi(ctx);
  const json body = bodyOf(verifyAs(c, ids[1], "t1"));
  const json want = {{"record_id", ids[1]}, {"valid", true}, {"chain_length", 3}, {"first_divergence", nullptr}, {"head_position", 4}};
  ctx.Assert(body == want, "verifying record 2 of 4 answered %s, expected %s: the answer says how many links it verified and where the first failure was", body.dump(), want.dump());
}
`,
  },
  hints: [
    'Rewrite the `decision_digest` of a stored record, or one `rec:` field of the chain, and verify: still valid. Verify another tenant\u2019s record with `?tenant=` set to theirs: valid, with their head position.',
    'The tenant comes from the query string before the header and is never compared with the record\u2019s; `valid` is a comparison of two positions, so nothing is hashed, and the answer has no `chain_length` or `first_divergence` to report.',
    'Read `X-Tenant-Id` only (401), 404 unless `record["tenant"] == tenant`; compare `ledger.record_digest(record)` with `chain.entry_at(tenant, position)["record_digest"]`; then answer `chain.verify_chain(tenant, position)` with `head_position`.',
  ],
  debrief: `Verification is only worth something if it can fail, so every input to it is recomputed: the record from its stored fields, each link from the one before it. Comparing the ledger row with the digest the chain kept at append time is what catches an edit to the ledger itself, which the chain alone would never see. Scoping by the header and answering 404 for foreign records keeps the endpoint from confirming that someone else's record exists. \`chain_length\` and \`first_divergence\` make the answer auditable: a reader can tell a full walk from a partial one. Production verifiers also check the receipt signature against the signer's published key, and compare the head with a copy anchored outside the service, as immudb clients do with the state they keep locally.`,
};
