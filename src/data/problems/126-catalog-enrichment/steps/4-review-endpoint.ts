import type {Step} from '@/lib/types';

export const reviewEndpointStep: Step = {
  id: 'review-endpoint',
  title: 'POST /v1/skus/{sku_id}/review: role, lease, idempotency, versioned labels',
  concept: 'http',
  file: 'review_api',
  focus: ['reviewer', 'catalogd', 'redis', 'enriched'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/skus/{sku_id}/review\` with body
\`{"decision": "accept" | "correct", "attributes": {...}, "note": "..."}\`: it reads the reviewer from
\`X-Reviewer-Id\` (\`"unknown"\` when absent), answers 400 for a bad decision or attribute name and 404
when \`store.pending(sku_id)\` has no proposal, merges a correction over the proposal, writes it
straight to the catalog with \`store.apply_catalog\` and drops the proposal. It serves the demo and
hides 4 flaws.

**Failure mode the checks target.** Anyone with a header rewrites the catalog; a reviewer overwrites
a SKU another reviewer has claimed; a retried request decides twice; and the decision is not kept
as a label or sent as an event, so the next model learns nothing and search does not hear of it.

- No \`X-Reviewer-Id\` is 401; an \`X-Reviewer-Role\` outside \`REVIEWER_ROLES\` is 403.
- \`Idempotency-Key\` is required (400); \`store.review_result(reviewer, key)\` answers a retry,
  \`store.record_review\` stores the answer.
- A caller who is not \`store.lease_holder(sku_id)\` (step 3's lease) is 409; the lease is released
  after the decision.
- Every decision is \`store.put_label(...)\`, then \`publish(event)\` (step 5) with \`source: "human"\`
  and \`attributes_version = store.next_version(sku_id)\`; the answer carries \`label_version\`.`,
  sequence: {
    participants: ['Reviewer', 'catalogd', 'Redis', 'sku.enriched'],
    messages: [
      {
        from: 'Reviewer',
        to: 'catalogd',
        label: 'POST /v1/skus/sku-1/review · X-Reviewer-Id · Idempotency-Key',
        kind: 'sync',
      },
      {from: 'catalogd', to: 'Redis', label: 'review:idem:ana:k-1 · proposal:sku-1 · review:lease:sku-1', kind: 'sync'},
      {from: 'catalogd', to: 'Redis', label: 'put_label → label:sku-1:v1', kind: 'sync'},
      {from: 'catalogd', to: 'sku.enriched', label: 'publish · source = human', kind: 'async'},
      {from: 'catalogd', to: 'Redis', label: 'drop proposal · release lease · record answer', kind: 'sync'},
      {from: 'catalogd', to: 'Reviewer', label: '200 {label_version, attributes_version}', kind: 'reply'},
    ],
  },
  hints: [
    'A curl without credentials relabels a SKU; two reviewers on one SKU overwrite each other; a retried click decides twice; the training set has no human labels and search still shows the old brand.',
    'The handler trusts any `X-Reviewer-Id`, does not ask who holds the lease, keeps no record of the key, and writes the catalog row directly instead of recording a label and publishing an event.',
    'Answer 401/403 on the headers, 400 without `Idempotency-Key` and `review_result` on a retry; 409 unless `lease_holder` is the caller; then `put_label`, `publish(event)` with `source: "human"`, `release_lease`, `record_review`.',
  ],
  checks: [
    {
      id: 'reviewer-auth',
      title: 'No reviewer is 401, a role outside REVIEWER_ROLES is 403',
      detail:
        'A request without `X-Reviewer-Id` is 401 and one whose `X-Reviewer-Role` is not in `REVIEWER_ROLES` is 403, and neither changes anything. The starter calls such a caller "unknown" and applies the decision.',
      match: {
        python: {
          all: [/REVIEWER_ROLES\s*=/, /\b401\b/, /\b403\b/],
          none: [/["']x-reviewer-id["'],\s*["'][^"']+["']/i],
        },
        typescript: {all: [/REVIEWER_ROLES\s*=/, /\b401\b/, /\b403\b/], none: [/'unknown'/]},
        go: {all: [/reviewerRoles\s*=/, /StatusUnauthorized|\b401\b/, /StatusForbidden|\b403\b/], none: [/"unknown"/]},
        scala: {all: [/ReviewerRoles(:[^=\n]*)?\s*=/, /Unauthorized/, /Forbidden/], none: [/"unknown"/]},
        cpp: {all: [/kReviewerRoles\s*=/, /\b401\b/, /\b403\b/], none: [/"unknown"/]},
      },
    },
    {
      id: 'lease-held',
      title: 'Only the lease holder decides, and the lease is released after',
      detail:
        'A caller who does not hold `review:lease:{sku_id}` is 409; after the decision the lease is released. The starter does not look at the lease, so two reviewers on one SKU overwrite each other.',
      match: {
        python: {
          all: [/\b409\b/, /store\.release_lease\(/],
          order: [/store\.lease_holder\(/, /store\.put_label\(|store\.apply_catalog\(/],
        },
        typescript: {all: [/\b409\b/, /releaseLease\(/], order: [/leaseHolder\(/, /putLabel\(|applyCatalog\(/]},
        go: {
          all: [/StatusConflict|\b409\b/, /store\.ReleaseLease\(/],
          order: [/store\.LeaseHolder\(/, /store\.PutLabel\(|store\.ApplyCatalog\(/],
        },
        scala: {
          all: [/Conflict/, /Store\.releaseLease\(/],
          order: [/Store\.leaseHolder\(/, /Store\.putLabel\(|Store\.applyCatalog\(/],
        },
        cpp: {
          all: [/\b409\b/, /store::release_lease\(/],
          order: [/store::lease_holder\(/, /store::put_label\(|store::apply_catalog\(/],
        },
      },
    },
    {
      id: 'idempotency-key',
      title: 'Idempotency-Key is required and a retry answers the first response',
      detail:
        'A decision without `Idempotency-Key` is 400; a retry with the same reviewer and key answers what the first attempt answered, without a second label or event. The starter ignores the header.',
      match: {
        python: {all: [/idempotency-key/i, /store\.review_result\(/, /store\.record_review\(/]},
        typescript: {all: [/idempotency-key/i, /reviewResult\(/, /recordReview\(/]},
        go: {all: [/Idempotency-Key/, /store\.ReviewResult\(/, /store\.RecordReview\(/]},
        scala: {all: [/Idempotency-Key/, /Store\.reviewResult\(/, /Store\.recordReview\(/]},
        cpp: {all: [/Idempotency-Key/, /store::review_result\(/, /store::record_review\(/]},
      },
    },
    {
      id: 'label-and-publish',
      title: 'Every decision becomes a label and a human event',
      detail:
        'The decision is stored with `store.put_label` and published on `sku.enriched` with `source: "human"` and a new `attributes_version`; the answer names the label version. The starter edits the catalog row directly, so no label is written for the next model and search does not hear of the fix.',
      match: {
        python: {all: [/store\.put_label\(/, /publish\(event\)/], none: [/store\.apply_catalog\(/]},
        typescript: {all: [/putLabel\(/, /publish\(event\)/], none: [/applyCatalog\(/]},
        go: {all: [/store\.PutLabel\(/, /publish\(ctx,\s*event\)/], none: [/store\.ApplyCatalog\(/]},
        scala: {all: [/Store\.putLabel\(/, /EnrichedEvents\.publish\(event\)/], none: [/Store\.applyCatalog\(/]},
        cpp: {all: [/store::put_label\(/, /publish\(event\)/], none: [/store::apply_catalog\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from enrich import store  # pending, lease_holder, release_lease, put_label, next_version, drop_proposal, review_result, record_review, apply_catalog

app = FastAPI()

DECISIONS = ("accept", "correct")
ATTRIBUTES = ("brand", "size", "unit", "organic", "category")


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


async def _decision(request: Request) -> dict | None:
    """The body, or None unless it is {"decision": accept|correct, "attributes": {known names}}."""
    try:
        body = await request.json()
    except ValueError:
        return None
    if not isinstance(body, dict) or body.get("decision") not in DECISIONS:
        return None
    corrections = body.get("attributes") or {}
    if not isinstance(corrections, dict) or any(name not in ATTRIBUTES for name in corrections):
        return None
    return {"decision": body["decision"], "attributes": corrections}


@app.post("/v1/skus/{sku_id}/review")
async def review(sku_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    reviewer = request.headers.get("x-reviewer-id", "unknown")
    body = await _decision(request)
    if body is None:
        return _error(400, "decision must be accept or correct, attributes among brand, size, unit, organic, category")
    proposal = store.pending(sku_id)
    if proposal is None:
        return _error(404, "no proposal is waiting for review")
    attributes = {**proposal["attributes"], **body["attributes"]} if body["decision"] == "correct" else proposal["attributes"]
    version = store.next_version(sku_id)
    store.apply_catalog(
        {
            "sku_id": sku_id,
            "merchant": proposal["merchant"],
            "attributes": attributes,
            "attributes_version": version,
            "taxonomy_version": proposal["taxonomy_version"],
            "source": "human",
        }
    )
    store.drop_proposal(sku_id)
    return JSONResponse({"sku_id": sku_id, "attributes_version": version, "taxonomy_version": proposal["taxonomy_version"], "reviewer": reviewer})
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from enrich import store  # pending, lease_holder, release_lease, put_label, next_version, drop_proposal, review_result, record_review, apply_catalog
from enriched_events import publish  # step 5

app = FastAPI()

REVIEWER_ROLES = ("reviewer", "catalog-admin")
DECISIONS = ("accept", "correct")
ATTRIBUTES = ("brand", "size", "unit", "organic", "category")


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


async def _decision(request: Request) -> dict | None:
    """The body, or None unless it is {"decision": accept|correct, "attributes": {known names}}."""
    try:
        body = await request.json()
    except ValueError:
        return None
    if not isinstance(body, dict) or body.get("decision") not in DECISIONS:
        return None
    corrections = body.get("attributes") or {}
    if not isinstance(corrections, dict) or any(name not in ATTRIBUTES for name in corrections):
        return None
    return {"decision": body["decision"], "attributes": corrections}


@app.post("/v1/skus/{sku_id}/review")
async def review(sku_id: str, request: Request) -> JSONResponse:
    reviewer = request.headers.get("x-reviewer-id", "")
    if not reviewer:
        return _error(401, "X-Reviewer-Id is required")
    if request.headers.get("x-reviewer-role") not in REVIEWER_ROLES:
        return _error(403, "only reviewers and catalog admins decide attributes")
    key = request.headers.get("idempotency-key", "")
    if not key:
        return _error(400, "Idempotency-Key is required")
    recorded = store.review_result(reviewer, key)
    if recorded is not None:
        return JSONResponse(recorded)  # a retry answers what the first attempt answered
    body = await _decision(request)
    if body is None:
        return _error(400, "decision must be accept or correct, attributes among brand, size, unit, organic, category")
    proposal = store.pending(sku_id)
    if proposal is None:
        return _error(404, "no proposal is waiting for review")
    if store.lease_holder(sku_id) != reviewer:
        return _error(409, "claim the SKU's review lease first")
    attributes = {**proposal["attributes"], **body["attributes"]} if body["decision"] == "correct" else proposal["attributes"]
    label_version = store.put_label(sku_id, body["decision"], attributes, proposal["taxonomy_version"], reviewer)
    event = {
        "sku_id": sku_id,
        "merchant": proposal["merchant"],
        "attributes": attributes,
        "attributes_version": store.next_version(sku_id),
        "taxonomy_version": proposal["taxonomy_version"],
        "source": "human",
    }
    publish(event)  # the indexer applies it to the catalog and the search index
    store.drop_proposal(sku_id)
    store.release_lease(sku_id, reviewer)
    response = {"sku_id": sku_id, "label_version": label_version, "attributes_version": event["attributes_version"], "taxonomy_version": event["taxonomy_version"]}
    store.record_review(reviewer, key, response)
    return JSONResponse(response)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type Attributes, applyCatalog, dropProposal, nextVersion, pending} from 'enrich/store';

export const app = Fastify();

export const DECISIONS = ['accept', 'correct'];
export const ATTRIBUTES = ['brand', 'size', 'unit', 'organic', 'category'];

/** The body, or null unless it is {"decision": accept|correct, "attributes": {known names}}. */
function decisionOf(body: unknown): {decision: string; attributes: Attributes} | null {
  if (typeof body !== 'object' || body === null) return null;
  const {decision, attributes = {}} = body as {decision?: unknown; attributes?: unknown};
  if (typeof decision !== 'string' || !DECISIONS.includes(decision)) return null;
  if (typeof attributes !== 'object' || attributes === null || Object.keys(attributes).some(name => !ATTRIBUTES.includes(name))) return null;
  return {decision, attributes: attributes as Attributes};
}

app.post('/v1/skus/:skuId/review', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const {skuId} = request.params as {skuId: string};
  const reviewer = typeof request.headers['x-reviewer-id'] === 'string' ? request.headers['x-reviewer-id'] : 'unknown';
  const body = decisionOf(request.body);
  if (body === null) return reply.code(400).send({error: 'decision must be accept or correct, attributes among brand, size, unit, organic, category'});
  const proposal = await pending(skuId);
  if (proposal === null) return reply.code(404).send({error: 'no proposal is waiting for review'});
  const attributes = body.decision === 'correct' ? {...proposal.attributes, ...body.attributes} : proposal.attributes;
  const version = await nextVersion(skuId);
  await applyCatalog({sku_id: skuId, merchant: proposal.merchant, attributes, attributes_version: version, taxonomy_version: proposal.taxonomy_version, source: 'human'});
  await dropProposal(skuId);
  return {sku_id: skuId, attributes_version: version, taxonomy_version: proposal.taxonomy_version, reviewer};
});
`,
      solution: `import Fastify from 'fastify';

import {type Attributes, type EnrichedEvent, dropProposal, leaseHolder, nextVersion, pending, putLabel, recordReview, releaseLease, reviewResult} from 'enrich/store';

import {publish} from './enriched_events'; // step 5

export const app = Fastify();

export const REVIEWER_ROLES = ['reviewer', 'catalog-admin'];
export const DECISIONS = ['accept', 'correct'];
export const ATTRIBUTES = ['brand', 'size', 'unit', 'organic', 'category'];

/** The body, or null unless it is {"decision": accept|correct, "attributes": {known names}}. */
function decisionOf(body: unknown): {decision: string; attributes: Attributes} | null {
  if (typeof body !== 'object' || body === null) return null;
  const {decision, attributes = {}} = body as {decision?: unknown; attributes?: unknown};
  if (typeof decision !== 'string' || !DECISIONS.includes(decision)) return null;
  if (typeof attributes !== 'object' || attributes === null || Object.keys(attributes).some(name => !ATTRIBUTES.includes(name))) return null;
  return {decision, attributes: attributes as Attributes};
}

app.post('/v1/skus/:skuId/review', async (request, reply) => {
  const {skuId} = request.params as {skuId: string};
  const header = (name: string): string => {
    const value = request.headers[name];
    return typeof value === 'string' ? value : '';
  };
  const reviewer = header('x-reviewer-id');
  if (reviewer === '') return reply.code(401).send({error: 'X-Reviewer-Id is required'});
  if (!REVIEWER_ROLES.includes(header('x-reviewer-role'))) return reply.code(403).send({error: 'only reviewers and catalog admins decide attributes'});
  const key = header('idempotency-key');
  if (key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const recorded = await reviewResult(reviewer, key);
  if (recorded !== null) return recorded; // a retry answers what the first attempt answered
  const body = decisionOf(request.body);
  if (body === null) return reply.code(400).send({error: 'decision must be accept or correct, attributes among brand, size, unit, organic, category'});
  const proposal = await pending(skuId);
  if (proposal === null) return reply.code(404).send({error: 'no proposal is waiting for review'});
  if ((await leaseHolder(skuId)) !== reviewer) return reply.code(409).send({error: "claim the SKU's review lease first"});
  const attributes = body.decision === 'correct' ? {...proposal.attributes, ...body.attributes} : proposal.attributes;
  const labelVersion = await putLabel(skuId, body.decision, attributes, proposal.taxonomy_version, reviewer);
  const event: EnrichedEvent = {
    sku_id: skuId,
    merchant: proposal.merchant,
    attributes,
    attributes_version: await nextVersion(skuId),
    taxonomy_version: proposal.taxonomy_version,
    source: 'human',
  };
  await publish(event); // the indexer applies it to the catalog and the search index
  await dropProposal(skuId);
  await releaseLease(skuId, reviewer);
  const response = {sku_id: skuId, label_version: labelVersion, attributes_version: event.attributes_version, taxonomy_version: event.taxonomy_version};
  await recordReview(reviewer, key, response);
  return response;
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"enrich/store" // store.Pending, LeaseHolder, ReleaseLease, PutLabel, NextVersion, DropProposal, ReviewResult, RecordReview, ApplyCatalog, Event
)

var (
	decisions      = []string{"accept", "correct"}
	attributeNames = []string{"brand", "size", "unit", "organic", "category"}
)

// Built in step 5 (enriched_events.go): one sku.enriched event, or an outbox row when the broker refuses it.
var publish = func(ctx context.Context, event store.Event) error {
	panic("publish is built in step 5")
}

type reviewBody struct {
	Decision   string         \`json:"decision"\`
	Attributes map[string]any \`json:"attributes"\`
	Note       string         \`json:"note"\`
}

func listed(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// decode reads the body; ok is false unless it is {"decision": accept|correct, "attributes": {known names}}.
func decode(r *http.Request) (reviewBody, bool) {
	var body reviewBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !listed(decisions, body.Decision) {
		return body, false
	}
	for name := range body.Attributes {
		if !listed(attributeNames, name) {
			return body, false
		}
	}
	return body, true
}

func review(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	ctx := r.Context()
	skuID := r.PathValue("sku_id")
	reviewer := r.Header.Get("X-Reviewer-Id")
	if reviewer == "" {
		reviewer = "unknown"
	}
	body, ok := decode(r)
	if !ok {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "decision must be accept or correct, attributes among brand, size, unit, organic, category"})
		return
	}
	proposal := store.Pending(ctx, skuID)
	if proposal == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no proposal is waiting for review"})
		return
	}
	attributes := map[string]any{}
	for name, value := range proposal.Attributes {
		attributes[name] = value
	}
	if body.Decision == "correct" {
		for name, value := range body.Attributes {
			attributes[name] = value
		}
	}
	version, _ := store.NextVersion(ctx, skuID)
	store.ApplyCatalog(ctx, store.Event{SkuID: skuID, Merchant: proposal.Merchant, Attributes: attributes, AttributesVersion: version, TaxonomyVersion: proposal.TaxonomyVersion, Source: "human"})
	store.DropProposal(ctx, skuID)
	writeJSON(rw, http.StatusOK, map[string]any{"sku_id": skuID, "attributes_version": version, "taxonomy_version": proposal.TaxonomyVersion, "reviewer": reviewer})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/skus/{sku_id}/review", review)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"enrich/store" // store.Pending, LeaseHolder, ReleaseLease, PutLabel, NextVersion, DropProposal, ReviewResult, RecordReview, Event
)

var (
	reviewerRoles  = []string{"reviewer", "catalog-admin"}
	decisions      = []string{"accept", "correct"}
	attributeNames = []string{"brand", "size", "unit", "organic", "category"}
)

// Built in step 5 (enriched_events.go): one sku.enriched event, or an outbox row when the broker refuses it.
var publish = func(ctx context.Context, event store.Event) error {
	panic("publish is built in step 5")
}

type reviewBody struct {
	Decision   string         \`json:"decision"\`
	Attributes map[string]any \`json:"attributes"\`
	Note       string         \`json:"note"\`
}

func listed(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// decode reads the body; ok is false unless it is {"decision": accept|correct, "attributes": {known names}}.
func decode(r *http.Request) (reviewBody, bool) {
	var body reviewBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !listed(decisions, body.Decision) {
		return body, false
	}
	for name := range body.Attributes {
		if !listed(attributeNames, name) {
			return body, false
		}
	}
	return body, true
}

func review(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	skuID := r.PathValue("sku_id")
	reviewer := r.Header.Get("X-Reviewer-Id")
	if reviewer == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Reviewer-Id is required"})
		return
	}
	if !listed(reviewerRoles, r.Header.Get("X-Reviewer-Role")) {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "only reviewers and catalog admins decide attributes"})
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	if recorded := store.ReviewResult(ctx, reviewer, key); recorded != nil {
		writeJSON(rw, http.StatusOK, recorded) // a retry answers what the first attempt answered
		return
	}
	body, ok := decode(r)
	if !ok {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "decision must be accept or correct, attributes among brand, size, unit, organic, category"})
		return
	}
	proposal := store.Pending(ctx, skuID)
	if proposal == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no proposal is waiting for review"})
		return
	}
	if holder, _ := store.LeaseHolder(ctx, skuID); holder != reviewer {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "claim the SKU's review lease first"})
		return
	}
	attributes := map[string]any{}
	for name, value := range proposal.Attributes {
		attributes[name] = value
	}
	if body.Decision == "correct" {
		for name, value := range body.Attributes {
			attributes[name] = value
		}
	}
	labelVersion, err := store.PutLabel(ctx, skuID, body.Decision, attributes, proposal.TaxonomyVersion, reviewer)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	version, _ := store.NextVersion(ctx, skuID)
	event := store.Event{SkuID: skuID, Merchant: proposal.Merchant, Attributes: attributes, AttributesVersion: version, TaxonomyVersion: proposal.TaxonomyVersion, Source: "human"}
	if err := publish(ctx, event); err != nil { // the indexer applies it to the catalog and the search index
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	store.DropProposal(ctx, skuID)
	store.ReleaseLease(ctx, skuID, reviewer)
	response := map[string]any{"sku_id": skuID, "label_version": labelVersion, "attributes_version": version, "taxonomy_version": proposal.TaxonomyVersion}
	store.RecordReview(ctx, reviewer, key, response)
	writeJSON(rw, http.StatusOK, response)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/skus/{sku_id}/review", review)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import scala.collection.mutable
import scala.util.Try

import enrich.Store // Store.pending, leaseHolder, releaseLease, putLabel, nextVersion, dropProposal, reviewResult, recordReview, applyCatalog

object ReviewApi {
  val Decisions: Set[String] = Set("accept", "correct")
  val AttributeNames: Set[String] = Set("brand", "size", "unit", "organic", "category")

  private def json(status: StatusCode, body: ujson.Value): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body)))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, ujson.Obj("error" -> message))

  /** The body, or None unless it is {"decision": accept|correct, "attributes": {known names}}. */
  def decisionOf(raw: String): Option[(String, ujson.Obj)] =
    Try(ujson.read(raw)).toOption.flatMap(_.objOpt).flatMap { body =>
      val decision = body.get("decision").flatMap(_.strOpt).filter(Decisions.contains)
      val corrections = body.get("attributes").map(_.objOpt).getOrElse(Some(mutable.LinkedHashMap.empty[String, ujson.Value]))
      for (d <- decision; c <- corrections if c.keys.forall(AttributeNames.contains)) yield (d, ujson.Obj.from(c))
    }

  def decide(skuId: String, reviewer: Option[String], raw: String): HttpResponse = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val who = reviewer.getOrElse("unknown")
    (decisionOf(raw), Store.pending(skuId)) match {
      case (None, _) => error(StatusCodes.BadRequest, "decision must be accept or correct, attributes among brand, size, unit, organic, category")
      case (_, None) => error(StatusCodes.NotFound, "no proposal is waiting for review")
      case (Some((decision, corrections)), Some(proposal)) =>
        val attributes = ujson.Obj.from(proposal("attributes").obj)
        if (decision == "correct") corrections.value.foreach { case (name, value) => attributes(name) = value }
        val version = Store.nextVersion(skuId).toDouble
        Store.applyCatalog(ujson.Obj("sku_id" -> skuId, "merchant" -> proposal("merchant").str, "attributes" -> attributes, "attributes_version" -> version,
          "taxonomy_version" -> proposal("taxonomy_version").str, "source" -> "human"))
        Store.dropProposal(skuId)
        json(StatusCodes.OK, ujson.Obj("sku_id" -> skuId, "attributes_version" -> version, "taxonomy_version" -> proposal("taxonomy_version").str, "reviewer" -> who))
    }
  }

  val route: Route = path("v1" / "skus" / Segment / "review") { skuId =>
    post {
      optionalHeaderValueByName("X-Reviewer-Id") { reviewer =>
        entity(as[String]) { raw => complete(decide(skuId, reviewer, raw)) }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import scala.collection.mutable
import scala.util.Try

import enrich.Store // Store.pending, leaseHolder, releaseLease, putLabel, nextVersion, dropProposal, reviewResult, recordReview, applyCatalog

object ReviewApi {
  val ReviewerRoles: Set[String] = Set("reviewer", "catalog-admin")
  val Decisions: Set[String] = Set("accept", "correct")
  val AttributeNames: Set[String] = Set("brand", "size", "unit", "organic", "category")

  private def json(status: StatusCode, body: ujson.Value): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body)))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, ujson.Obj("error" -> message))

  /** The body, or None unless it is {"decision": accept|correct, "attributes": {known names}}. */
  def decisionOf(raw: String): Option[(String, ujson.Obj)] =
    Try(ujson.read(raw)).toOption.flatMap(_.objOpt).flatMap { body =>
      val decision = body.get("decision").flatMap(_.strOpt).filter(Decisions.contains)
      val corrections = body.get("attributes").map(_.objOpt).getOrElse(Some(mutable.LinkedHashMap.empty[String, ujson.Value]))
      for (d <- decision; c <- corrections if c.keys.forall(AttributeNames.contains)) yield (d, ujson.Obj.from(c))
    }

  def decide(skuId: String, reviewer: Option[String], role: Option[String], idempotencyKey: Option[String], raw: String): HttpResponse = {
    val who = reviewer.getOrElse("")
    val key = idempotencyKey.getOrElse("")
    if (who.isEmpty) error(StatusCodes.Unauthorized, "X-Reviewer-Id is required")
    else if (!role.exists(ReviewerRoles.contains)) error(StatusCodes.Forbidden, "only reviewers and catalog admins decide attributes")
    else if (key.isEmpty) error(StatusCodes.BadRequest, "Idempotency-Key is required")
    else
      Store.reviewResult(who, key) match {
        case Some(recorded) => json(StatusCodes.OK, recorded) // a retry answers what the first attempt answered
        case None =>
          (decisionOf(raw), Store.pending(skuId)) match {
            case (None, _) => error(StatusCodes.BadRequest, "decision must be accept or correct, attributes among brand, size, unit, organic, category")
            case (_, None) => error(StatusCodes.NotFound, "no proposal is waiting for review")
            case (Some((decision, corrections)), Some(proposal)) =>
              if (!Store.leaseHolder(skuId).contains(who)) error(StatusCodes.Conflict, "claim the SKU's review lease first")
              else record(skuId, who, key, decision, corrections, proposal)
          }
      }
  }

  /** One decision by the lease holder: a label, then a human event. */
  def record(skuId: String, who: String, key: String, decision: String, corrections: ujson.Obj, proposal: ujson.Obj): HttpResponse = {
    val attributes = ujson.Obj.from(proposal("attributes").obj)
    if (decision == "correct") corrections.value.foreach { case (name, value) => attributes(name) = value }
    val taxonomyVersion = proposal("taxonomy_version").str
    val labelVersion = Store.putLabel(skuId, decision, attributes, taxonomyVersion, who)
    val event = ujson.Obj("sku_id" -> skuId, "merchant" -> proposal("merchant").str, "attributes" -> attributes,
      "attributes_version" -> Store.nextVersion(skuId).toDouble, "taxonomy_version" -> taxonomyVersion, "source" -> "human")
    EnrichedEvents.publish(event) // step 5: the indexer applies it to the catalog and the search index
    Store.dropProposal(skuId)
    Store.releaseLease(skuId, who)
    val response = ujson.Obj("sku_id" -> skuId, "label_version" -> labelVersion.toDouble, "attributes_version" -> event("attributes_version"), "taxonomy_version" -> taxonomyVersion)
    Store.recordReview(who, key, response)
    json(StatusCodes.OK, response)
  }

  val route: Route = path("v1" / "skus" / Segment / "review") { skuId =>
    post {
      (optionalHeaderValueByName("X-Reviewer-Id") & optionalHeaderValueByName("X-Reviewer-Role") & optionalHeaderValueByName("Idempotency-Key")) {
        (reviewer, role, key) => entity(as[String]) { raw => complete(decide(skuId, reviewer, role, key, raw)) }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "enrich/store.h"  // store::pending, lease_holder, release_lease, put_label, next_version, drop_proposal, review_result, record_review, apply_catalog

using json = nlohmann::json;

const std::vector<std::string> kDecisions = {"accept", "correct"};
const std::vector<std::string> kAttributes = {"brand", "size", "unit", "organic", "category"};

bool listed(const std::vector<std::string>& list, const std::string& value) {
  return std::find(list.begin(), list.end(), value) != list.end();
}

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// The body, or null unless it is {"decision": accept|correct, "attributes": {known names}}.
json decisionOf(const std::string& raw) {
  const json body = json::parse(raw, nullptr, false);
  if (!body.is_object() || !body.contains("decision") || !body["decision"].is_string() || !listed(kDecisions, body["decision"])) return nullptr;
  const json corrections = body.contains("attributes") ? body["attributes"] : json::object();
  if (!corrections.is_object()) return nullptr;
  for (const auto& item : corrections.items())
    if (!listed(kAttributes, item.key())) return nullptr;
  return {{"decision", body["decision"]}, {"attributes", corrections}};
}

void review(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string sku_id = req.matches[1];
  std::string reviewer = req.get_header_value("X-Reviewer-Id");
  if (reviewer.empty()) reviewer = "unknown";
  const json body = decisionOf(req.body);
  if (body.is_null()) return reply(res, 400, {{"error", "decision must be accept or correct, attributes among brand, size, unit, organic, category"}});
  const auto proposal = store::pending(sku_id);
  if (!proposal) return reply(res, 404, {{"error", "no proposal is waiting for review"}});
  json attributes = (*proposal)["attributes"];
  if (body["decision"] == "correct") attributes.update(body["attributes"]);
  const long long version = store::next_version(sku_id);
  store::apply_catalog({{"sku_id", sku_id}, {"merchant", (*proposal)["merchant"]}, {"attributes", attributes}, {"attributes_version", version},
                        {"taxonomy_version", (*proposal)["taxonomy_version"]}, {"source", "human"}});
  store::drop_proposal(sku_id);
  reply(res, 200, {{"sku_id", sku_id}, {"attributes_version", version}, {"taxonomy_version", (*proposal)["taxonomy_version"]}, {"reviewer", reviewer}});
}

void register_routes(httplib::Server& svr) {
  svr.Post(R"(/v1/skus/([\\w-]+)/review)", review);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "enrich/store.h"  // store::pending, lease_holder, release_lease, put_label, next_version, drop_proposal, review_result, record_review, apply_catalog

using json = nlohmann::json;

const std::vector<std::string> kReviewerRoles = {"reviewer", "catalog-admin"};
const std::vector<std::string> kDecisions = {"accept", "correct"};
const std::vector<std::string> kAttributes = {"brand", "size", "unit", "organic", "category"};

// Built in step 5 (enriched_events.cpp): one sku.enriched event, or an outbox row when the broker refuses it.
void publish(const json& event);

bool listed(const std::vector<std::string>& list, const std::string& value) {
  return std::find(list.begin(), list.end(), value) != list.end();
}

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// The body, or null unless it is {"decision": accept|correct, "attributes": {known names}}.
json decisionOf(const std::string& raw) {
  const json body = json::parse(raw, nullptr, false);
  if (!body.is_object() || !body.contains("decision") || !body["decision"].is_string() || !listed(kDecisions, body["decision"])) return nullptr;
  const json corrections = body.contains("attributes") ? body["attributes"] : json::object();
  if (!corrections.is_object()) return nullptr;
  for (const auto& item : corrections.items())
    if (!listed(kAttributes, item.key())) return nullptr;
  return {{"decision", body["decision"]}, {"attributes", corrections}};
}

void review(const httplib::Request& req, httplib::Response& res) {
  const std::string sku_id = req.matches[1];
  const std::string reviewer = req.get_header_value("X-Reviewer-Id");
  if (reviewer.empty()) return reply(res, 401, {{"error", "X-Reviewer-Id is required"}});
  if (!listed(kReviewerRoles, req.get_header_value("X-Reviewer-Role"))) return reply(res, 403, {{"error", "only reviewers and catalog admins decide attributes"}});
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return reply(res, 400, {{"error", "Idempotency-Key is required"}});
  if (const auto recorded = store::review_result(reviewer, key)) return reply(res, 200, *recorded);  // a retry answers what the first attempt answered
  const json body = decisionOf(req.body);
  if (body.is_null()) return reply(res, 400, {{"error", "decision must be accept or correct, attributes among brand, size, unit, organic, category"}});
  const auto proposal = store::pending(sku_id);
  if (!proposal) return reply(res, 404, {{"error", "no proposal is waiting for review"}});
  if (store::lease_holder(sku_id).value_or("") != reviewer) return reply(res, 409, {{"error", "claim the SKU's review lease first"}});
  json attributes = (*proposal)["attributes"];
  if (body["decision"] == "correct") attributes.update(body["attributes"]);
  const std::string taxonomy_version = (*proposal)["taxonomy_version"];
  const long long label_version = store::put_label(sku_id, body["decision"], attributes, taxonomy_version, reviewer);
  const json event = {{"sku_id", sku_id}, {"merchant", (*proposal)["merchant"]}, {"attributes", attributes},
                      {"attributes_version", store::next_version(sku_id)}, {"taxonomy_version", taxonomy_version}, {"source", "human"}};
  publish(event);  // the indexer applies it to the catalog and the search index
  store::drop_proposal(sku_id);
  store::release_lease(sku_id, reviewer);
  const json response = {{"sku_id", sku_id}, {"label_version", label_version}, {"attributes_version", event["attributes_version"]}, {"taxonomy_version", taxonomy_version}};
  store::record_review(reviewer, key, response);
  reply(res, 200, response);
}

void register_routes(httplib::Server& svr) {
  svr.Post(R"(/v1/skus/([\\w-]+)/review)", review);
}
`,
    },
  },
  harness: {
    python: `import json

from enrich import store, taxonomy

PROPOSAL = {"sku_id": "sku-1", "merchant": "m-1", "attributes": {"brand": None, "size": 1.0, "unit": "l", "organic": False, "category": "plant-milk"}, "confidence": 0.62, "taxonomy_version": taxonomy.VERSION}
CORRECT = {"decision": "correct", "attributes": {"brand": "Oatly"}, "note": "brand printed on the carton"}


def _api(ctx, holder="ana"):
    store.enqueue_review(PROPOSAL, "brand 'Glowra' is not a taxonomy candidate")
    if holder:
        ctx.redis.set("review:lease:sku-1", holder)
    return ctx.client(ctx.load("review_api").app)


def _headers(key, reviewer="ana", role="reviewer"):
    headers = {}
    for name, value in (("Idempotency-Key", key), ("X-Reviewer-Id", reviewer), ("X-Reviewer-Role", role)):
        if value:
            headers[name] = value
    return headers


async def _post(c, key, sku_id="sku-1", **who):
    return await c.post(f"/v1/skus/{sku_id}/review", json=CORRECT, headers=_headers(key, **who))


def _events(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records("sku.enriched")]


def _untouched(ctx, why):
    assert store.read_label("sku-1", 1) is None and not _events(ctx) and store.catalog_current("sku-1") is None, f"{why}, yet a label, an event or a catalog row was written"
    assert store.pending("sku-1") is not None, f"{why}, yet the proposal left the review queue"


async def check_reviewer_auth(ctx):
    async with _api(ctx) as c:
        r = await _post(c, "k-1", reviewer=None)
        assert r.status_code == 401, f"a decision without X-Reviewer-Id answered {r.status_code}, expected 401"
        r = await _post(c, "k-2", role="shopper")
        assert r.status_code == 403, f"a decision from role 'shopper' answered {r.status_code}, expected 403"
        _untouched(ctx, "after two refused requests")
        r = await _post(c, "k-3")
    assert r.status_code == 200, f"a reviewer holding the lease answered {r.status_code}: {r.text}"


async def check_lease_held(ctx):
    async with _api(ctx, holder="ben") as c:
        r = await _post(c, "k-1")
        assert r.status_code == 409, f"ana decided on a SKU whose review lease ben holds: answered {r.status_code}, expected 409"
        _untouched(ctx, "after a decision without the lease")
        ctx.redis.set("review:lease:sku-1", "ana")
        r = await _post(c, "k-2")
        assert r.status_code == 200, f"the lease holder's decision answered {r.status_code}: {r.text}"
        assert ctx.redis.get("review:lease:sku-1") is None, "the decision is made: release the lease so the SKU does not stay claimed for 15 minutes"
        r = await _post(c, "k-3", sku_id="sku-404")
    assert r.status_code == 404, f"a decision on a SKU with no proposal answered {r.status_code}, expected 404"


async def check_idempotency_key(ctx):
    async with _api(ctx) as c:
        r = await _post(c, None)
        assert r.status_code == 400, f"a decision without Idempotency-Key answered {r.status_code}, expected 400"
        _untouched(ctx, "after a decision without Idempotency-Key")
        first = await _post(c, "k-1")
        assert first.status_code == 200, f"the first decision answered {first.status_code}: {first.text}"
        retry = await _post(c, "k-1")
    assert retry.status_code == 200 and retry.json() == first.json(), f"a retry with the same Idempotency-Key must answer the first response: first {first.text}, retry {retry.status_code} {retry.text}"
    assert store.read_label("sku-1", 2) is None and len(_events(ctx)) == 1, f"the retry recorded a second decision: {len(_events(ctx))} events on sku.enriched"


async def check_label_and_publish(ctx):
    async with _api(ctx) as c:
        r = await _post(c, "k-1")
    assert r.status_code == 200, f"the decision answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("label_version") == 1, f"the answer must carry the label version, got {body}"
    label = store.read_label("sku-1", 1)
    assert label is not None, "no label:sku-1:v1 was written: the correction is the training example for the next model"
    assert label["decision"] == "correct" and label["attributes"]["brand"] == "Oatly" and label["reviewer"] == "ana" and label["taxonomy_version"] == taxonomy.VERSION, f"the label must hold the decision, the corrected attributes, the reviewer and the taxonomy version, got {label}"
    events = _events(ctx)
    assert len(events) == 1, f"the decision must reach sku.enriched once, the topic holds {len(events)} events"
    assert events[0]["source"] == "human" and events[0]["attributes"]["brand"] == "Oatly", f"the event must carry the corrected attributes with source human, got {events[0]}"
    assert events[0]["attributes_version"] == body.get("attributes_version"), f"the event's attributes_version {events[0]['attributes_version']} differs from the answer's {body.get('attributes_version')}"
    assert store.pending("sku-1") is None, "the decided proposal is still in the review queue"
`,
    typescript: `const PROPOSAL = {
  sku_id: 'sku-1',
  merchant: 'm-1',
  attributes: {brand: null, size: 1, unit: 'l', organic: false, category: 'plant-milk'},
  confidence: 0.62,
  taxonomy_version: 'tx-2026.11',
  source: 'model',
  status: 'review',
};
const CORRECT = {decision: 'correct', attributes: {brand: 'Oatly'}, note: 'brand printed on the carton'};

async function api(ctx, holder: string | null = 'ana') {
  const store = ctx.load('/support/enrich/store.ts');
  await store.enqueueReview(PROPOSAL, "brand 'Glowra' is not a taxonomy candidate");
  if (holder !== null) ctx.redis.set('review:lease:sku-1', holder);
  return {c: ctx.client(ctx.load('review_api').app), store};
}

function headers(key: string | null, reviewer: string | null = 'ana', role: string | null = 'reviewer'): Record<string, string> {
  const out: Record<string, string> = {};
  if (key !== null) out['Idempotency-Key'] = key;
  if (reviewer !== null) out['X-Reviewer-Id'] = reviewer;
  if (role !== null) out['X-Reviewer-Role'] = role;
  return out;
}

const post = (c, key: string | null, skuId = 'sku-1', reviewer: string | null = 'ana', role: string | null = 'reviewer') =>
  c.post(\`/v1/skus/\${skuId}/review\`, {json: CORRECT, headers: headers(key, reviewer, role)});

const events = (ctx) => ctx.kafka.records('sku.enriched').map(r => JSON.parse(Buffer.from(r.value).toString('utf8')));

async function untouched(ctx, store, why: string): Promise<void> {
  assert((await store.readLabel('sku-1', 1)) === null && events(ctx).length === 0 && (await store.catalogCurrent('sku-1')) === null, \`\${why}, yet a label, an event or a catalog row was written\`);
  assert((await store.pending('sku-1')) !== null, \`\${why}, yet the proposal left the review queue\`);
}

export async function check_reviewer_auth(ctx) {
  const {c, store} = await api(ctx);
  let r = await post(c, 'k-1', 'sku-1', null);
  assert.equal(r.status, 401, \`a decision without X-Reviewer-Id answered \${r.status}, expected 401\`);
  r = await post(c, 'k-2', 'sku-1', 'ana', 'shopper');
  assert.equal(r.status, 403, \`a decision from role 'shopper' answered \${r.status}, expected 403\`);
  await untouched(ctx, store, 'after two refused requests');
  r = await post(c, 'k-3');
  assert.equal(r.status, 200, \`a reviewer holding the lease answered \${r.status}: \${r.text}\`);
}

export async function check_lease_held(ctx) {
  const {c, store} = await api(ctx, 'ben');
  let r = await post(c, 'k-1');
  assert.equal(r.status, 409, \`ana decided on a SKU whose review lease ben holds: answered \${r.status}, expected 409\`);
  await untouched(ctx, store, 'after a decision without the lease');
  ctx.redis.set('review:lease:sku-1', 'ana');
  r = await post(c, 'k-2');
  assert.equal(r.status, 200, \`the lease holder's decision answered \${r.status}: \${r.text}\`);
  assert.equal(ctx.redis.get('review:lease:sku-1'), null, 'the decision is made: release the lease so the SKU does not stay claimed for 15 minutes');
  r = await post(c, 'k-3', 'sku-404');
  assert.equal(r.status, 404, \`a decision on a SKU with no proposal answered \${r.status}, expected 404\`);
}

export async function check_idempotency_key(ctx) {
  const {c, store} = await api(ctx);
  const r = await post(c, null);
  assert.equal(r.status, 400, \`a decision without Idempotency-Key answered \${r.status}, expected 400\`);
  await untouched(ctx, store, 'after a decision without Idempotency-Key');
  const first = await post(c, 'k-1');
  assert.equal(first.status, 200, \`the first decision answered \${first.status}: \${first.text}\`);
  const retry = await post(c, 'k-1');
  assert(retry.status === 200 && JSON.stringify(retry.json()) === JSON.stringify(first.json()), \`a retry with the same Idempotency-Key must answer the first response: first \${first.text}, retry \${retry.status} \${retry.text}\`);
  assert((await store.readLabel('sku-1', 2)) === null && events(ctx).length === 1, \`the retry recorded a second decision: \${events(ctx).length} events on sku.enriched\`);
}

export async function check_label_and_publish(ctx) {
  const {c, store} = await api(ctx);
  const r = await post(c, 'k-1');
  assert.equal(r.status, 200, \`the decision answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert.equal(body.label_version, 1, \`the answer must carry the label version, got \${r.text}\`);
  const label = await store.readLabel('sku-1', 1);
  assert(label !== null, 'no label:sku-1:v1 was written: the correction is the training example for the next model');
  assert(label.decision === 'correct' && label.attributes.brand === 'Oatly' && label.reviewer === 'ana' && label.taxonomy_version === 'tx-2026.11', \`the label must hold the decision, the corrected attributes, the reviewer and the taxonomy version, got \${JSON.stringify(label)}\`);
  const all = events(ctx);
  assert.equal(all.length, 1, 'the decision must reach sku.enriched once');
  assert(all[0].source === 'human' && all[0].attributes.brand === 'Oatly', \`the event must carry the corrected attributes with source human, got \${JSON.stringify(all[0])}\`);
  assert.equal(all[0].attributes_version, body.attributes_version, "the event's attributes_version must be the one the answer names");
  assert.equal(await store.pending('sku-1'), null, 'the decided proposal is still in the review queue');
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"enrich/store"
	"enrich/taxonomy"

	"leetbuild/harness"
)

var reviewBg = context.Background()

var correction = map[string]any{"decision": "correct", "attributes": map[string]any{"brand": "Oatly"}, "note": "brand printed on the carton"}

// reviewAPI parks one proposal for sku-1, gives the lease to holder, and stands in for step 5's publish.
func reviewAPI(ctx *harness.Ctx, holder string) (*harness.HTTP, *[]store.Event) {
	published := []store.Event{}
	publish = func(_ context.Context, event store.Event) error {
		published = append(published, event)
		return nil
	}
	proposal := store.Result{SkuID: "sku-1", Merchant: "m-1", Attributes: map[string]any{"brand": nil, "size": 1.0, "unit": "l", "organic": false, "category": "plant-milk"},
		Confidence: 0.62, TaxonomyVersion: taxonomy.Version, Source: "model", Status: "review"}
	ctx.NoError(store.EnqueueReview(reviewBg, proposal, "brand 'Glowra' is not a taxonomy candidate"), "parking the proposal")
	if holder != "" {
		ctx.Redis.Set("review:lease:sku-1", holder)
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux), &published
}

func decide(c *harness.HTTP, skuID string, headers ...string) *harness.Response {
	return c.Post("/v1/skus/"+skuID+"/review", correction, headers...)
}

func untouched(ctx *harness.Ctx, published *[]store.Event, why string) {
	ctx.Assert(store.ReadLabel(reviewBg, "sku-1", 1) == nil && len(*published) == 0 && store.CatalogCurrent(reviewBg, "sku-1") == nil, "%s, yet a label, an event or a catalog row was written", why)
	ctx.Assert(store.Pending(reviewBg, "sku-1") != nil, "%s, yet the proposal left the review queue", why)
}

func CheckReviewerAuth(ctx *harness.Ctx) {
	c, published := reviewAPI(ctx, "ana")
	r := decide(c, "sku-1", "Idempotency-Key", "k-1", "X-Reviewer-Role", "reviewer")
	ctx.Equal(r.Status, 401, "a decision without X-Reviewer-Id; the status")
	r = decide(c, "sku-1", "Idempotency-Key", "k-2", "X-Reviewer-Id", "ana", "X-Reviewer-Role", "shopper")
	ctx.Equal(r.Status, 403, "a decision from role 'shopper'; the status")
	untouched(ctx, published, "after two refused requests")
	r = decide(c, "sku-1", "Idempotency-Key", "k-3", "X-Reviewer-Id", "ana", "X-Reviewer-Role", "reviewer")
	ctx.Equal(r.Status, 200, "a reviewer holding the lease (%s); the status", r.Text())
}

func CheckLeaseHeld(ctx *harness.Ctx) {
	c, published := reviewAPI(ctx, "ben")
	ana := []string{"X-Reviewer-Id", "ana", "X-Reviewer-Role", "reviewer"}
	r := decide(c, "sku-1", append([]string{"Idempotency-Key", "k-1"}, ana...)...)
	ctx.Equal(r.Status, 409, "ana decided on a SKU whose review lease ben holds; the status")
	untouched(ctx, published, "after a decision without the lease")
	ctx.Redis.Set("review:lease:sku-1", "ana")
	r = decide(c, "sku-1", append([]string{"Idempotency-Key", "k-2"}, ana...)...)
	ctx.Equal(r.Status, 200, "the lease holder's decision (%s); the status", r.Text())
	_, held := ctx.Redis.Get("review:lease:sku-1")
	ctx.Assert(!held, "the decision is made: release the lease so the SKU does not stay claimed for 15 minutes")
	r = decide(c, "sku-404", append([]string{"Idempotency-Key", "k-3"}, ana...)...)
	ctx.Equal(r.Status, 404, "a decision on a SKU with no proposal; the status")
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	c, published := reviewAPI(ctx, "ana")
	ana := []string{"X-Reviewer-Id", "ana", "X-Reviewer-Role", "reviewer"}
	r := decide(c, "sku-1", ana...)
	ctx.Equal(r.Status, 400, "a decision without Idempotency-Key; the status")
	untouched(ctx, published, "after a decision without Idempotency-Key")
	first := decide(c, "sku-1", append([]string{"Idempotency-Key", "k-1"}, ana...)...)
	ctx.Equal(first.Status, 200, "the first decision (%s); the status", first.Text())
	retry := decide(c, "sku-1", append([]string{"Idempotency-Key", "k-1"}, ana...)...)
	ctx.Assert(retry.Status == 200 && retry.Text() == first.Text(), "a retry with the same Idempotency-Key must answer the first response: first %s, retry %d %s", first.Text(), retry.Status, retry.Text())
	ctx.Assert(store.ReadLabel(reviewBg, "sku-1", 2) == nil && len(*published) == 1, "the retry recorded a second decision: %d events published", len(*published))
}

func CheckLabelAndPublish(ctx *harness.Ctx) {
	c, published := reviewAPI(ctx, "ana")
	r := decide(c, "sku-1", "Idempotency-Key", "k-1", "X-Reviewer-Id", "ana", "X-Reviewer-Role", "reviewer")
	ctx.Equal(r.Status, 200, "the decision (%s); the status", r.Text())
	var body struct {
		LabelVersion      int64 \`json:"label_version"\`
		AttributesVersion int64 \`json:"attributes_version"\`
	}
	r.Decode(&body)
	ctx.Equal(body.LabelVersion, int64(1), "the answer must carry the label version (%s); label_version", r.Text())
	label := store.ReadLabel(reviewBg, "sku-1", 1)
	ctx.Assert(label != nil, "no label:sku-1:v1 was written: the correction is the training example for the next model")
	attributes, _ := label["attributes"].(map[string]any)
	ctx.Assert(label["decision"] == "correct" && attributes["brand"] == "Oatly" && label["reviewer"] == "ana" && label["taxonomy_version"] == taxonomy.Version,
		"the label must hold the decision, the corrected attributes, the reviewer and the taxonomy version, got %v", label)
	ctx.Equal(len(*published), 1, "the decision must be published once; the events")
	event := (*published)[0]
	ctx.Assert(event.Source == "human" && event.Attributes["brand"] == "Oatly", "the event must carry the corrected attributes with source human, got %+v", event)
	ctx.Equal(event.AttributesVersion, body.AttributesVersion, "the event's attributes_version must be the one the answer names")
	ctx.Assert(store.Pending(reviewBg, "sku-1") == nil, "the decided proposal is still in the review queue")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "enrich/store.h"
#include "enrich/taxonomy.h"

std::vector<nlohmann::json> review_published;

// Stands in for step 5: records the events the endpoint publishes.
void publish(const nlohmann::json& event) { review_published.push_back(event); }

namespace {

const std::string kCorrection = R"({"decision": "correct", "attributes": {"brand": "Oatly"}, "note": "brand printed on the carton"})";

// Parks one proposal for sku-1 and gives the lease to holder.
harness::HTTP reviewAPI(harness::Ctx& ctx, const std::string& holder) {
  review_published.clear();
  const nlohmann::json proposal = {{"sku_id", "sku-1"}, {"merchant", "m-1"},
                                   {"attributes", {{"brand", nullptr}, {"size", 1.0}, {"unit", "l"}, {"organic", false}, {"category", "plant-milk"}}},
                                   {"confidence", 0.62}, {"taxonomy_version", taxonomy::kVersion}};
  store::enqueue_review(proposal, "brand 'Glowra' is not a taxonomy candidate");
  if (!holder.empty()) ctx.Redis.Set("review:lease:sku-1", holder);
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

void untouched(harness::Ctx& ctx, const std::string& why) {
  ctx.Assert(!store::read_label("sku-1", 1) && review_published.empty() && !store::catalog_current("sku-1"), "%s, yet a label, an event or a catalog row was written", why);
  ctx.Assert(store::pending("sku-1").has_value(), "%s, yet the proposal left the review queue", why);
}

}  // namespace

void CheckReviewerAuth(harness::Ctx& ctx) {
  auto c = reviewAPI(ctx, "ana");
  auto r = c.Post("/v1/skus/sku-1/review", kCorrection, "Idempotency-Key", "k-1", "X-Reviewer-Role", "reviewer");
  ctx.Equal(r.Status, 401, "a decision without X-Reviewer-Id; the status");
  r = c.Post("/v1/skus/sku-1/review", kCorrection, "Idempotency-Key", "k-2", "X-Reviewer-Id", "ana", "X-Reviewer-Role", "shopper");
  ctx.Equal(r.Status, 403, "a decision from role 'shopper'; the status");
  untouched(ctx, "after two refused requests");
  r = c.Post("/v1/skus/sku-1/review", kCorrection, "Idempotency-Key", "k-3", "X-Reviewer-Id", "ana", "X-Reviewer-Role", "reviewer");
  ctx.Equal(r.Status, 200, "a reviewer holding the lease (%s); the status", r.Text());
}

void CheckLeaseHeld(harness::Ctx& ctx) {
  auto c = reviewAPI(ctx, "ben");
  auto r = c.Post("/v1/skus/sku-1/review", kCorrection, "Idempotency-Key", "k-1", "X-Reviewer-Id", "ana", "X-Reviewer-Role", "reviewer");
  ctx.Equal(r.Status, 409, "ana decided on a SKU whose review lease ben holds; the status");
  untouched(ctx, "after a decision without the lease");
  ctx.Redis.Set("review:lease:sku-1", "ana");
  r = c.Post("/v1/skus/sku-1/review", kCorrection, "Idempotency-Key", "k-2", "X-Reviewer-Id", "ana", "X-Reviewer-Role", "reviewer");
  ctx.Equal(r.Status, 200, "the lease holder's decision (%s); the status", r.Text());
  ctx.Assert(!ctx.Redis.Get("review:lease:sku-1"), "the decision is made: release the lease so the SKU does not stay claimed for 15 minutes");
  r = c.Post("/v1/skus/sku-404/review", kCorrection, "Idempotency-Key", "k-3", "X-Reviewer-Id", "ana", "X-Reviewer-Role", "reviewer");
  ctx.Equal(r.Status, 404, "a decision on a SKU with no proposal; the status");
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  auto c = reviewAPI(ctx, "ana");
  const auto r = c.Post("/v1/skus/sku-1/review", kCorrection, "X-Reviewer-Id", "ana", "X-Reviewer-Role", "reviewer");
  ctx.Equal(r.Status, 400, "a decision without Idempotency-Key; the status");
  untouched(ctx, "after a decision without Idempotency-Key");
  const auto first = c.Post("/v1/skus/sku-1/review", kCorrection, "Idempotency-Key", "k-1", "X-Reviewer-Id", "ana", "X-Reviewer-Role", "reviewer");
  ctx.Equal(first.Status, 200, "the first decision (%s); the status", first.Text());
  const auto retry = c.Post("/v1/skus/sku-1/review", kCorrection, "Idempotency-Key", "k-1", "X-Reviewer-Id", "ana", "X-Reviewer-Role", "reviewer");
  ctx.Assert(retry.Status == 200 && retry.Text() == first.Text(), "a retry with the same Idempotency-Key must answer the first response: first %s, retry %d %s", first.Text(), retry.Status, retry.Text());
  ctx.Assert(!store::read_label("sku-1", 2) && review_published.size() == 1, "the retry recorded a second decision: %d events published", review_published.size());
}

void CheckLabelAndPublish(harness::Ctx& ctx) {
  auto c = reviewAPI(ctx, "ana");
  const auto r = c.Post("/v1/skus/sku-1/review", kCorrection, "Idempotency-Key", "k-1", "X-Reviewer-Id", "ana", "X-Reviewer-Role", "reviewer");
  ctx.Equal(r.Status, 200, "the decision (%s); the status", r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object() && body.value("label_version", 0LL) == 1, "the answer must carry the label version, got %s", r.Text());
  const auto label = store::read_label("sku-1", 1);
  ctx.Assert(label.has_value(), "no label:sku-1:v1 was written: the correction is the training example for the next model");
  ctx.Assert((*label)["decision"] == "correct" && (*label)["attributes"]["brand"] == "Oatly" && (*label)["reviewer"] == "ana" && (*label)["taxonomy_version"] == taxonomy::kVersion,
             "the label must hold the decision, the corrected attributes, the reviewer and the taxonomy version, got %s", label->dump());
  ctx.Equal(review_published.size(), 1, "the decision must be published once; the events");
  const auto& event = review_published[0];
  ctx.Assert(event["source"] == "human" && event["attributes"]["brand"] == "Oatly", "the event must carry the corrected attributes with source human, got %s", event.dump());
  ctx.Assert(event["attributes_version"] == body["attributes_version"], "the event's attributes_version %s differs from the answer's %s", event["attributes_version"].dump(), body.value("attributes_version", nlohmann::json()).dump());
  ctx.Assert(!store::pending("sku-1"), "the decided proposal is still in the review queue");
}
`,
  },
  debrief: `The order of the guards is the order of who may know what: authentication and role first, so an anonymous caller learns nothing; the idempotency record next, so a retry is answered before anything is read or written; then the lease, which turns "two reviewers on one SKU" into a 409 instead of a lost correction. The label is written before the event because the label is the durable product of the review, the training example the next model is fine-tuned on, while the event only tells the catalog and the search index. Publishing instead of writing the catalog row keeps one path into the catalog, so step 5's version and human-wins rules apply to reviewers too. A larger tool would add reviewer agreement checks, an audit trail per label, and sampling of accepted SKUs for review.`,
};
