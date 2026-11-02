import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Prompt registry: the course is not "store a string in a database", it is the debugging you owe
 * a registry before it ships prompts into production. Immutable, hashed versions behind an
 * idempotent registration endpoint → an atomic Redis pointer swap with tenant pins and an audit
 * row → an eval-gated promotion that blocks on an unavailable evaluator → name-keyed lifecycle
 * events with an outbox → tenant-scoped, render-safe reads.
 */
export const promptRegistryProblem: Problem = {
  id: 'prompt-registry',
  title: 'Prompt Registry',
  tagline:
    'Versioned prompt templates behind an atomic Redis pointer and an eval gate, debugged until a rollback lands on every reader.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Prompt Registry

A prompt registry owns the text of every prompt as a versioned, immutable artifact: which version
each tenant is served, what evidence justified a promotion, and how a rollback lands on every reader
at once. The parts that decide whether the platform is safe are content identity, atomic promotion,
the eval gate, and the read path that renders a template with caller-supplied values.

## The real system

Langfuse's prompt management is a worked example: every save creates a new immutable version, and
labels such as \`production\`, \`staging\` or a tenant name are pointers the application fetches by
label, so promoting a version means moving the label rather than editing text in place. A registry
built on that idea moves the pointer in one atomic operation with an audit row per swap, blocks a
promotion when the evaluator is unavailable because an eval that did not run cannot be evidence,
publishes lifecycle events keyed by prompt name with hashes instead of template text, and renders
templates per tenant with escaping so a caller's value cannot rewrite the template.

## What you build here

One service, **registryd**, with five pieces:

1. \`POST /v1/prompts\`: authenticated tenant, a template capped at 32 KiB and an
   \`Idempotency-Key\`. Versions are immutable (a different write of the same version is \`409\`),
   placeholders are checked against an allowlist, and a replay returns the original content hash.
2. A **Redis** pointer cache: \`pointer:{name}\` and a tenant's \`pin:{tenant}:{name}\`, pin
   resolved first. One Lua \`EVAL\` writes pointer, audit entry and revision together.
3. A **gRPC** eval gate: a 3-second deadline per \`EvalService.Evaluate\` call, at most three
   attempts, retryable only on \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, a timeout or error blocks, a
   \`failed\` verdict is terminal, and the gate is keyed by the content hash.
4. A **Kafka** lifecycle path: events on \`prompt.lifecycle\` keyed by prompt name, an idempotent
   producer with \`acks=all\`, no template text anywhere, and an outbox row when the broker rejects
   the produce.
5. \`GET /v1/prompts/{name}/versions/{v}\`: tenant-scoped reads returning the eval record of the
   **exact content hash**, plus a render mode that validates and escapes every value.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path, and
looks right. Debug it against the failure modes, fix it, and prove the fix with checks that fail on
the starter and pass on your version.

## Left out on purpose

Prompt authoring UIs, approval workflows, per-model tokenizers, secret interpolation, eval dataset
management, multi-region replication of the pointer, and billing.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'register · read', x: 8, y: 50},
      {id: 'registry', kind: 'http', label: 'Prompt Registry', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'versions · evals', sub: 'immutable · hashed', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'pointer · pins', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'prompt.lifecycle', sub: 'key = name', x: 44, y: 88},
      {id: 'eval', kind: 'grpc', label: 'Eval service', sub: 'Evaluate · deadline 3 s', x: 66, y: 50},
      {id: 'consumer', kind: 'service', label: 'Lifecycle consumer', sub: 'group lifecycle', x: 66, y: 88},
    ],
    edges: [
      {from: 'client', to: 'registry', kind: 'http', label: 'HTTPS'},
      {from: 'registry', to: 'db', kind: 'plain', label: 'register · read version'},
      {from: 'registry', to: 'redis', kind: 'redis', label: 'pointer · pins · audit'},
      {from: 'registry', to: 'eval', kind: 'grpc', label: 'Evaluate · eval gate'},
      {from: 'registry', to: 'kafka', kind: 'kafka', label: 'produce prompt.lifecycle'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY lifecycle'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
