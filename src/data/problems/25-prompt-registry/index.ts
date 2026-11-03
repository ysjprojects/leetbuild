import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Prompt registry: the debugging a registry owes before it serves prompts to production. Versions
 * registered once under a content hash → a live pointer moved and rolled back by one Lua script →
 * an eval gate where only a verdict opens the door, recorded by content hash → name-keyed lifecycle
 * events with an outbox → reads that attach the eval of exactly these bytes and render values as
 * text. The eval service is a deterministic stand-in the harness serves over gRPC.
 */
export const promptRegistryProblem: Problem = {
  id: 'prompt-registry',
  title: 'Prompt Registry',
  tagline:
    'Prompt versions under a content hash, moved live by one Lua script once an eval gate has a verdict to show.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Prompt Registry

A prompt registry owns the text a model is given: every template as a numbered version that keeps
naming the same bytes, which version each tenant is served, the eval that justified the move, and
the rollback when it goes wrong.

## The real system

Langfuse's prompt management works this way: saving a prompt under an existing name creates a new
version, and labels such as \`production\`, \`staging\` or a tenant name point at one version each.
The application fetches by label, so promoting or rolling back moves a label instead of editing
text, and templates fill \`{{variable}}\` slots at runtime. This course adds the eval gate in front
of a move and the events that announce it.

## What you build here

One service, **registryd**, with five pieces sharing the \`prompts\` support package (\`config\`: the
evaluator's address, the topic, the \`{{placeholder}}\` syntax, the key layout; the \`versions\`,
\`evals\` and \`outbox\` stores; the \`LifecycleEvent\` record):

1. \`POST /v1/prompts\`: \`{name, version, template, variables}\` for \`X-Tenant-Id\`. At most 32 KiB,
   placeholders equal to the declared, allowed variables, stored once with its SHA-256; the same
   bytes resolve to the version holding them, other bytes under a taken number are 409.
2. **The live pointer in Redis**: \`promote\` and \`rollback\` each run as one Lua script over
   \`prompts:live\`, \`prompts:history\` and \`prompts:audit\`; only a registered version goes live, a
   rollback restores the version live before, and readers read the pointer on every call.
3. **The eval gate** (gRPC, \`Evaluator.Evaluate\`, a stand-in the checks serve): a 3-second deadline,
   at most three attempts on \`UNAVAILABLE\` or \`DEADLINE_EXCEEDED\`, no verdict means blocked, a
   failed verdict blocks at once, and every verdict is recorded under the content hash it judged.
4. **Kafka**: moves on \`prompt.lifecycle\` keyed by prompt name, ids, hash and eval id without the
   template, an idempotent producer with \`acks=all\`, and an outbox row from the delivery report.
5. \`GET /v1/prompts/{name}/versions/{v}\` and its \`/render\`: 404 for a version the tenant lacks,
   the eval of this version's hash, values checked and substituted in one pass.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Prompt authoring UIs, approval workflows, per-model tokenizers, eval dataset management, the outbox
relay, pointer replication across regions, and defenses against instructions smuggled inside a
value, which belong on the model side.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'register · promote · read', x: 8, y: 50},
      {id: 'registry', kind: 'http', label: 'registryd', sub: 'API + gate', x: 28, y: 50},
      {
        id: 'redis',
        kind: 'redis',
        label: 'Redis',
        sub: 'versions · live · history · audit · evals · outbox',
        x: 50,
        y: 15,
      },
      {id: 'eval', kind: 'grpc', label: 'Evaluator', sub: 'Evaluate · 3 s', x: 50, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'prompt.lifecycle', sub: 'key = name', x: 50, y: 85},
      {id: 'consumer', kind: 'service', label: 'Lifecycle consumer', sub: 'cache invalidation · audit', x: 76, y: 85},
    ],
    edges: [
      {from: 'client', to: 'registry', kind: 'http', label: 'POST / GET prompts'},
      {from: 'registry', to: 'redis', kind: 'redis', label: 'SET NX version · EVAL promote · rollback'},
      {from: 'registry', to: 'eval', kind: 'grpc', label: 'Evaluate'},
      {from: 'registry', to: 'kafka', kind: 'kafka', label: 'produce (ids, hash)'},
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
