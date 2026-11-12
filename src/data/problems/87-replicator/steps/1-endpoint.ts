import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/replications: an approved pair and a frozen conflict policy',
  concept: 'http',
  guides: ['request-boundaries'],
  file: 'api',
  focus: ['client', 'api', 'store'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/replications\` with body \`{source_region,
target_region, shards, conflict_policy}\`: it requires \`X-Operator-Id\` (401), bounds the shard set, and
stores the replication with \`store.create\`. \`PATCH /v1/replications/{id}\` \`{conflict_policy}\` writes
the policy with \`store.set_policy\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A typo copies a tenant's data into a region nobody approved; a
request without a policy silently gets last-write-wins; last-write-wins is accepted while the two
clocks disagree by seconds; and a \`PATCH\` changes the policy of a running replication, so rows merged
under the old rule stay as they were.

- \`(source_region, target_region)\` must be in \`APPROVED_REGION_PAIRS\` (the pair is ordered); any
  other pair is **400** and nothing is stored.
- \`conflict_policy\` is required and one of \`CONFLICT_POLICIES\` (\`source-wins\`, \`version-vector\`,
  \`manual\`, \`last-write-wins\`); absent or unknown is **400**.
- \`last-write-wins\` orders writes by wall clock: refuse it with **400** when
  \`regions.clock_skew_ms(source, target)\` exceeds \`SKEW_BOUND_MS\` (250).
- The policy is frozen: a \`PATCH\` with another policy is **409** naming the policy immutable; the same
  policy answers the replication unchanged.`,
  sequence: {
    participants: ['Operator', 'replicatord', 'Region clocks', 'replications store'],
    messages: [
      {from: 'Operator', to: 'replicatord', label: 'POST /v1/replications · X-Operator-Id', kind: 'sync'},
      {from: 'replicatord', to: 'replicatord', label: 'APPROVED_REGION_PAIRS · CONFLICT_POLICIES → 400', kind: 'sync'},
      {
        from: 'replicatord',
        to: 'Region clocks',
        label: 'clock_skew_ms(source, target) if last-write-wins',
        kind: 'sync',
      },
      {from: 'Region clocks', to: 'replicatord', label: 'skew ms > SKEW_BOUND_MS → 400', kind: 'reply'},
      {from: 'replicatord', to: 'replications store', label: 'create(owner, pair, shards, policy)', kind: 'sync'},
      {from: 'replicatord', to: 'Operator', label: '201 {id, conflict_policy, shards}', kind: 'reply'},
      {from: 'Operator', to: 'replicatord', label: 'PATCH {conflict_policy} → 409 when it differs', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers the create and policy routes',
      detail: 'Register `POST /v1/replications` and `PATCH /v1/replications/{id}`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/replications["']/, /@app\.patch\(\s*["']\/v1\/replications\/\{/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/replications['"]/, /app\.patch\(\s*['"]\/v1\/replications\/:/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/replications"/, /HandleFunc\(\s*"PATCH \/v1\/replications\/\{/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"replications"\s*\)/, /\bpatch\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/replications"/, /svr\.Patch\(/]},
      },
    },
    {
      id: 'approved-regions',
      title: 'Only an approved ordered region pair starts a replication',
      detail:
        'The ordered pair `(source_region, target_region)` is looked up in the approved set before anything is stored; any other pair is **400**.',
      match: {
        python: {all: [/APPROVED_REGION_PAIRS\s*=/, /not in APPROVED_REGION_PAIRS/]},
        typescript: {
          all: [/APPROVED_REGION_PAIRS\s*[:=]/, /APPROVED_REGION_PAIRS\[|APPROVED_REGION_PAIRS\.(has|includes)\(/],
        },
        go: {all: [/approvedRegionPairs\s*=/, /approvedRegionPairs\[/]},
        scala: {all: [/ApprovedRegionPairs\s*[:=]/, /ApprovedRegionPairs\.contains\(/]},
        cpp: {all: [/kApprovedRegionPairs\s*=/, /kApprovedRegionPairs\.(count|contains)\(/]},
      },
    },
    {
      id: 'conflict-policy',
      title: 'The conflict policy is required and comes from the documented set',
      detail:
        '`conflict_policy` is checked against `CONFLICT_POLICIES` and an absent or unknown one is **400**; nothing defaults it to `last-write-wins`.',
      match: {
        python: {all: [/CONFLICT_POLICIES\s*=/, /not in CONFLICT_POLICIES/], none: [/or\s*["']last-write-wins["']/]},
        typescript: {
          all: [/CONFLICT_POLICIES\s*=/, /CONFLICT_POLICIES\.includes\(/],
          none: [/\?\?\s*'last-write-wins'/],
        },
        go: {all: [/conflictPolicies\s*=/, /conflictPolicies\[/], none: [/policy\s*=\s*"last-write-wins"/]},
        scala: {
          all: [/ConflictPolicies\s*[:=]/, /ConflictPolicies\.contains\(/],
          none: [/getOrElse\(\s*"last-write-wins"\s*\)/],
        },
        cpp: {
          all: [/kConflictPolicies\s*=/, /kConflictPolicies\.(count|contains)\(/],
          none: [/"conflict_policy",\s*"last-write-wins"\)/],
        },
      },
    },
    {
      id: 'skew-bound',
      title: 'Last-write-wins is refused when the clocks disagree',
      detail:
        'For `last-write-wins` the measured skew (`clock_skew_ms`/`clockSkewMs`) is compared with `SKEW_BOUND_MS` (250 ms) and a larger skew is **400**.',
      match: {
        python: {all: [/SKEW_BOUND_MS\s*=\s*250/, /regions\.clock_skew_ms\(/]},
        typescript: {all: [/SKEW_BOUND_MS\s*=\s*250/, /clockSkewMs\(/]},
        go: {all: [/skewBoundMS\s*=\s*250/, /regions\.ClockSkewMS\(/]},
        scala: {all: [/SkewBoundMs\s*=\s*250/, /Regions\.clockSkewMs\(/]},
        cpp: {all: [/kSkewBoundMs\s*=\s*250/, /regions::clockSkewMs\(/]},
      },
    },
    {
      id: 'policy-immutable',
      title: 'The conflict policy is frozen once the replication exists',
      detail:
        '`PATCH` compares the requested policy with the stored one and answers **409** (`immutable`) when they differ; it never rewrites the policy (`set_policy`/`setPolicy`).',
      match: {
        python: {all: [/\b409\b/, /immutable/], none: [/store\.set_policy\(/]},
        typescript: {all: [/\b409\b/, /immutable/], none: [/setPolicy\(/]},
        go: {all: [/StatusConflict|\b409\b/, /immutable/], none: [/store\.SetPolicy\(/]},
        scala: {all: [/StatusCodes\.Conflict/, /immutable/], none: [/Store\.setPolicy\(/]},
        cpp: {all: [/\b409\b/, /immutable/], none: [/store::setPolicy\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from replication import regions, store  # store.create, get, set_policy · regions.clock_skew_ms

app = FastAPI()

MAX_SHARDS = 64


class ReplicationRequest(BaseModel):
    source_region: str
    target_region: str
    shards: list[int]
    conflict_policy: str | None = None


class PolicyUpdate(BaseModel):
    conflict_policy: str


def operator_of(request: Request) -> str:
    operator = request.headers.get("x-operator-id", "")
    if not operator:
        raise HTTPException(status_code=401, detail="X-Operator-Id is required")
    return operator


@app.post("/v1/replications", status_code=201)
def create_replication(body: ReplicationRequest, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    operator = operator_of(request)
    if not body.shards or len(body.shards) > MAX_SHARDS or len(set(body.shards)) != len(body.shards):
        raise HTTPException(status_code=400, detail="shards must be 1 to 64 distinct shard ids")
    policy = body.conflict_policy or "last-write-wins"
    return store.create(operator, body.source_region, body.target_region, body.shards, policy)


@app.patch("/v1/replications/{replication_id}")
def update_policy(replication_id: str, body: PolicyUpdate, request: Request) -> dict:
    operator = operator_of(request)
    replication = store.get(replication_id)
    if replication is None or replication["owner"] != operator:
        raise HTTPException(status_code=404, detail="no such replication")
    return store.set_policy(replication_id, body.conflict_policy)
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from replication import regions, store  # store.create, get, set_policy · regions.clock_skew_ms

app = FastAPI()

MAX_SHARDS = 64
# The ordered pairs the platform replicates between: a pair is approved one direction at a time.
APPROVED_REGION_PAIRS = {("us-east-1", "eu-west-1"), ("eu-west-1", "us-east-1"), ("us-east-1", "us-west-2")}
CONFLICT_POLICIES = ("source-wins", "version-vector", "manual", "last-write-wins")
# The largest clock difference under which ordering writes by wall clock is still defensible.
SKEW_BOUND_MS = 250


class ReplicationRequest(BaseModel):
    source_region: str
    target_region: str
    shards: list[int]
    conflict_policy: str | None = None


class PolicyUpdate(BaseModel):
    conflict_policy: str


def operator_of(request: Request) -> str:
    operator = request.headers.get("x-operator-id", "")
    if not operator:
        raise HTTPException(status_code=401, detail="X-Operator-Id is required")
    return operator


@app.post("/v1/replications", status_code=201)
def create_replication(body: ReplicationRequest, request: Request) -> dict:
    operator = operator_of(request)
    if (body.source_region, body.target_region) not in APPROVED_REGION_PAIRS:
        raise HTTPException(status_code=400, detail="the region pair is not approved")
    if body.conflict_policy not in CONFLICT_POLICIES:
        raise HTTPException(status_code=400, detail=f"conflict_policy must be one of {', '.join(CONFLICT_POLICIES)}")
    if body.conflict_policy == "last-write-wins":
        skew = regions.clock_skew_ms(body.source_region, body.target_region)
        if skew > SKEW_BOUND_MS:
            raise HTTPException(status_code=400, detail=f"clock skew {skew} ms exceeds SKEW_BOUND_MS: last-write-wins is unsound")
    if not body.shards or len(body.shards) > MAX_SHARDS or len(set(body.shards)) != len(body.shards):
        raise HTTPException(status_code=400, detail="shards must be 1 to 64 distinct shard ids")
    return store.create(operator, body.source_region, body.target_region, body.shards, body.conflict_policy)


@app.patch("/v1/replications/{replication_id}")
def update_policy(replication_id: str, body: PolicyUpdate, request: Request) -> dict:
    operator = operator_of(request)
    replication = store.get(replication_id)
    if replication is None or replication["owner"] != operator:
        raise HTTPException(status_code=404, detail="no such replication")
    if body.conflict_policy != replication["conflict_policy"]:
        # Rows already merged under the recorded policy stay consistent only if the policy stays.
        raise HTTPException(status_code=409, detail="conflict_policy is immutable once the replication exists")
    return replication
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import * as regions from 'replication/regions'; // regions.clockSkewMs
import * as store from 'replication/store'; // store.create, get, setPolicy

export const app = Fastify();

const MAX_SHARDS = 64;

interface ReplicationRequest {
  source_region: string;
  target_region: string;
  shards: number[];
  conflict_policy?: string;
}

const operatorOf = (headers: Record<string, unknown>): string | null => {
  const operator = headers['x-operator-id'];
  return typeof operator === 'string' && operator !== '' ? operator : null;
};

app.post('/v1/replications', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const operator = operatorOf(request.headers);
  if (operator === null) return reply.code(401).send({error: 'X-Operator-Id is required'});
  const body = request.body as ReplicationRequest;
  const shards = body.shards ?? [];
  if (shards.length === 0 || shards.length > MAX_SHARDS || new Set(shards).size !== shards.length) {
    return reply.code(400).send({error: 'shards must be 1 to 64 distinct shard ids'});
  }
  const policy = body.conflict_policy ?? 'last-write-wins';
  return reply.code(201).send(await store.create(operator, body.source_region, body.target_region, shards, policy));
});

app.patch('/v1/replications/:id', async (request, reply) => {
  const operator = operatorOf(request.headers);
  if (operator === null) return reply.code(401).send({error: 'X-Operator-Id is required'});
  const {id} = request.params as {id: string};
  const replication = await store.get(id);
  if (replication === null || replication.owner !== operator) return reply.code(404).send({error: 'no such replication'});
  const {conflict_policy} = request.body as {conflict_policy: string};
  return store.setPolicy(id, conflict_policy);
});
`,
      solution: `import Fastify from 'fastify';

import * as regions from 'replication/regions'; // regions.clockSkewMs
import * as store from 'replication/store'; // store.create, get, setPolicy

export const app = Fastify();

const MAX_SHARDS = 64;
// The ordered pairs the platform replicates between: a pair is approved one direction at a time.
const APPROVED_REGION_PAIRS: Record<string, true> = {'us-east-1>eu-west-1': true, 'eu-west-1>us-east-1': true, 'us-east-1>us-west-2': true};
const CONFLICT_POLICIES = ['source-wins', 'version-vector', 'manual', 'last-write-wins'];
// The largest clock difference under which ordering writes by wall clock is still defensible.
const SKEW_BOUND_MS = 250;

interface ReplicationRequest {
  source_region: string;
  target_region: string;
  shards: number[];
  conflict_policy?: string;
}

const operatorOf = (headers: Record<string, unknown>): string | null => {
  const operator = headers['x-operator-id'];
  return typeof operator === 'string' && operator !== '' ? operator : null;
};

app.post('/v1/replications', async (request, reply) => {
  const operator = operatorOf(request.headers);
  if (operator === null) return reply.code(401).send({error: 'X-Operator-Id is required'});
  const body = request.body as ReplicationRequest;
  if (APPROVED_REGION_PAIRS[\`\${body.source_region}>\${body.target_region}\`] !== true) {
    return reply.code(400).send({error: 'the region pair is not approved'});
  }
  const policy = body.conflict_policy;
  if (policy === undefined || !CONFLICT_POLICIES.includes(policy)) {
    return reply.code(400).send({error: \`conflict_policy must be one of \${CONFLICT_POLICIES.join(', ')}\`});
  }
  if (policy === 'last-write-wins') {
    const skew = await regions.clockSkewMs(body.source_region, body.target_region);
    if (skew > SKEW_BOUND_MS) return reply.code(400).send({error: \`clock skew \${skew} ms exceeds SKEW_BOUND_MS: last-write-wins is unsound\`});
  }
  const shards = body.shards ?? [];
  if (shards.length === 0 || shards.length > MAX_SHARDS || new Set(shards).size !== shards.length) {
    return reply.code(400).send({error: 'shards must be 1 to 64 distinct shard ids'});
  }
  return reply.code(201).send(await store.create(operator, body.source_region, body.target_region, shards, policy));
});

app.patch('/v1/replications/:id', async (request, reply) => {
  const operator = operatorOf(request.headers);
  if (operator === null) return reply.code(401).send({error: 'X-Operator-Id is required'});
  const {id} = request.params as {id: string};
  const replication = await store.get(id);
  if (replication === null || replication.owner !== operator) return reply.code(404).send({error: 'no such replication'});
  const {conflict_policy} = request.body as {conflict_policy: string};
  if (conflict_policy !== replication.conflict_policy) {
    // Rows already merged under the recorded policy stay consistent only if the policy stays.
    return reply.code(409).send({error: 'conflict_policy is immutable once the replication exists'});
  }
  return replication;
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"replication/regions" // regions.ClockSkewMS
	"replication/store"   // store.Create, Get, SetPolicy
)

const maxShards = 64

type replicationRequest struct {
	SourceRegion   string \`json:"source_region"\`
	TargetRegion   string \`json:"target_region"\`
	Shards         []int  \`json:"shards"\`
	ConflictPolicy string \`json:"conflict_policy"\`
}

var _ = regions.ClockSkewMS

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func distinct(shards []int) bool {
	seen := map[int]bool{}
	for _, shard := range shards {
		if seen[shard] {
			return false
		}
		seen[shard] = true
	}
	return true
}

func createReplication(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	operator := r.Header.Get("X-Operator-Id")
	if operator == "" {
		http.Error(rw, "X-Operator-Id is required", http.StatusUnauthorized)
		return
	}
	var body replicationRequest
	json.NewDecoder(r.Body).Decode(&body)
	if len(body.Shards) == 0 || len(body.Shards) > maxShards || !distinct(body.Shards) {
		http.Error(rw, "shards must be 1 to 64 distinct shard ids", http.StatusBadRequest)
		return
	}
	policy := body.ConflictPolicy
	if policy == "" {
		policy = "last-write-wins"
	}
	replication, err := store.Create(r.Context(), operator, body.SourceRegion, body.TargetRegion, body.Shards, policy)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusCreated, replication)
}

func updatePolicy(rw http.ResponseWriter, r *http.Request) {
	operator := r.Header.Get("X-Operator-Id")
	if operator == "" {
		http.Error(rw, "X-Operator-Id is required", http.StatusUnauthorized)
		return
	}
	replication, err := store.Get(r.Context(), r.PathValue("id"))
	if err != nil || replication == nil || replication.Owner != operator {
		http.Error(rw, "no such replication", http.StatusNotFound)
		return
	}
	var body struct {
		ConflictPolicy string \`json:"conflict_policy"\`
	}
	json.NewDecoder(r.Body).Decode(&body)
	updated, err := store.SetPolicy(r.Context(), replication.ID, body.ConflictPolicy)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusOK, updated)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/replications", createReplication)
	mux.HandleFunc("PATCH /v1/replications/{id}", updatePolicy)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	"replication/regions" // regions.ClockSkewMS
	"replication/store"   // store.Create, Get, SetPolicy
)

const maxShards = 64

// approvedRegionPairs are the ordered pairs the platform replicates between: a pair is approved one direction at a time.
var approvedRegionPairs = map[[2]string]bool{
	{"us-east-1", "eu-west-1"}: true,
	{"eu-west-1", "us-east-1"}: true,
	{"us-east-1", "us-west-2"}: true,
}

var conflictPolicies = map[string]bool{"source-wins": true, "version-vector": true, "manual": true, "last-write-wins": true}

// skewBoundMS is the largest clock difference under which ordering writes by wall clock is still defensible.
const skewBoundMS = 250

type replicationRequest struct {
	SourceRegion   string \`json:"source_region"\`
	TargetRegion   string \`json:"target_region"\`
	Shards         []int  \`json:"shards"\`
	ConflictPolicy string \`json:"conflict_policy"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func distinct(shards []int) bool {
	seen := map[int]bool{}
	for _, shard := range shards {
		if seen[shard] {
			return false
		}
		seen[shard] = true
	}
	return true
}

func createReplication(rw http.ResponseWriter, r *http.Request) {
	operator := r.Header.Get("X-Operator-Id")
	if operator == "" {
		http.Error(rw, "X-Operator-Id is required", http.StatusUnauthorized)
		return
	}
	var body replicationRequest
	json.NewDecoder(r.Body).Decode(&body)
	if !approvedRegionPairs[[2]string{body.SourceRegion, body.TargetRegion}] {
		http.Error(rw, "the region pair is not approved", http.StatusBadRequest)
		return
	}
	if !conflictPolicies[body.ConflictPolicy] {
		http.Error(rw, "conflict_policy must be one of source-wins, version-vector, manual, last-write-wins", http.StatusBadRequest)
		return
	}
	if body.ConflictPolicy == "last-write-wins" {
		if skew := regions.ClockSkewMS(r.Context(), body.SourceRegion, body.TargetRegion); skew > skewBoundMS {
			http.Error(rw, fmt.Sprintf("clock skew %d ms exceeds skewBoundMS: last-write-wins is unsound", skew), http.StatusBadRequest)
			return
		}
	}
	if len(body.Shards) == 0 || len(body.Shards) > maxShards || !distinct(body.Shards) {
		http.Error(rw, "shards must be 1 to 64 distinct shard ids", http.StatusBadRequest)
		return
	}
	replication, err := store.Create(r.Context(), operator, body.SourceRegion, body.TargetRegion, body.Shards, body.ConflictPolicy)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusCreated, replication)
}

func updatePolicy(rw http.ResponseWriter, r *http.Request) {
	operator := r.Header.Get("X-Operator-Id")
	if operator == "" {
		http.Error(rw, "X-Operator-Id is required", http.StatusUnauthorized)
		return
	}
	replication, err := store.Get(r.Context(), r.PathValue("id"))
	if err != nil || replication == nil || replication.Owner != operator {
		http.Error(rw, "no such replication", http.StatusNotFound)
		return
	}
	var body struct {
		ConflictPolicy string \`json:"conflict_policy"\`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.ConflictPolicy != replication.ConflictPolicy {
		// Rows already merged under the recorded policy stay consistent only if the policy stays.
		http.Error(rw, "conflict_policy is immutable once the replication exists", http.StatusConflict)
		return
	}
	writeJSON(rw, http.StatusOK, replication)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/replications", createReplication)
	mux.HandleFunc("PATCH /v1/replications/{id}", updatePolicy)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import replication.{Regions, Store} // Store.create, get, setPolicy · Regions.clockSkewMs

object Api {
  val MaxShards = 64

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(fields: Map[String, JsValue], name: String): Option[String] =
    fields.get(name).collect { case JsString(s) => s }

  val route: Route = concat(
    path("v1" / "replications") {
      post {
        optionalHeaderValueByName("X-Operator-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Operator-Id is required")
          case Some(operator) =>
            entity(as[String]) { raw =>
              // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
              val fields = raw.parseJson.asJsObject.fields
              val shards = fields.get("shards").collect { case JsArray(items) => items.collect { case JsNumber(n) => n.toInt } }.getOrElse(Vector.empty)
              if (shards.isEmpty || shards.size > MaxShards || shards.distinct.size != shards.size)
                complete(StatusCodes.BadRequest -> "shards must be 1 to 64 distinct shard ids")
              else {
                val policy = text(fields, "conflict_policy").getOrElse("last-write-wins")
                val created = Store.create(operator, text(fields, "source_region").getOrElse(""), text(fields, "target_region").getOrElse(""), shards, policy)
                complete(json(StatusCodes.Created, created.toJson))
              }
            }
        }
      }
    },
    path("v1" / "replications" / Segment) { replicationId =>
      patch {
        optionalHeaderValueByName("X-Operator-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Operator-Id is required")
          case Some(operator) =>
            entity(as[String]) { raw =>
              Store.get(replicationId).filter(_.owner == operator) match {
                case None => complete(StatusCodes.NotFound -> "no such replication")
                case Some(_) =>
                  val policy = text(raw.parseJson.asJsObject.fields, "conflict_policy").getOrElse("")
                  complete(json(StatusCodes.OK, Store.setPolicy(replicationId, policy).toJson))
              }
            }
        }
      }
    },
  )
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import replication.{Regions, Store} // Store.create, get, setPolicy · Regions.clockSkewMs

object Api {
  val MaxShards = 64
  /** The ordered pairs the platform replicates between: a pair is approved one direction at a time. */
  val ApprovedRegionPairs: Set[(String, String)] = Set(("us-east-1", "eu-west-1"), ("eu-west-1", "us-east-1"), ("us-east-1", "us-west-2"))
  val ConflictPolicies: Seq[String] = Seq("source-wins", "version-vector", "manual", "last-write-wins")
  /** The largest clock difference under which ordering writes by wall clock is still defensible. */
  val SkewBoundMs = 250L

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(fields: Map[String, JsValue], name: String): Option[String] =
    fields.get(name).collect { case JsString(s) => s }

  /** Why the request cannot start a replication, if it cannot. */
  private def refusal(source: String, target: String, policy: Option[String], shards: Seq[Int]): Option[String] =
    if (!ApprovedRegionPairs.contains((source, target))) Some("the region pair is not approved")
    else if (!policy.exists(ConflictPolicies.contains(_))) Some(s"conflict_policy must be one of \${ConflictPolicies.mkString(", ")}")
    else if (policy.contains("last-write-wins") && Regions.clockSkewMs(source, target) > SkewBoundMs)
      Some("clock skew exceeds SkewBoundMs: last-write-wins is unsound")
    else if (shards.isEmpty || shards.size > MaxShards || shards.distinct.size != shards.size) Some("shards must be 1 to 64 distinct shard ids")
    else None

  val route: Route = concat(
    path("v1" / "replications") {
      post {
        optionalHeaderValueByName("X-Operator-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Operator-Id is required")
          case Some(operator) =>
            entity(as[String]) { raw =>
              val fields = raw.parseJson.asJsObject.fields
              val shards = fields.get("shards").collect { case JsArray(items) => items.collect { case JsNumber(n) => n.toInt } }.getOrElse(Vector.empty)
              val source = text(fields, "source_region").getOrElse("")
              val target = text(fields, "target_region").getOrElse("")
              val policy = text(fields, "conflict_policy")
              refusal(source, target, policy, shards) match {
                case Some(reason) => complete(StatusCodes.BadRequest -> reason)
                case None => complete(json(StatusCodes.Created, Store.create(operator, source, target, shards, policy.get).toJson))
              }
            }
        }
      }
    },
    path("v1" / "replications" / Segment) { replicationId =>
      patch {
        optionalHeaderValueByName("X-Operator-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Operator-Id is required")
          case Some(operator) =>
            entity(as[String]) { raw =>
              Store.get(replicationId).filter(_.owner == operator) match {
                case None => complete(StatusCodes.NotFound -> "no such replication")
                case Some(existing) =>
                  val policy = text(raw.parseJson.asJsObject.fields, "conflict_policy").getOrElse("")
                  // Rows already merged under the recorded policy stay consistent only if the policy stays.
                  if (policy != existing.conflictPolicy) complete(StatusCodes.Conflict -> "conflict_policy is immutable once the replication exists")
                  else complete(json(StatusCodes.OK, existing.toJson))
              }
            }
        }
      }
    },
  )
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>
#include <vector>

#include "replication/regions.h"  // regions::clockSkewMs
#include "replication/store.h"    // store::create, get, setPolicy

using json = nlohmann::json;

constexpr std::size_t kMaxShards = 64;

void create_replication(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string op = req.get_header_value("X-Operator-Id");
  if (op.empty()) {
    res.status = 401;
    res.set_content("X-Operator-Id is required", "text/plain");
    return;
  }
  const json body = json::parse(req.body);
  const std::vector<int> shards = body.value("shards", std::vector<int>{});
  if (shards.empty() || shards.size() > kMaxShards || std::set<int>(shards.begin(), shards.end()).size() != shards.size()) {
    res.status = 400;
    res.set_content("shards must be 1 to 64 distinct shard ids", "text/plain");
    return;
  }
  const std::string policy = body.value("conflict_policy", std::string("last-write-wins"));
  const store::Replication created = store::create(op, body.value("source_region", ""), body.value("target_region", ""), shards, policy);
  res.status = 201;
  res.set_content(store::toJson(created).dump(), "application/json");
}

void update_policy(const httplib::Request& req, httplib::Response& res) {
  const std::string op = req.get_header_value("X-Operator-Id");
  if (op.empty()) {
    res.status = 401;
    res.set_content("X-Operator-Id is required", "text/plain");
    return;
  }
  const auto replication = store::get(req.matches[1]);
  if (!replication || replication->owner != op) {
    res.status = 404;
    res.set_content("no such replication", "text/plain");
    return;
  }
  const std::string policy = json::parse(req.body).value("conflict_policy", "");
  res.set_content(store::toJson(store::setPolicy(replication->id, policy)).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/replications", create_replication);
  svr.Patch(R"(/v1/replications/([\\w-]+))", update_policy);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>
#include <utility>
#include <vector>

#include "replication/regions.h"  // regions::clockSkewMs
#include "replication/store.h"    // store::create, get, setPolicy

using json = nlohmann::json;

constexpr std::size_t kMaxShards = 64;
// The ordered pairs the platform replicates between: a pair is approved one direction at a time.
const std::set<std::pair<std::string, std::string>> kApprovedRegionPairs = {
    {"us-east-1", "eu-west-1"}, {"eu-west-1", "us-east-1"}, {"us-east-1", "us-west-2"}};
const std::set<std::string> kConflictPolicies = {"source-wins", "version-vector", "manual", "last-write-wins"};
// The largest clock difference under which ordering writes by wall clock is still defensible.
constexpr long long kSkewBoundMs = 250;

void reject(httplib::Response& res, int status, const std::string& reason) {
  res.status = status;
  res.set_content(reason, "text/plain");
}

void create_replication(const httplib::Request& req, httplib::Response& res) {
  const std::string op = req.get_header_value("X-Operator-Id");
  if (op.empty()) return reject(res, 401, "X-Operator-Id is required");
  const json body = json::parse(req.body);
  const std::string source = body.value("source_region", "");
  const std::string target = body.value("target_region", "");
  if (!kApprovedRegionPairs.count({source, target})) return reject(res, 400, "the region pair is not approved");
  const std::string policy = body.value("conflict_policy", "");
  if (!kConflictPolicies.count(policy)) {
    return reject(res, 400, "conflict_policy must be one of source-wins, version-vector, manual, last-write-wins");
  }
  if (policy == "last-write-wins" && regions::clockSkewMs(source, target) > kSkewBoundMs) {
    return reject(res, 400, "clock skew exceeds kSkewBoundMs: last-write-wins is unsound");
  }
  const std::vector<int> shards = body.value("shards", std::vector<int>{});
  if (shards.empty() || shards.size() > kMaxShards || std::set<int>(shards.begin(), shards.end()).size() != shards.size()) {
    return reject(res, 400, "shards must be 1 to 64 distinct shard ids");
  }
  const store::Replication created = store::create(op, source, target, shards, policy);
  res.status = 201;
  res.set_content(store::toJson(created).dump(), "application/json");
}

void update_policy(const httplib::Request& req, httplib::Response& res) {
  const std::string op = req.get_header_value("X-Operator-Id");
  if (op.empty()) return reject(res, 401, "X-Operator-Id is required");
  const auto replication = store::get(req.matches[1]);
  if (!replication || replication->owner != op) return reject(res, 404, "no such replication");
  const std::string policy = json::parse(req.body).value("conflict_policy", "");
  // Rows already merged under the recorded policy stay consistent only if the policy stays.
  if (policy != replication->conflict_policy) return reject(res, 409, "conflict_policy is immutable once the replication exists");
  res.set_content(store::toJson(*replication).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/replications", create_replication);
  svr.Patch(R"(/v1/replications/([\\w-]+))", update_policy);
}
`,
    },
  },
  harness: {
    python: `from replication import store

OPS = {"X-Operator-Id": "ops-a"}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


def _body(source="us-east-1", target="eu-west-1", policy="source-wins", shards=(0, 1)):
    body = {"source_region": source, "target_region": target, "shards": list(shards)}
    if policy is not None:
        body["conflict_policy"] = policy
    return body


def _stored(ctx):
    return sorted(k for k in ctx.redis.keys("replication:*") if k != "replication:seq")


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/replications", json=_body(), headers=OPS)
        assert r.status_code == 201, f"POST /v1/replications answered {r.status_code}: {r.text}"
        created = r.json()
        stored = store.get(created.get("id", ""))
        assert stored is not None and stored["shards"] == [0, 1] and stored["conflict_policy"] == "source-wins", f"the store holds {stored} for the answer {created}"
        r = await c.patch(f"/v1/replications/{created['id']}", json={"conflict_policy": "source-wins"}, headers=OPS)
        assert r.status_code == 200, f"PATCH with the same policy answered {r.status_code}: {r.text}"
        r = await c.post("/v1/replications", json=_body())
    assert r.status_code == 401, f"a create without X-Operator-Id answered {r.status_code}, expected 401"


async def check_approved_regions(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/replications", json=_body(target="ap-south-1"), headers=OPS)
        assert r.status_code == 400, f"us-east-1 -> ap-south-1 is not an approved pair and answered {r.status_code}, expected 400"
        r = await c.post("/v1/replications", json=_body(source="us-west-2", target="us-east-1"), headers=OPS)
        assert r.status_code == 400, f"us-west-2 -> us-east-1 answered {r.status_code}: only us-east-1 -> us-west-2 is approved, the pair is ordered"
        assert _stored(ctx) == [], f"refused requests stored {_stored(ctx)}"
        r = await c.post("/v1/replications", json=_body(source="eu-west-1", target="us-east-1"), headers=OPS)
    assert r.status_code == 201, f"the approved pair eu-west-1 -> us-east-1 answered {r.status_code}: {r.text}"


async def check_conflict_policy(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/replications", json=_body(policy=None), headers=OPS)
        assert r.status_code == 400, f"a create without conflict_policy answered {r.status_code} ({r.text}), expected 400: no policy may be chosen for the operator"
        r = await c.post("/v1/replications", json=_body(policy="newest-wins"), headers=OPS)
        assert r.status_code == 400, f"the unknown policy newest-wins answered {r.status_code}, expected 400"
        assert _stored(ctx) == [], f"refused requests stored {_stored(ctx)}"
        r = await c.post("/v1/replications", json=_body(policy="manual"), headers=OPS)
    assert r.status_code == 201 and r.json().get("conflict_policy") == "manual", f"a create with manual answered {r.status_code} {r.text}"


async def check_skew_bound(ctx):
    ctx.redis.set("skew:us-east-1:eu-west-1", 400)
    async with _api(ctx) as c:
        r = await c.post("/v1/replications", json=_body(policy="last-write-wins"), headers=OPS)
        assert r.status_code == 400, f"last-write-wins with the clocks 400 ms apart answered {r.status_code}, expected 400 (SKEW_BOUND_MS is 250)"
        assert _stored(ctx) == [], f"a refused last-write-wins stored {_stored(ctx)}"
        r = await c.post("/v1/replications", json=_body(policy="source-wins"), headers=OPS)
        assert r.status_code == 201, f"source-wins reads no clock and must be accepted at any skew, got {r.status_code} {r.text}"
        ctx.redis.set("skew:us-east-1:eu-west-1", 100)
        r = await c.post("/v1/replications", json=_body(policy="last-write-wins"), headers=OPS)
    assert r.status_code == 201, f"last-write-wins with the clocks 100 ms apart answered {r.status_code} {r.text}, expected 201"


async def check_policy_immutable(ctx):
    async with _api(ctx) as c:
        created = (await c.post("/v1/replications", json=_body(policy="source-wins"), headers=OPS)).json()
        r = await c.patch(f"/v1/replications/{created['id']}", json={"conflict_policy": "version-vector"}, headers=OPS)
        assert r.status_code == 409, f"changing the policy of a running replication answered {r.status_code}, expected 409"
        assert "immutable" in r.text, f"the 409 must say the policy is immutable, got {r.text}"
        stored = store.get(created["id"])
        assert stored["conflict_policy"] == "source-wins", f"the stored policy became {stored['conflict_policy']}: a refused PATCH must not write"
        r = await c.patch(f"/v1/replications/{created['id']}", json={"conflict_policy": "source-wins"}, headers=OPS)
    assert r.status_code == 200 and r.json().get("conflict_policy") == "source-wins", f"a PATCH with the same policy answered {r.status_code} {r.text}"
`,
    typescript: `const OPS = {'X-Operator-Id': 'ops-a'};

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/replication/store.ts')};
}

function body(source = 'us-east-1', target = 'eu-west-1', policy: string | null = 'source-wins', shards = [0, 1]) {
  return policy === null
    ? {source_region: source, target_region: target, shards}
    : {source_region: source, target_region: target, shards, conflict_policy: policy};
}

const stored = ctx => ctx.redis.keys('replication:*').filter(k => k !== 'replication:seq');

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  let r = await c.post('/v1/replications', {json: body(), headers: OPS});
  assert.equal(r.status, 201, \`POST /v1/replications answered \${r.status}: \${r.text}\`);
  const created = r.json();
  const row = await store.get(created.id ?? '');
  assert(row !== null && JSON.stringify(row.shards) === '[0,1]' && row.conflict_policy === 'source-wins', \`the store holds \${JSON.stringify(row)} for the answer \${r.text}\`);
  r = await c.patch(\`/v1/replications/\${created.id}\`, {json: {conflict_policy: 'source-wins'}, headers: OPS});
  assert.equal(r.status, 200, \`PATCH with the same policy answered \${r.status}: \${r.text}\`);
  r = await c.post('/v1/replications', {json: body()});
  assert.equal(r.status, 401, \`a create without X-Operator-Id answered \${r.status}, expected 401\`);
}

export async function check_approved_regions(ctx) {
  const {c} = api(ctx);
  let r = await c.post('/v1/replications', {json: body('us-east-1', 'ap-south-1'), headers: OPS});
  assert.equal(r.status, 400, \`us-east-1 -> ap-south-1 is not an approved pair and answered \${r.status}, expected 400\`);
  r = await c.post('/v1/replications', {json: body('us-west-2', 'us-east-1'), headers: OPS});
  assert.equal(r.status, 400, \`us-west-2 -> us-east-1 answered \${r.status}: only us-east-1 -> us-west-2 is approved, the pair is ordered\`);
  assert.deepStrictEqual(stored(ctx), [], \`refused requests stored \${JSON.stringify(stored(ctx))}\`);
  r = await c.post('/v1/replications', {json: body('eu-west-1', 'us-east-1'), headers: OPS});
  assert.equal(r.status, 201, \`the approved pair eu-west-1 -> us-east-1 answered \${r.status}: \${r.text}\`);
}

export async function check_conflict_policy(ctx) {
  const {c} = api(ctx);
  let r = await c.post('/v1/replications', {json: body('us-east-1', 'eu-west-1', null), headers: OPS});
  assert.equal(r.status, 400, \`a create without conflict_policy answered \${r.status} (\${r.text}), expected 400: no policy may be chosen for the operator\`);
  r = await c.post('/v1/replications', {json: body('us-east-1', 'eu-west-1', 'newest-wins'), headers: OPS});
  assert.equal(r.status, 400, \`the unknown policy newest-wins answered \${r.status}, expected 400\`);
  assert.deepStrictEqual(stored(ctx), [], \`refused requests stored \${JSON.stringify(stored(ctx))}\`);
  r = await c.post('/v1/replications', {json: body('us-east-1', 'eu-west-1', 'manual'), headers: OPS});
  assert(r.status === 201 && r.json().conflict_policy === 'manual', \`a create with manual answered \${r.status} \${r.text}\`);
}

export async function check_skew_bound(ctx) {
  const {c} = api(ctx);
  ctx.redis.set('skew:us-east-1:eu-west-1', '400');
  let r = await c.post('/v1/replications', {json: body('us-east-1', 'eu-west-1', 'last-write-wins'), headers: OPS});
  assert.equal(r.status, 400, \`last-write-wins with the clocks 400 ms apart answered \${r.status}, expected 400 (SKEW_BOUND_MS is 250)\`);
  assert.deepStrictEqual(stored(ctx), [], \`a refused last-write-wins stored \${JSON.stringify(stored(ctx))}\`);
  r = await c.post('/v1/replications', {json: body('us-east-1', 'eu-west-1', 'source-wins'), headers: OPS});
  assert.equal(r.status, 201, \`source-wins reads no clock and must be accepted at any skew, got \${r.status} \${r.text}\`);
  ctx.redis.set('skew:us-east-1:eu-west-1', '100');
  r = await c.post('/v1/replications', {json: body('us-east-1', 'eu-west-1', 'last-write-wins'), headers: OPS});
  assert.equal(r.status, 201, \`last-write-wins with the clocks 100 ms apart answered \${r.status} \${r.text}, expected 201\`);
}

export async function check_policy_immutable(ctx) {
  const {c, store} = api(ctx);
  const created = (await c.post('/v1/replications', {json: body(), headers: OPS})).json();
  let r = await c.patch(\`/v1/replications/\${created.id}\`, {json: {conflict_policy: 'version-vector'}, headers: OPS});
  assert.equal(r.status, 409, \`changing the policy of a running replication answered \${r.status}, expected 409\`);
  assert(r.text.includes('immutable'), \`the 409 must say the policy is immutable, got \${r.text}\`);
  const row = await store.get(created.id);
  assert.equal(row.conflict_policy, 'source-wins', \`the stored policy became \${row.conflict_policy}: a refused PATCH must not write\`);
  r = await c.patch(\`/v1/replications/\${created.id}\`, {json: {conflict_policy: 'source-wins'}, headers: OPS});
  assert(r.status === 200 && r.json().conflict_policy === 'source-wins', \`a PATCH with the same policy answered \${r.status} \${r.text}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"replication/store"

	"leetbuild/harness"
)

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func body(source, target, policy string) map[string]any {
	b := map[string]any{"source_region": source, "target_region": target, "shards": []int{0, 1}}
	if policy != "" {
		b["conflict_policy"] = policy
	}
	return b
}

func create(c *harness.HTTP, source, target, policy string) *harness.Response {
	return c.Post("/v1/replications", body(source, target, policy), "X-Operator-Id", "ops-a")
}

func stored(ctx *harness.Ctx) []string {
	out := []string{}
	for _, k := range ctx.Redis.Keys("replication:*") {
		if k != "replication:seq" {
			out = append(out, k)
		}
	}
	return out
}

func idOf(r *harness.Response) string {
	var created struct {
		ID string \`json:"id"\`
	}
	r.Decode(&created)
	return created.ID
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := create(c, "us-east-1", "eu-west-1", "source-wins")
	ctx.Equal(r.Status, 201, "POST /v1/replications (%s)", r.Text())
	id := idOf(r)
	row, err := store.Get(context.Background(), id)
	ctx.NoError(err, "store.Get")
	ctx.Assert(row != nil && len(row.Shards) == 2 && row.ConflictPolicy == "source-wins", "the store holds %+v for the answer %s", row, r.Text())
	r = c.Patch("/v1/replications/"+id, map[string]string{"conflict_policy": "source-wins"}, "X-Operator-Id", "ops-a")
	ctx.Equal(r.Status, 200, "PATCH with the same policy (%s)", r.Text())
	r = c.Post("/v1/replications", body("us-east-1", "eu-west-1", "source-wins"))
	ctx.Equal(r.Status, 401, "a create without X-Operator-Id")
}

func CheckApprovedRegions(ctx *harness.Ctx) {
	c := api(ctx)
	r := create(c, "us-east-1", "ap-south-1", "source-wins")
	ctx.Equal(r.Status, 400, "us-east-1 -> ap-south-1 is not an approved pair")
	r = create(c, "us-west-2", "us-east-1", "source-wins")
	ctx.Equal(r.Status, 400, "us-west-2 -> us-east-1: only us-east-1 -> us-west-2 is approved, the pair is ordered")
	ctx.Equal(stored(ctx), []string{}, "refused requests must store nothing; stored")
	r = create(c, "eu-west-1", "us-east-1", "source-wins")
	ctx.Equal(r.Status, 201, "the approved pair eu-west-1 -> us-east-1 (%s)", r.Text())
}

func CheckConflictPolicy(ctx *harness.Ctx) {
	c := api(ctx)
	r := create(c, "us-east-1", "eu-west-1", "")
	ctx.Equal(r.Status, 400, "a create without conflict_policy (%s): no policy may be chosen for the operator", r.Text())
	r = create(c, "us-east-1", "eu-west-1", "newest-wins")
	ctx.Equal(r.Status, 400, "the unknown policy newest-wins")
	ctx.Equal(stored(ctx), []string{}, "refused requests must store nothing; stored")
	r = create(c, "us-east-1", "eu-west-1", "manual")
	ctx.Assert(r.Status == 201 && strings.Contains(r.Text(), \`"manual"\`), "a create with manual answered %d %s", r.Status, r.Text())
}

func CheckSkewBound(ctx *harness.Ctx) {
	c := api(ctx)
	ctx.Redis.Set("skew:us-east-1:eu-west-1", "400")
	r := create(c, "us-east-1", "eu-west-1", "last-write-wins")
	ctx.Equal(r.Status, 400, "last-write-wins with the clocks 400 ms apart (skewBoundMS is 250)")
	ctx.Equal(stored(ctx), []string{}, "a refused last-write-wins must store nothing; stored")
	r = create(c, "us-east-1", "eu-west-1", "source-wins")
	ctx.Equal(r.Status, 201, "source-wins reads no clock and must be accepted at any skew (%s)", r.Text())
	ctx.Redis.Set("skew:us-east-1:eu-west-1", "100")
	r = create(c, "us-east-1", "eu-west-1", "last-write-wins")
	ctx.Equal(r.Status, 201, "last-write-wins with the clocks 100 ms apart (%s)", r.Text())
}

func CheckPolicyImmutable(ctx *harness.Ctx) {
	c := api(ctx)
	id := idOf(create(c, "us-east-1", "eu-west-1", "source-wins"))
	r := c.Patch("/v1/replications/"+id, map[string]string{"conflict_policy": "version-vector"}, "X-Operator-Id", "ops-a")
	ctx.Equal(r.Status, 409, "changing the policy of a running replication")
	ctx.Assert(strings.Contains(r.Text(), "immutable"), "the 409 must say the policy is immutable, got %s", r.Text())
	row, _ := store.Get(context.Background(), id)
	ctx.Equal(row.ConflictPolicy, "source-wins", "a refused PATCH must not write; the stored policy")
	r = c.Patch("/v1/replications/"+id, map[string]string{"conflict_policy": "source-wins"}, "X-Operator-Id", "ops-a")
	ctx.Assert(r.Status == 200 && strings.Contains(r.Text(), \`"source-wins"\`), "a PATCH with the same policy answered %d %s", r.Status, r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>
#include <vector>

#include "replication/store.h"

namespace {

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string body(const std::string& source, const std::string& target, const std::string& policy) {
  nlohmann::json b = {{"source_region", source}, {"target_region", target}, {"shards", {0, 1}}};
  if (!policy.empty()) b["conflict_policy"] = policy;
  return b.dump();
}

harness::Response create(harness::HTTP& c, const std::string& source, const std::string& target, const std::string& policy) {
  return c.Post("/v1/replications", body(source, target, policy), "Content-Type", "application/json", "X-Operator-Id", "ops-a");
}

harness::Response patch(harness::HTTP& c, const std::string& id, const std::string& policy) {
  return c.Patch("/v1/replications/" + id, nlohmann::json{{"conflict_policy", policy}}.dump(), "Content-Type", "application/json",
                 "X-Operator-Id", "ops-a");
}

std::vector<std::string> stored(harness::Ctx& ctx) {
  std::vector<std::string> out;
  for (const auto& k : ctx.Redis.Keys("replication:*")) {
    if (k != "replication:seq") out.push_back(k);
  }
  return out;
}

std::string field(const harness::Response& r, const std::string& name) {
  const auto j = nlohmann::json::parse(r.Text(), nullptr, false);
  return j.is_object() && j.contains(name) && j[name].is_string() ? j[name].get<std::string>() : "";
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = create(c, "us-east-1", "eu-west-1", "source-wins");
  ctx.Equal(r.Status, 201, "POST /v1/replications (%s)", r.Text());
  const std::string id = field(r, "id");
  const auto row = store::get(id);
  ctx.Assert(row && row->shards.size() == 2 && row->conflict_policy == "source-wins", "the store holds no matching replication for the answer %s", r.Text());
  r = patch(c, id, "source-wins");
  ctx.Equal(r.Status, 200, "PATCH with the same policy (%s)", r.Text());
  r = c.Post("/v1/replications", body("us-east-1", "eu-west-1", "source-wins"), "Content-Type", "application/json");
  ctx.Equal(r.Status, 401, "a create without X-Operator-Id");
}

void CheckApprovedRegions(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = create(c, "us-east-1", "ap-south-1", "source-wins");
  ctx.Equal(r.Status, 400, "us-east-1 -> ap-south-1 is not an approved pair");
  r = create(c, "us-west-2", "us-east-1", "source-wins");
  ctx.Equal(r.Status, 400, "us-west-2 -> us-east-1: only us-east-1 -> us-west-2 is approved, the pair is ordered");
  ctx.Equal(stored(ctx), std::vector<std::string>{}, "refused requests must store nothing; stored");
  r = create(c, "eu-west-1", "us-east-1", "source-wins");
  ctx.Equal(r.Status, 201, "the approved pair eu-west-1 -> us-east-1 (%s)", r.Text());
}

void CheckConflictPolicy(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = create(c, "us-east-1", "eu-west-1", "");
  ctx.Equal(r.Status, 400, "a create without conflict_policy (%s): no policy may be chosen for the operator", r.Text());
  r = create(c, "us-east-1", "eu-west-1", "newest-wins");
  ctx.Equal(r.Status, 400, "the unknown policy newest-wins");
  ctx.Equal(stored(ctx), std::vector<std::string>{}, "refused requests must store nothing; stored");
  r = create(c, "us-east-1", "eu-west-1", "manual");
  ctx.Assert(r.Status == 201 && field(r, "conflict_policy") == "manual", "a create with manual answered %d %s", r.Status, r.Text());
}

void CheckSkewBound(harness::Ctx& ctx) {
  auto c = api(ctx);
  ctx.Redis.Set("skew:us-east-1:eu-west-1", "400");
  auto r = create(c, "us-east-1", "eu-west-1", "last-write-wins");
  ctx.Equal(r.Status, 400, "last-write-wins with the clocks 400 ms apart (kSkewBoundMs is 250)");
  ctx.Equal(stored(ctx), std::vector<std::string>{}, "a refused last-write-wins must store nothing; stored");
  r = create(c, "us-east-1", "eu-west-1", "source-wins");
  ctx.Equal(r.Status, 201, "source-wins reads no clock and must be accepted at any skew (%s)", r.Text());
  ctx.Redis.Set("skew:us-east-1:eu-west-1", "100");
  r = create(c, "us-east-1", "eu-west-1", "last-write-wins");
  ctx.Equal(r.Status, 201, "last-write-wins with the clocks 100 ms apart (%s)", r.Text());
}

void CheckPolicyImmutable(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string id = field(create(c, "us-east-1", "eu-west-1", "source-wins"), "id");
  auto r = patch(c, id, "version-vector");
  ctx.Equal(r.Status, 409, "changing the policy of a running replication");
  ctx.Assert(r.Text().find("immutable") != std::string::npos, "the 409 must say the policy is immutable, got %s", r.Text());
  ctx.Equal(store::get(id)->conflict_policy, "source-wins", "a refused PATCH must not write; the stored policy");
  r = patch(c, id, "source-wins");
  ctx.Assert(r.Status == 200 && field(r, "conflict_policy") == "source-wins", "a PATCH with the same policy answered %d %s", r.Status, r.Text());
}
`,
  },
  hints: [
    'Start a replication from us-east-1 to ap-south-1, or leave out conflict_policy: both answer 201. Then PATCH the policy of a running replication: the stored policy changes.',
    'Nothing in the create path consults an allowlist, a policy set or the region clocks, `or "last-write-wins"` fills a missing policy in, and the PATCH handler hands the new policy straight to `store.set_policy`.',
    'Declare `APPROVED_REGION_PAIRS`, `CONFLICT_POLICIES` and `SKEW_BOUND_MS = 250`; answer 400 for an unapproved pair, a missing or unknown policy, and last-write-wins above the skew; in PATCH, 409 `immutable` when the policy differs.',
  ],
  debrief: `The fixes are guard clauses that run before anything is stored, so a refused request leaves no replication behind. The skew probe sits inside the last-write-wins branch because that is the only policy that reads a wall clock; source-wins and version vectors do not care how far apart the clocks are. Freezing the policy is a comparison, not a delete: rows already merged under the recorded rule stay consistent with the rule on record. A real control plane records who approved each region pair and why (data residency is usually the reason), re-measures skew continuously and pauses a last-write-wins replication when it drifts, and lets an operator change a policy only by creating a new replication and cutting over.`,
};
