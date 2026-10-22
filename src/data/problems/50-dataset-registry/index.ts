import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Dataset registry on the AI-era track: the course is not "store a version in a database", it is the
 * review you owe a model-generated registry before training runs depend on its version names.
 * Immutable, licensed, measured version records → one atomic latest-version pointer with pins that
 * never move → a deadline-bounded validator call that gates promotion → dataset-keyed events with no
 * content and an outbox after the commit → a tenant-scoped read that returns provenance and an
 * expiring signed URL.
 */
export const datasetRegistryProblem: Problem = {
  id: 'dataset-registry',
  title: 'Dataset Registry',
  tagline: 'Immutable dataset versions with provenance, licenses and pinned consumers.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Dataset Registry

A dataset registry is the piece of an AI platform that turns bytes into a name a training run can
quote two years later. It records which content hash sits behind which version, under which license
and for which owner, keeps one latest-version pointer that promotion moves atomically, gates that
promotion on a validator call it can trust, publishes the events other services live on, and answers
a read with provenance rather than a bare object URL.

## The real system

Production registries receive registrations from many teams, and every field a caller sends is a
claim: the size of the dataset, the license it is under, the validator's verdict, the team that owns
it. They treat a \`(dataset, version)\` pair as immutable, so a hash always names the same bytes, and
they measure the object instead of believing the number in the body. Each dataset has one
latest-version pointer, moved by a single atomic operation that appends its audit record in the same
step, and consumers that pin a version keep reading that version because a pin is a lease. A
candidate is promoted only after a validator call answered inside a deadline and covered the whole
object, or said how much it covered. Registry events are keyed by the dataset so one dataset's
history stays ordered, they carry identity and outcomes rather than the content the validator read,
and they are published only after the registry write commits, with an outbox when the broker
rejects the produce. The read endpoint returns provenance — source, license, row count, validator
report — plus a short-lived signed URL scoped to the caller's tenant.

## What you build here

One service, **registryd**, with five pieces:

1. \`POST /v1/datasets\`: validated hash, license allowlist and owner, a version that is immutable
   once written (a re-register is \`409\`), and a size that comes from measuring the content rather
   than from the caller.
2. A **Redis** state module: one durable latest-version pointer per dataset, promoted by a single
   atomic script that also appends the audit record, consumer pins that a promotion never moves, a
   purge that refuses a pinned version, and a read that fails closed instead of serving an
   unversioned view.
3. A **gRPC** validator client: a 30-second deadline, a timeout that leaves the previous version
   latest and marks the candidate pending, a report that states its coverage, and review feedback
   that opens a new candidate version instead of editing one in place.
4. A **Kafka** event path: \`dataset.event\` keyed by the dataset, payloads with versions, license
   ids and validator outcomes and no content sample, and publish-after-commit with an outbox row
   when the broker rejects the produce.
5. \`GET /v1/datasets/{id}/versions/{v}\`: tenant-scoped provenance — a foreign version is \`404\` —
   a signed URL that expires, and a validator report that is present even when it failed.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Upload and multipart transfer of the bytes themselves, storage-tiering and lifecycle policies,
column-level schema registries, access-review workflows, per-tenant quotas on storage, and the
training job scheduler that consumes the pins. The five pieces above are the ones that decide
whether a version name means anything.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'register · read', x: 8, y: 50},
      {id: 'registry', kind: 'http', label: 'Dataset Registry', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'registry · outbox', sub: 'versions · licence · report', x: 46, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'latest · pins', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'dataset.event', sub: 'key = dataset', x: 46, y: 86},
      {id: 'validator', kind: 'grpc', label: 'Validator', sub: 'schema · license · size', x: 68, y: 12},
      {id: 'storage', kind: 'external', label: 'Object store', sub: 'content hash · signed URL', x: 68, y: 38},
      {id: 'consumer', kind: 'service', label: 'Training consumer', sub: 'pins · reorder guard', x: 68, y: 86},
    ],
    edges: [
      {from: 'client', to: 'registry', kind: 'http', label: 'HTTPS'},
      {from: 'registry', to: 'db', kind: 'plain', label: 'version · outbox'},
      {from: 'registry', to: 'redis', kind: 'redis', label: 'latest · pins'},
      {from: 'registry', to: 'validator', kind: 'grpc', label: 'Validate · 30 s deadline'},
      {from: 'registry', to: 'storage', kind: 'plain', label: 'measure · sign'},
      {from: 'registry', to: 'kafka', kind: 'kafka', label: 'produce dataset.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume per dataset'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'read latest · pin'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
