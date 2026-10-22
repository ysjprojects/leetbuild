import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {ruleCacheStep} from './steps/2-state';
import {detectorClientStep} from './steps/3-dependency';
import {decisionEventsStep} from './steps/4-events';
import {ruleReadStep} from './steps/5-read';

/**
 * Prompt firewall on the AI-era track: the course is not "block some phrases in a request", it is
 * the review you owe a screening service before it stands between a company and everything its
 * users send it. Fail-closed HTTP → immutable versioned rules behind one atomic Redis swap → a gRPC
 * detector with a deadline and a deterministic lexical backstop → content-free decision events with
 * an outbox → a rule read that tells a reviewer which version is actually live.
 */
export const promptFirewallProblem: Problem = {
  id: 'prompt-firewall',
  title: 'Prompt Firewall',
  tagline: 'Screening for injection and exfiltration patterns without breaking legitimate prompts.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Prompt Firewall

A prompt firewall is the piece of an AI platform that decides which prompts are allowed to reach a
model at all. The visible part is a decision — \`allow\`, \`strip\` or \`block\` — and the parts that
decide whether the system is safe are the ones that only run when something has already gone wrong:
what happens when the rule engine raises, when the model detector is slow, when the broker is down,
and when a reviewer asks which rules were in force.

## The real system

Production firewalls treat the prompt as hostile input, not as a string to filter. They reject
oversized text and unknown channels before spending any work, and they fail *closed*: an internal
error blocks, because a false block is a support ticket and a false allow is an incident. They keep
their rules as immutable versioned sets and swap one pointer atomically, so a screen never matches a
half-applied batch and a rollback names the exact set it restores. They call a model-based detector
over gRPC under a short deadline, retry a bounded number of times, and fall through to a
deterministic lexical pass when the model cannot answer — a backstop that runs on every failure and
at every size. They publish one decision event per screen, keyed so a channel's decisions stay
ordered, carrying rule ids, spans and a prompt hash and never the prompt or the matched text. And
they expose the active rule set with its version, its changelog and a tenant-scoped view of custom
rules, so a reviewer can prove what was in force when a prompt was blocked.

## What you build here

One service, **firewalld**, with five pieces:

1. \`POST /v1/firewall/screen\`: a 128 KiB prompt cap, a validated channel (\`user\`, \`tool\`,
   \`retrieval\`), a decision from the active rule set with matched rule ids and spans, and a failure
   policy that blocks rather than allows.
2. A **Redis** rule cache: whole rule sets published under \`firewall:rules:v{version}\`, an active
   pointer swapped by one atomic script, the previous version recorded for rollback, and readers
   that resolve the pointer and then the complete versioned set.
3. A **gRPC** detector client: a 500 ms deadline per attempt, at most two attempts, retries only on
   \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, and a deterministic lexical backstop (delimiter breakouts,
   tool-instruction patterns) that runs on every detector failure and never behind a size gate.
4. A **Kafka** decision path: \`firewall.decision\` keyed by channel, an idempotent producer with
   \`acks=all\`, payloads of rule ids, spans and a \`prompt_sha256\`, and an outbox row whenever the
   broker rejects the produce.
5. \`GET /v1/firewall/rules\`: the active version, its changelog, custom rules scoped to the caller's
   tenant, and a \`rule_version\` stamped into every decision the service records.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the demo,
and it fails open in a way that only shows up during an outage. Your job in every step is the job you
will have on a real screening service: read the draft against the failure modes, name the subtle
one, fix it, and prove the fix with checks that fail on the draft and pass on your version.

## Left out on purpose

Rule authoring UIs, model-based classification training, prompt tokenizers, per-tenant rate limits,
multi-region rule replication, and the human review queue for false positives. The five pieces above
are the ones that decide whether the firewall can be trusted to sit in front of a model.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'prompt · channel', x: 8, y: 50},
      {id: 'firewall', kind: 'http', label: 'Prompt Firewall', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'rules', kind: 'db', label: 'rule sets', sub: 'versioned · changelog', x: 44, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'active pointer', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'firewall.decision', sub: 'key = channel', x: 44, y: 88},
      {id: 'detector', kind: 'grpc', label: 'Detector', sub: 'Detect · 500 ms', x: 66, y: 10},
      {id: 'backstop', kind: 'service', label: 'Lexical backstop', sub: 'delimiters · tool', x: 66, y: 38},
      {id: 'outbox', kind: 'db', label: 'outbox', sub: 'unsent decisions', x: 66, y: 64},
      {id: 'audit', kind: 'service', label: 'Audit consumer', sub: 'group by channel', x: 84, y: 88},
    ],
    edges: [
      {from: 'client', to: 'firewall', kind: 'http', label: 'HTTPS'},
      {from: 'firewall', to: 'rules', kind: 'plain', label: 'active rules'},
      {from: 'firewall', to: 'redis', kind: 'redis', label: 'active version'},
      {from: 'firewall', to: 'detector', kind: 'grpc', label: 'Detect / deadline'},
      {from: 'firewall', to: 'backstop', kind: 'plain', label: 'on detector failure'},
      {from: 'firewall', to: 'kafka', kind: 'kafka', label: 'produce firewall.decision'},
      {from: 'firewall', to: 'outbox', kind: 'plain', label: 'on produce failure'},
      {from: 'kafka', to: 'audit', kind: 'kafka', label: 'consume'},
      {from: 'audit', to: 'outbox', kind: 'plain', label: 'replay'},
      {from: 'rules', to: 'outbox', kind: 'plain', label: 'changelog'},
    ],
  },
  steps: [endpointStep, ruleCacheStep, detectorClientStep, decisionEventsStep, ruleReadStep],
};
