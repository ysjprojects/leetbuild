import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Multimodal ingest on the AI-era track: the course is not "store an image and call a caption
 * model", it is the review you owe a model-generated ingest path before hundreds of tenants point
 * their uploaders at it. Metadata registered under the content hash before the bytes arrive → one
 * atomic Redis reservation for dedupe and the per-tenant quota → a vision call with a deadline
 * whose failure degrades to text-only indexing instead of a placeholder caption → per-asset events
 * that carry checksums and embedding ids and are published only after the index write confirms →
 * a read endpoint that scopes by tenant and hands out short-lived signed URLs.
 */
export const multimodalIngestProblem: Problem = {
  id: 'multimodal-ingest',
  title: 'Multimodal Ingest',
  tagline: 'Images and captions enter the index together, deduped and tenant-safe.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Multimodal Ingest

A multimodal ingest service is the piece of an AI platform that turns an uploaded image and its
caption into exactly one searchable document: metadata registered before the bytes arrive, a content
hash that collapses re-uploads, a vision model that captions what the caller did not, an indexer
that writes text and image vectors together, and an event stream that tells the rest of the platform
what became searchable. The visible part is a search result with a thumbnail; the parts that decide
whether the platform can be trusted are the trust boundary at upload, the atomic dedupe and quota,
the failure policy around the vision model, the key and payload of the events, and the signed,
tenant-scoped read.

## The real system

Production ingest never lets the bytes and the metadata arrive together. The client registers the
asset first — mime type, byte size, optional caption, content hash — and receives a signed URL to
PUT the bytes to object storage, so a 20 MiB upload never occupies an API worker. The mime type
comes from an allowlist rather than the request, because "image/svg+xml" and a polyglot PDF are the
same field. The content hash is the idempotency key: two uploads of the same bytes under the same
tenant are one asset with one set of embeddings, whatever the client retries.

Dedupe and quota live in one atomic reservation. Checking "have I seen this hash" with one command
and incrementing the tenant's minute counter with another leaves a window where two concurrent
requests both observe room that only one of them has; the reservation has to happen inside a single
Lua script, and both keys have to expire or the dedupe map grows forever and a tenant that had one
busy minute stays locked out.

Captions are optional and expensive. When the request has none, the service asks a vision model over
gRPC under a deadline. A timeout is not an error the user sees: the asset is indexed with text-only
embeddings and flagged as degraded, so search still works and the backfill can find it later. A
content-policy rejection is different — the asset must fail with a reason, because indexing it
text-only would hide the rejection. And nothing that failed may ever be replaced by placeholder
text: a caption of "an image" is worse than no caption, because it matches every query.

Events carry facts, not addresses. The indexed event is keyed by asset id so every event about one
asset stays ordered, carries the checksum and the embedding ids instead of a URL, and is published
only after the index write confirms — otherwise a consumer reacts to an asset it cannot read yet.
Rejections leave an outbox row so the broker's bad day is not the index's bad day.

Reads are signed and scoped. The read endpoint answers with metadata, the caption and its character
offsets, and a signed URL that expires in 15 minutes and covers the tenant, so an id leaked to
another tenant is a 404 and a URL leaked to a proxy stops working.

## What you build here

One service, **ingestd**, with five pieces:

1. \`POST /v1/assets\`: authenticated tenant, mime allowlist, 20 MiB byte cap, 4 KiB caption cap, and
   a required \`Idempotency-Key\` carrying the content hash — a re-registration returns the original
   asset id instead of a duplicate.
2. A **Redis** reservation: one Lua \`EVAL\` that checks the \`(tenant, content hash)\` dedupe key,
   refuses the **501st** asset of a tenant's minute with \`Retry-After\`, and expires both keys on
   first write; a duplicate passes through the cache path without spending quota.
3. A **gRPC** vision client: a 3-second deadline per caption call, a content-policy rejection that
   fails the asset, and a timeout that degrades to text-only embeddings with \`caption: null\` — never
   placeholder text.
4. A **Kafka** \`asset.indexed\` event: keyed by asset id, carrying checksums and embedding ids and no
   object URL, published only after the index write confirms, with an outbox row on rejection.
5. \`GET /v1/assets/{id}\`: tenant-scoped (foreign id → **404**) with a signed URL that expires in 15
   minutes; the API never proxies the original bytes.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Object storage internals and multipart uploads, EXIF stripping and image resizing, the vector store's
own schema, caption quality evaluation, caption backfill scheduling, per-tenant mime overrides,
virus scanning, and cross-region replication. The five pieces above are the ones that decide whether
the ingest is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'register · upload · read', x: 8, y: 50},
      {id: 'ingest', kind: 'http', label: 'Ingest API', sub: 'HTTPS :8443', x: 27, y: 50},
      {id: 'db', kind: 'db', label: 'assets · outbox', sub: 'metadata · rows', x: 45, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'dedupe · quota', x: 45, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'asset.indexed', sub: 'key = asset_id', x: 45, y: 88},
      {id: 'vision', kind: 'grpc', label: 'Vision service', sub: 'Caption · 3 s', x: 68, y: 10},
      {id: 'objects', kind: 'external', label: 'Object store', sub: 'signed PUT / GET', x: 68, y: 38},
      {id: 'indexer', kind: 'service', label: 'Indexer', sub: 'text + image vectors', x: 68, y: 64},
      {id: 'consumer', kind: 'service', label: 'Event consumer', sub: 'group ingest-index', x: 68, y: 88},
    ],
    edges: [
      {from: 'client', to: 'ingest', kind: 'http', label: 'HTTPS'},
      {from: 'client', to: 'objects', kind: 'plain', label: 'PUT signed url'},
      {from: 'ingest', to: 'db', kind: 'plain', label: 'assets · outbox'},
      {from: 'ingest', to: 'redis', kind: 'redis', label: 'reserve'},
      {from: 'ingest', to: 'vision', kind: 'grpc', label: 'Caption · deadline 3 s'},
      {from: 'ingest', to: 'objects', kind: 'plain', label: 'presign'},
      {from: 'vision', to: 'objects', kind: 'plain', label: 'signed GET'},
      {from: 'ingest', to: 'indexer', kind: 'plain', label: 'upsert vectors'},
      {from: 'ingest', to: 'kafka', kind: 'kafka', label: 'produce asset.indexed'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'indexer', kind: 'plain', label: 'verify + backfill'},
      {from: 'indexer', to: 'db', kind: 'plain', label: 'embedding ids'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
