import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Tool registry on the AI-era track: the course is not "store some tool definitions in a table",
 * it is the review you owe a model-generated registry before agents are allowed to act on what it
 * serves. Role-gated registration with an immutable version → one atomic Redis promotion agents
 * resolve through, per-run pins → a sandbox validation over gRPC that fails closed → tool-keyed
 * lifecycle events published only after the verdict → a resolve endpoint bounded by the caller's
 * pin and allowlist.
 */
export const toolRegistryProblem: Problem = {
  id: 'tool-registry',
  title: 'Tool Registry',
  tagline: 'A curated catalog of agent tools with side-effect classes and pinned versions.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Tool Registry

A tool registry is the piece of an AI platform that decides which tools exist, what each one is
allowed to do, and which version an agent is actually calling. The visible part is a lookup; the
parts that decide whether the platform is safe are who may register a tool, whether an unvalidated
version can go live, whether an agent mid-plan can be flipped onto a different definition, and
whether the record of all of that is complete and secret-free.

## The real system

Production registries treat a tool definition like a release: registration is a privileged change
with an owner, the schema is checked as JSON Schema before it is stored, and the version is minted
from the content so the same definition can never silently replace an existing one. The active
catalog lives in Redis behind a single version pointer, so a promotion is one atomic swap and an
agent that pinned a version at the start of a run keeps resolving against that version for the whole
run — a rollback moves the pointer back and the next resolution lands on the previous catalog. No
candidate version goes live on hope: it is exercised in a sandbox over gRPC under a short deadline,
with credentials scoped to the sandbox, and a timeout, an error or a rejection keeps the previous
version active with the reason recorded. Every register, validate, promote and revoke publishes a
\`tool.lifecycle\` event keyed by tool name, so one tool's history stays ordered, carrying the version,
the side-effect class and the validator outcome — never sandbox logs, never credentials — and a
rejection writes an outbox row rather than losing the record. Resolution is where the platform's
promises are enforced: the caller gets the version its pin and allowlist entitle it to, and nothing
about the owner's internal wiring.

## What you build here

One service, **toolsd**, with five pieces:

1. \`POST /v1/tools\`: registration restricted to the platform reviewer role (\`403\` otherwise), a name
   and a schema that is validated as JSON Schema (\`422\` with the failing pointer), a side-effect class
   of \`read\`, \`write\` or \`irreversible\`, an owner team, and a server-minted immutable version —
   re-registering an existing version is \`409\`.
2. A **Redis** catalog: the active version behind one pointer written by a single atomic script, the
   catalog snapshot read in one round trip, a per-tenant pin that survives a promotion for the run,
   and a promotion guard that refuses a candidate with no passing validation.
3. A **gRPC** sandbox client: a 10-second deadline, sandbox-scoped credentials that never touch the
   production provider, a failure or timeout that keeps the previous version with a visible reason,
   and a schema rejection that is terminal until the version changes.
4. A **Kafka** lifecycle path: \`tool.lifecycle\` keyed by tool name, the version, side-effect class and
   validator outcome in the payload, an idempotent producer with \`acks=all\`, publish-after-validation,
   and an outbox row on rejection.
5. \`GET /v1/tools/{name}\`: resolution against the caller's catalog pin and allowlist — the pinned
   version when the caller pinned one, a **404** for a tool outside the allowlist, and no internal
   endpoint, credential or owner-only field in the response.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Tool authoring UIs, schema-diff review workflows, per-tenant catalog forks, marketplace curation,
tool call metering and billing, sandbox container provisioning, signing and supply-chain attestation
of tool images, and revocation propagation to already-running runs. The five pieces above are the
ones that decide whether the registry is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Agent runtime', sub: 'register · resolve', x: 8, y: 50},
      {id: 'registry', kind: 'http', label: 'Tool Registry', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'reviewer', kind: 'service', label: 'Reviewer role', sub: 'platform-reviewer', x: 26, y: 12},
      {id: 'db', kind: 'db', label: 'tools · outbox', sub: 'owners · versions', x: 48, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'catalog · pins', x: 48, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'tool.lifecycle', sub: 'key = tool name', x: 48, y: 86},
      {id: 'sandbox', kind: 'grpc', label: 'Sandbox validator', sub: 'Validate · 10 s', x: 70, y: 26},
      {id: 'vault', kind: 'external', label: 'Sandbox credentials', sub: 'scoped · not production', x: 70, y: 52},
      {id: 'consumer', kind: 'service', label: 'Lifecycle consumer', sub: 'group tool-audit', x: 70, y: 86},
    ],
    edges: [
      {from: 'client', to: 'registry', kind: 'http', label: 'HTTPS'},
      {from: 'reviewer', to: 'registry', kind: 'plain', label: 'role claim'},
      {from: 'registry', to: 'db', kind: 'plain', label: 'tools · outbox'},
      {from: 'registry', to: 'redis', kind: 'redis', label: 'catalog · pins'},
      {from: 'registry', to: 'sandbox', kind: 'grpc', label: 'Validate(name, version)'},
      {from: 'vault', to: 'sandbox', kind: 'plain', label: 'scoped token'},
      {from: 'registry', to: 'kafka', kind: 'kafka', label: 'produce tool.lifecycle'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'audit trail'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
