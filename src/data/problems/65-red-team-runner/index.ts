import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Red team runner: the debugging an adversarial runner owes before it points a probe set at
 * someone's system. A registered, non-production target and an idempotent run → one atomic Redis
 * claim per probe inside an hourly per-target budget → sandbox calls with a deadline, a bounded retry
 * and a shared kill switch → target-keyed finding events that carry an evidence reference → a report
 * that calls a run with uncovered categories incomplete. The sandbox is a deterministic stand-in the
 * harness serves over gRPC.
 */
export const redTeamRunnerProblem: Problem = {
  id: 'red-team-runner',
  title: 'Red Team Runner',
  tagline:
    'Probe runs against registered targets: a Redis probe budget, a shared kill switch, sealed evidence, coverage.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Red Team Runner

A red team runner plays the attacker: it sends adversarial probes at a model, a prompt pipeline or an
agent, and reports what got through in a form someone can reproduce. The visible part is a list of
findings; what decides whether it is safe to run is everything around the probes.

## The real system

NVIDIA's garak, an open-source LLM vulnerability scanner, is organised around the nouns this course
uses: a generator wraps the target, a probe tries to elicit one kind of failure, a detector judges the
output. Its JSONL report records every attempt with a status (0: not sent to the target, 1: answered
but not evaluated, 2: evaluated) and adds an eval entry per probe and detector pair, so a reader sees
what was tried as well as what fired. A hosted runner that points such probes at other teams' systems
adds the operating controls around that loop: a target registry, a budget per target, a kill switch
every runner obeys, evidence kept out of the event stream, and a report that counts coverage before it
calls a run a pass.

## What you build here

One service, **redteamd**, with five pieces sharing one contract, the \`redteam\` support package
(\`config\`: the sandbox address, the topic, the budgets, the key layout; \`targets\`, \`catalog\`, the run
store \`runs\`, \`evidence\`, \`outbox\`):

1. \`POST /v1/redteam/runs\`: a registered target (400 unknown, 403 production), a catalog probe set, an
   \`Idempotency-Key\`; the run is stored under \`(tenant, key)\`.
2. **Redis probe claims**: \`claim_probe(target, probe_hash, category)\` in one Lua script: a claimed
   \`redteam:probe:{target}:{hash}\` is a \`duplicate\`, an exhausted \`redteam:budget:{target}:{window}\`
   (200 probes an hour, 20 of them destructive) is \`budget\`, otherwise the probe is claimed for a day.
3. **Sandbox client** (gRPC, a stand-in the checks serve): \`redteam:kill:{target}\` read before every
   probe, a five-second deadline, one retry on \`UNAVAILABLE\`, each outcome counted per category.
4. **Kafka**: findings on \`redteam.finding\` keyed by target, with an \`evidence_ref\` sealed first, an
   idempotent producer, and an outbox row from the delivery report.
5. \`GET /v1/redteam/runs/{id}\`: tenant-scoped coverage per category; \`incomplete\` while a category
   lacks verdicts.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path and looks right. The task
says where the flaws live; the checks say what must change.

## Left out on purpose

Probe authoring, detectors beyond the sandbox's blocked flag, severity scoring, evidence retention,
reviewer assignment and the dashboard.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Operator', sub: 'start · report', x: 8, y: 50},
      {id: 'runner', kind: 'http', label: 'redteamd', sub: 'API + runner', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'runs · claims · budgets · kill · evidence', x: 50, y: 15},
      {id: 'sandbox', kind: 'grpc', label: 'Probe sandbox', sub: 'Probe · 5 s', x: 50, y: 85},
      {id: 'kafka', kind: 'kafka', label: 'redteam.finding', sub: 'key = target_id', x: 72, y: 50},
      {id: 'reviewer', kind: 'service', label: 'Review queue', sub: 'opens evidence_ref', x: 92, y: 50},
    ],
    edges: [
      {from: 'client', to: 'runner', kind: 'http', label: 'POST / GET runs'},
      {from: 'runner', to: 'redis', kind: 'redis', label: 'EVALSHA claim · GET kill · seal'},
      {from: 'runner', to: 'sandbox', kind: 'grpc', label: 'Probe'},
      {from: 'runner', to: 'kafka', kind: 'kafka', label: 'produce finding'},
      {from: 'kafka', to: 'reviewer', kind: 'kafka', label: 'consume per target'},
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
