import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Multimodal ingest: the course is not "store an image and call a caption model", it is the
 * debugging you owe an ingest path before hundreds of tenants point their uploaders at it. Metadata
 * registered under the content hash before the bytes arrive → one atomic Redis reservation for
 * dedupe and the per-tenant quota → a vision call with a deadline whose failure degrades to
 * text-only indexing instead of a placeholder caption → per-asset events that carry checksums and
 * embedding ids and are published only after the index write confirms → a read endpoint that
 * scopes by tenant and hands out short-lived signed URLs.
 */
export const multimodalIngestProblem: Problem = {
  id: 'multimodal-ingest',
  title: 'Multimodal Ingest',
  tagline: 'Images and captions enter the index together, deduped and tenant-safe.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Multimodal Ingest

A multimodal ingest service turns an uploaded image and its caption into exactly one searchable
document: metadata registered before the bytes arrive, a content hash that collapses re-uploads, a
vision model that captions what the caller did not, and an event that tells the platform what became
searchable. The parts that decide whether the platform can be trusted are the trust boundary at
upload, the atomic dedupe and quota, the failure policy around the vision model, the payload of the
events, and the tenant-scoped read.

## The real system

Immich, the open-source photo server, runs this pipeline for every library it hosts: a separate
machine-learning service embeds each uploaded asset with a CLIP model, the vectors land in Postgres
through the VectorChord extension, and "Smart Search" indexing runs as a background job queue, so
switching models means re-queueing every asset rather than blocking uploads.

The shape generalizes: the client registers the asset first and PUTs the bytes to a signed URL, so
a 20 MiB upload does not occupy an API worker, and the content hash is the idempotency key.

## What you build here

One service, **ingestd**, with five pieces:

1. \`POST /v1/assets\`: tenant, mime allowlist, 20 MiB byte cap, 4 KiB caption cap, and a required
   \`Idempotency-Key\` carrying the content hash; a re-registration returns the original asset id.
2. A **Redis** reservation: one Lua \`EVAL\` for the \`(tenant, content hash)\` dedupe key and the
   minute counter, **429** with \`Retry-After\` on the 501st asset, both keys expiring on first write.
3. A **gRPC** vision client: a 3-second deadline, a content-policy rejection that fails the asset,
   and a timeout that degrades to text-only embeddings with \`caption: null\`.
4. A **Kafka** \`asset.indexed\` event: keyed by asset id, carrying checksums and embedding ids and
   no object URL, published after the index write confirms, with an outbox row on rejection.
5. \`GET /v1/assets/{id}\`: tenant-scoped (foreign id is **404**) with a 15-minute signed URL; the
   API does not proxy the bytes.

## The debugging habit

Every starter compiles and serves the happy path. Debug it, fix it, and prove the fix with checks
that fail on the starter and pass on your version.

## Left out on purpose

Object storage internals and multipart uploads, EXIF stripping and image resizing, the vector store's
own schema, caption quality evaluation, caption backfill scheduling, per-tenant mime overrides, virus
scanning, and cross-region replication.`,
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
