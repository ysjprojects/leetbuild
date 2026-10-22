import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/requests: a chain the requester cannot shortcut',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'policy'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, stores
a request and answers with a request id, so the demo approves a spend request end to end. It also
lets the requester choose who signs off on them. Review it like the workflow owner, fix it, and
prove the fix with the checks below.

Implement \`POST /v1/requests\` with body
\`{"chain_id": "spend", "why": "new laptop", "amount_cents": 420000}\`. The body also carries an
\`approvers\` array — accept the field, never trust it.

- The tenant comes from \`X-Tenant-Id\` and the requester from \`X-User-Id\`; either missing is **401**.
- \`chain_id\` matches \`^[a-z0-9][a-z0-9_-]{1,31}$\` (**400** otherwise) — an unknown chain id is the
  policy store's answer, not a reason to invent a chain.
- \`why\` is a non-empty string of at most **4 KiB** (\`1 << 12\` bytes) of UTF-8; a larger one is
  **413**. The audit field is bounded, or it is not a field, it is a payload.
- Approvers are **resolved from the chain policy at submit time** and the chain definition
  **version is pinned** on the stored request (\`chain_version\`). Whatever the body says about
  approvers is discarded: \`approvers\` comes from the pinned version, never from the caller.
- **Self-approval is rejected at resolution time**: when the requester appears in the resolved
  chain the submit is **409** (\`requester_cannot_approve\`) and nothing is stored.
- \`Idempotency-Key\` is required (**400** when missing). A replay with the same \`(tenant, key)\`
  returns the **original** \`request_id\` with \`"replayed": true\` instead of creating a second
  request with its own chain.

**Failure mode the checks target.** Resolving approvers from the request body is the whole bug: a
requester names a friendly colleague — or themselves — and the chain becomes a formality that
approves whatever it is handed. The missing \`why\` cap turns the audit field into an unbounded blob
that outlives the request. And an un-keyed submit turns every client retry into a second request
with a second chain, so one spend is approved twice by two different sets of people.`,
  sequence: {
    participants: ['Client', 'Approval API', 'chain policy', 'request store'],
    messages: [
      {from: 'Client', to: 'Approval API', label: 'POST /v1/requests · X-Tenant-Id · X-User-Id', kind: 'sync'},
      {
        from: 'Approval API',
        to: 'Approval API',
        label: 'validate tenant · requester · chain id · why ≤ 4 KiB',
        kind: 'sync',
      },
      {from: 'Approval API', to: 'request store', label: 'get(tenant, Idempotency-Key)', kind: 'sync'},
      {from: 'request store', to: 'Approval API', label: 'stored request / none', kind: 'reply'},
      {from: 'Approval API', to: 'chain policy', label: 'chains.get(chain_id) · pin version', kind: 'sync'},
      {from: 'chain policy', to: 'Approval API', label: '{version, approvers}', kind: 'reply'},
      {from: 'Approval API', to: 'Approval API', label: 'requester in approvers → 409, nothing stored', kind: 'sync'},
      {from: 'Approval API', to: 'request store', label: 'put(tenant, key, request)', kind: 'async'},
      {from: 'Approval API', to: 'Client', label: '201 {request_id, chain_version, approvers}', kind: 'reply'},
    ],
  },
  hints: [
    'The `approvers` array in the body is a decoy: never read it. Resolve the chain from the policy store (`chains.get(chain_id)` → `{version, approvers}`) and store that version on the request, so a later policy edit cannot silently change who signs off on an in-flight request.',
    'Self-approval is a resolution-time check, not a later one: the moment you have the resolved approvers, ask whether the requester is one of them. Answering 409 before the store write is what makes “nothing was created” true.',
    'Idempotency is keyed by `(tenant, Idempotency-Key)` and looked up before resolution. Return the stored `request_id` with `"replayed": true`; minting a new id on a retry is what gives one spend two chains.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/requests',
      detail: 'Register the submit route on `POST /v1/requests`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/requests["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/requests['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/requests"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"requests"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/requests"/]},
      },
    },
    {
      id: 'policy-approvers',
      title: 'Resolves the approvers from the pinned chain policy',
      detail:
        'Approvers come from `resolve_approvers(chain_id)` — the policy store’s chain definition — and its `version` is pinned on the request as `chain_version`. The caller’s `approvers` array is never read.',
      match: {
        python: {all: [/resolve_approvers\(/, /chain_version/], none: [/body\.approvers/]},
        typescript: {all: [/resolveApprovers\(/, /chain_version/], none: [/body\.approvers/]},
        go: {all: [/resolveApprovers\(/, /chainVersion/], none: [/body\.Approvers/]},
        scala: {all: [/resolveApprovers\(/, /chainVersion/], none: [/body\.approvers/]},
        cpp: {all: [/resolve_approvers\(/, /chain_version/], none: [/body\["approvers"\]/]},
      },
    },
    {
      id: 'self-approval',
      title: 'Rejects a chain the requester appears in',
      detail:
        'When the requester is one of the resolved approvers, the submit is **409** with reason `requester_cannot_approve` and nothing is stored. The draft accepts whatever list it is given.',
      match: {
        python: {all: [/requester_cannot_approve/, /status_code\s*=\s*409/]},
        typescript: {all: [/requester_cannot_approve/, /code\(\s*409\s*\)/]},
        go: {all: [/requesterCannotApprove/, /StatusConflict/]},
        scala: {all: [/RequesterCannotApprove/, /StatusCodes\.Conflict/]},
        cpp: {all: [/requester_cannot_approve/, /\b409\b/]},
      },
    },
    {
      id: 'why-cap',
      title: 'Caps the why field at 4 KiB',
      detail:
        '`why` is measured in bytes against a 4 KiB (`1 << 12`) cap and answered with **413** when it is larger. The draft stores whatever length arrives.',
      match: {
        python: {all: [/MAX_WHY_BYTES/, /status_code\s*=\s*413/]},
        typescript: {all: [/MAX_WHY_BYTES/, /code\(\s*413\s*\)/]},
        go: {all: [/maxWhyBytes/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/MaxWhyBytes/, /StatusCodes\.RequestEntityTooLarge/]},
        cpp: {all: [/kMaxWhyBytes/, /\b413\b/]},
      },
    },
    {
      id: 'idempotency',
      title: 'Replays return the original request id',
      detail:
        '`Idempotency-Key` is required and the request is looked up under `(tenant, key)` before resolution; a replay answers with the stored `request_id` and `"replayed": true`. The draft ignores the header and mints a new request per call.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(/, /replayed/]},
        typescript: {all: [/idempotency-key/, /store\.get\(/, /replayed/]},
        go: {all: [/Idempotency-Key/, /store\.Get\(/, /replayed/]},
        scala: {all: [/Idempotency-Key/, /store\.get\(/, /replayed/]},
        cpp: {all: [/Idempotency-Key/, /store\.get\(/, /replayed/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class SubmitRequest(BaseModel):
    chain_id: str
    why: str
    amount_cents: int = 0
    approvers: list[str] = []


class Chains:
    def get(self, chain_id: str) -> dict:
        """The chain definition: {"version": int, "approvers": [actor ids]}."""
        raise NotImplementedError


class RequestStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The request stored under (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, request: dict) -> None:
        """Store the request under (tenant, idem_key)."""
        raise NotImplementedError


chains = Chains()
store = RequestStore()


@app.post("/v1/requests")
def submit(
    body: SubmitRequest,
    tenant: str = Header(alias="X-Tenant-Id"),
    requester: str = Header(alias="X-User-Id"),
) -> JSONResponse:
    # TODO: this draft takes the approvers from the request body, never resolves the chain from
    # policy, never rejects a chain the requester appears in, ignores Idempotency-Key, and never
    # caps the why field. Review all four.
    request_id = str(uuid.uuid4())
    request = {
        "request_id": request_id,
        "tenant": tenant,
        "requester": requester,
        "chain_id": body.chain_id,
        "approvers": body.approvers,
        "why": body.why,
    }
    store.put(tenant, request_id, request)
    return JSONResponse({"request_id": request_id, "approvers": body.approvers}, status_code=201)
`,
      solution: `import re
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

CHAIN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,31}$")
MAX_WHY_BYTES = 1 << 12


class SubmitRequest(BaseModel):
    chain_id: str
    why: str
    amount_cents: int = 0
    approvers: list[str] = []


class Chains:
    def get(self, chain_id: str) -> dict:
        """The chain definition: {"version": int, "approvers": [actor ids]}."""
        raise NotImplementedError


class RequestStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The request stored under (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, request: dict) -> None:
        """Store the request under (tenant, idem_key)."""
        raise NotImplementedError


chains = Chains()
store = RequestStore()


def resolve_approvers(chain_id: str) -> tuple[int, list[str]]:
    """The approvers of the pinned chain version, resolved at submit time."""
    chain = chains.get(chain_id)
    return int(chain["version"]), list(chain["approvers"])


@app.post("/v1/requests")
def submit(
    body: SubmitRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    requester: str | None = Header(default=None, alias="X-User-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if requester is None or requester == "":
        raise HTTPException(status_code=401, detail="missing X-User-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if not CHAIN_ID_RE.match(body.chain_id):
        raise HTTPException(status_code=400, detail="invalid chain_id")
    if body.why == "":
        raise HTTPException(status_code=400, detail="why must be a non-empty string")
    why_bytes = len(body.why.encode("utf-8"))
    if why_bytes > MAX_WHY_BYTES:
        raise HTTPException(status_code=413, detail="why exceeds 4 KiB")

    stored = store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse({"request_id": stored["request_id"], "replayed": True}, status_code=200)

    # The caller's approvers are the one field of the body this endpoint never reads.
    chain_version, approvers = resolve_approvers(body.chain_id)
    if requester in approvers:
        raise HTTPException(status_code=409, detail="requester_cannot_approve")

    request = {
        "request_id": str(uuid.uuid4()),
        "tenant": tenant,
        "requester": requester,
        "chain_id": body.chain_id,
        "chain_version": chain_version,
        "approvers": approvers,
        "why_bytes": why_bytes,
    }
    store.put(tenant, idem_key, request)
    return JSONResponse({"request_id": request["request_id"], "chain_version": chain_version}, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/requests: a model-generated draft that takes the approvers from the body. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

export interface ChainDefinition {
  version: number;
  approvers: string[];
}

export interface StoredRequest {
  request_id: string;
  tenant: string;
  requester: string;
  chain_id: string;
  approvers: string[];
}

interface SubmitBody {
  chain_id: string;
  why: string;
  amount_cents?: number;
  approvers?: string[];
}

export const chains = {
  async get(chainId: string): Promise<ChainDefinition> {
    throw new Error(\`chains.get(\${chainId}) is not wired up\`);
  },
};

export const store = {
  async get(tenant: string, idemKey: string): Promise<StoredRequest | null> {
    throw new Error(\`store.get(\${tenant}, \${idemKey}) is not wired up\`);
  },
  async put(tenant: string, idemKey: string, request: StoredRequest): Promise<void> {
    throw new Error(\`store.put(\${tenant}, \${idemKey}) is not wired up\`);
  },
};

app.post('/v1/requests', async (request, reply) => {
  // TODO: this draft takes the approvers from the request body, never resolves the chain from
  // policy, never rejects a chain the requester appears in, ignores Idempotency-Key, and never
  // caps the why field. Review all four.
  const tenant = request.headers['x-tenant-id'] as string;
  const requester = request.headers['x-user-id'] as string;
  const body = request.body as SubmitBody;
  const stored: StoredRequest = {
    request_id: randomUUID(),
    tenant,
    requester,
    chain_id: body.chain_id,
    approvers: body.approvers ?? [],
  };
  await store.put(tenant, stored.request_id, stored);
  return reply.code(201).send({request_id: stored.request_id, approvers: stored.approvers});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/requests: resolve the chain from the pinned policy, never from the caller. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const CHAIN_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const MAX_WHY_BYTES = 1 << 12;

export interface ChainDefinition {
  version: number;
  approvers: string[];
}

export interface StoredRequest {
  request_id: string;
  tenant: string;
  requester: string;
  chain_id: string;
  chain_version: number;
  approvers: string[];
}

interface SubmitBody {
  chain_id: string;
  why: string;
  amount_cents?: number;
  approvers?: string[];
}

export const chains = {
  async get(chainId: string): Promise<ChainDefinition> {
    throw new Error(\`chains.get(\${chainId}) is not wired up\`);
  },
};

export const store = {
  async get(tenant: string, idemKey: string): Promise<StoredRequest | null> {
    throw new Error(\`store.get(\${tenant}, \${idemKey}) is not wired up\`);
  },
  async put(tenant: string, idemKey: string, request: StoredRequest): Promise<void> {
    throw new Error(\`store.put(\${tenant}, \${idemKey}) is not wired up\`);
  },
};

/** The approvers of the pinned chain version, resolved at submit time. */
async function resolveApprovers(chainId: string): Promise<[number, string[]]> {
  const chain = await chains.get(chainId);
  return [chain.version, [...chain.approvers]];
}

app.post('/v1/requests', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const requester = request.headers['x-user-id'];
  if (typeof requester !== 'string' || requester === '')
    return reply.code(401).send({error: 'missing X-User-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<SubmitBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.chain_id !== 'string')
    return reply.code(400).send({error: 'chain_id is required'});
  if (!CHAIN_ID_RE.test(body.chain_id)) return reply.code(400).send({error: 'invalid chain_id'});
  if (typeof body.why !== 'string' || body.why === '')
    return reply.code(400).send({error: 'why must be a non-empty string'});
  const whyBytes = Buffer.byteLength(body.why, 'utf8');
  if (whyBytes > MAX_WHY_BYTES) return reply.code(413).send({error: 'why exceeds 4 KiB'});

  const stored = await store.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send({request_id: stored.request_id, replayed: true});

  // The caller's approvers are the one field of the body this endpoint never reads.
  const [chainVersion, approvers] = await resolveApprovers(body.chain_id);
  if (approvers.includes(requester))
    return reply.code(409).send({error: 'requester_cannot_approve'});

  const created: StoredRequest = {
    request_id: randomUUID(),
    tenant,
    requester,
    chain_id: body.chain_id,
    chain_version: chainVersion,
    approvers,
  };
  await store.put(tenant, idemKey, created);
  return reply.code(201).send({request_id: created.request_id, chain_version: chainVersion});
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

	"github.com/google/uuid"
)

type SubmitRequest struct {
	ChainID    string   \`json:"chain_id"\`
	Why        string   \`json:"why"\`
	AmountCents int64   \`json:"amount_cents"\`
	Approvers  []string \`json:"approvers"\`
}

type Chains struct{}

func (c *Chains) Get(ctx context.Context, chainID string) (map[string]any, error) { return nil, nil }

type RequestStore struct{}

func (s *RequestStore) Get(ctx context.Context, tenant, idemKey string) (map[string]any, error) {
	return nil, nil
}

func (s *RequestStore) Put(ctx context.Context, tenant, idemKey string, request map[string]any) error {
	return nil
}

var (
	chains = &Chains{}
	store  = &RequestStore{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func submit(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft takes the approvers from the request body, never resolves the chain from
	// policy, never rejects a chain the requester appears in, ignores Idempotency-Key, and never
	// caps the why field. Review all four.
	tenant := r.Header.Get("X-Tenant-Id")
	requester := r.Header.Get("X-User-Id")
	var body SubmitRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	requestID := uuid.NewString()
	request := map[string]any{
		"request_id": requestID,
		"tenant":     tenant,
		"requester":  requester,
		"chain_id":   body.ChainID,
		"approvers":  body.Approvers,
	}
	if err := store.Put(r.Context(), tenant, requestID, request); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]any{"request_id": requestID, "approvers": body.Approvers})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/requests", submit)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"regexp"

	"github.com/google/uuid"
)

const maxWhyBytes = 1 << 12

const requesterCannotApprove = "requester_cannot_approve"

var chainIDRe = regexp.MustCompile(\`^[a-z0-9][a-z0-9_-]{1,31}$\`)

type SubmitRequest struct {
	ChainID     string   \`json:"chain_id"\`
	Why         string   \`json:"why"\`
	AmountCents int64    \`json:"amount_cents"\`
	Approvers   []string \`json:"approvers"\`
}

type Chains struct{}

func (c *Chains) Get(ctx context.Context, chainID string) (map[string]any, error) { return nil, nil }

type RequestStore struct{}

func (s *RequestStore) Get(ctx context.Context, tenant, idemKey string) (map[string]any, error) {
	return nil, nil
}

func (s *RequestStore) Put(ctx context.Context, tenant, idemKey string, request map[string]any) error {
	return nil
}

var (
	chains = &Chains{}
	store  = &RequestStore{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// resolveApprovers returns the approvers of the pinned chain version.
func resolveApprovers(ctx context.Context, chainID string) (int, []string) {
	chain, _ := chains.Get(ctx, chainID)
	version, _ := chain["version"].(float64)
	raw, _ := chain["approvers"].([]any)
	approvers := make([]string, 0, len(raw))
	for _, a := range raw {
		approvers = append(approvers, a.(string))
	}
	return int(version), approvers
}

func submit(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	requester := r.Header.Get("X-User-Id")
	if requester == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-User-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body SubmitRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if !chainIDRe.MatchString(body.ChainID) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid chain_id"})
		return
	}
	if body.Why == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "why must be a non-empty string"})
		return
	}
	if len([]byte(body.Why)) > maxWhyBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "why exceeds 4 KiB"})
		return
	}
	stored, err := store.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, map[string]any{"request_id": stored["request_id"], "replayed": true})
		return
	}

	// The caller's approvers are the one field of the body this endpoint never reads.
	chainVersion, approvers := resolveApprovers(r.Context(), body.ChainID)
	for _, a := range approvers {
		if a == requester {
			writeJSON(rw, http.StatusConflict, map[string]string{"error": requesterCannotApprove})
			return
		}
	}
	requestID := uuid.NewString()
	request := map[string]any{
		"request_id":    requestID,
		"tenant":        tenant,
		"requester":     requester,
		"chain_id":      body.ChainID,
		"chain_version": chainVersion,
		"approvers":     approvers,
	}
	if err := store.Put(r.Context(), tenant, idemKey, request); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]any{"request_id": requestID, "chain_version": chainVersion})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/requests", submit)
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

import java.util.UUID

final case class SubmitRequest(chain_id: String, why: String, amount_cents: Long, approvers: List[String])
final case class ChainDefinition(version: Int, approvers: List[String])
final case class StoredRequest(
    request_id: String,
    tenant: String,
    requester: String,
    chain_id: String,
    approvers: List[String]
)

object Api {
  implicit val system: ActorSystem = ActorSystem("approval-workflow")
  implicit val submitFormat: RootJsonFormat[SubmitRequest] = jsonFormat4(SubmitRequest)
  implicit val storedFormat: RootJsonFormat[StoredRequest] = jsonFormat5(StoredRequest)

  class Chains {
    def get(chainId: String): ChainDefinition = throw new NotImplementedError("chains.get")
  }

  class RequestStore {
    def get(tenant: String, idemKey: String): Option[StoredRequest] = throw new NotImplementedError("store.get")
    def put(tenant: String, idemKey: String, request: StoredRequest): Unit = throw new NotImplementedError("store.put")
  }

  val chains = new Chains
  val store = new RequestStore

  val route: Route =
    path("v1" / "requests") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          headerValueByName("X-User-Id") { requester =>
            entity(as[SubmitRequest]) { body =>
              // TODO: this draft takes the approvers from the request body, never resolves the chain
              // from policy, never rejects a chain the requester appears in, ignores
              // Idempotency-Key, and never caps the why field. Review all four.
              val request = StoredRequest(UUID.randomUUID().toString, tenant, requester, body.chain_id, body.approvers)
              store.put(tenant, request.request_id, request)
              complete(StatusCodes.Created, request)
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
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import java.nio.charset.StandardCharsets
import java.util.UUID

final case class SubmitRequest(chain_id: String, why: String, amount_cents: Long, approvers: List[String])
final case class ChainDefinition(version: Int, approvers: List[String])
final case class StoredRequest(
    request_id: String,
    tenant: String,
    requester: String,
    chain_id: String,
    chain_version: Int,
    approvers: List[String]
)

object Api {
  implicit val system: ActorSystem = ActorSystem("approval-workflow")
  implicit val submitFormat: RootJsonFormat[SubmitRequest] = jsonFormat4(SubmitRequest)
  implicit val storedFormat: RootJsonFormat[StoredRequest] = jsonFormat6(StoredRequest)

  val ChainIdRe = "^[a-z0-9][a-z0-9_-]{1,31}$".r
  val MaxWhyBytes = 1 << 12
  val RequesterCannotApprove = "requester_cannot_approve"

  class Chains {
    def get(chainId: String): ChainDefinition = throw new NotImplementedError("chains.get")
  }

  class RequestStore {
    def get(tenant: String, idemKey: String): Option[StoredRequest] = throw new NotImplementedError("store.get")
    def put(tenant: String, idemKey: String, request: StoredRequest): Unit = throw new NotImplementedError("store.put")
  }

  val chains = new Chains
  val store = new RequestStore

  /** The approvers of the pinned chain version, resolved at submit time. */
  def resolveApprovers(chainId: String): (Int, List[String]) = {
    val chain = chains.get(chainId)
    (chain.version, chain.approvers)
  }

  val route: Route =
    path("v1" / "requests") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("X-User-Id") { requesterOpt =>
            optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
              entity(as[SubmitRequest]) { body =>
                if (!tenantOpt.exists(_.nonEmpty)) {
                  complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
                } else if (!requesterOpt.exists(_.nonEmpty)) {
                  complete(StatusCodes.Unauthorized, """{"error":"missing X-User-Id"}""")
                } else if (!idemOpt.exists(_.nonEmpty)) {
                  complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
                } else if (ChainIdRe.findFirstIn(body.chain_id).isEmpty) {
                  complete(StatusCodes.BadRequest, """{"error":"invalid chain_id"}""")
                } else if (body.why.isEmpty) {
                  complete(StatusCodes.BadRequest, """{"error":"why must be a non-empty string"}""")
                } else if (body.why.getBytes(StandardCharsets.UTF_8).length > MaxWhyBytes) {
                  complete(StatusCodes.RequestEntityTooLarge, """{"error":"why exceeds 4 KiB"}""")
                } else {
                  val tenant = tenantOpt.get
                  val requester = requesterOpt.get
                  val idemKey = idemOpt.get
                  store.get(tenant, idemKey) match {
                    case Some(stored) =>
                      complete(StatusCodes.OK, s"""{"request_id":"\${stored.request_id}","replayed":true}""")
                    case None =>
                      // The caller's approvers are the one field of the body this endpoint never reads.
                      val (chainVersion, approvers) = resolveApprovers(body.chain_id)
                      if (approvers.contains(requester)) {
                        complete(StatusCodes.Conflict, s"""{"error":"$RequesterCannotApprove"}""")
                      } else {
                        val request =
                          StoredRequest(UUID.randomUUID().toString, tenant, requester, body.chain_id, chainVersion, approvers)
                        store.put(tenant, idemKey, request)
                        complete(
                          StatusCodes.Created,
                          s"""{"request_id":"\${request.request_id}","chain_version":$chainVersion}"""
                        )
                      }
                  }
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

#include <string>
#include <vector>

using json = nlohmann::json;

struct Chains {
  std::optional<json> get(const std::string& chainId);
};

struct RequestStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& request);
};

Chains chains;
RequestStore store;
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/requests", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft takes the approvers from the request body, never resolves the chain from
    // policy, never rejects a chain the requester appears in, ignores Idempotency-Key, and never
    // caps the why field. Review all four.
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto requester = req.get_header_value("X-User-Id");
    const json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto requestId = uuidString();
    const json request = {
        {"request_id", requestId},
        {"tenant", tenant},
        {"requester", requester},
        {"chain_id", body.value("chain_id", std::string())},
        {"approvers", body.value("approvers", std::vector<std::string>())},
    };
    store.put(tenant, requestId, request);
    res.status = 201;
    res.set_content(json{{"request_id", requestId}, {"approvers", request["approvers"]}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <regex>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxWhyBytes = 1 << 12;
const std::regex kChainIdRe("^[a-z0-9][a-z0-9_-]{1,31}$");

struct Chains {
  std::optional<json> get(const std::string& chainId);
};

struct RequestStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& request);
};

Chains chains;
RequestStore store;
std::string uuidString();

/** The approvers of the pinned chain version, resolved at submit time. */
std::pair<int, std::vector<std::string>> resolve_approvers(const std::string& chainId) {
  const auto chain = chains.get(chainId);
  if (!chain) return {0, {}};
  return {chain->value("version", 0), chain->value("approvers", std::vector<std::string>{})};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/requests", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto requester = req.get_header_value("X-User-Id");
    if (requester.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-User-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    const json body = json::parse(req.body, nullptr, false);
    const auto chainId = body.is_object() ? body.value("chain_id", std::string()) : std::string();
    if (!std::regex_match(chainId, kChainIdRe)) {
      res.status = 400;
      res.set_content(R"({"error":"invalid chain_id"})", "application/json");
      return;
    }
    const auto why = body.value("why", std::string());
    if (why.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"why must be a non-empty string"})", "application/json");
      return;
    }
    if (why.size() > kMaxWhyBytes) {
      res.status = 413;
      res.set_content(R"({"error":"why exceeds 4 KiB"})", "application/json");
      return;
    }
    const auto stored = store.get(tenant, idemKey);
    if (stored) {
      res.status = 200;
      res.set_content(json{{"request_id", (*stored)["request_id"]}, {"replayed", true}}.dump(), "application/json");
      return;
    }

    // The caller's approvers are the one field of the body this endpoint never reads.
    const auto [chainVersion, approvers] = resolve_approvers(chainId);
    for (const auto& approver : approvers) {
      if (approver == requester) {
        res.status = 409;
        res.set_content(R"({"error":"requester_cannot_approve"})", "application/json");
        return;
      }
    }
    const auto requestId = uuidString();
    const json request = {
        {"request_id", requestId},
        {"tenant", tenant},
        {"requester", requester},
        {"chain_id", chainId},
        {"chain_version", chainVersion},
        {"approvers", approvers},
    };
    store.put(tenant, idemKey, request);
    res.status = 201;
    res.set_content(json{{"request_id", requestId}, {"chain_version", chainVersion}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing the trust boundary of a submit endpoint: what the caller may influence and what only the system may decide. The draft reads fine because the demo posts its own approvers and nobody retries. Four defects are being checked: the approver list comes from the pinned chain policy, never the body (a requester who names their own approver, or themselves, is the whole incident); self-approval is rejected at resolution time, before anything is stored; the audit \`why\` field is bounded to 4 KiB so it cannot be used as a payload; and the submit is idempotent under \`(tenant, Idempotency-Key)\` so a client retry returns the original request id instead of a second chain. Real workflows add the pinned version's hash to the event trail, expire unused idempotency keys, and resolve approvers by role with a directory lookup rather than an actor id list.`,
};
