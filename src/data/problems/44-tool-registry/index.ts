import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

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
  tagline: 'A registry that lets agents call only reviewed, sandbox-validated tool versions.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Tool Registry

A tool registry decides which tools exist, what each one may do, and which version an agent is
actually calling.

## The real system

The Model Context Protocol, the tool interface Claude Desktop, Cursor and other agent hosts speak,
shows what a catalog carries. A server answers \`tools/list\` with each tool's name and an
\`inputSchema\` in JSON Schema, and may attach annotations such as \`readOnlyHint\` and
\`destructiveHint\` that say whether a call only reads or may destroy something; the spec tells
clients to treat those hints as untrusted unless the server is. A server that declares
\`listChanged\` sends \`notifications/tools/list_changed\` when its tool set moves, so hosts re-list
instead of calling a definition that no longer exists. A registry is the trusted side of that
contract: it decides who may register, validates the schema before storing it, mints the version
from the content, exercises a candidate in a sandbox before it goes live, and keeps a run on the
catalog it started with.

## What you build here

One service, **toolsd**, on two provided modules: the tool store (\`toolsd.store\`: the
\`tool:{name}:{version}\` hashes, tenant allowlists \`tenant:{tenant}:tools\`, the lifecycle outbox
\`tools:outbox\`) and the catalog step 2 builds (\`toolsd.catalog\`: \`promote\`, \`rollback\`,
\`pin_run\`, \`resolve\`, plus the sandbox verdicts \`record_validation\` and \`validation\`).

1. \`POST /v1/tools\`: registration by the \`platform-reviewer\` role only (403), a side-effect class
   of \`read\`, \`write\` or \`irreversible\` (400), a schema checked with failing JSON pointers (422),
   and a version minted from the content (409 on reuse).
2. A **Redis** catalog: \`catalog:version:{cv}\` hashes behind \`catalog:active\`, a per-run pin with a
   6-hour TTL, a one-write rollback to \`catalog:previous\`, and a guard that refuses a candidate
   without a passing \`catalog:validation:{cv}\`.
3. A **gRPC** sandbox check, \`Sandbox.Validate\`: a 10-second deadline, the sandbox's own token,
   \`unavailable\` when it cannot answer, \`rejected\` for good on \`INVALID_ARGUMENT\`, and promotion
   only after OK.
4. **Kafka** \`tool.lifecycle\` records, one per tool, keyed by tool name, carrying the recorded
   verdict and nothing internal, from an idempotent producer with \`acks=all\`; a refused record is
   parked in the outbox.
5. \`GET /v1/tools/{name}\`: resolution through the caller's run pin and tenant allowlist, 404
   outside it, and only \`name\`, \`version\`, \`side_effect\` and \`schema\` in the answer.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Tool authoring UIs, schema-diff review workflows, per-tenant catalog forks, marketplace curation,
tool call metering, sandbox container provisioning, signing of tool images, and revocation
propagation to already-running runs.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Agent runtime', sub: 'register · resolve', x: 8, y: 50},
      {id: 'registry', kind: 'http', label: 'Tool Registry', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'reviewer', kind: 'service', label: 'Reviewer role', sub: 'platform-reviewer', x: 26, y: 12},
      {id: 'db', kind: 'db', label: 'tool store', sub: 'tool versions · allowlists · outbox', x: 48, y: 12},
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
      {from: 'registry', to: 'sandbox', kind: 'grpc', label: 'Validate(cv, tools)'},
      {from: 'vault', to: 'sandbox', kind: 'plain', label: 'scoped token'},
      {from: 'registry', to: 'kafka', kind: 'kafka', label: 'produce tool.lifecycle'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'audit trail'},
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
