import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Tool registry: the course is not "store some tool definitions in a table", it is the debugging
 * you owe a registry before agents are allowed to act on what it serves. Role-gated registration
 * with an immutable version → one atomic Redis promotion agents resolve through, per-run pins → a
 * sandbox validation over gRPC that fails closed → tool-keyed lifecycle events published only after
 * the verdict → a resolve endpoint bounded by the caller's pin and allowlist.
 */
export const toolRegistryProblem: Problem = {
  id: 'tool-registry',
  title: 'Tool Registry',
  tagline: 'A catalog of agent tools with side-effect classes, sandbox verdicts and pinned versions.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Tool Registry

A tool registry decides which tools exist, what each one is allowed to do, and which version an
agent is actually calling.

## The real system

The Model Context Protocol, the tool interface Claude Desktop, Cursor and other agent hosts speak,
shows what a catalog carries. A server answers \`tools/list\` with each tool's name and an
\`inputSchema\` in JSON Schema, and may attach annotations such as \`readOnlyHint\` and
\`destructiveHint\` that say whether a call only reads or may destroy something; the spec tells
clients to treat those hints as untrusted unless the server is. A server that declares
\`listChanged\` sends \`notifications/tools/list_changed\` when its tool set moves, so hosts re-list
instead of calling a definition that no longer exists. A registry is the trusted side of that
contract: it decides who may register, validates the schema before storing it, mints the version
from the content, exercises a candidate in a sandbox before it goes live, keeps a run on the version
it started with, and records every transition with the verdict rather than the sandbox output.

## What you build here

One service, **toolsd**, with five pieces:

1. \`POST /v1/tools\`: registration restricted to the platform reviewer role (\`403\`), a schema
   validated as JSON Schema (\`422\` with the failing pointer), a side-effect class of \`read\`,
   \`write\` or \`irreversible\`, and a server-minted immutable version (\`409\` on reuse).
2. A **Redis** catalog: one hash per version behind one pointer swap, a per-run pin that survives a
   promotion, a one-write rollback, and a guard that refuses an unvalidated candidate.
3. A **gRPC** sandbox client: a 10-second deadline, a sandbox-scoped credential, a timeout that
   keeps the previous version with a recorded reason, and a terminal schema rejection.
4. A **Kafka** lifecycle path: \`tool.lifecycle\` keyed by tool name, carrying version, side-effect
   class and validator outcome, an idempotent producer with \`acks=all\`, and an outbox row on
   rejection.
5. \`GET /v1/tools/{name}\`: resolution against the caller's catalog pin and allowlist, a **404**
   outside the allowlist, and no internal endpoint or credential in the response.

## The debugging habit

Every starter compiles and serves the happy path. Debug it against the failure modes, fix it, and
prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Tool authoring UIs, schema-diff review workflows, per-tenant catalog forks, marketplace curation,
tool call metering, sandbox container provisioning, signing of tool images, and revocation
propagation to already-running runs.`,
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
