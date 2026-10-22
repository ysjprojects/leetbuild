import {DROPBOX} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {protoFiles, protoModules} from './proto';
import {gateApiStep} from './steps/1-gate-api';
import {gateSnapshotStep} from './steps/2-gate-snapshot';
import {gatesRpcStep} from './steps/3-gates-rpc';
import {exposureLogStep} from './steps/4-exposure-log';

/**
 * Dropbox's Stormcrow, rebuilt as the four pieces every feature-gating system is made of: an API
 * that edits gates and keeps their history → a config snapshot every server loads and evaluates
 * without a single network call, assigning variants by hashing the user with the gate's seed →
 * a batch gRPC lookup for desktop and mobile clients → exposure events logged to Kafka off the
 * request path.
 */
export const dropboxGatesProblem: Problem = {
  id: 'dropbox-gates',
  title: 'Feature Gates',
  tagline:
    "Dropbox's Stormcrow: gates edited through an API, variants assigned by a hash that stores nothing, served to clients in one batch, logged without slowing a request.",
  difficulty: 'easy',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 40,
  company: DROPBOX,
  sources: [
    {
      title: 'Introducing Stormcrow',
      url: 'https://dropbox.tech/infrastructure/introducing-stormcrow',
      by: 'Tom McLaughlin',
      date: '2017-03-06',
      takes:
        'Feature gates as populations matched in fall-through order with a variant mix each; stateless assignment by hashing the user id with a per-gate seed; a JSON config snapshot pushed to every server and reloaded by a background loader instead of a database call per gate; batched variant lookups for desktop and mobile clients; every assignment and exposure logged to monitoring; overrides for QA and an audit history of edits.',
    },
  ],
  statement: `# Feature Gates

"Show the red button to a third of German users, the blue one to everyone in English, and nothing to
anyone else — now, not after the next deploy." A feature gate is that sentence turned into
configuration: a code path asks \`get_variant("button_color", user)\` and gets an answer it can switch
on. Every product company builds one. Most build it twice, because the first one makes a network call
per decision.

## The real system

Dropbox's **Stormcrow** gates everything from infrastructure knobs to A/B tests on web, desktop and
mobile. Gates are edited in a UI and reach production within ten minutes. A gate is a list of
*populations* — rules over the user, session, team or device — tried in order, each with its own mix
of variants; whoever matches a population is assigned a variant by **hashing their id with the
gate's seed**, so the assignment is stateless and the same on every server. Populations can be
derived from other populations, or from queries over the analytics warehouse exported once a day.

## From the source

*Introducing Stormcrow* explains why the configuration is **not** read from a database: with many
gates evaluated per page load, that would mean a flood of fetches and a single point of failure.
Instead a \`stormcrow_config.json\` is pushed to every server on every edit, and a background
"loader" thread reloads it when it changes — so evaluating a gate is a pure function over data
already in memory. Desktop and mobile clients cannot hold that file; they **batch**-request every
feature's variant from the backend at start-up. Every assignment and exposure is logged to the
monitoring system, which draws per-variant graphs annotated with each edit. Dropboxers test with
**overrides** that pin themselves into a variant, and every gate keeps an **audit history**, because
gate edits — unlike code — happen at any hour and are not in version control. The post's hard-won
lesson: *avoid I/O in the feature gating system*; pass what you know in from the caller.

This course keeps that shape with Redis in place of the pushed file (one hash the loaders poll), a
gRPC service in place of the clients' batch endpoint, and Kafka in place of the monitoring pipeline.

## What you build here

One service, **gates**, used by every other service and by the clients:

1. \`PUT /gates/{name}\` that validates a gate — populations in order, variant shares that add up to
   100, a seed — bumps its **version**, honours \`If-Match\`, and appends to the gate's **history**.
2. The **snapshot loader** and \`get_variant\`: one \`HGETALL\` when \`gates:version\` changes, nothing
   at all per decision; the variant comes from \`sha256(seed:user_id)\`, so it is the same everywhere
   and survives a rollout from 10% to 20% without reassigning anyone.
3. **\`Gates.GetVariants\`** over gRPC: every requested gate in one reply, \`OFF\` for the ones the server
   has never heard of, served from the snapshot.
4. **Exposure events** on \`gate-exposures\`, keyed by gate and stamped with the version that assigned
   them — enqueued, never awaited, bounded when the broker is away.

## Left out on purpose

The rule engine over datafields, derived and warehouse-backed populations, selector inferring, the
static analyzer that finds stale gates in the code base, and the monitoring graphs themselves. The
four pieces above are the ones that decide whether a gating system is a cheap pure function or a
dependency on the critical path of every request.`,
  diagram: {
    nodes: [
      {id: 'dropboxer', kind: 'client', label: 'Dropboxer', sub: 'PUT /gates/{name} · history', x: 8, y: 26},
      {id: 'api', kind: 'http', label: 'gates API', sub: 'HTTPS :8443', x: 30, y: 26},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'gates · gates:version · gate:{name}:history', x: 56, y: 26},
      {id: 'clients', kind: 'client', label: 'Desktop · mobile', sub: 'GetVariants(user, features)', x: 8, y: 74},
      {id: 'svc', kind: 'grpc', label: 'Gates', sub: 'gRPC :9000', x: 30, y: 74},
      {id: 'web', kind: 'service', label: 'app servers', sub: 'snapshot loader · get_variant', x: 56, y: 74},
      {id: 'kafka', kind: 'kafka', label: 'gate-exposures', sub: 'key = gate', x: 79, y: 74},
      {id: 'monitoring', kind: 'service', label: 'monitoring', sub: 'per-variant graphs', x: 94, y: 74},
    ],
    edges: [
      {from: 'dropboxer', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'HSET · INCR version · LPUSH history'},
      {from: 'web', to: 'redis', kind: 'redis', label: 'GET version · HGETALL (loader)'},
      {from: 'clients', to: 'svc', kind: 'grpc', label: 'GetVariants'},
      {from: 'svc', to: 'web', kind: 'plain', label: 'snapshot'},
      {from: 'web', to: 'kafka', kind: 'kafka', label: 'exposures'},
      {from: 'kafka', to: 'monitoring', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [gateApiStep, gateSnapshotStep, gatesRpcStep, exposureLogStep],
  support: {python: protoModules, typescript: protoFiles},
  learn,
};
