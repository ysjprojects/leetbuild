import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Dataset registry: the course is not "store a version in a database", it is the debugging you
 * owe a registry before training runs depend on its version names. Immutable, licensed, measured
 * version records → one atomic latest-version pointer with pins that stay put → a
 * deadline-bounded validator call that gates promotion → dataset-keyed events with no content and
 * an outbox after the commit → a tenant-scoped read that returns provenance and an expiring signed
 * URL.
 */
export const datasetRegistryProblem: Problem = {
  id: 'dataset-registry',
  title: 'Dataset Registry',
  tagline: 'Content-hashed dataset versions, a pinned latest pointer and signed reads.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Dataset Registry

A dataset registry turns bytes into a name a training run can quote two years later. It records
which content hash sits behind which version, under which license and owner, moves one
latest-version pointer atomically, gates promotion on a validator call it can trust, publishes the
events other services live on, and answers a read with provenance rather than a bare object URL.

## The real system

The Hugging Face Hub gives every dataset its own git repository, and \`datasets.load_dataset\`
takes a \`revision\` argument that accepts a commit SHA or a git tag, so a training script can
quote the exact bytes it read instead of whatever \`main\` points at today. That is the contract a
registry owes its consumers: a name resolves to one set of bytes for as long as the name exists.
An in-house registry adds what a git host does not: a license allowlist and an owner on every
registration, a size the registry measured itself, an atomic promotion with its audit row, pins a
promotion leaves alone, a validator deadline whose timeout means "pending", dataset-keyed events
published after the commit, and reads with provenance and an expiring tenant-scoped signed URL.

## What you build here

One service, **registryd**, with five pieces:

1. \`POST /v1/datasets\`: validated hash, license allowlist and owner, immutable versions (a
   re-register is \`409\`), and a size measured from the content.
2. A **Redis** state module: one durable latest-version pointer per dataset, promoted by one atomic
   script that also appends the audit record, pins that stay put, a purge that refuses a pinned
   version, and a read that fails closed.
3. A **gRPC** validator client: a 30-second deadline, a timeout that marks the candidate pending, a
   report that states its coverage, and review feedback that opens a new candidate version.
4. A **Kafka** event path: \`dataset.event\` keyed by the dataset, payloads without the content
   sample, publish-after-commit, and an outbox row when the broker rejects the produce.
5. \`GET /v1/datasets/{id}/versions/{v}\`: tenant-scoped provenance (a foreign version is \`404\`),
   an expiring signed URL, and a validator report present even when it failed.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. Debug it against the failure modes, name the subtle one, fix it, and prove the fix
with checks that fail on the starter and pass on your version.

## Left out on purpose

Upload of the bytes themselves, storage lifecycle policies, column-level schema registries,
access-review workflows, per-tenant storage quotas, and the scheduler that consumes the pins.`,
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
