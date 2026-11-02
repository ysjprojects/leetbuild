import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/replications: a replication that names its conflict policy',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'store'],
  task: `## Task

**Starting point.** The starter registers \`POST /v1/replications\` and \`PATCH /v1/replications/{id}\`
with body \`{"source_region", "target_region", "shards": [0, 1], "conflict_policy"}\`, checks the
operator header, stores the row and returns it. It compiles, it serves the demo, and it hides 4
flaws.

**Failure mode the checks target.** The starter accepts any pair of regions, so a typo copies data
into a region nobody approved. It defaults an absent policy to \`last-write-wins\` without measuring
skew, which reorders writes when a clock drifts. And its \`PATCH\` overwrites the policy of a
running replication, so rows merged under the old rule stay wrong.

- A missing \`X-Operator-Id\` header is **401**.
- \`source_region\` and \`target_region\` must form an **approved ordered pair** from the
  allowlist; any other pair is **400**.
- \`shards\` is a non-empty list of at most **64** unique ids in \`0..1023\` (**400** otherwise).
- \`conflict_policy\` is **required** and one of \`source-wins\`, \`version-vector\`, \`manual\` or
  \`last-write-wins\` (**400** when absent or unknown). No server-side default.
- \`last-write-wins\` is only sound while the two clocks agree: measure \`clock_skew_ms(source,
  target)\` and refuse it with **400** above \`SKEW_BOUND_MS\` (250 ms).
- The policy is **immutable**: a \`PATCH\` whose policy differs from the frozen one is **409**.
- The response is the stored replication; a replication the caller does not own is **404**.`,
  sequence: {
    participants: ['Operator', 'Replicator API', 'region clocks', 'Postgres'],
    messages: [
      {from: 'Operator', to: 'Replicator API', label: 'POST /v1/replications · X-Operator-Id', kind: 'sync'},
      {from: 'Replicator API', to: 'Replicator API', label: 'validate operator · approved pair · policy', kind: 'sync'},
      {
        from: 'Replicator API',
        to: 'region clocks',
        label: 'probe skew when last-write-wins',
        kind: 'sync',
      },
      {from: 'region clocks', to: 'Replicator API', label: 'skew ms', kind: 'reply'},
      {from: 'Replicator API', to: 'Postgres', label: 'put(replication) · policy frozen', kind: 'async'},
      {from: 'Replicator API', to: 'Operator', label: '201 {id, conflict_policy, shards}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/replications',
      detail: 'Register the replication route on `POST /v1/replications`, and the policy route on `PATCH`.',
      match: {
        python: {
          all: [
            /@app\.post\(\s*["']\/v1\/replications["']/,
            /@app\.patch\(\s*["']\/v1\/replications\/\{replication_id\}["']/,
          ],
        },
        typescript: {
          all: [/app\.post\(\s*['"]\/v1\/replications['"]/, /app\.patch\(\s*['"]\/v1\/replications\/:id['"]/],
        },
        go: {all: [/HandleFunc\(\s*"POST \/v1\/replications"/, /HandleFunc\(\s*"PATCH \/v1\/replications\/\{id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"replications"\s*\)/, /\bpost\s*\{/, /\bpatch\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/replications"/, /svr\.Patch\(/]},
      },
    },
    {
      id: 'approved-regions',
      title: 'Only an approved ordered region pair starts a replication',
      detail:
        'The pair `(source_region, target_region)` is checked against the approved allowlist and an unapproved pair is **400**. The starter replicates anywhere the caller points it.',
      match: {
        python: {all: [/APPROVED_REGION_PAIRS/, /status_code\s*=\s*400/]},
        typescript: {all: [/APPROVED_REGION_PAIRS/, /code\(\s*400\s*\)/]},
        go: {all: [/approvedRegionPairs/, /StatusBadRequest/]},
        scala: {all: [/ApprovedRegionPairs/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kApprovedRegionPairs/, /\b400\b/]},
      },
    },
    {
      id: 'conflict-policy',
      title: 'The conflict policy is required and comes from the documented set',
      detail:
        '`conflict_policy` is validated against the documented set (`source-wins`, `version-vector`, `manual`, `last-write-wins`) and a missing or unknown policy is **400** — the starter defaults it to `last-write-wins`.',
      match: {
        python: {all: [/CONFLICT_POLICIES/, /"manual"/], none: [/or\s*"last-write-wins"/]},
        typescript: {all: [/CONFLICT_POLICIES/, /'manual'/], none: [/\?\?\s*'last-write-wins'/]},
        go: {all: [/conflictPolicies/, /"manual"/], none: [/policy\s*=\s*"last-write-wins"/]},
        scala: {all: [/ConflictPolicies/, /"manual"/], none: [/getOrElse\("last-write-wins"\)/]},
        cpp: {
          all: [/kConflictPolicies/, /"manual"/],
          none: [/value\(\s*"conflict_policy"\s*,\s*std::string\("last-write-wins"\)/],
        },
      },
    },
    {
      id: 'policy-immutable',
      title: 'The conflict policy is frozen once the replication starts',
      detail:
        '`PATCH` compares the requested policy with the frozen one and answers **409** `immutable` instead of overwriting it. The starter rewrites the policy mid-replication.',
      match: {
        python: {
          all: [/status_code\s*=\s*409/, /immutable/],
          none: [/replication\["conflict_policy"\]\s*=\s*body\.conflict_policy/],
        },
        typescript: {all: [/code\(\s*409\s*\)/, /immutable/], none: [/\.conflict_policy\s*=\s*body\.conflict_policy/]},
        go: {all: [/StatusConflict/, /immutable/], none: [/\["conflict_policy"\]\s*=\s*body\.ConflictPolicy/]},
        scala: {all: [/StatusCodes\.Conflict/, /immutable/]},
        cpp: {all: [/\b409\b/, /immutable/]},
      },
    },
    {
      id: 'skew-bound',
      title: 'Last-write-wins is refused when the clock skew exceeds the bound',
      detail:
        'The measured skew between the two regions (`clock_skew_ms`) is compared with `SKEW_BOUND_MS` (250 ms) and last-write-wins is **400** above it, because wall-clock ordering is unsound there.',
      match: {
        python: {all: [/SKEW_BOUND_MS/, /clock_skew_ms\(/, /status_code\s*=\s*400/]},
        typescript: {all: [/SKEW_BOUND_MS/, /clockSkewMs\(/, /code\(\s*400\s*\)/]},
        go: {all: [/skewBoundMS/, /clockSkewMS\(/, /StatusBadRequest/]},
        scala: {all: [/SkewBoundMS/, /clockSkewMs\(/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kSkewBoundMs/, /clockSkewMs\(/, /\b400\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()


class ReplicationRequest(BaseModel):
    source_region: str
    target_region: str
    shards: list[int]
    conflict_policy: str | None = None


class ReplicationStore:
    def get(self, replication_id: str) -> dict | None:
        """The stored replication, if any."""
        raise NotImplementedError

    def put(self, replication_id: str, replication: dict) -> None:
        """Store the replication under its id."""
        raise NotImplementedError


store = ReplicationStore()


@app.post("/v1/replications", status_code=201)
def create_replication(body: ReplicationRequest, x_operator_id: str | None = Header(default=None)):
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    if not x_operator_id:
        raise HTTPException(status_code=401, detail="missing X-Operator-Id")
    replication = {
        "id": f"rep-{int(time.time())}",
        "owner": x_operator_id,
        "source_region": body.source_region,
        "target_region": body.target_region,
        "shards": body.shards,
        "conflict_policy": body.conflict_policy or "last-write-wins",
    }
    store.put(replication["id"], replication)
    return replication


@app.patch("/v1/replications/{replication_id}")
def update_replication(
    replication_id: str,
    body: ReplicationRequest,
    x_operator_id: str | None = Header(default=None),
):
    replication = store.get(replication_id)
    if replication is None:
        raise HTTPException(status_code=404, detail="unknown replication")
    replication["conflict_policy"] = body.conflict_policy or replication["conflict_policy"]
    store.put(replication_id, replication)
    return replication
`,
      solution: `import uuid

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()

# The platform replicates between these ordered pairs only, and the skew bound is the largest clock
# difference under which ordering by wall clock is still defensible.
APPROVED_REGION_PAIRS = {
    ("us-east-1", "eu-west-1"),
    ("us-east-1", "us-west-2"),
    ("eu-west-1", "ap-south-1"),
}
CONFLICT_POLICIES = {"source-wins", "version-vector", "manual", "last-write-wins"}
SKEW_BOUND_MS = 250
MAX_SHARDS = 64


class ReplicationRequest(BaseModel):
    source_region: str
    target_region: str
    shards: list[int]
    conflict_policy: str | None = None


class PolicyUpdate(BaseModel):
    conflict_policy: str | None = None


class ReplicationStore:
    def get(self, replication_id: str) -> dict | None:
        """The stored replication, if any."""
        raise NotImplementedError

    def put(self, replication_id: str, replication: dict) -> None:
        """Store the replication under its id."""
        raise NotImplementedError


store = ReplicationStore()


def clock_skew_ms(source_region: str, target_region: str) -> int:
    """Measured clock skew between the two regions, in milliseconds."""
    raise NotImplementedError


def validate_shards(shards: list[int]) -> None:
    if not shards or len(shards) > MAX_SHARDS or len(set(shards)) != len(shards):
        raise HTTPException(status_code=400, detail="shards must be 1..64 unique shard ids")
    if any(shard < 0 or shard > 1023 for shard in shards):
        raise HTTPException(status_code=400, detail="shard id out of range")


@app.post("/v1/replications", status_code=201)
def create_replication(body: ReplicationRequest, x_operator_id: str | None = Header(default=None)):
    if not x_operator_id:
        raise HTTPException(status_code=401, detail="missing X-Operator-Id")
    pair = (body.source_region, body.target_region)
    if pair not in APPROVED_REGION_PAIRS:
        raise HTTPException(status_code=400, detail="region pair is not approved")
    if body.conflict_policy is None or body.conflict_policy not in CONFLICT_POLICIES:
        raise HTTPException(status_code=400, detail="conflict_policy must be one of the documented policies")
    if body.conflict_policy == "last-write-wins":
        skew = clock_skew_ms(body.source_region, body.target_region)
        if skew > SKEW_BOUND_MS:
            raise HTTPException(
                status_code=400,
                detail="clock skew exceeds SKEW_BOUND_MS: wall-clock ordering is unsound",
            )
    validate_shards(body.shards)
    replication = {
        "id": f"rep-{uuid.uuid4().hex[:12]}",
        "owner": x_operator_id,
        "source_region": body.source_region,
        "target_region": body.target_region,
        "shards": body.shards,
        "conflict_policy": body.conflict_policy,
    }
    store.put(replication["id"], replication)
    return replication


@app.patch("/v1/replications/{replication_id}")
def update_replication(
    replication_id: str,
    body: PolicyUpdate,
    x_operator_id: str | None = Header(default=None),
):
    replication = store.get(replication_id)
    if replication is None or replication["owner"] != x_operator_id:
        raise HTTPException(status_code=404, detail="unknown replication")
    if body.conflict_policy is not None and body.conflict_policy != replication["conflict_policy"]:
        raise HTTPException(status_code=409, detail="conflict policy is immutable once the replication starts")
    return replication
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

const app = Fastify({logger: true});

interface ReplicationBody {
  source_region: string;
  target_region: string;
  shards: number[];
  conflict_policy?: string;
}

interface Replication {
  id: string;
  owner: string;
  source_region: string;
  target_region: string;
  shards: number[];
  conflict_policy: string;
}

class ReplicationStore {
  get(replicationId: string): Replication | undefined {
    throw new Error('not implemented');
  }
  put(replication: Replication): void {
    throw new Error('not implemented');
  }
}

const store = new ReplicationStore();

app.post('/v1/replications', async (request, reply) => {
  const operator = request.headers['x-operator-id'];
  if (typeof operator !== 'string' || operator === '') return reply.code(401).send({error: 'missing X-Operator-Id'});
  const body = request.body as ReplicationBody;
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const replication: Replication = {
    id: \`rep-\${randomUUID()}\`,
    owner: operator,
    source_region: body.source_region,
    target_region: body.target_region,
    shards: body.shards,
    conflict_policy: body.conflict_policy ?? 'last-write-wins',
  };
  store.put(replication);
  return reply.code(201).send(replication);
});

app.patch('/v1/replications/:id', async (request, reply) => {
  const body = request.body as ReplicationBody;
  const replication = store.get((request.params as {id: string}).id);
  if (replication === undefined) return reply.code(404).send({error: 'unknown replication'});
  replication.conflict_policy = body.conflict_policy ?? replication.conflict_policy;
  store.put(replication);
  return reply.code(200).send(replication);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

const app = Fastify({logger: true});

// Approved ordered region pairs, the documented conflict policies, and the largest clock skew
// under which ordering by wall clock is still defensible.
const APPROVED_REGION_PAIRS: Record<string, true> = {
  'us-east-1|eu-west-1': true,
  'us-east-1|us-west-2': true,
  'eu-west-1|ap-south-1': true,
};
const CONFLICT_POLICIES: Record<string, true> = {
  'source-wins': true,
  'version-vector': true,
  'manual': true,
  'last-write-wins': true,
};
const SKEW_BOUND_MS = 250;
const MAX_SHARDS = 64;

interface ReplicationBody {
  source_region: string;
  target_region: string;
  shards: number[];
  conflict_policy?: string;
}

interface Replication {
  id: string;
  owner: string;
  source_region: string;
  target_region: string;
  shards: number[];
  conflict_policy: string;
}

class ReplicationStore {
  get(replicationId: string): Replication | undefined {
    throw new Error('not implemented');
  }
  put(replication: Replication): void {
    throw new Error('not implemented');
  }
}

const store = new ReplicationStore();

function clockSkewMs(sourceRegion: string, targetRegion: string): number {
  throw new Error('probe the two regions’ clocks');
}

function validShards(shards: unknown): shards is number[] {
  return (
    Array.isArray(shards) &&
    shards.length > 0 &&
    shards.length <= MAX_SHARDS &&
    new Set(shards).size === shards.length &&
    shards.every(shard => Number.isInteger(shard) && shard >= 0 && shard <= 1023)
  );
}

app.post('/v1/replications', async (request, reply) => {
  const operator = request.headers['x-operator-id'];
  if (typeof operator !== 'string' || operator === '') return reply.code(401).send({error: 'missing X-Operator-Id'});
  const body = request.body as ReplicationBody;
  if (APPROVED_REGION_PAIRS[\`\${body.source_region}|\${body.target_region}\`] !== true)
    return reply.code(400).send({error: 'region pair is not approved'});
  if (body.conflict_policy === undefined || CONFLICT_POLICIES[body.conflict_policy] !== true)
    return reply.code(400).send({error: 'conflict_policy must be one of the documented policies'});
  if (body.conflict_policy === 'last-write-wins') {
    const skew = clockSkewMs(body.source_region, body.target_region);
    if (skew > SKEW_BOUND_MS)
      return reply.code(400).send({error: 'clock skew exceeds SKEW_BOUND_MS: wall-clock ordering is unsound'});
  }
  if (!validShards(body.shards)) return reply.code(400).send({error: 'shards must be 1..64 unique shard ids'});

  const replication: Replication = {
    id: \`rep-\${randomUUID()}\`,
    owner: operator,
    source_region: body.source_region,
    target_region: body.target_region,
    shards: body.shards,
    conflict_policy: body.conflict_policy,
  };
  store.put(replication);
  request.log.info({replication: replication.id, policy: replication.conflict_policy}, 'replication started');
  return reply.code(201).send(replication);
});

app.patch('/v1/replications/:id', async (request, reply) => {
  const operator = request.headers['x-operator-id'];
  const body = request.body as Partial<ReplicationBody>;
  const replication = store.get((request.params as {id: string}).id);
  if (replication === undefined || replication.owner !== operator) return reply.code(404).send({error: 'unknown replication'});
  if (body.conflict_policy !== undefined && body.conflict_policy !== replication.conflict_policy)
    return reply.code(409).send({error: 'conflict policy is immutable once the replication starts'});
  return reply.code(200).send(replication);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"
)

type ReplicationRequest struct {
	SourceRegion   string \`json:"source_region"\`
	TargetRegion   string \`json:"target_region"\`
	Shards         []int  \`json:"shards"\`
	ConflictPolicy string \`json:"conflict_policy"\`
}

type ReplicationStore struct{}

func (s *ReplicationStore) Get(ctx context.Context, id string) (map[string]any, error) {
	return nil, nil
}

func (s *ReplicationStore) Put(ctx context.Context, id string, replication map[string]any) error {
	return nil
}

var store = &ReplicationStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createReplication(rw http.ResponseWriter, r *http.Request) {
	operator := r.Header.Get("X-Operator-Id")
	if operator == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Operator-Id"})
		return
	}
	var body ReplicationRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	policy := body.ConflictPolicy
	if policy == "" {
		policy = "last-write-wins"
	}
	replication := map[string]any{
		"id":              "rep-" + strconv.FormatInt(time.Now().Unix(), 10),
		"owner":           operator,
		"source_region":   body.SourceRegion,
		"target_region":   body.TargetRegion,
		"shards":          body.Shards,
		"conflict_policy": policy,
	}
	store.Put(r.Context(), replication["id"].(string), replication)
	writeJSON(rw, http.StatusCreated, replication)
}

func updateReplication(rw http.ResponseWriter, r *http.Request) {
	var body ReplicationRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	replication, err := store.Get(r.Context(), r.PathValue("id"))
	if err != nil || replication == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown replication"})
		return
	}
	if body.ConflictPolicy != "" {
		replication["conflict_policy"] = body.ConflictPolicy
	}
	store.Put(r.Context(), r.PathValue("id"), replication)
	writeJSON(rw, http.StatusOK, replication)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/replications", createReplication)
	mux.HandleFunc("PATCH /v1/replications/{id}", updateReplication)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"
)

const (
	skewBoundMS = 250
	maxShards   = 64
)

// The platform replicates between these ordered pairs only, and the policy is frozen when the
// replication starts.
var approvedRegionPairs = map[string]bool{
	"us-east-1->eu-west-1": true,
	"us-east-1->us-west-2": true,
	"eu-west-1->ap-south-1": true,
}

var conflictPolicies = map[string]bool{
	"source-wins":      true,
	"version-vector":   true,
	"manual":           true,
	"last-write-wins":  true,
}

type ReplicationRequest struct {
	SourceRegion   string \`json:"source_region"\`
	TargetRegion   string \`json:"target_region"\`
	Shards         []int  \`json:"shards"\`
	ConflictPolicy string \`json:"conflict_policy"\`
}

type ReplicationStore struct{}

func (s *ReplicationStore) Get(ctx context.Context, id string) (map[string]any, error) {
	return nil, nil
}

func (s *ReplicationStore) Put(ctx context.Context, id string, replication map[string]any) error {
	return nil
}

var store = &ReplicationStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// clockSkewMS measures the clock difference between the two regions against a shared time source.
func clockSkewMS(ctx context.Context, sourceRegion, targetRegion string) (int, error) {
	return 0, nil
}

func validShards(shards []int) bool {
	if len(shards) == 0 || len(shards) > maxShards {
		return false
	}
	seen := map[int]bool{}
	for _, shard := range shards {
		if shard < 0 || shard > 1023 || seen[shard] {
			return false
		}
		seen[shard] = true
	}
	return true
}

func createReplication(rw http.ResponseWriter, r *http.Request) {
	operator := r.Header.Get("X-Operator-Id")
	if operator == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Operator-Id"})
		return
	}
	var body ReplicationRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if !approvedRegionPairs[body.SourceRegion+"->"+body.TargetRegion] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "region pair is not approved"})
		return
	}
	if !conflictPolicies[body.ConflictPolicy] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "conflict_policy must be one of the documented policies"})
		return
	}
	if body.ConflictPolicy == "last-write-wins" {
		skew, err := clockSkewMS(r.Context(), body.SourceRegion, body.TargetRegion)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TR skew probe failed"})
			return
		}
		if skew > skewBoundMS {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "clock skew exceeds skewBoundMS: wall-clock ordering is unsound"})
			return
		}
	}
	if !validShards(body.Shards) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "shards must be 1..64 unique shard ids"})
		return
	}
	replication := map[string]any{
		"id":              "rep-" + strconv.FormatInt(time.Now().UnixNano(), 36),
		"owner":           operator,
		"source_region":   body.SourceRegion,
		"target_region":   body.TargetRegion,
		"shards":          body.Shards,
		"conflict_policy": body.ConflictPolicy,
	}
	if err := store.Put(r.Context(), replication["id"].(string), replication); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("replication %s started policy=%s", replication["id"], body.ConflictPolicy)
	writeJSON(rw, http.StatusCreated, replication)
}

func updateReplication(rw http.ResponseWriter, r *http.Request) {
	operator := r.Header.Get("X-Operator-Id")
	var body ReplicationRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	replication, err := store.Get(r.Context(), r.PathValue("id"))
	if err != nil || replication == nil || replication["owner"] != operator {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown replication"})
		return
	}
	if body.ConflictPolicy != "" && body.ConflictPolicy != replication["conflict_policy"] {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "conflict policy is immutable once the replication starts"})
		return
	}
	writeJSON(rw, http.StatusOK, replication)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/replications", createReplication)
	mux.HandleFunc("PATCH /v1/replications/{id}", updateReplication)
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

final case class ReplicationRequest(source_region: String, target_region: String, shards: List[Int], conflict_policy: Option[String])
final case class Replication(id: String, owner: String, source_region: String, target_region: String, shards: List[Int], conflict_policy: String)

object ReplicationApi {
  implicit val system: ActorSystem = ActorSystem("replicatord")
  implicit val requestFormat: RootJsonFormat[ReplicationRequest] = jsonFormat4(ReplicationRequest)
  implicit val replicationFormat: RootJsonFormat[Replication] = jsonFormat6(Replication)

  val store = ReplicationStore.open()

  val route: Route =
    path("v1" / "replications") {
      post {
        headerValueByName("X-Operator-Id") { operator =>
          entity(as[ReplicationRequest]) { body =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            val replication = Replication(
              id = s"rep-\${System.currentTimeMillis()}",
              owner = operator,
              source_region = body.source_region,
              target_region = body.target_region,
              shards = body.shards,
              conflict_policy = body.conflict_policy.getOrElse("last-write-wins"),
            )
            store.put(replication)
            complete(StatusCodes.Created, replication)
          }
        }
      }
    } ~
      path("v1" / "replications" / Segment) { replicationId =>
        patch {
          entity(as[ReplicationRequest]) { body =>
            store.get(replicationId) match {
              case None => complete(StatusCodes.NotFound, """{"error":"unknown replication"}""")
              case Some(replication) =>
                val updated = body.conflict_policy.fold(replication)(policy => replication.copy(conflict_policy = policy))
                store.put(updated)
                complete(StatusCodes.OK, updated)
            }
          }
        }
      }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ReplicationRequest(source_region: String, target_region: String, shards: List[Int], conflict_policy: Option[String])
final case class Replication(id: String, owner: String, source_region: String, target_region: String, shards: List[Int], conflict_policy: String)

object ReplicationApi {
  implicit val system: ActorSystem = ActorSystem("replicatord")
  implicit val requestFormat: RootJsonFormat[ReplicationRequest] = jsonFormat4(ReplicationRequest)
  implicit val replicationFormat: RootJsonFormat[Replication] = jsonFormat6(Replication)

  // Approved ordered region pairs, the documented conflict policies, and the largest clock skew
  // under which ordering by wall clock is still defensible.
  val ApprovedRegionPairs = Set("us-east-1->eu-west-1", "us-east-1->us-west-2", "eu-west-1->ap-south-1")
  val ConflictPolicies = Set("source-wins", "version-vector", "manual", "last-write-wins")
  val SkewBoundMS = 250
  val MaxShards = 64

  val store = ReplicationStore.open()

  def clockSkewMs(sourceRegion: String, targetRegion: String): Long = {
    throw new UnsupportedOperationException("probe the two regions’ clocks")
  }

  def validShards(shards: List[Int]): Boolean =
    shards.nonEmpty && shards.size <= MaxShards && shards.distinct.size == shards.size &&
      shards.forall(shard => shard >= 0 && shard <= 1023)

  val route: Route =
    path("v1" / "replications") {
      post {
        headerValueByName("X-Operator-Id") { operator =>
          entity(as[ReplicationRequest]) { body =>
            if (!ApprovedRegionPairs.contains(s"\${body.source_region}->\${body.target_region}")) {
              complete(StatusCodes.BadRequest, """{"error":"region pair is not approved"}""")
            } else if (!body.conflict_policy.exists(ConflictPolicies.contains)) {
              complete(StatusCodes.BadRequest, """{"error":"conflict_policy must be one of the documented policies"}""")
            } else if (body.conflict_policy.contains("last-write-wins") &&
                       clockSkewMs(body.source_region, body.target_region) > SkewBoundMS) {
              complete(
                StatusCodes.BadRequest,
                """{"error":"clock skew exceeds SkewBoundMS: wall-clock ordering is unsound"}""",
              )
            } else if (!validShards(body.shards)) {
              complete(StatusCodes.BadRequest, """{"error":"shards must be 1..64 unique shard ids"}""")
            } else {
              val replication = Replication(
                id = s"rep-\${UUID.randomUUID().toString.take(12)}",
                owner = operator,
                source_region = body.source_region,
                target_region = body.target_region,
                shards = body.shards,
                conflict_policy = body.conflict_policy.get,
              )
              store.put(replication)
              system.log.info(s"replication \${replication.id} started policy=\${replication.conflict_policy}")
              complete(StatusCodes.Created, replication)
            }
          }
        }
      }
    } ~
      path("v1" / "replications" / Segment) { replicationId =>
        patch {
          optionalHeaderValueByName("X-Operator-Id") { operatorOpt =>
            entity(as[ReplicationRequest]) { body =>
              store.get(replicationId) match {
                case Some(replication) if operatorOpt.contains(replication.owner) =>
                  if (body.conflict_policy.exists(_ != replication.conflict_policy)) {
                    complete(
                      StatusCodes.Conflict,
                      """{"error":"conflict policy is immutable once the replication starts"}""",
                    )
                  } else {
                    complete(StatusCodes.OK, replication)
                  }
                case _ => complete(StatusCodes.NotFound, """{"error":"unknown replication"}""")
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

#include <chrono>
#include <string>

using json = nlohmann::json;

struct ReplicationStore {
  std::optional<json> get(const std::string& replicationId);
  void put(const std::string& replicationId, const json& replication);
};

ReplicationStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/replications", [](const httplib::Request& req, httplib::Response& res) {
    const auto operatorId = req.get_header_value("X-Operator-Id");
    if (operatorId.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Operator-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const json replication = {
        {"id", "rep-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count())},
        {"owner", operatorId},
        {"source_region", body.value("source_region", std::string())},
        {"target_region", body.value("target_region", std::string())},
        {"shards", body.value("shards", json::array())},
        {"conflict_policy", body.value("conflict_policy", std::string("last-write-wins"))},
    };
    store.put(replication["id"].get<std::string>(), replication);
    res.status = 201;
    res.set_content(replication.dump(), "application/json");
  });

  svr.Patch(R"(/v1/replications/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    const auto replicationId = req.matches[1].str();
    const auto stored = store.get(replicationId);
    if (!stored) {
      res.status = 404;
      res.set_content(R"({"error":"unknown replication"})", "application/json");
      return;
    }
    json updated = *stored;
    if (body.contains("conflict_policy")) updated["conflict_policy"] = body["conflict_policy"];
    store.put(replicationId, updated);
    res.status = 200;
    res.set_content(updated.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

// The platform replicates between these ordered pairs only, and the policy is frozen when the
// replication starts.
const std::set<std::string> kApprovedRegionPairs = {
    "us-east-1->eu-west-1", "us-east-1->us-west-2", "eu-west-1->ap-south-1"};
const std::set<std::string> kConflictPolicies = {"source-wins", "version-vector", "manual", "last-write-wins"};
constexpr long long kSkewBoundMs = 250;
constexpr std::size_t kMaxShards = 64;

struct ReplicationStore {
  std::optional<json> get(const std::string& replicationId);
  void put(const std::string& replicationId, const json& replication);
};

ReplicationStore store;

std::string uuidString();
long long clockSkewMs(const std::string& sourceRegion, const std::string& targetRegion);

bool validShards(const json& shards) {
  if (!shards.is_array() || shards.empty() || shards.size() > kMaxShards) return false;
  std::set<int> seen;
  for (const auto& shard : shards) {
    if (!shard.is_number_integer()) return false;
    const int id = shard.get<int>();
    if (id < 0 || id > 1023 || !seen.insert(id).second) return false;
  }
  return true;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/replications", [](const httplib::Request& req, httplib::Response& res) {
    const auto operatorId = req.get_header_value("X-Operator-Id");
    if (operatorId.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Operator-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto sourceRegion = body.value("source_region", std::string());
    const auto targetRegion = body.value("target_region", std::string());
    if (kApprovedRegionPairs.count(sourceRegion + "->" + targetRegion) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"region pair is not approved"})", "application/json");
      return;
    }
    if (!body.contains("conflict_policy") || !body["conflict_policy"].is_string() ||
        kConflictPolicies.count(body["conflict_policy"].get<std::string>()) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"conflict_policy must be one of the documented policies"})", "application/json");
      return;
    }
    const auto policy = body["conflict_policy"].get<std::string>();
    if (policy == "last-write-wins" && clockSkewMs(sourceRegion, targetRegion) > kSkewBoundMs) {
      res.status = 400;
      res.set_content(R"({"error":"clock skew exceeds kSkewBoundMs: wall-clock ordering is unsound"})", "application/json");
      return;
    }
    if (!validShards(body["shards"])) {
      res.status = 400;
      res.set_content(R"({"error":"shards must be 1..64 unique shard ids"})", "application/json");
      return;
    }
    const json replication = {
        {"id", "rep-" + uuidString()},
        {"owner", operatorId},
        {"source_region", sourceRegion},
        {"target_region", targetRegion},
        {"shards", body["shards"]},
        {"conflict_policy", policy},
    };
    store.put(replication["id"].get<std::string>(), replication);
    res.status = 201;
    res.set_content(replication.dump(), "application/json");
  });

  svr.Patch(R"(/v1/replications/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto operatorId = req.get_header_value("X-Operator-Id");
    json body = json::parse(req.body, nullptr, false);
    const auto replicationId = req.matches[1].str();
    const auto stored = store.get(replicationId);
    if (!stored || (*stored)["owner"].get<std::string>() != operatorId) {
      res.status = 404;
      res.set_content(R"({"error":"unknown replication"})", "application/json");
      return;
    }
    if (body.contains("conflict_policy") && body["conflict_policy"] != (*stored)["conflict_policy"]) {
      res.status = 409;
      res.set_content(R"({"error":"conflict policy is immutable once the replication starts"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(stored->dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Start a replication from `us-east-1` to a region that is not on the allowlist, or omit `conflict_policy`: the starter answers 201 both times, and a later `PATCH` quietly changes the policy.',
    'Nothing in the create path consults an allowlist or a policy set, `conflict_policy or "last-write-wins"` fills the gap, and the update handler assigns whatever policy the body carries.',
    'Add `APPROVED_REGION_PAIRS`, `CONFLICT_POLICIES` and `SKEW_BOUND_MS`; reject unapproved pairs, missing policies and last-write-wins above the skew with 400; make `PATCH` compare and answer 409 `immutable`.',
  ],
  debrief: `The fixes are guard clauses placed before anything is stored, in cost order: operator, approved pair, policy set, skew probe, shard set. The skew probe sits inside the last-write-wins branch because that is the only policy that reads a wall clock, so it is the only one whose soundness depends on the two clocks agreeing. Immutability is a comparison rather than a delete: the create path records the policy, the update path answers 409 when the requested value differs, and rows already merged under the old rule stay consistent with the rule on record. Production replicators go further: they record a policy version on every applied batch, keep a region catalogue with residency rules, and audit who started and stopped each replication.`,
};
