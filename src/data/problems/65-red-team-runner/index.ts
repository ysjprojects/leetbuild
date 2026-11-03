import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Red team runner: the course is not "send a request and see what happens", it is the debugging
 * you owe an adversarial runner before it points a probe set at something. A registered,
 * non-production target only → one atomic Redis claim per probe with an hourly per-target budget →
 * a deadline-bounded call with a shared kill switch and a resumable abort → target-keyed finding
 * events that carry an evidence reference, never the attack → a coverage report that calls a
 * skipped category incomplete.
 */
export const redTeamRunnerProblem: Problem = {
  id: 'red-team-runner',
  title: 'Red Team Runner',
  tagline: 'Adversarial probe runs with a target registry, a shared kill switch and a report that counts coverage.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Red Team Runner

A red team runner plays the attacker: it sends adversarial probes at a model, a prompt pipeline or
an agent, and reports what it found in a form someone can reproduce. The visible part is a list of
findings; what decides whether it is safe to run is the target registry, the probe claim and budget,
the kill switch in front of every call, the finding event that carries evidence instead of the
attack, and a report that counts the coverage it achieved.

## The real system

NVIDIA's garak, an open-source LLM vulnerability scanner, is organised around the same nouns this
course uses. A generator wraps the target and handles authentication, connection management and
backoff; a probe tries to elicit one kind of failure and wraps each adversarial interaction in an
attempt; a detector examines the outputs for a single failure mode; and the report is a log of
attempts with per-probe, per-detector pass and fail counts, so a reader sees what was tried, not
only what fired. A hosted runner that points such probes at other teams' systems adds the operating
controls around that loop: a target registry, a probe claimed once, a budget that expires with its
window, a deadline per call, a kill switch in shared state, findings keyed by target with a
reference to sealed evidence, and a report that counts coverage before it calls a run a pass.

## What you build here

One service, **redteamd**, with five pieces:

1. \`POST /v1/redteam/runs\`: authenticated tenant, a target resolved through \`TARGET_REGISTRY\`
   (\`400\` unregistered, \`403\` production), and an \`Idempotency-Key\` so a replay returns the
   existing run.
2. A **Redis** probe ledger: \`(target, probe_hash)\` claimed with one atomic \`SET … NX … EX\`, an
   hourly per-target budget reserved inside one Lua \`EVAL\`, and a smaller cap for destructive
   categories.
3. A **gRPC** call to the system under test: a 5-second deadline, one retry on \`DEADLINE_EXCEEDED\`,
   and a shared kill switch read before every probe.
4. A **Kafka** finding stream: \`redteam.finding\` keyed by target id, an idempotent producer with
   \`acks=all\`, and an \`evidence_ref\` sealed before the event is produced.
5. \`GET /v1/redteam/runs/{id}\`: tenant-scoped with a \`404\` for a foreign run, coverage per
   category, and \`incomplete\` while any category was skipped.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path and
looks right. In every step you debug it against the failure modes, fix it, and prove the fix with
checks that fail on the starter and pass on your version.

## Left out on purpose

Probe authoring, model-specific attack libraries, jailbreak discovery, severity scoring, evidence
retention policy, reviewer assignment, and the dashboard.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Operator', sub: 'submit · report', x: 8, y: 50},
      {id: 'runner', kind: 'http', label: 'Red Team Runner', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'target · run store', sub: 'registry · runs', x: 46, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'dedupe · budgets · kill', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'redteam.finding', sub: 'key = target id', x: 46, y: 90},
      {id: 'sandbox', kind: 'service', label: 'Probe sandbox', sub: 'isolated egress', x: 68, y: 10},
      {id: 'sut', kind: 'grpc', label: 'System under test', sub: 'Probe', x: 68, y: 38},
      {id: 'evidence', kind: 'external', label: 'Evidence store', sub: 'sealed bundles', x: 68, y: 66},
      {id: 'reviewer', kind: 'service', label: 'Review queue', sub: 'findings · triage', x: 88, y: 90},
    ],
    edges: [
      {from: 'client', to: 'runner', kind: 'http', label: 'HTTPS'},
      {from: 'runner', to: 'db', kind: 'plain', label: 'targets · runs'},
      {from: 'runner', to: 'redis', kind: 'redis', label: 'claim · budget · kill'},
      {from: 'runner', to: 'sandbox', kind: 'plain', label: 'dispatch probe set'},
      {from: 'sandbox', to: 'sut', kind: 'grpc', label: 'Probe · deadline 5s'},
      {from: 'runner', to: 'evidence', kind: 'plain', label: 'seal bundle'},
      {from: 'runner', to: 'kafka', kind: 'kafka', label: 'produce redteam.finding'},
      {from: 'kafka', to: 'reviewer', kind: 'kafka', label: 'consume per target'},
      {from: 'reviewer', to: 'evidence', kind: 'plain', label: 'GET evidence_ref'},
      {from: 'runner', to: 'sut', kind: 'grpc', label: 'Probe (kill switch first)'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
