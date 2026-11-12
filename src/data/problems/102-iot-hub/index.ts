import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * IoT hub: the debugging a device-management layer needs before it unlocks a door twice. Commands
 * recorded under the caller's idempotency id with a validity window → a Redis shadow whose desired
 * and reported documents keep their own versions → gRPC delivery under a deadline where only the
 * device's acknowledgement counts → command transitions keyed by device with an outbox → a shadow
 * read that shows both documents and the delta.
 */
export const iotHubProblem: Problem = {
  id: 'iot-hub',
  title: 'IoT Hub',
  tagline: 'Door-lock commands that run once, and a device shadow that shows where the device is behind.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# IoT Hub

An IoT hub stands between operators and devices in the field. It accepts a command and runs it
once, hands it to a gateway that may not reach the device for hours, records what happened to it,
and keeps a **device shadow**: what the operator wants the device to be (desired) next to what the
device last said it is (reported).

## The real system

AWS IoT Core's Device Shadow service keeps one JSON document per device with a \`desired\` and a
\`reported\` section, publishes a \`delta\` listing the desired fields the device has not reached yet,
and rejects an update whose \`version\` does not match the stored one with a 409, so a stale writer
cannot overwrite a newer document. This course keeps that shape in Redis, with one difference: the
two sections carry their own versions, because the operator and the device write them at different
times.

## What you build here

One service, **iothub**, on one provided package (\`iothub\`): \`commands\` (the command store),
\`shadow\` (step 2's functions as later steps use them), \`registry\` (which tenant owns a device)
and \`outbox\`.

1. \`POST /v1/devices/{device_id}/commands\` with \`{idempotency_id, action, params, validity_s,
   ack_required}\`: one command per \`(device, idempotency_id)\` in \`command:{device}:{idempotency_id}\`,
   an \`expires_at_ms\` window, at most 10 commands per device per minute, and a \`pending_ack\` state
   until the device answers.
2. A **Redis** shadow: \`shadow:{device}:desired\` and \`shadow:{device}:reported\` hashes and their
   versions in \`shadow:{device}\`. \`update_desired\` merges, \`apply_report\` keeps only a newer report
   in one Lua script, \`read_shadow\` returns both.
3. A **gRPC** \`DeviceGateway.Deliver\` client: \`deliver(command)\` answers \`delivered\`, \`queued\`,
   \`expired\` or \`failed\` under a 5-second deadline, at most three attempts, inside the window.
4. A **Kafka** \`iot.command\` stream: \`publish_transition(command, outcome)\` keyed by device id,
   ids and outcome only, idempotent with \`acks=all\`, an outbox row when the broker does not
   acknowledge.
5. \`GET /v1/devices/{device_id}/shadow\`: both documents, both versions and the \`delta\`, **404**
   for a device the caller's \`X-Tenant-Id\` does not own.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Device provisioning and certificates, MQTT and CoAP transports, firmware updates, per-model payload
schemas, telemetry storage and the relay that drains the outbox.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Operator', sub: 'commands · shadow read', x: 6, y: 50},
      {id: 'hub', kind: 'http', label: 'iothub', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'command:* · shadow:*', x: 46, y: 14},
      {id: 'gateway', kind: 'grpc', label: 'Device gateway', sub: 'Deliver · 5 s', x: 52, y: 50},
      {id: 'device', kind: 'external', label: 'Device', sub: 'acks · reports', x: 76, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'iot.command', sub: 'key = device id', x: 46, y: 86},
      {id: 'audit', kind: 'service', label: 'Fleet audit', sub: 'consumer group', x: 72, y: 86},
      {id: 'outbox', kind: 'db', label: 'Outbox', sub: 'unacknowledged events', x: 24, y: 86},
    ],
    edges: [
      {from: 'client', to: 'hub', kind: 'http', label: 'POST commands · GET shadow'},
      {from: 'hub', to: 'redis', kind: 'redis', label: 'commands · desired/reported'},
      {from: 'hub', to: 'gateway', kind: 'grpc', label: 'Deliver · expires_at_ms'},
      {from: 'gateway', to: 'device', kind: 'plain', label: 'push · ack'},
      {from: 'device', to: 'hub', kind: 'plain', label: 'reported state'},
      {from: 'hub', to: 'kafka', kind: 'kafka', label: 'publish_transition'},
      {from: 'kafka', to: 'audit', kind: 'kafka', label: 'consume'},
      {from: 'hub', to: 'outbox', kind: 'plain', label: 'no ack → row'},
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
