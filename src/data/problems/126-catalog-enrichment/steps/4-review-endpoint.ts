import type {Step} from '@/lib/types';

export const reviewEndpointStep: Step = {
  id: 'review-endpoint',
  title: 'POST /v1/skus/{sku_id}/review: role, lease, idempotency, versioned labels',
  concept: 'http',
  file: 'review_api',
  focus: ['reviewer', 'catalogd', 'taxonomy', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route,
reads the reviewer's decision and writes the attributes to the catalog. It compiles, it serves the
demo, and it hides five production flaws. Review it like the owner of the labelling pipeline, fix
it, and prove the fix with the checks below.

Implement \`POST /v1/skus/{sku_id}/review\` with body
\`{"decision": "accept" | "correct", "attributes": {…}, "note": "…"}\`:

- The reviewer comes from the authenticated \`X-Reviewer-Id\` header (**401** when missing) and
  their role from \`X-Reviewer-Role\`, set by the gateway; **403** unless the role is one of
  \`REVIEWER_ROLES\` (\`reviewer\`, \`catalog-admin\`). Anyone who can reach the service must not
  be able to label the catalog.
- \`decision\` is one of \`ALLOWED_DECISIONS\` (**400** otherwise). \`correct\` requires
  \`attributes\` whose keys are all in \`ALLOWED_ATTRIBUTES\` (\`brand\`, \`size\`, \`unit\`,
  \`organic\`, \`category\`; **400** otherwise); \`note\` is at most **1 KiB**.
- \`Idempotency-Key\` is required (**400**). A retry with the same \`(reviewer, key)\` returns the
  stored outcome instead of labelling twice.
- The SKU must have a pending proposal (**404** otherwise) and the caller must **hold its review
  lease** (**409** when another reviewer does, or nobody does).
- Both decisions are labels: \`accept\` confirms the proposal, \`correct\` merges the reviewer's
  attributes over it. Store the result with \`labels.put(sku_id, attributes, taxonomy_version,
  reviewer)\`, which returns the label version; then apply it to the catalog with
  \`source: "human"\`, release the lease, and answer with the label version and the taxonomy
  version. Never log the attributes or the note — log ids and the decision.

**Failure mode the checks target.** The draft lets any caller with a header rewrite the catalog, lets
two reviewers overwrite each other, double-applies on retry, accepts any attribute key, and — the
expensive one — throws the correction away: it edits the catalog row and keeps nothing for the
next model, so the human work the source post relies on to train the next extractor is lost.`,
  sequence: {
    participants: ['Reviewer', 'catalogd', 'review store', 'labels', 'catalog'],
    messages: [
      {
        from: 'Reviewer',
        to: 'catalogd',
        label: 'POST /v1/skus/{sku_id}/review · X-Reviewer-Id · Idempotency-Key',
        kind: 'sync',
      },
      {from: 'catalogd', to: 'catalogd', label: 'role · decision · attribute keys · note size', kind: 'sync'},
      {from: 'catalogd', to: 'review store', label: 'get(reviewer, idem_key)', kind: 'sync'},
      {from: 'review store', to: 'catalogd', label: 'stored outcome / none', kind: 'reply'},
      {from: 'catalogd', to: 'catalog', label: 'pending(sku_id) · lease holder', kind: 'sync'},
      {from: 'catalogd', to: 'labels', label: 'put(sku_id, attributes, taxonomy_version, reviewer)', kind: 'sync'},
      {from: 'labels', to: 'catalogd', label: 'label_version', kind: 'reply'},
      {from: 'catalogd', to: 'catalog', label: 'apply(sku_id, attributes, source=human) · release lease', kind: 'sync'},
      {from: 'catalogd', to: 'review store', label: 'put(reviewer, idem_key, outcome)', kind: 'async'},
      {from: 'catalogd', to: 'Reviewer', label: '200 {label_version, taxonomy_version, attributes}', kind: 'reply'},
    ],
  },
  hints: [
    'Guard clauses first, cheapest first: reviewer id (401), role in `REVIEWER_ROLES` (403), Idempotency-Key (400), decision in `ALLOWED_DECISIONS`, attribute keys ⊆ `ALLOWED_ATTRIBUTES`, note size. Nothing below them touches a store.',
    'The idempotency lookup is `reviews.get(reviewer, idem_key)` and happens before the lease check; the outcome you store at the end is the body you returned. Then `catalog.pending(sku_id)` (404) and `lease.holder(sku_id) == reviewer` (409).',
    'A decision is a label before it is a catalog edit: `labels.put(sku_id, attributes, pending["taxonomy_version"], reviewer)` returns the version; only then `catalog.apply(..., source="human")` and `lease.release(sku_id, reviewer)`.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/skus/{sku_id}/review',
      detail: 'Register the review route on `POST /v1/skus/{sku_id}/review`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/skus\/\{sku_id\}\/review["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/skus\/:skuId\/review['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/skus\/\{sku_id\}\/review"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"skus"\s*\/\s*Segment\s*\/\s*"review"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*R"\(\/v1\/skus\//]},
      },
    },
    {
      id: 'reviewer-role',
      title: 'Requires a reviewer id and a reviewer role',
      detail:
        'A missing `X-Reviewer-Id` is **401** and a role outside `REVIEWER_ROLES` (`reviewer`, `catalog-admin`) is **403**, before any store is touched. The draft accepts any caller that sets the header.',
      match: {
        python: {all: [/REVIEWER_ROLES/, /X-Reviewer-Role/, /status_code\s*=\s*401/, /status_code\s*=\s*403/]},
        typescript: {all: [/REVIEWER_ROLES/, /x-reviewer-role/, /code\(\s*401\s*\)/, /code\(\s*403\s*\)/]},
        go: {all: [/reviewerRoles/, /X-Reviewer-Role/, /StatusUnauthorized/, /StatusForbidden/]},
        scala: {all: [/ReviewerRoles/, /X-Reviewer-Role/, /StatusCodes\.Unauthorized/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/kReviewerRoles/, /X-Reviewer-Role/, /\b401\b/, /\b403\b/]},
      },
    },
    {
      id: 'validate-decision',
      title: 'Validates the decision, the attribute keys and the note',
      detail:
        '`decision` must be in `ALLOWED_DECISIONS`, every corrected attribute key in `ALLOWED_ATTRIBUTES`, and the note at most `MAX_NOTE_BYTES = 1024`; each failure is **400**. The draft writes whatever keys the body contains into the catalog.',
      match: {
        python: {
          all: [/ALLOWED_DECISIONS/, /ALLOWED_ATTRIBUTES/, /MAX_NOTE_BYTES\s*=\s*1024/, /status_code\s*=\s*400/],
        },
        typescript: {
          all: [/ALLOWED_DECISIONS/, /ALLOWED_ATTRIBUTES/, /MAX_NOTE_BYTES\s*=\s*1024/, /code\(\s*400\s*\)/],
        },
        go: {all: [/allowedDecisions/, /allowedAttributes/, /maxNoteBytes\s*=\s*1024/, /StatusBadRequest/]},
        scala: {all: [/AllowedDecisions/, /AllowedAttributes/, /MaxNoteBytes\s*=\s*1024/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kAllowedDecisions/, /kAllowedAttributes/, /kMaxNoteBytes\s*=\s*1024/, /\b400\b/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys retries by (reviewer, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required and the outcome is stored under `(reviewer, key)`; a replay returns the stored outcome instead of labelling twice. The draft ignores the header.',
      match: {
        python: {all: [/Idempotency-Key/, /reviews\.get\(/, /reviews\.put\(/]},
        typescript: {all: [/idempotency-key/, /reviews\.get\(/, /reviews\.put\(/]},
        go: {all: [/Idempotency-Key/, /reviews\.Get\(/, /reviews\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /reviews\.get\(/, /reviews\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /reviews\.get\(/, /reviews\.put\(/]},
      },
    },
    {
      id: 'lease-and-label',
      title: 'Requires the lease and stores the decision as a versioned label',
      detail:
        'The caller must hold the SKU’s lease (**409** otherwise); the decision is stored with `labels.put(sku_id, attributes, taxonomy_version, reviewer)` before the catalog is updated with `source: "human"` and the lease released. The draft edits the catalog and keeps no label.',
      match: {
        python: {
          all: [/lease\.holder\(/, /status_code\s*=\s*409/, /taxonomy_version/, /lease\.release\(/],
          order: [/= labels\.put\(/, /catalog\.apply\(/],
        },
        typescript: {
          all: [/lease\.holder\(/, /code\(\s*409\s*\)/, /taxonomy_version/, /lease\.release\(/],
          order: [/= await labels\.put\(/, /catalog\.apply\(/],
        },
        go: {
          all: [/lease\.Holder\(/, /StatusConflict/, /TaxonomyVersion/, /lease\.Release\(/],
          order: [/:= labels\.Put\(/, /catalog\.Apply\(/],
        },
        scala: {
          all: [/lease\.holder\(/, /StatusCodes\.Conflict/, /taxonomy_version/, /lease\.release\(/],
          order: [/= labels\.put\(/, /catalog\.apply\(/],
        },
        cpp: {
          all: [/lease\.holder\(/, /\b409\b/, /taxonomy_version/, /lease\.release\(/],
          order: [/= labels\.put\(/, /catalog\.apply\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("review")


class ReviewRequest(BaseModel):
    decision: str
    attributes: dict | None = None
    note: str = ""


class Catalog:
    def pending(self, sku_id: str) -> dict | None:
        """The model's proposal awaiting review: {attributes, taxonomy_version}."""
        raise NotImplementedError

    def apply(self, sku_id: str, attributes: dict, source: str) -> None:
        raise NotImplementedError


catalog = Catalog()


@app.post("/v1/skus/{sku_id}/review")
def review(sku_id: str, body: ReviewRequest, reviewer: str = Header(alias="X-Reviewer-Id")) -> JSONResponse:
    # TODO: this draft trusts any caller with a header, ignores Idempotency-Key, accepts any
    # attribute keys, never checks the review lease, and keeps no label of the decision. Review all five.
    pending = catalog.pending(sku_id) or {"attributes": {}}
    attributes = pending["attributes"] if body.decision == "accept" else {**pending["attributes"], **(body.attributes or {})}
    catalog.apply(sku_id, attributes, source="human")
    logger.info("review sku=%s reviewer=%s attributes=%r note=%r", sku_id, reviewer, attributes, body.note)
    return JSONResponse({"sku_id": sku_id, "attributes": attributes}, status_code=200)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("review")

REVIEWER_ROLES = {"reviewer", "catalog-admin"}
ALLOWED_DECISIONS = {"accept", "correct"}
ALLOWED_ATTRIBUTES = {"brand", "size", "unit", "organic", "category"}
MAX_NOTE_BYTES = 1024


class ReviewRequest(BaseModel):
    decision: str
    attributes: dict | None = None
    note: str = ""


class ReviewStore:
    def get(self, reviewer: str, idem_key: str) -> dict | None:
        """The outcome stored for (reviewer, idem_key), if any."""
        raise NotImplementedError

    def put(self, reviewer: str, idem_key: str, outcome: dict) -> None:
        raise NotImplementedError


class LabelStore:
    def put(self, sku_id: str, attributes: dict, taxonomy_version: str, reviewer: str) -> int:
        """Append a labelled example; returns its version."""
        raise NotImplementedError


class ReviewLease:
    def holder(self, sku_id: str) -> str | None:
        raise NotImplementedError

    def release(self, sku_id: str, reviewer: str) -> bool:
        raise NotImplementedError


class Catalog:
    def pending(self, sku_id: str) -> dict | None:
        """The model's proposal awaiting review: {attributes, taxonomy_version}."""
        raise NotImplementedError

    def apply(self, sku_id: str, attributes: dict, source: str) -> None:
        raise NotImplementedError


reviews = ReviewStore()
labels = LabelStore()
lease = ReviewLease()
catalog = Catalog()


@app.post("/v1/skus/{sku_id}/review")
def review(
    sku_id: str,
    body: ReviewRequest,
    reviewer: str | None = Header(default=None, alias="X-Reviewer-Id"),
    role: str | None = Header(default=None, alias="X-Reviewer-Role"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if reviewer is None or reviewer == "":
        raise HTTPException(status_code=401, detail="missing X-Reviewer-Id")
    if role not in REVIEWER_ROLES:
        raise HTTPException(status_code=403, detail="reviewer role required")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.decision not in ALLOWED_DECISIONS:
        raise HTTPException(status_code=400, detail="decision must be accept or correct")
    corrections = body.attributes or {}
    if body.decision == "correct" and not corrections:
        raise HTTPException(status_code=400, detail="correct requires attributes")
    unknown = set(corrections) - ALLOWED_ATTRIBUTES
    if unknown:
        raise HTTPException(status_code=400, detail=f"unknown attributes: {sorted(unknown)}")
    if len(body.note.encode("utf-8")) > MAX_NOTE_BYTES:
        raise HTTPException(status_code=400, detail="note exceeds 1 KiB")

    stored = reviews.get(reviewer, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    pending = catalog.pending(sku_id)
    if pending is None:
        raise HTTPException(status_code=404, detail="no proposal awaiting review")
    if lease.holder(sku_id) != reviewer:
        raise HTTPException(status_code=409, detail="review lease is held by another reviewer")

    attributes = {**pending["attributes"], **corrections} if body.decision == "correct" else pending["attributes"]
    label_version = labels.put(sku_id, attributes, pending["taxonomy_version"], reviewer)
    catalog.apply(sku_id, attributes, source="human")
    lease.release(sku_id, reviewer)

    outcome = {
        "review_id": str(uuid.uuid4()),
        "sku_id": sku_id,
        "decision": body.decision,
        "attributes": attributes,
        "label_version": label_version,
        "taxonomy_version": pending["taxonomy_version"],
    }
    reviews.put(reviewer, idem_key, outcome)
    logger.info("review sku=%s reviewer=%s decision=%s label=%d", sku_id, reviewer, body.decision, label_version)
    return JSONResponse(outcome, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/skus/:skuId/review: a model-generated draft that writes any caller's edit to the catalog. */
import Fastify from 'fastify';

import {catalog} from './catalog';

export const app = Fastify();

interface ReviewBody {
  decision: string;
  attributes?: Record<string, unknown>;
  note?: string;
}

app.post('/v1/skus/:skuId/review', async (request, reply) => {
  // TODO: this draft trusts any caller with a header, ignores Idempotency-Key, accepts any
  // attribute keys, never checks the review lease, and keeps no label of the decision. Review all five.
  const {skuId} = request.params as {skuId: string};
  const reviewer = request.headers['x-reviewer-id'] as string;
  const body = request.body as ReviewBody;
  const pending = (await catalog.pending(skuId)) ?? {attributes: {}, taxonomy_version: ''};
  const attributes = body.decision === 'accept' ? pending.attributes : {...pending.attributes, ...(body.attributes ?? {})};
  await catalog.apply(skuId, attributes, 'human');
  request.log.info({skuId, reviewer, attributes, note: body.note}, 'reviewed');
  return reply.code(200).send({sku_id: skuId, attributes});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/skus/:skuId/review: role-gated, lease-checked, idempotent, every decision a versioned label. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {catalog, labels, lease, reviews} from './catalog';

export const app = Fastify();

const REVIEWER_ROLES: Record<string, true> = {reviewer: true, 'catalog-admin': true};
const ALLOWED_DECISIONS: Record<string, true> = {accept: true, correct: true};
const ALLOWED_ATTRIBUTES: Record<string, true> = {brand: true, size: true, unit: true, organic: true, category: true};
const MAX_NOTE_BYTES = 1024;

interface ReviewBody {
  decision: string;
  attributes?: Record<string, unknown>;
  note?: string;
}

interface Outcome {
  review_id: string;
  sku_id: string;
  decision: string;
  attributes: Record<string, unknown>;
  label_version: number;
  taxonomy_version: string;
}

app.post('/v1/skus/:skuId/review', async (request, reply) => {
  const {skuId} = request.params as {skuId: string};
  const reviewer = request.headers['x-reviewer-id'];
  if (typeof reviewer !== 'string' || reviewer === '') return reply.code(401).send({error: 'missing X-Reviewer-Id'});
  const role = request.headers['x-reviewer-role'];
  if (typeof role !== 'string' || REVIEWER_ROLES[role] !== true)
    return reply.code(403).send({error: 'reviewer role required'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<ReviewBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.decision !== 'string' || ALLOWED_DECISIONS[body.decision] !== true)
    return reply.code(400).send({error: 'decision must be accept or correct'});
  const corrections = body.attributes ?? {};
  if (body.decision === 'correct' && Object.keys(corrections).length === 0)
    return reply.code(400).send({error: 'correct requires attributes'});
  const unknown = Object.keys(corrections).filter(key => ALLOWED_ATTRIBUTES[key] !== true);
  if (unknown.length > 0) return reply.code(400).send({error: \`unknown attributes: \${unknown.join(', ')}\`});
  const note = body.note ?? '';
  if (Buffer.byteLength(note, 'utf8') > MAX_NOTE_BYTES) return reply.code(400).send({error: 'note exceeds 1 KiB'});

  const stored = await reviews.get(reviewer, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const pending = await catalog.pending(skuId);
  if (pending === null) return reply.code(404).send({error: 'no proposal awaiting review'});
  if ((await lease.holder(skuId)) !== reviewer)
    return reply.code(409).send({error: 'review lease is held by another reviewer'});

  const attributes = body.decision === 'correct' ? {...pending.attributes, ...corrections} : pending.attributes;
  const labelVersion = await labels.put(skuId, attributes, pending.taxonomy_version, reviewer);
  await catalog.apply(skuId, attributes, 'human');
  await lease.release(skuId, reviewer);

  const outcome: Outcome = {
    review_id: randomUUID(),
    sku_id: skuId,
    decision: body.decision,
    attributes,
    label_version: labelVersion,
    taxonomy_version: pending.taxonomy_version,
  };
  await reviews.put(reviewer, idemKey, outcome);
  request.log.info({skuId, reviewer, decision: body.decision, labelVersion}, 'reviewed');
  return reply.code(200).send(outcome);
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
)

type ReviewRequest struct {
	Decision   string         \`json:"decision"\`
	Attributes map[string]any \`json:"attributes"\`
	Note       string         \`json:"note"\`
}

type Proposal struct {
	Attributes      map[string]any
	TaxonomyVersion string
}

type Catalog struct{}

func (c *Catalog) Pending(skuID string) (*Proposal, error) { return nil, nil }

func (c *Catalog) Apply(skuID string, attributes map[string]any, source string) error { return nil }

var catalog = &Catalog{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func review(rw http.ResponseWriter, r *http.Request) {
	skuID := r.PathValue("sku_id")
	reviewer := r.Header.Get("X-Reviewer-Id")
	var body ReviewRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft trusts any caller with a header, ignores Idempotency-Key, accepts any
	// attribute keys, never checks the review lease, and keeps no label of the decision. Review all five.
	pending, _ := catalog.Pending(skuID)
	attributes := map[string]any{}
	if pending != nil {
		for k, v := range pending.Attributes {
			attributes[k] = v
		}
	}
	if body.Decision != "accept" {
		for k, v := range body.Attributes {
			attributes[k] = v
		}
	}
	_ = catalog.Apply(skuID, attributes, "human")
	log.Printf("review sku=%s reviewer=%s attributes=%v note=%q", skuID, reviewer, attributes, body.Note)
	writeJSON(rw, http.StatusOK, map[string]any{"sku_id": skuID, "attributes": attributes})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/skus/{sku_id}/review", review)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"

	"github.com/google/uuid"
)

const maxNoteBytes = 1024

var (
	reviewerRoles     = map[string]bool{"reviewer": true, "catalog-admin": true}
	allowedDecisions  = map[string]bool{"accept": true, "correct": true}
	allowedAttributes = map[string]bool{"brand": true, "size": true, "unit": true, "organic": true, "category": true}
)

type ReviewRequest struct {
	Decision   string         \`json:"decision"\`
	Attributes map[string]any \`json:"attributes"\`
	Note       string         \`json:"note"\`
}

type Proposal struct {
	Attributes      map[string]any
	TaxonomyVersion string
}

type Outcome struct {
	ReviewID        string         \`json:"review_id"\`
	SkuID           string         \`json:"sku_id"\`
	Decision        string         \`json:"decision"\`
	Attributes      map[string]any \`json:"attributes"\`
	LabelVersion    int64          \`json:"label_version"\`
	TaxonomyVersion string         \`json:"taxonomy_version"\`
}

type ReviewStore struct{}

func (s *ReviewStore) Get(reviewer, idemKey string) (*Outcome, error) { return nil, nil }

func (s *ReviewStore) Put(reviewer, idemKey string, outcome Outcome) error { return nil }

// LabelStore appends labelled examples for the next model; Put returns the label version.
type LabelStore struct{}

func (s *LabelStore) Put(skuID string, attributes map[string]any, taxonomyVersion, reviewer string) (int64, error) {
	return 0, nil
}

type ReviewLease struct{}

func (l *ReviewLease) Holder(skuID string) (string, error) { return "", nil }

func (l *ReviewLease) Release(skuID, reviewer string) (bool, error) { return true, nil }

type Catalog struct{}

func (c *Catalog) Pending(skuID string) (*Proposal, error) { return nil, nil }

func (c *Catalog) Apply(skuID string, attributes map[string]any, source string) error { return nil }

var (
	reviews = &ReviewStore{}
	labels  = &LabelStore{}
	lease   = &ReviewLease{}
	catalog = &Catalog{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func review(rw http.ResponseWriter, r *http.Request) {
	skuID := r.PathValue("sku_id")
	reviewer := r.Header.Get("X-Reviewer-Id")
	if reviewer == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Reviewer-Id"})
		return
	}
	if !reviewerRoles[r.Header.Get("X-Reviewer-Role")] {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "reviewer role required"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body ReviewRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if !allowedDecisions[body.Decision] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "decision must be accept or correct"})
		return
	}
	if body.Decision == "correct" && len(body.Attributes) == 0 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "correct requires attributes"})
		return
	}
	var unknown []string
	for key := range body.Attributes {
		if !allowedAttributes[key] {
			unknown = append(unknown, key)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("unknown attributes: %v", unknown)})
		return
	}
	if len(body.Note) > maxNoteBytes {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "note exceeds 1 KiB"})
		return
	}

	stored, err := reviews.Get(reviewer, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}

	pending, err := catalog.Pending(skuID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if pending == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no proposal awaiting review"})
		return
	}
	holder, err := lease.Holder(skuID)
	if err != nil || holder != reviewer {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "review lease is held by another reviewer"})
		return
	}

	attributes := make(map[string]any, len(pending.Attributes))
	for k, v := range pending.Attributes {
		attributes[k] = v
	}
	if body.Decision == "correct" {
		for k, v := range body.Attributes {
			attributes[k] = v
		}
	}
	labelVersion, err := labels.Put(skuID, attributes, pending.TaxonomyVersion, reviewer)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if err := catalog.Apply(skuID, attributes, "human"); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	_, _ = lease.Release(skuID, reviewer)

	outcome := Outcome{
		ReviewID:        uuid.NewString(),
		SkuID:           skuID,
		Decision:        body.Decision,
		Attributes:      attributes,
		LabelVersion:    labelVersion,
		TaxonomyVersion: pending.TaxonomyVersion,
	}
	_ = reviews.Put(reviewer, idemKey, outcome)
	log.Printf("review sku=%s reviewer=%s decision=%s label=%d", skuID, reviewer, body.Decision, labelVersion)
	writeJSON(rw, http.StatusOK, outcome)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/skus/{sku_id}/review", review)
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
import spray.json._

final case class ReviewRequest(decision: String, attributes: Option[Map[String, JsValue]], note: Option[String])

object ReviewApi {
  import DefaultJsonProtocol._
  implicit val system: ActorSystem = ActorSystem("catalogd")
  implicit val reviewFormat: RootJsonFormat[ReviewRequest] = jsonFormat3(ReviewRequest)

  val catalog = Catalog.open()

  val route: Route =
    path("v1" / "skus" / Segment / "review") { skuId =>
      post {
        headerValueByName("X-Reviewer-Id") { reviewer =>
          entity(as[ReviewRequest]) { body =>
            // TODO: this draft trusts any caller with a header, ignores Idempotency-Key, accepts
            // any attribute keys, never checks the review lease, and keeps no label of the decision.
            val pending = catalog.pending(skuId).map(_.attributes).getOrElse(Map.empty[String, JsValue])
            val attributes = if (body.decision == "accept") pending else pending ++ body.attributes.getOrElse(Map.empty)
            catalog.apply(skuId, attributes, "human")
            system.log.info(s"review sku=$skuId reviewer=$reviewer attributes=$attributes note=\${body.note}")
            complete(StatusCodes.OK, JsObject("sku_id" -> JsString(skuId), "attributes" -> JsObject(attributes)))
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

final case class ReviewRequest(decision: String, attributes: Option[Map[String, JsValue]], note: Option[String])

object ReviewApi {
  import DefaultJsonProtocol._
  implicit val system: ActorSystem = ActorSystem("catalogd")
  implicit val reviewFormat: RootJsonFormat[ReviewRequest] = jsonFormat3(ReviewRequest)

  val ReviewerRoles = Set("reviewer", "catalog-admin")
  val AllowedDecisions = Set("accept", "correct")
  val AllowedAttributes = Set("brand", "size", "unit", "organic", "category")
  val MaxNoteBytes = 1024

  val reviews = ReviewStore.open()
  val labels = LabelStore.open()
  val lease = ReviewLease.open()
  val catalog = Catalog.open()

  def error(status: StatusCode, message: String): Route =
    complete(status, JsObject("error" -> JsString(message)))

  val route: Route =
    path("v1" / "skus" / Segment / "review") { skuId =>
      post {
        optionalHeaderValueByName("X-Reviewer-Id") { reviewerOpt =>
          optionalHeaderValueByName("X-Reviewer-Role") { roleOpt =>
            optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
              entity(as[ReviewRequest]) { body =>
                val corrections = body.attributes.getOrElse(Map.empty[String, JsValue])
                val unknown = corrections.keySet.diff(AllowedAttributes)
                val note = body.note.getOrElse("")
                if (!reviewerOpt.exists(_.nonEmpty)) error(StatusCodes.Unauthorized, "missing X-Reviewer-Id")
                else if (!roleOpt.exists(ReviewerRoles.contains)) error(StatusCodes.Forbidden, "reviewer role required")
                else if (!idemOpt.exists(_.nonEmpty)) error(StatusCodes.BadRequest, "Idempotency-Key is required")
                else if (!AllowedDecisions.contains(body.decision))
                  error(StatusCodes.BadRequest, "decision must be accept or correct")
                else if (body.decision == "correct" && corrections.isEmpty)
                  error(StatusCodes.BadRequest, "correct requires attributes")
                else if (unknown.nonEmpty)
                  error(StatusCodes.BadRequest, s"unknown attributes: \${unknown.toList.sorted.mkString(", ")}")
                else if (note.getBytes(StandardCharsets.UTF_8).length > MaxNoteBytes)
                  error(StatusCodes.BadRequest, "note exceeds 1 KiB")
                else {
                  val reviewer = reviewerOpt.get
                  val idemKey = idemOpt.get
                  reviews.get(reviewer, idemKey) match {
                    case Some(stored) => complete(StatusCodes.OK, stored)
                    case None =>
                      catalog.pending(skuId) match {
                        case None => error(StatusCodes.NotFound, "no proposal awaiting review")
                        case Some(pending) =>
                          if (!lease.holder(skuId).contains(reviewer))
                            error(StatusCodes.Conflict, "review lease is held by another reviewer")
                          else {
                            val attributes =
                              if (body.decision == "correct") pending.attributes ++ corrections else pending.attributes
                            val labelVersion = labels.put(skuId, attributes, pending.taxonomyVersion, reviewer)
                            catalog.apply(skuId, attributes, "human")
                            lease.release(skuId, reviewer)
                            val outcome = JsObject(
                              "review_id" -> JsString(UUID.randomUUID().toString),
                              "sku_id" -> JsString(skuId),
                              "decision" -> JsString(body.decision),
                              "attributes" -> JsObject(attributes),
                              "label_version" -> JsNumber(labelVersion),
                              "taxonomy_version" -> JsString(pending.taxonomyVersion)
                            )
                            reviews.put(reviewer, idemKey, outcome)
                            system.log.info(
                              s"review sku=$skuId reviewer=$reviewer decision=\${body.decision} label=$labelVersion"
                            )
                            complete(StatusCodes.OK, outcome)
                          }
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

#include <iostream>
#include <optional>
#include <string>

using json = nlohmann::json;

struct Proposal {
  json attributes;
  std::string taxonomy_version;
};

struct Catalog {
  std::optional<Proposal> pending(const std::string& skuId);
  void apply(const std::string& skuId, const json& attributes, const std::string& source);
};

Catalog catalog;

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post(R"(/v1/skus/([^/]+)/review)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string skuId = req.matches[1];
    const auto reviewer = req.get_header_value("X-Reviewer-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft trusts any caller with a header, ignores Idempotency-Key, accepts any
    // attribute keys, never checks the review lease, and keeps no label of the decision. Review all five.
    const auto pending = catalog.pending(skuId);
    json attributes = pending ? pending->attributes : json::object();
    if (body.value("decision", std::string()) != "accept" && body.contains("attributes"))
      attributes.update(body["attributes"]);
    catalog.apply(skuId, attributes, "human");
    std::cerr << "review sku=" << skuId << " reviewer=" << reviewer << " attributes=" << attributes.dump()
              << " note=" << body.value("note", std::string()) << "\\n";
    res.status = 200;
    res.set_content(json{{"sku_id", skuId}, {"attributes", attributes}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::set<std::string> kReviewerRoles = {"reviewer", "catalog-admin"};
const std::set<std::string> kAllowedDecisions = {"accept", "correct"};
const std::set<std::string> kAllowedAttributes = {"brand", "size", "unit", "organic", "category"};
constexpr std::size_t kMaxNoteBytes = 1024;

struct Proposal {
  json attributes;
  std::string taxonomy_version;
};

struct ReviewStore {
  std::optional<json> get(const std::string& reviewer, const std::string& idemKey);
  void put(const std::string& reviewer, const std::string& idemKey, const json& outcome);
};

// Appends labelled examples for the next model; put returns the label version.
struct LabelStore {
  long long put(const std::string& skuId, const json& attributes, const std::string& taxonomyVersion,
                const std::string& reviewer);
};

struct ReviewLease {
  std::optional<std::string> holder(const std::string& skuId);
  bool release(const std::string& skuId, const std::string& reviewer);
};

struct Catalog {
  std::optional<Proposal> pending(const std::string& skuId);
  void apply(const std::string& skuId, const json& attributes, const std::string& source);
};

ReviewStore reviews;
LabelStore labels;
ReviewLease lease;
Catalog catalog;
std::string uuidString();

void fail(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post(R"(/v1/skus/([^/]+)/review)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string skuId = req.matches[1];
    const auto reviewer = req.get_header_value("X-Reviewer-Id");
    if (reviewer.empty()) return fail(res, 401, "missing X-Reviewer-Id");
    if (kReviewerRoles.count(req.get_header_value("X-Reviewer-Role")) == 0)
      return fail(res, 403, "reviewer role required");
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) return fail(res, 400, "Idempotency-Key is required");

    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("decision") || !body["decision"].is_string())
      return fail(res, 400, "decision must be accept or correct");
    const auto decision = body["decision"].get<std::string>();
    if (kAllowedDecisions.count(decision) == 0) return fail(res, 400, "decision must be accept or correct");
    const json corrections = body.contains("attributes") && body["attributes"].is_object() ? body["attributes"] : json::object();
    if (decision == "correct" && corrections.empty()) return fail(res, 400, "correct requires attributes");
    std::vector<std::string> unknown;
    for (const auto& [key, value] : corrections.items())
      if (kAllowedAttributes.count(key) == 0) unknown.push_back(key);
    if (!unknown.empty()) return fail(res, 400, "unknown attributes: " + json(unknown).dump());
    if (body.value("note", std::string()).size() > kMaxNoteBytes) return fail(res, 400, "note exceeds 1 KiB");

    if (const auto stored = reviews.get(reviewer, idemKey)) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }

    const auto pending = catalog.pending(skuId);
    if (!pending) return fail(res, 404, "no proposal awaiting review");
    const auto holder = lease.holder(skuId);
    if (!holder || *holder != reviewer) return fail(res, 409, "review lease is held by another reviewer");

    json attributes = pending->attributes;
    if (decision == "correct") attributes.update(corrections);
    const long long labelVersion = labels.put(skuId, attributes, pending->taxonomy_version, reviewer);
    catalog.apply(skuId, attributes, "human");
    lease.release(skuId, reviewer);

    const json outcome = {
        {"review_id", uuidString()},
        {"sku_id", skuId},
        {"decision", decision},
        {"attributes", attributes},
        {"label_version", labelVersion},
        {"taxonomy_version", pending->taxonomy_version},
    };
    reviews.put(reviewer, idemKey, outcome);
    std::cerr << "review sku=" << skuId << " reviewer=" << reviewer << " decision=" << decision
              << " label=" << labelVersion << "\\n";
    res.status = 200;
    res.set_content(outcome.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a generated handler at the boundary where humans write into a model's world. Three of the five flaws are ordinary trust-boundary work: a role check (anyone who can reach the service is not a reviewer), input whitelists (a correction with an unknown key is a schema change nobody approved), and idempotency keyed by reviewer so a retried request does not label twice. The lease check is the concurrency flaw: without it the lease from step 3 is decorative and two reviewers silently overwrite each other. The label store is the one that matters to the business: in the source posts the reviewers' decisions are the golden annotations that train the next extractor, so a review endpoint that only edits the catalog row is throwing away the most expensive data the system produces. Storing the decision with the taxonomy version it was made under is what lets the training job tell which labels still apply after a taxonomy release. Real systems add reviewer agreement sampling (a second reviewer on a percentage of decisions, the "second human audits the first" the post describes), per-reviewer accuracy against that sample, and a feed from the labels into an eval set that gates the next model.`,
};
