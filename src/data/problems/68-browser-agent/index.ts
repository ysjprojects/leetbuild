import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Browser agent: the course is the debugging a browser-driving service owes before it points a
 * real browser at a real page for a tenant. A session that is a policy and a budget → one atomic
 * step transition with a lease that expires → driver calls with deadlines, verified clicks and
 * every redirect hop authorized → session-keyed step events without typed text, appended before
 * the commit → a read scoped to the owner with a bounded trace and an expiring screenshot.
 */
export const browserAgentProblem: Problem = {
  id: 'browser-agent',
  title: 'Browser Agent',
  tagline: 'Egress profiles, step leases, verified clicks and a redacted trace for an agent that drives real browsers.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Browser Agent

A browser agent runs a real browser on someone else's behalf: it turns a task into navigations,
clicks and typed text, and the operator reads back what it did. The risk sits in the parts that look
like plumbing: where the browser may go, who may drive a session, what a retry does to a form, and
what the trace keeps.

## The real system

Playwright, the browser automation library many agents drive, intercepts requests with
\`page.route\`, and its documentation notes that the handler is called only for the first URL when
the response is a redirect; its maintainers confirmed the same holds for \`context.route\`. An
allowlist built on interception sees the page the agent asked for, not the hop the page sent it
to. This course puts the policy where it holds: the driver follows no redirect, and the agent
authorizes every hop itself.

## What you build here

One service, **browserd**, on a provided \`browser\` package: \`profiles\` (the egress catalog and
\`authorize_navigation\`), \`sessions\` (the \`browser:session:{id}\` hash), \`lease\` (step 2's
transition), \`trace\` (the step record, \`digest\` and the trace store) and \`screenshots\`.

1. \`POST /v1/browser/sessions\` with \`{task, profile, start_url?, max_steps}\`, \`X-Tenant-Id\` and
   \`Idempotency-Key\`: a known profile, a start page inside it, 1 to 60 steps, one session per key.
2. A **Redis** transition, \`begin_step(session_id, worker)\`: one Lua script over the session hash
   and the 45-second lease \`browser:lease:{id}\`, charging the budget once per step.
3. A **gRPC** \`BrowserDriver\` client, \`run_action\`: 15-second deadlines, a lost click checked
   against \`Snapshot\` before any replay, \`authorize_navigation\` on every redirect hop.
4. A **Kafka** \`browser.step\` stream keyed by session id, carrying \`action\`, \`outcome\` and
   \`target_digest\` but no typed text, target or URL; the \`trace-store\` consumer appends before it
   commits.
5. \`GET /v1/browser/sessions/{id}\`: the owner's last 50 steps and a screenshot reference signed for
   15 minutes; another tenant's session is a 404.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Fingerprinting and stealth, per-site login flows, computer-vision element finding, the CDP wire
protocol, subresource filtering through an egress proxy, and multi-region driver pools.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'start · replay', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'browserd', sub: 'start · read', x: 26, y: 50},
      {id: 'profile', kind: 'db', label: 'Egress profiles', sub: 'schemes · hosts · entry', x: 46, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'session hash · lease 45 s', x: 46, y: 50},
      {id: 'worker', kind: 'service', label: 'Driver worker', sub: 'begin_step · run_action', x: 46, y: 82},
      {id: 'driver', kind: 'grpc', label: 'Browser driver', sub: 'Navigate / Act / Snapshot', x: 68, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'browser.step', sub: 'key = session id', x: 68, y: 82},
      {id: 'consumer', kind: 'service', label: 'Trace consumer', sub: 'group trace-store', x: 88, y: 82},
      {id: 'store', kind: 'db', label: 'Trace store', sub: 'browser:trace:{id}', x: 88, y: 50},
      {id: 'artifact', kind: 'external', label: 'Screenshot store', sub: 'signed · 15 min', x: 88, y: 20},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST /v1/browser/sessions'},
      {from: 'client', to: 'api', kind: 'http', label: 'GET session · replay'},
      {from: 'api', to: 'profile', kind: 'plain', label: 'get_profile · authorize start_url'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'create_session · load_session'},
      {from: 'api', to: 'store', kind: 'plain', label: 'trace by session'},
      {from: 'api', to: 'artifact', kind: 'plain', label: 'sign screenshot'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'EVAL begin_step'},
      {from: 'worker', to: 'driver', kind: 'grpc', label: 'Navigate / Act / Snapshot'},
      {from: 'worker', to: 'profile', kind: 'plain', label: 'authorize each hop'},
      {from: 'worker', to: 'kafka', kind: 'kafka', label: 'produce browser.step'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'store', kind: 'plain', label: 'append then commit'},
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
