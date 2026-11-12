import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Resumable upload: the course is not "accept a multipart body", it is the debugging you owe an
 * upload pipeline before a mobile client loses a multi-gigabyte file to one failed part. A bounded
 * part plan at initiation → one Lua script that registers each part once → part writes verified
 * against the store's checksum under a deadline → an upload-keyed completion event after the object
 * commits → a status read that names exactly the parts to send again.
 */
export const resumableUploadProblem: Problem = {
  id: 'resumable-upload',
  title: 'Resumable Upload',
  tagline: 'Multi-gigabyte uploads that resume from the exact part numbers still missing.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Resumable Upload

A resumable upload service lets a client send a multi-gigabyte file in numbered parts, survive a
dropped connection, and send again only the parts the server does not hold. The progress bar is the
visible part; what decides whether a resume is correct is the part plan, the manifest of registered
parts, the checksum each write is verified against, and a status read that names the gaps.

## The real system

Amazon S3 multipart upload numbers parts 1 to 10,000, takes parts of 5 MiB to 5 GiB with no minimum
on the last one, lists the parts it holds (\`ListParts\`) so a client can resume, and assembles them
into one object at \`CompleteMultipartUpload\`. This course builds the same shape as one service.

## What you build here

One service, **uploadd**, on two provided modules: \`uploads.store\` (upload records
\`upload:{id}\`, initiation idempotency, the \`outbox\` list) and \`uploads.manifest\` (step 2's
\`register_part\`, \`read_parts\`, \`uploaded_bytes\`, provided to the later steps).

1. \`POST /v1/uploads\` with \`X-Tenant-Id\`, \`Idempotency-Key\` and \`{total_bytes, part_bytes,
   content_type}\`: parts of 5 to 64 MiB, \`part_count = ceil(total_bytes / part_bytes)\`, a 5 GiB
   quota (413), and a retry that answers the original upload.
2. A **Redis** manifest: \`upload:{id}:parts\` (part number → \`size:checksum\`) and
   \`upload:{id}:bytes\`, written by one Lua script that refuses numbers outside \`1..part_count\`,
   registers a part once and expires both keys after 24 hours.
3. \`store_part\`: **gRPC** \`ObjectStore.WritePart\` under a 30-second deadline, the store's SHA-256
   compared with the client's, at most 3 attempts per part, the part registered only once verified.
4. \`complete_upload\`: \`ObjectStore.CommitObject\`, then \`upload.completed\` on the **Kafka** topic
   \`upload.event\`, keyed by upload id, idempotent with \`acks=all\`, an outbox row when the broker
   refuses it.
5. \`GET /v1/uploads/{upload_id}\`: the \`stored\` parts with size and checksum and a \`resume\` list of
   every part to send again; another tenant's upload is 404.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Signed per-part URLs, streaming request bodies, object assembly inside the store, aborting an
upload, storage billing and client-side chunking. The five pieces above decide whether a client that
lost its connection at part 412 resumes at part 412.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Uploader', sub: 'parts · resume', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'uploadd', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'upload records', sub: 'upload:{id} · outbox', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis manifest', sub: 'upload:{id}:parts · :bytes', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'upload.event', sub: 'key = upload id', x: 44, y: 86},
      {id: 'store', kind: 'grpc', label: 'Object store', sub: 'WritePart · CommitObject', x: 66, y: 30},
      {id: 'consumer', kind: 'service', label: 'Media pipeline', sub: 'consumes upload.completed', x: 66, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'create_upload · initiation'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'register_part (Lua) · read_parts'},
      {from: 'api', to: 'store', kind: 'grpc', label: 'WritePart 30 s · CommitObject'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after the commit'},
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
