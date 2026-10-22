import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * File storage on the AI-era track: the course is not "upload a file", it is the review you owe a
 * model-generated storage service before a tenant's quota, bytes and links are trusted. A validated
 * upload handshake that counts the stream against its declaration → one atomic Redis reservation with
 * a TTL → object-store writes with chunk-scoped retries and a commit-gated completion → file events
 * keyed by file id with no user text → a signed, tenant-scoped, audited download URL.
 */
export const fileStorageProblem: Problem = {
  id: 'file-storage',
  title: 'File Storage',
  tagline: 'Uploads that respect quota, resume cleanly and never expose permanent links.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# File Storage

A file-storage service is the piece of a platform that accepts bytes from tenants, keeps them within a
quota, survives an interrupted upload, and hands them back without turning a one-time read into a
permanent capability. The visible part is an upload id and a download link; the parts that decide
whether the service is safe are the size the server believes, the reservation it holds, the retry it
performs and the link it signs.

## The real system

Production storage services never trust the size a client declares. They reserve quota atomically so two
uploads cannot both spend the last gigabyte, count the bytes that actually arrive, and abort a stream
that runs past its declaration. They keep an upload's session and its reservation in one atomic unit
with an expiry, so an abandoned multi-gigabyte upload stops pinning the tenant's headroom. They write
chunks to the object store under a deadline, retry only the chunk that failed, and let the store dedupe
an identical chunk by its hash. They mark a file complete only after the store confirms the commit, so
an interrupted upload never appears in a listing. They publish one event per file keyed by the file id,
carrying digests and sniffed types but never the original filename. And they answer a download with a
signed URL that expires, is bound to the requesting tenant, and leaves an audit record naming the
person who asked.

## What you build here

One service, **stored**, with five pieces:

1. \`POST /v1/files\`: an authenticated tenant, a declared size within 5 GiB and a mime in the allowlist,
   a quota check, and a tenant-scoped upload id. The declared size is verified against the actual
   stream — a stream past its declaration aborts mid-upload — and the finalize path records the type
   sniffed from the bytes rather than the one the caller claimed.
2. A **Redis** state layer: the session and the tenant's reservation move in one atomic script, the
   chunk ack and the byte accounting move in another, the session key expires after 24 hours, and a
   sweep releases the reservation of a session that expired without finishing.
3. A **gRPC** object-store client: every chunk write runs under a 15-second deadline, a retried chunk
   carries its SHA-256 so the store dedupes it, and completion waits for the store's \`CommitMultipart\`
   before the local index marks the file committed.
4. A **Kafka** event path: one \`file.event\` per upload, finalize and delete, keyed by file id so a file's
   lifecycle stays ordered, with the digest, the sniffed type and the size — and no original filename.
5. \`GET /v1/files/{id}\`: the file's tenant is checked against the caller (a foreign id is \`404\`), the
   response is a signed URL that expires in 10 minutes, and the issuance is audited with the requester.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Billing and invoicing, cross-region replication, client-side encryption, lifecycle and retention rules,
thumbnail generation, virus scanning pipelines, and the CDN's own configuration. The five pieces above
are the ones that decide whether the storage service is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'upload · download', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'Upload API', sub: 'HTTPS :8443', x: 24, y: 34},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'sessions · quota', x: 42, y: 12},
      {id: 'store', kind: 'grpc', label: 'Object store', sub: 'gRPC :9000', x: 42, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'file.event', sub: 'key = file id', x: 42, y: 88},
      {id: 'reader', kind: 'http', label: 'Download API', sub: 'GET /v1/files', x: 64, y: 34},
      {id: 'audit', kind: 'kafka', label: 'file.audit', sub: 'issuance trail', x: 64, y: 72},
      {id: 'consumer', kind: 'service', label: 'Event consumer', sub: 'derives metadata', x: 84, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'client', to: 'reader', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'sessions · quota'},
      {from: 'api', to: 'store', kind: 'grpc', label: 'PutChunk · CommitMultipart'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce file.event'},
      {from: 'reader', to: 'redis', kind: 'redis', label: 'authorize · sign'},
      {from: 'reader', to: 'audit', kind: 'kafka', label: 'download_issued'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
