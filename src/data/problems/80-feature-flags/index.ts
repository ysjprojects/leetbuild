import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Feature flags: the course is not "add a boolean to config", it is the debugging you owe a flag
 * service before it decides what every user sees. A create validated against the schema registry
 * and keyed by Idempotency-Key → one versioned Redis snapshot swapped by a Lua script, with per-flag
 * bucketing → a kill committed to the snapshot, then pushed to the edge relay under a 1-second
 * deadline → flag-keyed change events produced after the commit, with an outbox fed by the
 * delivery report → an explain endpoint that answers the served decision to its own user only.
 */
export const featureFlagsProblem: Problem = {
  id: 'feature-flags',
  title: 'Feature Flags',
  tagline:
    'A schema registry, one versioned Redis snapshot, a gRPC kill switch, flag-keyed events and an explain endpoint.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Feature Flags

A feature-flag service decides which users see which behavior without a deploy. The visible part is
a boolean in a response. The parts that keep the platform safe are the validation at creation, the
snapshot every evaluation reads, the kill switch, the event stream that tells other systems a flag
changed, and the explanation that has to agree with what a user was served.

## The real system

Unleash, the open-source flag platform, computes a user's rollout position by hashing the user id
together with the strategy's \`groupId\` (MurmurHash, normalized to 0 to 100). The \`groupId\`
defaults to the flag's name, so each flag splits users independently; two flags that must target the
same people are given the same \`groupId\` on purpose, and changing it reshuffles everyone. This
course asks the same of \`bucket(flag_key, user_id, salt)\`, with FNV-1a in place of MurmurHash.

## What you build here

One service, **flagsvc**, on four provided modules: \`flags.registry\` (the attributes a rule may
target, the operators each type allows, \`rule_error\`, \`rule_matches\`), \`flags.hashing\`
(\`fnv1a32\`), \`flags.store\` (flag versions under \`flag:{key}:v{n}\`, the recorded answers of
creates) and \`flags.engine\` (step 2's snapshot functions, provided to the later steps).

1. \`POST /v1/flags\` with \`{key, default, rules, rollout}\`: rules checked against the registry, a
   required \`default\`, and an \`Idempotency-Key\` whose replay answers the recorded version.
2. A **Redis** snapshot: the whole rule set as one JSON document under \`flags:snapshot\`, replaced by
   a Lua script only by a newer version; \`bucket\` hashes \`"{salt}.{flag_key}.{user_id}"\`.
3. A **gRPC** kill: \`kill_flag\` commits a snapshot with the flag killed, then calls
   \`Relay.PushKill\` with a 1-second deadline; a failed push waits in \`flags:push:pending\`.
4. A **Kafka** \`flag.event\` stream keyed by flag key, produced after the snapshot commits, naming
   the attributes rules target but no values, with \`flags:outbox\` fed by the delivery report.
5. \`GET /v1/flags/{key}/evaluation\`: the decision \`engine.evaluate\` serves, for the caller named by
   \`X-User-Id\` only, with \`Cache-Control: private, no-store\`.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path, and
looks right. In every step you debug the starter against the failure modes the task names, fix it,
and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Flag authoring UIs, per-environment promotion, SDK streaming, segments, multivariate flags,
experiment statistics and the retrier that drains the pending and outbox lists.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Admin · SDK', sub: 'create · explain', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'flagsvc', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'store', kind: 'db', label: 'flags.store', sub: 'flag:{key}:v{n}', x: 46, y: 14},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'flags:snapshot · version', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'flag.event', sub: 'key = flag key', x: 46, y: 86},
      {id: 'relay', kind: 'grpc', label: 'Edge relay', sub: 'PushKill · 1 s', x: 68, y: 22},
      {id: 'sdk', kind: 'service', label: 'SDK streams', sub: 'poll every 5 s', x: 86, y: 44},
      {id: 'consumer', kind: 'service', label: 'Audit · analytics', sub: 'consume flag.event', x: 68, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST /v1/flags · GET evaluation'},
      {from: 'api', to: 'store', kind: 'plain', label: 'save · create_result'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'publish_snapshot · evaluate'},
      {from: 'api', to: 'relay', kind: 'grpc', label: 'PushKill after the commit'},
      {from: 'relay', to: 'sdk', kind: 'plain', label: 'drop the flag now'},
      {from: 'sdk', to: 'redis', kind: 'redis', label: 'read snapshot'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after the commit'},
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
