import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Resumable upload: the course is not "accept a multipart body", it is the debugging you owe an
 * upload pipeline before a mobile client loses a multi-gigabyte file to one failed part.
 * Declared-parts initiation with bounded part counts → an atomic Redis
 * manifest that registers each part exactly once → gRPC part writes that verify the store's
 * checksum before marking stored → upload events keyed by upload id and published after the object
 * commits → a status read that names the exact missing and corrupt parts.
 */
export const resumableUploadProblem: Problem = {
  id: 'resumable-upload',
  title: 'Resumable Upload',
  tagline: 'Multi-gigabyte uploads that resume from the exact missing part number.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Resumable Upload

A resumable upload service is the piece of a platform that lets a client send a multi-gigabyte file in
parts, survive a dropped connection, and resume from the exact part that failed instead of starting
over. The visible part is a progress bar; the parts that decide whether the upload is correct are the
declared-part contract, the atomic manifest, the per-part verification, the event ordering and the
resume read.

## The real system

The tus resumable upload protocol makes resume a two-step dance: the client sends a \`HEAD\` to the
upload URL and the server answers with an \`Upload-Offset\` header saying how many bytes it has, and
the client continues with a \`PATCH\` from that offset. Its creation extension declares
\`Upload-Length\` up front so the server can bound the session before any bytes arrive. Part-based
services such as S3 multipart upload follow the same shape with numbered parts instead of a byte
offset: initiate with a declared size, register each part with the checksum the store computed, and
list the parts on resume. The service in this course does the part-based version: one atomic
manifest write per part, a checksum compared against the store's echo before a part is called
stored, completion published only after the object commits, and a status read that returns the
missing and corrupt part numbers scoped to the owning tenant.

## What you build here

One service, **uploadd**, with five pieces:

1. \`POST /v1/uploads\`: authenticated tenant, declared \`total_bytes\`, \`part_bytes\` and
   \`content_type\`, a part count bounded by the minimum part size and the tenant quota, the sniffed
   type recorded at completion, and an \`Idempotency-Key\` so a retry returns the original upload id.
2. A **Redis** part manifest: one atomic Lua \`EVAL\` per part that rejects duplicates and numbers
   outside \`1..part_count\`, counts bytes from unique parts only, and expires the manifest, its parts
   and its byte counter after 24 hours.
3. A **gRPC** part writer: a 30-second deadline per \`WritePart\`, a checksum comparison against the
   store's echo, a per-part retry bounded by \`MAX_PART_ATTEMPTS\`, and a resume list naming the exact
   missing part numbers.
4. A **Kafka** event path: \`upload.event\` keyed by upload id, \`upload.completed\` published after the
   object commits, an outbox row when the broker rejects, and no content bytes in the event.
5. \`GET /v1/uploads/{upload_id}\`: stored, missing and corrupt parts with their checksums, a \`resume\`
   list, and a 404 for a foreign tenant's upload.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. Your job in every step is the job you will have on a real feature: debug it against
the failure modes, fix it, optimize what is wasteful, and prove the fix with checks that fail on the
starter and pass on your version.

## Left out on purpose

Signed per-part upload URLs, S3-style multipart ETag reconciliation, cross-region object replication,
bandwidth throttling, per-tenant storage billing, client-side chunking strategy, and the finalize-time
assembly of the object. The five pieces above are the ones that decide whether the upload is correct,
resumable and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Uploader', sub: 'parts · resume', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Upload API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'upload · outbox', sub: 'id · parts', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'manifest · expiry', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'upload.event', sub: 'key = upload id', x: 44, y: 86},
      {id: 'store', kind: 'grpc', label: 'Object store', sub: 'WritePart', x: 66, y: 12},
      {id: 'consumer', kind: 'service', label: 'Event consumer', sub: 'group upload', x: 66, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'upload · outbox'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'manifest · expiry'},
      {from: 'api', to: 'store', kind: 'grpc', label: 'WritePart'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce upload.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
