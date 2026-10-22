import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Red team runner on the AI-era track: the course is not "send a request and see what happens", it
 * is the review you owe a model-generated adversarial runner before it points a probe set at
 * something. A registered, non-production target only → one atomic Redis claim per probe with an
 * hourly per-target budget → a deadline-bounded call with a shared kill switch and a resumable
 * abort → target-keyed finding events that carry an evidence reference, never the attack → a
 * coverage report that calls a skipped category incomplete.
 */
export const redTeamRunnerProblem: Problem = {
  id: 'red-team-runner',
  title: 'Red Team Runner',
  tagline: 'Adversarial probes that run safely, cover their cases and produce reproducible findings.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Red Team Runner

A red team runner is the piece of an AI platform that plays the attacker: it sends adversarial
probes at a model, a prompt pipeline or an agent, and reports what it found in a form someone can
reproduce. The visible part is a list of findings; the parts that decide whether it is safe to run
are the target registry, the probe claim and budget, the kill switch in front of every call, the
finding event that carries evidence instead of the attack, and a report that is honest about the
coverage it achieved.

## The real system

Production red team runners do not accept a URL and start probing. They resolve the target through a
registry, refuse anything in production, and answer a replayed submission with the run they already
created. They claim each probe once — keyed by the target and the probe hash — so a retry or a
second worker cannot double-run it, and they spend from a per-target budget that expires with its
window and separates destructive categories from harmless ones. Every probe call carries a deadline
and a bounded retry, and the kill switch that aborts a run lives in shared state, because a runner
that hits unintended damage has to stop every replica, not itself. An aborted run records where it
stopped. Findings are published keyed by target so one target's stream stays ordered, they carry a
probe id, a severity and a reference to the sealed evidence bundle rather than the adversarial
payload, and the bundle is sealed before the event exists. The report returns coverage by category,
blocked and succeeded probes, unfixed findings, and it refuses to call a run a pass when a category
was skipped.

## What you build here

One service, **redteamd**, with five pieces:

1. \`POST /v1/redteam/runs\`: authenticated tenant, a target resolved through \`TARGET_REGISTRY\`,
   \`400\` for an unregistered target, \`403\` for a production environment, and an
   \`Idempotency-Key\` so a replay returns the existing run instead of re-dispatching the probe set.
2. A **Redis** probe ledger: \`(target, probe_hash)\` claimed with one atomic \`SET … NX … EX\`, an
   hourly per-target budget reserved inside one Lua \`EVAL\` that sets its own expiry, and a smaller
   cap of its own for destructive categories.
3. A **gRPC** call to the system under test: a 5-second deadline, at most one retry on
   \`DEADLINE_EXCEEDED\`, and a shared kill switch read before every probe that ends the run with a
   recorded resume point.
4. A **Kafka** finding stream: one \`redteam.finding\` event per finding keyed by target id, an
   idempotent producer with \`acks=all\`, an \`evidence_ref\` instead of the raw payload, and the
   evidence bundle sealed before the event is produced.
5. \`GET /v1/redteam/runs/{id}\`: tenant-scoped with a \`404\` for a foreign run, coverage per
   category with blocked, succeeded and unfixed counts, a warning for every category the kill switch
   skipped, and a status that is \`incomplete\` while any category is skipped.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Probe authoring and mutation, model-specific attack libraries, jailbreak discovery, scoring of
severity, evidence retention and redaction policy, reviewer assignment and SLAs, and the dashboard.
The five pieces above are the ones that decide whether an adversarial runner is safe to operate,
interruptible, reproducible and honest.`,
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
