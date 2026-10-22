import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Browser agent on the AI-era track: the course is not "click a button from a script", it is the
 * review you owe a model-generated browser driver before it points a real browser at a real page
 * with a real tenant's credentials. A session started with a policy and a budget instead of a URL →
 * Redis state with a step lease and a TTL so a crashed driver's session is reusable → driver calls
 * with a deadline that never replay a side effect → session-keyed, redacted step events whose trace
 * is appended before the offset commits → a replay that pages the trace, scopes it to the tenant and
 * hands out only an expiring screenshot reference.
 */
export const browserAgentProblem: Problem = {
  id: 'browser-agent',
  title: 'Browser Agent',
  tagline: 'Drive real browsers through scripts with bounded steps, resumable sessions and safe egress.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Browser Agent

A browser agent is the piece of an AI platform that runs a real browser on someone else's behalf: it
turns a task description into navigations, clicks and typed text, decides which hosts the browser may
reach, how many steps a session may take, which worker owns the session, what happens when the driver
hangs, and what the operator gets to see afterwards. The visible part is a page that ends up in the
right state; the parts that decide whether the platform is safe are the egress policy, the budget,
the lease, the driver's failure policy, the event payload and the replay.

## The real system

Production browser agents are sandboxes with an allowlist, not a headless Chrome behind a URL
parameter. A session starts from a *policy* — a task description, a named egress profile and a step
budget — and never from a URL the caller chose, because the caller's URL is a destination the caller
picked and the page can redirect anywhere from there. Every navigation is re-validated against the
profile *at action time*, including each redirect hop and each subresource the page pulls, so a
hostile page cannot walk the agent to \`169.254.169.254\` on the second hop. Session state lives in
Redis with a lease: the driver takes the lease on each action, refreshes a short TTL while it makes
progress, and lets the lease expire so a crashed driver's session is recovered rather than stranded —
and the key holds *references* to pages and artifacts, never the page HTML itself. Driver calls go
out over gRPC with a 15-second deadline, and a click that times out is verified against page state
before anything is retried, because the first click may already have landed; retryability is a
per-action property, and a hung page is closed before the next action starts on it. Every step
publishes a \`browser.step\` event keyed by session id — action type, target digest and outcome, never
page content and never the values the agent typed — the trace is appended before the consumer commits
its offset, and a rejected produce leaves a pending row behind. The read path pages the trace, refuses
to serve another tenant's session, and returns a signed screenshot reference that expires.

## What you build here

One service, **browserd**, with five pieces:

1. \`POST /v1/browser/sessions\`: an authenticated tenant, a task capped at 4 KiB, a named egress
   profile resolved against the server's own catalog, a step budget from 1 to 60, and an
   \`Idempotency-Key\` so a retry resumes the same session. The request carries no start URL, and
   \`authorize_navigation(profile, url)\` re-validates every redirect hop and subresource at action
   time, recording the reason when a hop is blocked.
2. A **Redis** session document under \`session:{id}\`: current page reference, step index, budget
   remaining and lease, written by one atomic script per transition with a 45-second lease TTL that a
   crashed driver cannot keep alive, so the session is reusable without being immortal — and the key
   holds a page *reference*, never the page HTML.
3. A **gRPC** driver client: every call carries a 15-second deadline, retries are per action
   (\`navigate\`, \`snapshot\`, \`wait\` — never \`click\`, \`submit\` or \`type\`), a timed-out click is
   verified against the page digest before any retry, and a hung page is closed before the next action.
4. A **Kafka** event path: one \`browser.step\` event per action keyed by session id so a session's
   trace stays ordered, carrying action type, target digest and outcome — no page content, no typed
   values — appended to the trace before the offset commits, with an idempotent producer and a pending
   row when the broker rejects the produce.
5. \`GET /v1/browser/sessions/{id}\`: the ordered, bounded step trace, the budget outcome from the same
   Redis hash the worker writes, and a screenshot reference that expires within 15 minutes — with a
   foreign session answered exactly like a missing one.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Browser fingerprinting and stealth, per-site login flows and credential vaults, computer-vision
element finding, the CDP wire protocol, multi-region driver pools, per-tenant browser image builds,
and billing for browser minutes. The five pieces above are the ones that decide whether a browser
agent is safe to point at the open web.`,
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
