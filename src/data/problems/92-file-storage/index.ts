import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * File storage: the course is not "upload a file", it is the debugging you owe a storage service
 * before a tenant's quota, bytes and links are trusted. Parts held to the tenant and the declared
 * size and type → one Redis script that reserves quota and opens a 24-hour session → object-store
 * writes retried part by part and indexed only after the commit → file events keyed by file id,
 * after the change, without the filename → a tenant-scoped download link signed for ten minutes
 * and audited with the requester.
 */
export const fileStorageProblem: Problem = {
  id: 'file-storage',
  title: 'File Storage',
  tagline: 'Multipart uploads on a Redis quota, committed over gRPC, announced on Kafka, read through signed links.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# File Storage

A file-storage service accepts bytes from tenants, keeps them within a quota, survives an interrupted
upload and hands them back without turning one download into a permanent capability. The visible
parts are an upload id and a download link; what decides whether the service is safe is the size the
server believes, the reservation it holds, the part it retries and the link it signs.

## The real system

Amazon S3's multipart upload is the shape this course follows: an object is uploaded as numbered
parts, a part whose transmission fails is retransmitted without affecting the others, and
\`CompleteMultipartUpload\` assembles them into one object. A part or a whole object can carry a
checksum that S3 validates server-side, failing the request with \`BadDigest\` on a mismatch. Reads are
granted through presigned URLs that carry their own expiry.

## What you build here

One service, **stored**, on one Redis layout and two provided modules: \`files.store\` (staged parts
\`part:{upload_id}:{n}\`, the file index \`file:{file_id}\`, \`sniff_mime\`, \`commit_file\`,
\`delete_file\`, \`sign_url\`/\`verify_url\`) and \`files.sessions\` (step 2's functions, provided to the
other steps).

1. \`POST /v1/files\` (\`X-Tenant-Id\`, \`{size, mime, name}\`) → 201 \`{upload_id, declared_size}\` and
   \`PUT /v1/uploads/{upload_id}/parts/{n}\` (\`application/octet-stream\`) → \`{part, actual_bytes}\`:
   bound to the tenant, held to the declared size, sniffed against the declared type.
2. **Redis** sessions: \`open_session\` checks \`quota:used:{tenant}\` against \`quota:limit:{tenant}\`,
   reserves in \`quota:reservations:{tenant}\` and opens \`session:{upload_id}\` for 24 h in one script;
   \`ack_part\` counts a part once; \`sweep\` releases each expired reservation once.
3. **gRPC** \`stored.ObjectStore\` at \`objectstore:9000\`: \`complete(upload_id)\` writes each part with
   \`PutChunk\` (15 s deadline, SHA-256, retried alone), then \`CommitMultipart\`, then \`commit_file\`.
4. **Kafka** \`file.event\`: \`finalize(upload_id)\` and \`delete_file(file_id)\` emit
   \`{type, file_id, tenant, size, mime, digest}\` keyed by file id, after the change, from an
   idempotent producer with \`acks=all\`.
5. \`GET /v1/files/{file_id}\` (\`X-Tenant-Id\`, \`X-User-Id\`) → \`{file_id, url, expires_at}\`: the
   caller's committed files only (404 otherwise), a URL signed for 600 s, and a \`download_issued\`
   record on \`file.audit\` naming the user.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Billing, cross-region replication, client-side encryption, retention rules, thumbnails, virus
scanning and CDN configuration.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'upload · download', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'Upload API', sub: 'POST /v1/files · PUT parts', x: 24, y: 34},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'sessions · quota · file index', x: 46, y: 12},
      {id: 'store', kind: 'grpc', label: 'Object store', sub: 'objectstore:9000 · 15 s', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'file.event', sub: 'key = file id', x: 46, y: 88},
      {id: 'reader', kind: 'http', label: 'Download API', sub: 'GET /v1/files/{id}', x: 68, y: 34},
      {id: 'audit', kind: 'kafka', label: 'file.audit', sub: 'download_issued · user', x: 68, y: 70},
      {id: 'consumer', kind: 'service', label: 'Event consumer', sub: 'search · thumbnails', x: 86, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'client', to: 'reader', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'OPEN_LUA · ACK_LUA · stage parts'},
      {from: 'api', to: 'store', kind: 'grpc', label: 'PutChunk · CommitMultipart'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'finalized · deleted'},
      {from: 'reader', to: 'redis', kind: 'redis', label: 'find_file'},
      {from: 'reader', to: 'audit', kind: 'kafka', label: 'download_issued'},
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
