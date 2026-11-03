import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Browser agent: the course is not "click a button from a script", it is the debugging you owe a
 * browser driver before it points a real browser at a real page with a real tenant's credentials.
 * A session started with a policy and a budget instead of a URL → Redis state with a step lease
 * and a TTL so a crashed driver's session is reusable → driver calls with a deadline that never
 * replay a side effect → session-keyed, redacted step events whose trace is appended before the
 * offset commits → a replay that pages the trace, scopes it to the tenant and hands out only an
 * expiring screenshot reference.
 */
export const browserAgentProblem: Problem = {
  id: 'browser-agent',
  title: 'Browser Agent',
  tagline: 'Drive real browsers through scripts with bounded steps, resumable sessions and safe egress.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Browser Agent

A browser agent runs a real browser on someone else's behalf: it turns a task description into
navigations, clicks and typed text, and decides which hosts the browser may reach and what the
operator sees afterwards.

## The real system

Production browser agents are sandboxes with an allowlist, not a headless Chrome behind a URL
parameter. A session starts from a *policy* (a task, a named egress profile and a step budget), and
every navigation is re-validated at action time, including each redirect hop, so a hostile page
cannot walk the agent to \`169.254.169.254\` on the second hop. A click that times out is checked
against page state before any retry, because the first click may already have landed.

## What you build here

One service, **browserd**, with five pieces:

1. \`POST /v1/browser/sessions\`: an authenticated tenant, a task capped at 4 KiB, a named egress
   profile from the server's catalog, a step budget from 1 to 60, an \`Idempotency-Key\`, no start
   URL, and \`authorize_navigation(profile, url)\` on every redirect hop and subresource.
2. A **Redis** session document under \`session:{id}\`: page reference, step index, budget and lease,
   written by one atomic script per transition with a 45-second lease TTL.
3. A **gRPC** driver client: a 15-second deadline, retries only for \`navigate\`, \`snapshot\` and
   \`wait\`, a timed-out click verified against the page digest, a hung page closed first.
4. A **Kafka** event path: one \`browser.step\` event per action keyed by session id, with action
   type, target digest and outcome but no page content or typed values, appended to the trace before
   the offset commits.
5. \`GET /v1/browser/sessions/{id}\`: the bounded step trace, the budget outcome, a screenshot
   reference that expires within 15 minutes, and a foreign session answered like a missing one.

## The debugging habit

Every starter compiles and serves the happy path. Debug it against the failure modes, fix it, and
prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Fingerprinting and stealth, per-site login flows, computer-vision element finding, the CDP wire
protocol, and multi-region driver pools.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'start · replay', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'Session API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'profile', kind: 'db', label: 'Egress profiles', sub: 'schemes · hosts · entry', x: 46, y: 12},
      {id: 'redis', kind: 'redis', label: 'Session state', sub: 'lease · budget · TTL', x: 46, y: 50},
      {id: 'worker', kind: 'service', label: 'Driver pool', sub: 'bounded step loop', x: 46, y: 82},
      {id: 'driver', kind: 'grpc', label: 'Browser driver', sub: 'Navigate / Act / Snapshot', x: 68, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'browser.step', sub: 'key = session id', x: 68, y: 82},
      {id: 'consumer', kind: 'service', label: 'Trace consumer', sub: 'group dedupe', x: 88, y: 82},
      {id: 'store', kind: 'db', label: 'Trace store', sub: 'steps by session', x: 88, y: 50},
      {id: 'artifact', kind: 'external', label: 'Screenshot store', sub: 'signed · ≤15 min', x: 88, y: 20},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST /v1/browser/sessions'},
      {from: 'client', to: 'api', kind: 'http', label: 'GET session · replay'},
      {from: 'api', to: 'profile', kind: 'plain', label: 'resolve allowlist'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'create · read state'},
      {from: 'api', to: 'store', kind: 'plain', label: 'trace by session'},
      {from: 'api', to: 'artifact', kind: 'plain', label: 'sign screenshot'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'LEASE · TRANSITION'},
      {from: 'worker', to: 'driver', kind: 'grpc', label: 'Navigate / Act'},
      {from: 'worker', to: 'profile', kind: 'plain', label: 'authorize each hop'},
      {from: 'worker', to: 'kafka', kind: 'kafka', label: 'produce browser.step'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'store', kind: 'plain', label: 'append then commit'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
