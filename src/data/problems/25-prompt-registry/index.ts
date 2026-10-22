import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Prompt registry on the AI-era track: the course is not "store a string in a database", it is the
 * review you owe a model-generated registry before it ships prompts into production. Immutable,
 * hashed versions behind an idempotent registration endpoint → an atomic Redis pointer swap with
 * tenant pins and an audit row → an eval-gated promotion that blocks on an unavailable evaluator →
 * name-keyed lifecycle events with an outbox → tenant-scoped, render-safe reads.
 */
export const promptRegistryProblem: Problem = {
  id: 'prompt-registry',
  title: 'Prompt Registry',
  tagline: 'Versioned prompt templates with eval-gated promotion and tenant pins — reviewed like production.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Prompt Registry

A prompt registry is the piece of an AI platform that owns the text of every prompt as a versioned,
immutable artifact: who may change it, which version each tenant is served, what evidence justified a
promotion, and how a rollback lands on every reader at once. The visible part is a version number in a
response; the parts that decide whether the platform is safe are content identity, atomic promotion,
the eval gate, and the read path that renders a template with caller-supplied values.

## The real system

Production registries never edit a version in place: a version is a name for a piece of content that
never changes, so the same bytes always resolve to the same content hash and a replayed registration
cannot fork history. They move the active pointer in one atomic operation — a promotion and a rollback
racing each other must leave every reader on one version, never half the fleet on each — and they keep
an audit row for every swap. They call an eval service before any promotion and treat an unavailable
evaluator as a block, because an eval that never ran cannot be evidence. They publish lifecycle events
keyed by prompt name so one prompt's history stays ordered, carrying hashes and actor ids instead of
the template text that the topic would retain for days. And they render templates for a specific
tenant with escaping, so a caller's value can never rewrite the template or leak another tenant's
eval record.

## What you build here

One service, **registryd**, with five pieces:

1. \`POST /v1/prompts\`: authenticated tenant, a name, a template capped at 32 KiB, an optional parent
   version, and an \`Idempotency-Key\`. Versions are immutable — a second write of the same name and
   version is \`409\` — placeholders are checked against a declared allowlist, and a replayed
   registration returns the original content hash instead of minting a new version.
2. A **Redis** pointer cache: \`pointer:{name}\` holds the global version and \`pin:{tenant}:{name}\`
   holds a tenant's own, resolved pin first. One atomic Lua \`EVAL\` writes the pointer, the audit
   entry and the revision together, so a promotion racing a rollback cannot split the fleet and a
   rollback takes effect on the next read rather than when a cached pointer expires.
3. A **gRPC** eval gate: a 3-second deadline per call to \`EvalService.Evaluate\`, at most three
   attempts, retryable only on \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, a timeout or error blocks the
   promotion, a completed \`failed\` verdict is terminal, and a fresh eval is required once the
   version's bytes change — the gate is keyed by the content hash.
4. A **Kafka** lifecycle path: \`registered\`, \`promoted\`, \`pinned\` and \`rolled_back\` events on
   \`prompt.lifecycle\`, keyed by prompt name for per-prompt order, an idempotent producer with
   \`acks=all\`, no template text in the event or the logs, an outbox row when the broker rejects the
   produce, and a consumer that updates Redis counters before it commits the offset.
5. \`GET /v1/prompts/{name}/versions/{v}\`: tenant-scoped reads that return the template, its declared
   variables and the eval record of the **exact content hash** asked for, plus a render mode that
   validates every supplied value against the allowlist and escapes it so no value can break the
   template.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Prompt authoring UIs, ownership and approval workflows, per-model tokenizers, secret interpolation,
dataset management for evals, multi-region replication of the pointer, and billing. The five pieces
above are the ones that decide whether the registry is correct, isolated and shippable.`,
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
