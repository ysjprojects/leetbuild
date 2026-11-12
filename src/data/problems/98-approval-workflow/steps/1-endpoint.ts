import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/requests: a chain the requester cannot shortcut',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'policy'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/requests\` with body
\`{"chain_id", "why", "amount_cents", "approvers"}\`, the tenant from \`X-Tenant-Id\` and the requester
from \`X-User-Id\` (401 without them, 400 on a malformed \`chain_id\`). It resolves the chain with
\`policy.resolve_approvers\` (404 for an unknown one), uses the body's \`approvers\` when there are
any, stores the request with \`store.put\`, opens it with \`chain.start_chain\` and answers **201**
\`{request_id, chain_version, approvers, replayed}\`. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** A requester who names their own approvers, or who sits on the
policy's chain, signs off their own spend; an unbounded \`why\` turns an audit field into a blob; a
client retry opens a second request with a second chain.

- Approvers come from the policy only, its \`version\` pinned as \`chain_version\`; the body's
  \`approvers\` is ignored.
- A requester on the resolved chain is **409** \`requester_cannot_approve\` and nothing is stored.
- \`why\` is non-empty (**400**) and at most \`MAX_WHY_BYTES\` = 4096 bytes of UTF-8 (**413**).
- \`Idempotency-Key\` is required (**400**). Look up \`store.get(tenant, key)\` before resolving and
  answer a replay with the stored request: **200**, \`"replayed": true\`.`,
  sequence: {
    participants: ['Client', 'Approval API', 'request store', 'chain policy'],
    messages: [
      {
        from: 'Client',
        to: 'Approval API',
        label: 'POST /v1/requests · X-Tenant-Id · X-User-Id · Idempotency-Key',
        kind: 'sync',
      },
      {from: 'Approval API', to: 'Approval API', label: 'chain_id · why ≤ 4096 bytes', kind: 'sync'},
      {from: 'Approval API', to: 'request store', label: 'get(tenant, key)', kind: 'sync'},
      {from: 'request store', to: 'Approval API', label: 'stored request → 200 replayed', kind: 'reply'},
      {from: 'Approval API', to: 'chain policy', label: 'resolve_approvers(chain_id)', kind: 'sync'},
      {from: 'chain policy', to: 'Approval API', label: '{version, approvers}', kind: 'reply'},
      {from: 'Approval API', to: 'Approval API', label: 'requester on the chain → 409', kind: 'sync'},
      {from: 'Approval API', to: 'request store', label: 'put(request, key) · start_chain', kind: 'sync'},
      {from: 'Approval API', to: 'Client', label: '201 {request_id, chain_version, approvers}', kind: 'reply'},
    ],
  },
  hints: [
    'Submit as the director with `"approvers": ["u-friend"]`: the request is accepted and u-friend is the only approver. Post the same body twice with one `Idempotency-Key`: two request ids, two chains.',
    'The handler prefers `body.approvers` over the policy, never compares the requester with the chain it resolved, measures nothing about `why`, and writes the key with `store.put` without ever reading it back.',
    'Read the key first (400 without it) and replay `store.get(tenant, key)` with 200; then 400/413 on `why` by UTF-8 bytes; approvers from `resolve_approvers` only; 409 `requester_cannot_approve` when the requester is on them.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/requests',
      detail: 'Register the submit route on `POST /v1/requests`, store the request and open its chain.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/requests["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/requests['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/requests"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"requests"\s*\)/, /\bpost\b/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/requests"/]},
      },
    },
    {
      id: 'policy-approvers',
      title: 'Takes the approvers from the policy only',
      detail:
        'The approvers are the ones `resolve_approvers` returns and its version is pinned as `chain_version`; the body’s `approvers` is never read. The starter lets the caller name the chain.',
      match: {
        python: {all: [/resolve_approvers\(/, /chain_version/], none: [/body\.approvers/]},
        typescript: {all: [/resolveApprovers\(/, /chain_version/], none: [/body\.approvers/]},
        go: {all: [/policy\.ResolveApprovers\(/, /ChainVersion/], none: [/body\.Approvers/]},
        scala: {all: [/Policy\.resolveApprovers\(/, /chainVersion/], none: [/"approvers"\)/]},
        cpp: {all: [/policy::resolveApprovers\(/, /version/], none: [/body(\.value\(|\[)\s*"approvers"/]},
      },
    },
    {
      id: 'self-approval',
      title: 'Rejects a requester who is on their own chain',
      detail:
        'When the requester is one of the resolved approvers the submit is **409** `requester_cannot_approve` and nothing is stored, no request and no chain.',
      match: {
        python: {all: [/requester_cannot_approve/, /\b409\b/]},
        typescript: {all: [/requester_cannot_approve/, /\b409\b/]},
        go: {all: [/requester_cannot_approve/, /StatusConflict|\b409\b/]},
        scala: {all: [/requester_cannot_approve/, /Conflict|\b409\b/]},
        cpp: {all: [/requester_cannot_approve/, /\b409\b/]},
      },
    },
    {
      id: 'why-cap',
      title: 'Caps why at 4096 bytes of UTF-8',
      detail:
        '`why` is required (400 when empty) and measured in UTF-8 bytes against 4096 (`MAX_WHY_BYTES`): larger is **413** and nothing is stored. A character count lets 2049 two-byte characters through.',
      match: {
        python: {all: [/4096|1\s*<<\s*12/, /\.encode\(/, /\b413\b/]},
        typescript: {all: [/4096|1\s*<<\s*12/, /byteLength\(/, /\b413\b/]},
        go: {all: [/4096|1\s*<<\s*12/, /StatusRequestEntityTooLarge|\b413\b/]},
        scala: {all: [/4096|1\s*<<\s*12/, /getBytes\(/, /PayloadTooLarge|RequestEntityTooLarge|\b413\b/]},
        cpp: {all: [/4096|1\s*<<\s*12/, /\b413\b/]},
      },
    },
    {
      id: 'idempotency',
      title: 'Replays a retried submit',
      detail:
        '`Idempotency-Key` is required (400) and looked up with `store.get(tenant, key)` before the chain is resolved; a hit answers the stored request with `"replayed": true` instead of storing a second one.',
      match: {
        python: {all: [/idempotency-key/i], order: [/store\.get\(/, /resolve_approvers\(/]},
        typescript: {all: [/idempotency-key/i], order: [/store\.get\(/, /resolveApprovers\(/]},
        go: {all: [/Idempotency-Key/i], order: [/store\.Get\(/, /policy\.ResolveApprovers\(/]},
        scala: {all: [/Idempotency-Key/i], order: [/Store\.get\(/, /Policy\.resolveApprovers\(/]},
        cpp: {all: [/Idempotency-Key/i], order: [/store::get\(/, /policy::resolveApprovers\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import re

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from approvals import chain, policy, store  # resolve_approvers · new_request_id, get, put · start_chain

app = FastAPI()

CHAIN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,31}$")


class SubmitBody(BaseModel):
    chain_id: str
    why: str
    amount_cents: int = 0
    approvers: list[str] = []


def error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


@app.post("/v1/requests")
def submit(body: SubmitBody, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    requester = request.headers.get("x-user-id", "")
    if not tenant or not requester:
        return error(401, "X-Tenant-Id and X-User-Id are required")
    if not CHAIN_ID_RE.fullmatch(body.chain_id):
        return error(400, "invalid chain_id")
    resolved = policy.resolve_approvers(body.chain_id)
    if resolved is None:
        return error(404, "unknown chain")
    approvers = body.approvers or resolved["approvers"]  # the requester may narrow the chain for their request
    record = {
        "request_id": store.new_request_id(),
        "tenant": tenant,
        "requester": requester,
        "chain_id": body.chain_id,
        "chain_version": resolved["version"],
        "approvers": approvers,
        "why": body.why,
        "amount_cents": body.amount_cents,
    }
    store.put(record, request.headers.get("idempotency-key", ""))
    chain.start_chain(record["request_id"], approvers)
    return JSONResponse(
        {"request_id": record["request_id"], "chain_version": record["chain_version"], "approvers": approvers, "replayed": False},
        status_code=201,
    )
`,
      solution: `import re

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from approvals import chain, policy, store  # resolve_approvers · new_request_id, get, put · start_chain

app = FastAPI()

CHAIN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,31}$")
MAX_WHY_BYTES = 4096


class SubmitBody(BaseModel):
    chain_id: str
    why: str
    amount_cents: int = 0
    approvers: list[str] = []  # accepted for old clients, never read


def error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


def answer(record: dict, status: int, replayed: bool) -> JSONResponse:
    body = {"request_id": record["request_id"], "chain_version": record["chain_version"], "approvers": record["approvers"], "replayed": replayed}
    return JSONResponse(body, status_code=status)


@app.post("/v1/requests")
def submit(body: SubmitBody, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    requester = request.headers.get("x-user-id", "")
    if not tenant or not requester:
        return error(401, "X-Tenant-Id and X-User-Id are required")
    key = request.headers.get("idempotency-key", "")
    if not key:
        return error(400, "Idempotency-Key is required")
    if not CHAIN_ID_RE.fullmatch(body.chain_id):
        return error(400, "invalid chain_id")
    if not body.why:
        return error(400, "why is required")
    if len(body.why.encode("utf-8")) > MAX_WHY_BYTES:
        return error(413, f"why is longer than {MAX_WHY_BYTES} bytes")
    stored = store.get(tenant, key)
    if stored is not None:
        return answer(stored, 200, True)  # a retry gets the request its first attempt created
    resolved = policy.resolve_approvers(body.chain_id)
    if resolved is None:
        return error(404, "unknown chain")
    # The policy decides who approves; the version is pinned so a later edit cannot reshape this chain.
    if requester in resolved["approvers"]:
        return error(409, "requester_cannot_approve")
    record = {
        "request_id": store.new_request_id(),
        "tenant": tenant,
        "requester": requester,
        "chain_id": body.chain_id,
        "chain_version": resolved["version"],
        "approvers": resolved["approvers"],
        "why": body.why,
        "amount_cents": body.amount_cents,
    }
    store.put(record, key)
    chain.start_chain(record["request_id"], record["approvers"])
    return answer(record, 201, False)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import * as chain from 'approvals/chain'; // startChain
import * as policy from 'approvals/policy'; // resolveApprovers
import * as store from 'approvals/store'; // newRequestId, get, put

export const app = Fastify();

const CHAIN_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

interface SubmitBody {
  chain_id: string;
  why: string;
  amount_cents?: number;
  approvers?: string[];
}

app.post('/v1/requests', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  const requester = request.headers['x-user-id'];
  if (typeof tenant !== 'string' || tenant === '' || typeof requester !== 'string' || requester === '') {
    return reply.code(401).send({error: 'X-Tenant-Id and X-User-Id are required'});
  }
  const body = request.body as SubmitBody;
  if (!CHAIN_ID_RE.test(body.chain_id ?? '')) return reply.code(400).send({error: 'invalid chain_id'});
  const resolved = await policy.resolveApprovers(body.chain_id);
  if (resolved === null) return reply.code(404).send({error: 'unknown chain'});
  // the requester may narrow the chain for their request
  const approvers = body.approvers !== undefined && body.approvers.length > 0 ? body.approvers : resolved.approvers;
  const record: store.ApprovalRequest = {
    request_id: await store.newRequestId(),
    tenant,
    requester,
    chain_id: body.chain_id,
    chain_version: resolved.version,
    approvers,
    why: body.why,
    amount_cents: body.amount_cents ?? 0,
  };
  const key = request.headers['idempotency-key'];
  await store.put(record, typeof key === 'string' ? key : '');
  await chain.startChain(record.request_id, approvers);
  return reply.code(201).send({request_id: record.request_id, chain_version: record.chain_version, approvers, replayed: false});
});
`,
      solution: `import Fastify from 'fastify';

import * as chain from 'approvals/chain'; // startChain
import * as policy from 'approvals/policy'; // resolveApprovers
import * as store from 'approvals/store'; // newRequestId, get, put

export const app = Fastify();

const CHAIN_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
export const MAX_WHY_BYTES = 4096;

interface SubmitBody {
  chain_id: string;
  why: string;
  amount_cents?: number;
  approvers?: string[]; // accepted for old clients, never read
}

const answer = (record: store.ApprovalRequest, replayed: boolean) => ({
  request_id: record.request_id,
  chain_version: record.chain_version,
  approvers: record.approvers,
  replayed,
});

app.post('/v1/requests', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  const requester = request.headers['x-user-id'];
  if (typeof tenant !== 'string' || tenant === '' || typeof requester !== 'string' || requester === '') {
    return reply.code(401).send({error: 'X-Tenant-Id and X-User-Id are required'});
  }
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = request.body as SubmitBody;
  if (!CHAIN_ID_RE.test(body.chain_id ?? '')) return reply.code(400).send({error: 'invalid chain_id'});
  if (typeof body.why !== 'string' || body.why === '') return reply.code(400).send({error: 'why is required'});
  if (Buffer.byteLength(body.why, 'utf8') > MAX_WHY_BYTES) {
    return reply.code(413).send({error: \`why is longer than \${MAX_WHY_BYTES} bytes\`});
  }
  const stored = await store.get(tenant, key);
  if (stored !== null) return reply.code(200).send(answer(stored, true)); // a retry gets the request its first attempt created
  const resolved = await policy.resolveApprovers(body.chain_id);
  if (resolved === null) return reply.code(404).send({error: 'unknown chain'});
  // The policy decides who approves; the version is pinned so a later edit cannot reshape this chain.
  if (resolved.approvers.includes(requester)) return reply.code(409).send({error: 'requester_cannot_approve'});
  const record: store.ApprovalRequest = {
    request_id: await store.newRequestId(),
    tenant,
    requester,
    chain_id: body.chain_id,
    chain_version: resolved.version,
    approvers: resolved.approvers,
    why: body.why,
    amount_cents: body.amount_cents ?? 0,
  };
  await store.put(record, key);
  await chain.startChain(record.request_id, record.approvers);
  return reply.code(201).send(answer(record, false));
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"regexp"

	"approvals/chain"  // chain.StartChain
	"approvals/policy" // policy.ResolveApprovers
	"approvals/store"  // store.NewRequestID, Get, Put
)

var chainIDRe = regexp.MustCompile(\`^[a-z0-9][a-z0-9_-]{1,31}$\`)

type submitBody struct {
	ChainID     string   \`json:"chain_id"\`
	Why         string   \`json:"why"\`
	AmountCents int64    \`json:"amount_cents"\`
	Approvers   []string \`json:"approvers"\`
}

type submitted struct {
	RequestID    string   \`json:"request_id"\`
	ChainVersion int      \`json:"chain_version"\`
	Approvers    []string \`json:"approvers"\`
	Replayed     bool     \`json:"replayed"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func fail(rw http.ResponseWriter, status int, message string) {
	writeJSON(rw, status, map[string]string{"error": message})
}

func submit(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	ctx := r.Context()
	tenant, requester := r.Header.Get("X-Tenant-Id"), r.Header.Get("X-User-Id")
	if tenant == "" || requester == "" {
		fail(rw, http.StatusUnauthorized, "X-Tenant-Id and X-User-Id are required")
		return
	}
	var body submitBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !chainIDRe.MatchString(body.ChainID) {
		fail(rw, http.StatusBadRequest, "invalid chain_id")
		return
	}
	resolved, err := policy.ResolveApprovers(ctx, body.ChainID)
	if err != nil {
		fail(rw, http.StatusInternalServerError, err.Error())
		return
	}
	if resolved == nil {
		fail(rw, http.StatusNotFound, "unknown chain")
		return
	}
	approvers := body.Approvers // the requester may narrow the chain for their request
	if len(approvers) == 0 {
		approvers = resolved.Approvers
	}
	requestID, err := store.NewRequestID(ctx)
	if err != nil {
		fail(rw, http.StatusInternalServerError, err.Error())
		return
	}
	record := &store.Request{RequestID: requestID, Tenant: tenant, Requester: requester, ChainID: body.ChainID,
		ChainVersion: resolved.Version, Approvers: approvers, Why: body.Why, AmountCents: body.AmountCents}
	if err := store.Put(ctx, record, r.Header.Get("Idempotency-Key")); err != nil {
		fail(rw, http.StatusInternalServerError, err.Error())
		return
	}
	if err := chain.StartChain(ctx, requestID, approvers); err != nil {
		fail(rw, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(rw, http.StatusCreated, submitted{RequestID: requestID, ChainVersion: record.ChainVersion, Approvers: approvers})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/requests", submit)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"slices"

	"approvals/chain"  // chain.StartChain
	"approvals/policy" // policy.ResolveApprovers
	"approvals/store"  // store.NewRequestID, Get, Put
)

var chainIDRe = regexp.MustCompile(\`^[a-z0-9][a-z0-9_-]{1,31}$\`)

const maxWhyBytes = 4096

type submitBody struct {
	ChainID     string   \`json:"chain_id"\`
	Why         string   \`json:"why"\`
	AmountCents int64    \`json:"amount_cents"\`
	Approvers   []string \`json:"approvers"\` // accepted for old clients, never read
}

type submitted struct {
	RequestID    string   \`json:"request_id"\`
	ChainVersion int      \`json:"chain_version"\`
	Approvers    []string \`json:"approvers"\`
	Replayed     bool     \`json:"replayed"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func fail(rw http.ResponseWriter, status int, message string) {
	writeJSON(rw, status, map[string]string{"error": message})
}

func submit(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	tenant, requester := r.Header.Get("X-Tenant-Id"), r.Header.Get("X-User-Id")
	if tenant == "" || requester == "" {
		fail(rw, http.StatusUnauthorized, "X-Tenant-Id and X-User-Id are required")
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		fail(rw, http.StatusBadRequest, "Idempotency-Key is required")
		return
	}
	var body submitBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !chainIDRe.MatchString(body.ChainID) {
		fail(rw, http.StatusBadRequest, "invalid chain_id")
		return
	}
	if body.Why == "" {
		fail(rw, http.StatusBadRequest, "why is required")
		return
	}
	if len(body.Why) > maxWhyBytes { // len counts the UTF-8 bytes
		fail(rw, http.StatusRequestEntityTooLarge, fmt.Sprintf("why is longer than %d bytes", maxWhyBytes))
		return
	}
	stored, err := store.Get(ctx, tenant, key)
	if err != nil {
		fail(rw, http.StatusInternalServerError, err.Error())
		return
	}
	if stored != nil { // a retry gets the request its first attempt created
		writeJSON(rw, http.StatusOK, submitted{RequestID: stored.RequestID, ChainVersion: stored.ChainVersion, Approvers: stored.Approvers, Replayed: true})
		return
	}
	resolved, err := policy.ResolveApprovers(ctx, body.ChainID)
	if err != nil {
		fail(rw, http.StatusInternalServerError, err.Error())
		return
	}
	if resolved == nil {
		fail(rw, http.StatusNotFound, "unknown chain")
		return
	}
	// The policy decides who approves; the version is pinned so a later edit cannot reshape this chain.
	if slices.Contains(resolved.Approvers, requester) {
		fail(rw, http.StatusConflict, "requester_cannot_approve")
		return
	}
	requestID, err := store.NewRequestID(ctx)
	if err != nil {
		fail(rw, http.StatusInternalServerError, err.Error())
		return
	}
	record := &store.Request{RequestID: requestID, Tenant: tenant, Requester: requester, ChainID: body.ChainID,
		ChainVersion: resolved.Version, Approvers: resolved.Approvers, Why: body.Why, AmountCents: body.AmountCents}
	if err := store.Put(ctx, record, key); err != nil {
		fail(rw, http.StatusInternalServerError, err.Error())
		return
	}
	if err := chain.StartChain(ctx, requestID, record.Approvers); err != nil {
		fail(rw, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(rw, http.StatusCreated, submitted{RequestID: requestID, ChainVersion: record.ChainVersion, Approvers: record.Approvers})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/requests", submit)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import approvals.{Chain, Policy, Store} // Policy.resolveApprovers · Store.newRequestId, get, put · Chain.startChain

object Api {
  val ChainIdRe = "^[a-z0-9][a-z0-9_-]{1,31}$".r

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  def submit(tenant: String, requester: String, idemKey: String, raw: String): HttpResponse = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    if (tenant.isEmpty || requester.isEmpty) return error(StatusCodes.Unauthorized, "X-Tenant-Id and X-User-Id are required")
    val fields = raw.parseJson.asJsObject.fields
    def text(name: String): String = fields.get(name).collect { case JsString(s) => s }.getOrElse("")
    val chainId = text("chain_id")
    if (!ChainIdRe.matches(chainId)) return error(StatusCodes.BadRequest, "invalid chain_id")
    Policy.resolveApprovers(chainId) match {
      case None => error(StatusCodes.NotFound, "unknown chain")
      case Some(resolved) =>
        // the requester may narrow the chain for their request
        val named = fields.get("approvers").collect { case JsArray(items) => items.collect { case JsString(s) => s } }.getOrElse(Vector.empty)
        val approvers = if (named.nonEmpty) named else resolved.approvers
        val amount = fields.get("amount_cents").collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
        val record = Store.Request(Store.newRequestId(), tenant, requester, chainId, resolved.version, approvers, text("why"), amount)
        Store.put(record, idemKey)
        Chain.startChain(record.requestId, approvers)
        json(StatusCodes.Created, JsObject(
          "request_id" -> JsString(record.requestId), "chain_version" -> JsNumber(record.chainVersion),
          "approvers" -> JsArray(approvers.map(JsString(_)).toVector), "replayed" -> JsBoolean(false)))
    }
  }

  val route: Route = path("v1" / "requests") {
    post {
      (optionalHeaderValueByName("X-Tenant-Id") & optionalHeaderValueByName("X-User-Id") & optionalHeaderValueByName("Idempotency-Key")) {
        (tenant, requester, idemKey) =>
          entity(as[String]) { raw =>
            complete(submit(tenant.getOrElse(""), requester.getOrElse(""), idemKey.getOrElse(""), raw))
          }
      }
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets.UTF_8

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import approvals.{Chain, Policy, Store} // Policy.resolveApprovers · Store.newRequestId, get, put · Chain.startChain

object Api {
  val ChainIdRe = "^[a-z0-9][a-z0-9_-]{1,31}$".r
  val MaxWhyBytes = 4096

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def answer(status: StatusCode, record: Store.Request, replayed: Boolean): HttpResponse =
    json(status, JsObject(
      "request_id" -> JsString(record.requestId), "chain_version" -> JsNumber(record.chainVersion),
      "approvers" -> JsArray(record.approvers.map(JsString(_)).toVector), "replayed" -> JsBoolean(replayed)))

  def submit(tenant: String, requester: String, idemKey: String, raw: String): HttpResponse = {
    if (tenant.isEmpty || requester.isEmpty) return error(StatusCodes.Unauthorized, "X-Tenant-Id and X-User-Id are required")
    if (idemKey.isEmpty) return error(StatusCodes.BadRequest, "Idempotency-Key is required")
    val fields = raw.parseJson.asJsObject.fields
    def text(name: String): String = fields.get(name).collect { case JsString(s) => s }.getOrElse("")
    val chainId = text("chain_id")
    val why = text("why")
    if (!ChainIdRe.matches(chainId)) return error(StatusCodes.BadRequest, "invalid chain_id")
    if (why.isEmpty) return error(StatusCodes.BadRequest, "why is required")
    if (why.getBytes(UTF_8).length > MaxWhyBytes) return error(StatusCodes.PayloadTooLarge, s"why is longer than $MaxWhyBytes bytes")
    // a retry gets the request its first attempt created
    val stored = Store.get(tenant, idemKey)
    if (stored.isDefined) return answer(StatusCodes.OK, stored.get, replayed = true)
    Policy.resolveApprovers(chainId) match {
      case None => error(StatusCodes.NotFound, "unknown chain")
      // The policy decides who approves; the version is pinned so a later edit cannot reshape this chain.
      case Some(resolved) if resolved.approvers.contains(requester) => error(StatusCodes.Conflict, "requester_cannot_approve")
      case Some(resolved) =>
        val amount = fields.get("amount_cents").collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
        val record = Store.Request(Store.newRequestId(), tenant, requester, chainId, resolved.version, resolved.approvers, why, amount)
        Store.put(record, idemKey)
        Chain.startChain(record.requestId, record.approvers)
        answer(StatusCodes.Created, record, replayed = false)
    }
  }

  val route: Route = path("v1" / "requests") {
    post {
      (optionalHeaderValueByName("X-Tenant-Id") & optionalHeaderValueByName("X-User-Id") & optionalHeaderValueByName("Idempotency-Key")) {
        (tenant, requester, idemKey) =>
          entity(as[String]) { raw =>
            complete(submit(tenant.getOrElse(""), requester.getOrElse(""), idemKey.getOrElse(""), raw))
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

#include <regex>
#include <string>
#include <vector>

#include "approvals/chain.h"   // chain::startChain
#include "approvals/policy.h"  // policy::resolveApprovers
#include "approvals/store.h"   // store::newRequestId, get, put

using json = nlohmann::json;

const std::regex kChainIdRe("^[a-z0-9][a-z0-9_-]{1,31}$");

void send_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void submit(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const std::string requester = req.get_header_value("X-User-Id");
  if (tenant.empty() || requester.empty()) return send_json(res, 401, {{"error", "X-Tenant-Id and X-User-Id are required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !std::regex_match(body.value("chain_id", ""), kChainIdRe)) {
    return send_json(res, 400, {{"error", "invalid chain_id"}});
  }
  const std::string chain_id = body["chain_id"];
  const auto resolved = policy::resolveApprovers(chain_id);
  if (!resolved) return send_json(res, 404, {{"error", "unknown chain"}});
  // the requester may narrow the chain for their request
  std::vector<std::string> approvers = body.value("approvers", std::vector<std::string>{});
  if (approvers.empty()) approvers = resolved->approvers;
  const store::Request record{store::newRequestId(), tenant,  requester, chain_id, resolved->version,
                              approvers,             body.value("why", ""), body.value("amount_cents", 0LL)};
  store::put(record, req.get_header_value("Idempotency-Key"));
  chain::startChain(record.request_id, approvers);
  send_json(res, 201, {{"request_id", record.request_id}, {"chain_version", record.chain_version}, {"approvers", approvers}, {"replayed", false}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/requests", submit); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <regex>
#include <string>
#include <vector>

#include "approvals/chain.h"   // chain::startChain
#include "approvals/policy.h"  // policy::resolveApprovers
#include "approvals/store.h"   // store::newRequestId, get, put

using json = nlohmann::json;

const std::regex kChainIdRe("^[a-z0-9][a-z0-9_-]{1,31}$");
constexpr size_t kMaxWhyBytes = 4096;

void send_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

json answer(const store::Request& record, bool replayed) {
  return {{"request_id", record.request_id}, {"chain_version", record.chain_version}, {"approvers", record.approvers}, {"replayed", replayed}};
}

void submit(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const std::string requester = req.get_header_value("X-User-Id");
  if (tenant.empty() || requester.empty()) return send_json(res, 401, {{"error", "X-Tenant-Id and X-User-Id are required"}});
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return send_json(res, 400, {{"error", "Idempotency-Key is required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !std::regex_match(body.value("chain_id", ""), kChainIdRe)) {
    return send_json(res, 400, {{"error", "invalid chain_id"}});
  }
  const std::string chain_id = body["chain_id"];
  const std::string why = body.value("why", "");
  if (why.empty()) return send_json(res, 400, {{"error", "why is required"}});
  // size() counts the UTF-8 bytes
  if (why.size() > kMaxWhyBytes) return send_json(res, 413, {{"error", "why is longer than 4096 bytes"}});
  // a retry gets the request its first attempt created
  if (const auto stored = store::get(tenant, key)) return send_json(res, 200, answer(*stored, true));
  const auto resolved = policy::resolveApprovers(chain_id);
  if (!resolved) return send_json(res, 404, {{"error", "unknown chain"}});
  // The policy decides who approves; the version is pinned so a later edit cannot reshape this chain.
  const auto& approvers = resolved->approvers;
  if (std::find(approvers.begin(), approvers.end(), requester) != approvers.end()) {
    return send_json(res, 409, {{"error", "requester_cannot_approve"}});
  }
  const store::Request record{store::newRequestId(), tenant, requester, chain_id, resolved->version, approvers, why, body.value("amount_cents", 0LL)};
  store::put(record, key);
  chain::startChain(record.request_id, record.approvers);
  send_json(res, 201, answer(record, false));
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/requests", submit); }
`,
    },
  },
  harness: {
    python: `from approvals import policy, store

BODY = {"chain_id": "spend", "why": "new laptop", "amount_cents": 420000}


def _api(ctx):
    policy.define_chain("spend", 3, ["u-mgr", "u-dir"])
    return ctx.client(ctx.load("api").app)


def _headers(user="u-req", tenant="t-acme", key="k-1"):
    headers = {"X-Tenant-Id": tenant, "X-User-Id": user}
    if key:
        headers["Idempotency-Key"] = key
    return headers


def _stored(ctx):
    return sorted(ctx.redis.keys("request:r-*"))


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/requests", json=BODY, headers=_headers())
        anonymous = await c.post("/v1/requests", json=BODY, headers={"Idempotency-Key": "k-2"})
    assert r.status_code == 201, f"POST /v1/requests answered {r.status_code}: {r.text}"
    request_id = r.json().get("request_id")
    stored = store.load(request_id) if request_id else None
    assert stored is not None, f"the submit answered {r.text} but no request {request_id!r} is in the store"
    assert (stored["tenant"], stored["requester"], stored["why"]) == ("t-acme", "u-req", "new laptop"), f"the stored request is {stored}"
    current = ctx.redis.hget(f"approval:{request_id}:state", "current_approver")
    assert current == "u-mgr", f"the chain of {request_id} waits on {current!r}, expected its first approver u-mgr"
    assert anonymous.status_code == 401, f"a submit without X-Tenant-Id and X-User-Id answered {anonymous.status_code}, expected 401"


async def check_policy_approvers(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/requests", json={**BODY, "approvers": ["u-friend"]}, headers=_headers())
        assert r.status_code == 201, f"a submit naming its own approvers answered {r.status_code}: {r.text}"
        stored = store.load(r.json()["request_id"])
        assert stored["approvers"] == ["u-mgr", "u-dir"], f"the stored chain is {stored['approvers']}: the requester named it. The approvers come from the policy (u-mgr, u-dir)"
        assert stored["chain_version"] == 3, f"the stored chain_version is {stored['chain_version']}, expected the policy's version 3"
        current = ctx.redis.hget(f"approval:{stored['request_id']}:state", "current_approver")
        assert current == "u-mgr", f"the chain waits on {current!r}, expected the policy's first approver u-mgr"
        policy.define_chain("spend", 4, ["u-mgr", "u-cfo"])
        assert store.load(stored["request_id"])["chain_version"] == 3, "a policy edit after the submit changed the pinned request"
        unknown = await c.post("/v1/requests", json={**BODY, "chain_id": "travel"}, headers=_headers(key="k-2"))
    assert unknown.status_code == 404, f"a submit on an unknown chain answered {unknown.status_code}, expected 404"


async def check_self_approval(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/requests", json=BODY, headers=_headers(user="u-dir"))
        assert r.status_code == 409, f"the director submitted a request on a chain they approve and got {r.status_code}, expected 409"
        assert "requester_cannot_approve" in r.text, f"the 409 must say requester_cannot_approve, got {r.text}"
        assert _stored(ctx) == [] and ctx.redis.keys("approval:*") == [], f"a refused submit stored {_stored(ctx)} {ctx.redis.keys('approval:*')}"
        r = await c.post("/v1/requests", json={**BODY, "approvers": ["u-friend"]}, headers=_headers(user="u-dir", key="k-2"))
        assert r.status_code == 409, f"the director naming u-friend as approver got {r.status_code}: the policy's chain still holds the director, expected 409"
        ok = await c.post("/v1/requests", json=BODY, headers=_headers(key="k-3"))
    assert ok.status_code == 201, f"a requester who is not on the chain got {ok.status_code}: {ok.text}"


async def check_why_cap(ctx):
    async with _api(ctx) as c:
        at_cap = await c.post("/v1/requests", json={**BODY, "why": "x" * 4096}, headers=_headers(key="k-1"))
        assert at_cap.status_code == 201, f"a why of exactly 4096 bytes answered {at_cap.status_code}, expected 201"
        over = await c.post("/v1/requests", json={**BODY, "why": "x" * 4097}, headers=_headers(key="k-2"))
        assert over.status_code == 413, f"a why of 4097 bytes answered {over.status_code}, expected 413"
        wide = await c.post("/v1/requests", json={**BODY, "why": "é" * 2049}, headers=_headers(key="k-3"))
        assert wide.status_code == 413, f"a why of 2049 two-byte characters (4098 bytes) answered {wide.status_code}: measure UTF-8 bytes, not characters"
        empty = await c.post("/v1/requests", json={**BODY, "why": ""}, headers=_headers(key="k-4"))
        assert empty.status_code == 400, f"an empty why answered {empty.status_code}, expected 400"
    assert len(_stored(ctx)) == 1, f"only the 4096-byte request may be stored, the store holds {_stored(ctx)}"


async def check_idempotency(ctx):
    async with _api(ctx) as c:
        first = await c.post("/v1/requests", json=BODY, headers=_headers(key="k-1"))
        assert first.status_code == 201, f"the first submit answered {first.status_code}: {first.text}"
        replay = await c.post("/v1/requests", json=BODY, headers=_headers(key="k-1"))
        assert replay.status_code == 200, f"a replay of Idempotency-Key k-1 answered {replay.status_code}, expected 200"
        body = replay.json()
        assert body.get("request_id") == first.json()["request_id"] and body.get("replayed") is True, f"the replay answered {body}, expected the original request_id {first.json()['request_id']} with replayed true"
        assert len(_stored(ctx)) == 1, f"two submits with one Idempotency-Key stored {_stored(ctx)}: a retry opened a second chain"
        other = await c.post("/v1/requests", json=BODY, headers=_headers(tenant="t-globex", key="k-1"))
        assert other.status_code == 201 and other.json().get("request_id") != first.json()["request_id"], f"the same key from another tenant answered {other.status_code} {other.text}: keys are per tenant"
        missing = await c.post("/v1/requests", json=BODY, headers=_headers(key=""))
    assert missing.status_code == 400, f"a submit without Idempotency-Key answered {missing.status_code}, expected 400"
`,
    typescript: `const BODY = {chain_id: 'spend', why: 'new laptop', amount_cents: 420000};

async function api(ctx) {
  const policy = ctx.load('/support/approvals/policy.ts');
  await policy.defineChain('spend', 3, ['u-mgr', 'u-dir']);
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/approvals/store.ts'), policy};
}

function headers(user = 'u-req', tenant = 't-acme', key = 'k-1'): Record<string, string> {
  const out: Record<string, string> = {'X-Tenant-Id': tenant, 'X-User-Id': user};
  if (key !== '') out['Idempotency-Key'] = key;
  return out;
}

const stored = ctx => (ctx.redis.keys('request:r-*') as string[]).sort();

export async function check_route(ctx) {
  const {c, store} = await api(ctx);
  const r = await c.post('/v1/requests', {json: BODY, headers: headers()});
  assert.equal(r.status, 201, \`POST /v1/requests answered \${r.status}: \${r.text}\`);
  const requestId = r.json().request_id;
  const record = requestId ? await store.load(requestId) : null;
  assert(record !== null, \`the submit answered \${r.text} but no request \${requestId} is in the store\`);
  assert(record.tenant === 't-acme' && record.requester === 'u-req' && record.why === 'new laptop', \`the stored request is \${JSON.stringify(record)}\`);
  const current = ctx.redis.hget(\`approval:\${requestId}:state\`, 'current_approver');
  assert.equal(current, 'u-mgr', \`the chain of \${requestId} waits on \${current}, expected its first approver u-mgr\`);
  const anonymous = await c.post('/v1/requests', {json: BODY, headers: {'Idempotency-Key': 'k-2'}});
  assert.equal(anonymous.status, 401, \`a submit without X-Tenant-Id and X-User-Id answered \${anonymous.status}, expected 401\`);
}

export async function check_policy_approvers(ctx) {
  const {c, store, policy} = await api(ctx);
  const r = await c.post('/v1/requests', {json: {...BODY, approvers: ['u-friend']}, headers: headers()});
  assert.equal(r.status, 201, \`a submit naming its own approvers answered \${r.status}: \${r.text}\`);
  const record = await store.load(r.json().request_id);
  assert.deepEqual(record.approvers, ['u-mgr', 'u-dir'], \`the stored chain is \${JSON.stringify(record.approvers)}: the requester named it. The approvers come from the policy (u-mgr, u-dir)\`);
  assert.equal(record.chain_version, 3, \`the stored chain_version is \${record.chain_version}, expected the policy's version 3\`);
  const current = ctx.redis.hget(\`approval:\${record.request_id}:state\`, 'current_approver');
  assert.equal(current, 'u-mgr', \`the chain waits on \${current}, expected the policy's first approver u-mgr\`);
  await policy.defineChain('spend', 4, ['u-mgr', 'u-cfo']);
  assert.equal((await store.load(record.request_id)).chain_version, 3, 'a policy edit after the submit changed the pinned request');
  const unknown = await c.post('/v1/requests', {json: {...BODY, chain_id: 'travel'}, headers: headers('u-req', 't-acme', 'k-2')});
  assert.equal(unknown.status, 404, \`a submit on an unknown chain answered \${unknown.status}, expected 404\`);
}

export async function check_self_approval(ctx) {
  const {c} = await api(ctx);
  let r = await c.post('/v1/requests', {json: BODY, headers: headers('u-dir')});
  assert.equal(r.status, 409, \`the director submitted a request on a chain they approve and got \${r.status}, expected 409\`);
  assert(r.text.includes('requester_cannot_approve'), \`the 409 must say requester_cannot_approve, got \${r.text}\`);
  assert(stored(ctx).length === 0 && ctx.redis.keys('approval:*').length === 0, \`a refused submit stored \${JSON.stringify(stored(ctx))} \${JSON.stringify(ctx.redis.keys('approval:*'))}\`);
  r = await c.post('/v1/requests', {json: {...BODY, approvers: ['u-friend']}, headers: headers('u-dir', 't-acme', 'k-2')});
  assert.equal(r.status, 409, \`the director naming u-friend as approver got \${r.status}: the policy's chain still holds the director, expected 409\`);
  const ok = await c.post('/v1/requests', {json: BODY, headers: headers('u-req', 't-acme', 'k-3')});
  assert.equal(ok.status, 201, \`a requester who is not on the chain got \${ok.status}: \${ok.text}\`);
}

export async function check_why_cap(ctx) {
  const {c} = await api(ctx);
  const atCap = await c.post('/v1/requests', {json: {...BODY, why: 'x'.repeat(4096)}, headers: headers('u-req', 't-acme', 'k-1')});
  assert.equal(atCap.status, 201, \`a why of exactly 4096 bytes answered \${atCap.status}, expected 201\`);
  const over = await c.post('/v1/requests', {json: {...BODY, why: 'x'.repeat(4097)}, headers: headers('u-req', 't-acme', 'k-2')});
  assert.equal(over.status, 413, \`a why of 4097 bytes answered \${over.status}, expected 413\`);
  const wide = await c.post('/v1/requests', {json: {...BODY, why: 'é'.repeat(2049)}, headers: headers('u-req', 't-acme', 'k-3')});
  assert.equal(wide.status, 413, \`a why of 2049 two-byte characters (4098 bytes) answered \${wide.status}: measure UTF-8 bytes, not characters\`);
  const empty = await c.post('/v1/requests', {json: {...BODY, why: ''}, headers: headers('u-req', 't-acme', 'k-4')});
  assert.equal(empty.status, 400, \`an empty why answered \${empty.status}, expected 400\`);
  assert.equal(stored(ctx).length, 1, \`only the 4096-byte request may be stored, the store holds \${JSON.stringify(stored(ctx))}\`);
}

export async function check_idempotency(ctx) {
  const {c} = await api(ctx);
  const first = await c.post('/v1/requests', {json: BODY, headers: headers()});
  assert.equal(first.status, 201, \`the first submit answered \${first.status}: \${first.text}\`);
  const replay = await c.post('/v1/requests', {json: BODY, headers: headers()});
  assert.equal(replay.status, 200, \`a replay of Idempotency-Key k-1 answered \${replay.status}, expected 200\`);
  const body = replay.json();
  assert(body.request_id === first.json().request_id && body.replayed === true, \`the replay answered \${replay.text}, expected the original request_id \${first.json().request_id} with replayed true\`);
  assert.equal(stored(ctx).length, 1, \`two submits with one Idempotency-Key stored \${JSON.stringify(stored(ctx))}: a retry opened a second chain\`);
  const other = await c.post('/v1/requests', {json: BODY, headers: headers('u-req', 't-globex', 'k-1')});
  assert(other.status === 201 && other.json().request_id !== first.json().request_id, \`the same key from another tenant answered \${other.status} \${other.text}: keys are per tenant\`);
  const missing = await c.post('/v1/requests', {json: BODY, headers: headers('u-req', 't-acme', '')});
  assert.equal(missing.status, 400, \`a submit without Idempotency-Key answered \${missing.status}, expected 400\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"approvals/policy"
	"approvals/store"

	"leetbuild/harness"
)

var apiBg = context.Background()

var apiBody = map[string]any{"chain_id": "spend", "why": "new laptop", "amount_cents": 420000}

type apiAnswer struct {
	RequestID    string   \`json:"request_id"\`
	ChainVersion int      \`json:"chain_version"\`
	Approvers    []string \`json:"approvers"\`
	Replayed     bool     \`json:"replayed"\`
}

func apiServe(ctx *harness.Ctx) *harness.HTTP {
	ctx.NoError(policy.DefineChain(apiBg, "spend", 3, []string{"u-mgr", "u-dir"}), "defining the spend chain")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiWith(field string, value any) map[string]any {
	out := map[string]any{}
	for k, v := range apiBody {
		out[k] = v
	}
	out[field] = value
	return out
}

func apiSubmit(c *harness.HTTP, body map[string]any, user, tenant, key string) *harness.Response {
	header := []string{"X-Tenant-Id", tenant, "X-User-Id", user}
	if key != "" {
		header = append(header, "Idempotency-Key", key)
	}
	return c.Post("/v1/requests", body, header...)
}

func apiDecode(r *harness.Response) apiAnswer {
	var a apiAnswer
	r.Decode(&a)
	return a
}

func apiLoad(ctx *harness.Ctx, requestID string) *store.Request {
	record, err := store.Load(apiBg, requestID)
	ctx.NoError(err, "store.Load(%s)", requestID)
	return record
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiServe(ctx)
	r := apiSubmit(c, apiBody, "u-req", "t-acme", "k-1")
	ctx.Equal(r.Status, 201, "POST /v1/requests (%s)", r.Text())
	requestID := apiDecode(r).RequestID
	record := apiLoad(ctx, requestID)
	ctx.Assert(record != nil, "the submit answered %s but no request %q is in the store", r.Text(), requestID)
	ctx.Assert(record.Tenant == "t-acme" && record.Requester == "u-req" && record.Why == "new laptop", "the stored request is %+v", record)
	current, _ := ctx.Redis.HGet("approval:"+requestID+":state", "current_approver")
	ctx.Equal(current, "u-mgr", "the chain of %s must wait on its first approver; current_approver", requestID)
	anonymous := c.Post("/v1/requests", apiBody, "Idempotency-Key", "k-2")
	ctx.Equal(anonymous.Status, 401, "a submit without X-Tenant-Id and X-User-Id")
}

func CheckPolicyApprovers(ctx *harness.Ctx) {
	c := apiServe(ctx)
	r := apiSubmit(c, apiWith("approvers", []string{"u-friend"}), "u-req", "t-acme", "k-1")
	ctx.Equal(r.Status, 201, "a submit naming its own approvers (%s)", r.Text())
	record := apiLoad(ctx, apiDecode(r).RequestID)
	ctx.Assert(record != nil, "no request stored for %s", r.Text())
	ctx.Equal(record.Approvers, []string{"u-mgr", "u-dir"}, "the requester named the chain; the approvers come from the policy. The stored approvers")
	ctx.Equal(record.ChainVersion, 3, "the stored chain_version must be the policy's version 3")
	current, _ := ctx.Redis.HGet("approval:"+record.RequestID+":state", "current_approver")
	ctx.Equal(current, "u-mgr", "the chain must wait on the policy's first approver; current_approver")
	ctx.NoError(policy.DefineChain(apiBg, "spend", 4, []string{"u-mgr", "u-cfo"}), "redefining the spend chain")
	ctx.Equal(apiLoad(ctx, record.RequestID).ChainVersion, 3, "a policy edit after the submit must not change the pinned request; chain_version")
	unknown := apiSubmit(c, apiWith("chain_id", "travel"), "u-req", "t-acme", "k-2")
	ctx.Equal(unknown.Status, 404, "a submit on an unknown chain")
}

func CheckSelfApproval(ctx *harness.Ctx) {
	c := apiServe(ctx)
	r := apiSubmit(c, apiBody, "u-dir", "t-acme", "k-1")
	ctx.Equal(r.Status, 409, "the director submitted a request on a chain they approve")
	ctx.Assert(strings.Contains(r.Text(), "requester_cannot_approve"), "the 409 must say requester_cannot_approve, got %s", r.Text())
	ctx.Assert(len(ctx.Redis.Keys("request:r-*")) == 0 && len(ctx.Redis.Keys("approval:*")) == 0, "a refused submit stored %q %q", ctx.Redis.Keys("request:r-*"), ctx.Redis.Keys("approval:*"))
	r = apiSubmit(c, apiWith("approvers", []string{"u-friend"}), "u-dir", "t-acme", "k-2")
	ctx.Equal(r.Status, 409, "the director naming u-friend as approver: the policy's chain still holds the director")
	ok := apiSubmit(c, apiBody, "u-req", "t-acme", "k-3")
	ctx.Equal(ok.Status, 201, "a requester who is not on the chain (%s)", ok.Text())
}

func CheckWhyCap(ctx *harness.Ctx) {
	c := apiServe(ctx)
	ctx.Equal(apiSubmit(c, apiWith("why", strings.Repeat("x", 4096)), "u-req", "t-acme", "k-1").Status, 201, "a why of exactly 4096 bytes")
	ctx.Equal(apiSubmit(c, apiWith("why", strings.Repeat("x", 4097)), "u-req", "t-acme", "k-2").Status, 413, "a why of 4097 bytes")
	ctx.Equal(apiSubmit(c, apiWith("why", strings.Repeat("é", 2049)), "u-req", "t-acme", "k-3").Status, 413, "a why of 2049 two-byte characters (4098 bytes): measure UTF-8 bytes, not characters")
	ctx.Equal(apiSubmit(c, apiWith("why", ""), "u-req", "t-acme", "k-4").Status, 400, "an empty why")
	ctx.Equal(len(ctx.Redis.Keys("request:r-*")), 1, "only the 4096-byte request may be stored; the stored requests")
}

func CheckIdempotency(ctx *harness.Ctx) {
	c := apiServe(ctx)
	first := apiSubmit(c, apiBody, "u-req", "t-acme", "k-1")
	ctx.Equal(first.Status, 201, "the first submit (%s)", first.Text())
	replay := apiSubmit(c, apiBody, "u-req", "t-acme", "k-1")
	ctx.Equal(replay.Status, 200, "a replay of Idempotency-Key k-1")
	answer := apiDecode(replay)
	ctx.Assert(answer.RequestID == apiDecode(first).RequestID && answer.Replayed, "the replay answered %s, expected the original request_id %s with replayed true", replay.Text(), apiDecode(first).RequestID)
	ctx.Equal(len(ctx.Redis.Keys("request:r-*")), 1, "two submits with one Idempotency-Key must store one request (a retry opened a second chain); the stored requests")
	other := apiSubmit(c, apiBody, "u-req", "t-globex", "k-1")
	ctx.Assert(other.Status == 201 && apiDecode(other).RequestID != apiDecode(first).RequestID, "the same key from another tenant answered %d %s: keys are per tenant", other.Status, other.Text())
	missing := apiSubmit(c, apiBody, "u-req", "t-acme", "")
	ctx.Equal(missing.Status, 400, "a submit without Idempotency-Key")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "approvals/policy.h"
#include "approvals/store.h"

namespace {

const nlohmann::json kBody = {{"chain_id", "spend"}, {"why", "new laptop"}, {"amount_cents", 420000}};

harness::HTTP apiServe(harness::Ctx& ctx) {
  policy::defineChain("spend", 3, {"u-mgr", "u-dir"});
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

nlohmann::json apiWith(const std::string& field, const nlohmann::json& value) {
  nlohmann::json out = kBody;
  out[field] = value;
  return out;
}

harness::Response apiSubmit(harness::HTTP& c, const nlohmann::json& body, const std::string& user, const std::string& tenant, const std::string& key) {
  if (key.empty()) return c.Post("/v1/requests", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant, "X-User-Id", user);
  return c.Post("/v1/requests", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant, "X-User-Id", user, "Idempotency-Key", key);
}

std::string apiRequestId(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body.value("request_id", "") : "";
}

std::string repeat(const std::string& unit, int n) {
  std::string out;
  for (int i = 0; i < n; i++) out += unit;
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = apiServe(ctx);
  const auto r = apiSubmit(c, kBody, "u-req", "t-acme", "k-1");
  ctx.Equal(r.Status, 201, "POST /v1/requests (%s)", r.Text());
  const std::string request_id = apiRequestId(r);
  const auto record = store::load(request_id);
  ctx.Assert(record.has_value(), "the submit answered %s but no request %q is in the store", r.Text(), request_id);
  ctx.Assert(record->tenant == "t-acme" && record->requester == "u-req" && record->why == "new laptop", "the stored request is tenant %q requester %q why %q", record->tenant, record->requester, record->why);
  ctx.Equal(ctx.Redis.HGet("approval:" + request_id + ":state", "current_approver"), std::optional<std::string>("u-mgr"), "the chain of %s must wait on its first approver; current_approver", request_id);
  const auto anonymous = c.Post("/v1/requests", kBody.dump(), "Content-Type", "application/json", "Idempotency-Key", "k-2");
  ctx.Equal(anonymous.Status, 401, "a submit without X-Tenant-Id and X-User-Id");
}

void CheckPolicyApprovers(harness::Ctx& ctx) {
  auto c = apiServe(ctx);
  const auto r = apiSubmit(c, apiWith("approvers", {"u-friend"}), "u-req", "t-acme", "k-1");
  ctx.Equal(r.Status, 201, "a submit naming its own approvers (%s)", r.Text());
  const auto record = store::load(apiRequestId(r));
  ctx.Assert(record.has_value(), "no request stored for %s", r.Text());
  ctx.Equal(record->approvers, std::vector<std::string>{"u-mgr", "u-dir"}, "the requester named the chain; the approvers come from the policy. The stored approvers");
  ctx.Equal(record->chain_version, 3, "the stored chain_version must be the policy's version 3");
  ctx.Equal(ctx.Redis.HGet("approval:" + record->request_id + ":state", "current_approver"), std::optional<std::string>("u-mgr"), "the chain must wait on the policy's first approver; current_approver");
  policy::defineChain("spend", 4, {"u-mgr", "u-cfo"});
  ctx.Equal(store::load(record->request_id)->chain_version, 3, "a policy edit after the submit must not change the pinned request; chain_version");
  const auto unknown = apiSubmit(c, apiWith("chain_id", "travel"), "u-req", "t-acme", "k-2");
  ctx.Equal(unknown.Status, 404, "a submit on an unknown chain");
}

void CheckSelfApproval(harness::Ctx& ctx) {
  auto c = apiServe(ctx);
  auto r = apiSubmit(c, kBody, "u-dir", "t-acme", "k-1");
  ctx.Equal(r.Status, 409, "the director submitted a request on a chain they approve");
  ctx.Assert(r.Text().find("requester_cannot_approve") != std::string::npos, "the 409 must say requester_cannot_approve, got %s", r.Text());
  ctx.Assert(ctx.Redis.Keys("request:r-*").empty() && ctx.Redis.Keys("approval:*").empty(), "a refused submit stored %q %q", ctx.Redis.Keys("request:r-*"), ctx.Redis.Keys("approval:*"));
  r = apiSubmit(c, apiWith("approvers", {"u-friend"}), "u-dir", "t-acme", "k-2");
  ctx.Equal(r.Status, 409, "the director naming u-friend as approver: the policy's chain still holds the director");
  const auto ok = apiSubmit(c, kBody, "u-req", "t-acme", "k-3");
  ctx.Equal(ok.Status, 201, "a requester who is not on the chain (%s)", ok.Text());
}

void CheckWhyCap(harness::Ctx& ctx) {
  auto c = apiServe(ctx);
  ctx.Equal(apiSubmit(c, apiWith("why", repeat("x", 4096)), "u-req", "t-acme", "k-1").Status, 201, "a why of exactly 4096 bytes");
  ctx.Equal(apiSubmit(c, apiWith("why", repeat("x", 4097)), "u-req", "t-acme", "k-2").Status, 413, "a why of 4097 bytes");
  ctx.Equal(apiSubmit(c, apiWith("why", repeat("\\u00e9", 2049)), "u-req", "t-acme", "k-3").Status, 413, "a why of 2049 two-byte characters (4098 bytes): measure UTF-8 bytes, not characters");
  ctx.Equal(apiSubmit(c, apiWith("why", ""), "u-req", "t-acme", "k-4").Status, 400, "an empty why");
  ctx.Equal(ctx.Redis.Keys("request:r-*").size(), 1, "only the 4096-byte request may be stored; the stored requests");
}

void CheckIdempotency(harness::Ctx& ctx) {
  auto c = apiServe(ctx);
  const auto first = apiSubmit(c, kBody, "u-req", "t-acme", "k-1");
  ctx.Equal(first.Status, 201, "the first submit (%s)", first.Text());
  const auto replay = apiSubmit(c, kBody, "u-req", "t-acme", "k-1");
  ctx.Equal(replay.Status, 200, "a replay of Idempotency-Key k-1");
  const auto body = nlohmann::json::parse(replay.Text(), nullptr, false);
  ctx.Assert(apiRequestId(replay) == apiRequestId(first) && body.is_object() && body.value("replayed", false),
             "the replay answered %s, expected the original request_id %s with replayed true", replay.Text(), apiRequestId(first));
  ctx.Equal(ctx.Redis.Keys("request:r-*").size(), 1, "two submits with one Idempotency-Key must store one request (a retry opened a second chain); the stored requests");
  const auto other = apiSubmit(c, kBody, "u-req", "t-globex", "k-1");
  ctx.Assert(other.Status == 201 && apiRequestId(other) != apiRequestId(first), "the same key from another tenant answered %d %s: keys are per tenant", other.Status, other.Text());
  ctx.Equal(apiSubmit(c, kBody, "u-req", "t-acme", "").Status, 400, "a submit without Idempotency-Key");
}
`,
  },
  debrief: `Every rule here protects the record an auditor reads later. The approvers come from the policy and the version is pinned because a chain is a statement about who had authority when the request was made; a caller-supplied list or a policy edit mid-flight would make that statement false. Self-approval is refused at resolution time, before anything is stored, so no half-made request exists to clean up. The key is read before the chain is resolved: a retry must find the first request, not compete with it. Production approval systems also expand group approvers and managers from a directory at that same moment, keep the idempotency record with an expiry, and apply separation-of-duties rules across chains, not just within one.`,
};
