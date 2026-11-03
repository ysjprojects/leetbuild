import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Multimodal ingest: the course is not "store an image and call a caption model", it is the
 * debugging you owe an ingest path before hundreds of tenants point their uploaders at it. Metadata
 * registered under the content hash before the bytes arrive → one atomic Redis reservation for
 * dedupe and the per-tenant quota → a vision call under a deadline whose failure indexes no caption
 * and queues a backfill → per-asset events that carry checksums and embedding ids, produced after
 * the index write → a read that scopes by tenant and hands out short-lived signed URLs. The steps
 * share the `ingest` support package (asset store, index writer, object-store signer).
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

A multimodal ingest service turns an uploaded image, with or without a caption, into exactly one
searchable asset: metadata registered under the content hash before the bytes arrive, a reservation
that collapses re-uploads and meters each tenant, a caption from a vision model when the uploader
gave none, an index write and an event that tells the platform what became searchable, and a read
that hands the bytes out only through a short-lived signed URL.

## The real system

Immich, the open-source photo server, takes the same shape. Its upload endpoint accepts an
\`x-immich-checksum\` header, the file's SHA-1, so the server can spot a duplicate before the bytes
are sent, and answers \`created\`, \`replaced\` or \`duplicate\`. The model work (CLIP embeddings for
smart search, face recognition) runs in a separate machine-learning container that can live on
another host, so a slow model holds up indexing, not uploads.

## What you build here

One service, **ingestd**, over three provided modules: the asset store \`ingest.assets\` (asset
hashes in Redis, the backfill set, the outbox), the index writer \`ingest.vectors\` and the object
store's side of a signed URL, \`ingest.objects\`.

1. \`POST /v1/assets\`: the tenant from \`X-Tenant-Id\`, a mime allowlist, 20 MiB and 4 KiB caps, and
   \`Idempotency-Key\` as the content hash, so a re-registration answers 200 with the original asset.
2. A **Redis** reservation, \`reserve(tenant, checksum, asset_id)\`: one Lua script over
   \`ingest:dedupe:{tenant}:{checksum}\` and the minute counter \`ingest:quota:{tenant}:{window}\`,
   500 a minute, \`retry_after\` up to the window's end.
3. A **gRPC** vision client, \`caption_asset(asset)\`: \`Caption\` under a 3-second deadline; a policy
   refusal fails the asset, an outage indexes it without a caption, degraded and queued for backfill.
4. A **Kafka** \`asset.indexed\` event, \`index_and_publish(asset, captioned)\`: the index first, then
   an event keyed by asset id with checksum and embedding ids and no URL, from an idempotent
   producer, with an outbox row when the broker does not acknowledge.
5. \`GET /v1/assets/{id}\`: scoped to the tenant (another tenant's id is 404), with a 15-minute URL
   whose MAC covers checksum, tenant and expiry; the API does not carry the bytes.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Object storage internals and multipart uploads, EXIF stripping and resizing, the vector store's own
schema, caption quality, the backfill worker and the outbox relay, virus scanning, and cross-region
replication.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'register · upload · read', x: 8, y: 50},
      {id: 'ingest', kind: 'http', label: 'Ingest API', sub: 'ingestd', x: 27, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'assets · dedupe · quota · outbox', x: 47, y: 14},
      {id: 'vision', kind: 'grpc', label: 'Vision service', sub: 'Caption · 3 s', x: 70, y: 14},
      {id: 'objects', kind: 'external', label: 'Object store', sub: 'signed PUT / GET', x: 70, y: 40},
      {id: 'indexer', kind: 'service', label: 'Index', sub: 'image + caption vectors', x: 47, y: 64},
      {id: 'kafka', kind: 'kafka', label: 'asset.indexed', sub: 'key = asset_id', x: 47, y: 88},
      {id: 'consumer', kind: 'service', label: 'Event consumer', sub: 'search · audit', x: 70, y: 88},
    ],
    edges: [
      {from: 'client', to: 'ingest', kind: 'http', label: 'HTTPS'},
      {from: 'client', to: 'objects', kind: 'plain', label: 'PUT · GET signed url'},
      {from: 'ingest', to: 'redis', kind: 'redis', label: 'assets · EVAL reserve'},
      {from: 'ingest', to: 'vision', kind: 'grpc', label: 'Caption · deadline 3 s'},
      {from: 'vision', to: 'objects', kind: 'plain', label: 'read by checksum'},
      {from: 'ingest', to: 'indexer', kind: 'plain', label: 'upsert vectors'},
      {from: 'ingest', to: 'kafka', kind: 'kafka', label: 'produce asset.indexed'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
