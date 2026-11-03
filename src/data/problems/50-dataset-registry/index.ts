import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Dataset registry: the course is not "store a version in a database", it is the debugging you
 * owe a registry before training runs depend on its version names. Immutable, licensed, measured
 * version records → one atomic latest-version pointer with pins that stay put → a validator call
 * under a deadline that gates promotion on a full scan → dataset-keyed events after the commit with
 * an outbox on a failed delivery → a tenant-scoped read with provenance and an expiring signed URL.
 */
export const datasetRegistryProblem: Problem = {
  id: 'dataset-registry',
  title: 'Dataset Registry',
  tagline: 'Content-hashed dataset versions, a promoted pointer with pins, and signed provenance reads.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Dataset Registry

A dataset registry turns bytes into a name a training run can quote two years later. It records
which content hash sits behind which version, under which license and owner, moves one
latest-version pointer only after a validator has seen every row, tells the services downstream,
and answers a read with provenance rather than a bare object URL.

## The real system

On the Hugging Face Hub every dataset is its own git repository, and \`datasets.load_dataset\` takes
a \`revision\` argument (a branch, a tag or a commit SHA), so a training script can pin the exact
bytes it read instead of whatever \`main\` points at today. An in-house registry owes its consumers
the same promise and adds what a git host does not: a license allowlist, an owner, a size it
measured itself, a validation gate before promotion, and reads scoped to a tenant.

## What you build here

One service, **registryd**, on one provided store (\`registry.store\`: objects under
\`object:{sha}\`, version records under \`dataset:{dataset}:v:{version}\`, the \`outbox\` list and
\`sign_url\`) and one pointer (\`registry.pointer\`: \`promote\`, \`latest\`, \`pin\`, \`purge\`, built
in step 2 and provided to the later steps):

1. \`POST /v1/datasets\`: a version is created once (\`create_version\`; a repeat is 409), carries
   the caller's tenant and owner and an allowlisted license, and its size and rows come from
   \`measure\`.
2. A **Redis** pointer \`dataset:{dataset}:latest\` without expiry, moved together with its
   \`dataset:{dataset}:audit\` entry by one Lua script; pins in \`dataset:{dataset}:pins\` that no
   promotion moves; a purge that refuses the latest or a pinned version; a read that fails closed.
3. A **gRPC** \`Validator.Validate\` call under a 30-second deadline, scanning every row: a pass
   promotes, a failure is \`rejected\`, no verdict is \`pending\`, and the pointer stays put.
4. A **Kafka** \`dataset.promoted\` event on \`dataset.event\`, keyed by the dataset, without the
   rows, produced after the pointer moved, and kept in the outbox when the delivery fails.
5. \`GET /v1/datasets/{dataset}/versions/{version}\`: the caller's tenant only, \`latest\` through the
   pointer, the validator report in every status, and a signed URL that expires in five minutes.

\`\`\`proto
service Validator { rpc Validate(ValidateRequest) returns (ValidationReport); }
\`\`\`

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Uploading the bytes, storage lifecycle rules, column-level schema registries, access reviews,
per-tenant quotas, the relay that drains the outbox, and the scheduler that reads the pins.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'register · read', x: 8, y: 50},
      {id: 'registry', kind: 'http', label: 'registryd', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'registry store', sub: 'versions · objects · outbox', x: 46, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'latest · audit · pins', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'dataset.event', sub: 'key = dataset', x: 46, y: 86},
      {id: 'validator', kind: 'grpc', label: 'Validator', sub: 'Validate · 30 s', x: 68, y: 12},
      {id: 'storage', kind: 'external', label: 'Object store', sub: 'signed URL · 5 min', x: 68, y: 38},
      {id: 'consumer', kind: 'service', label: 'Training consumer', sub: 'pins a version', x: 68, y: 86},
    ],
    edges: [
      {from: 'client', to: 'registry', kind: 'http', label: 'HTTPS'},
      {from: 'registry', to: 'db', kind: 'plain', label: 'create_version · measure'},
      {from: 'registry', to: 'redis', kind: 'redis', label: 'promote · latest'},
      {from: 'registry', to: 'validator', kind: 'grpc', label: 'Validate · every row'},
      {from: 'registry', to: 'storage', kind: 'plain', label: 'sign_url'},
      {from: 'registry', to: 'kafka', kind: 'kafka', label: 'produce after promote'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume per dataset'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'pin'},
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
