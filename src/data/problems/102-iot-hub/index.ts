import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * IoT hub: the debugging a device-management layer needs before it unlocks a door twice. Commands
 * that carry an idempotency id, a validity window and an acknowledgment, a Redis shadow whose
 * desired and reported documents keep independent versions, gRPC delivery to the device gateway
 * with a deadline and queue-only-until-expiry semantics, command events keyed by device with an
 * outbox, and a shadow read that shows desired, reported and their divergence.
 */
export const iotHubProblem: Problem = {
  id: 'iot-hub',
  title: 'IoT Hub',
  tagline: 'A device shadow that shows where the device is behind, fed by commands that execute once.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# IoT Hub

An IoT hub stands between operators and the devices in the field. It accepts commands and runs each
one once, keeps a **device shadow** so desired and reported state can disagree without either being
lost, delivers commands to a device gateway that may be offline for days, and publishes a command
history the fleet team can audit.

## The real system

AWS IoT Core's Device Shadow service stores a JSON document with separate \`desired\` and
\`reported\` sections, publishes a \`/delta\` document listing the fields where the two differ, and
rejects an update whose \`version\` does not match the latest one it holds, so a stale writer cannot
overwrite a newer document. This course keeps the same shape: two documents, two counters, a
divergence list computed from the documents, and a report that is not newer changes nothing. On the
command side, production hubs attach an identity and a validity window to every command, deliver
through a gateway under a deadline, and require the device's acknowledgment before calling a command
delivered. Command events are keyed by device so one device's history stays ordered and carry ids
and outcomes rather than payload secrets.

## What you build here

One service, **iothub**, with five pieces:

1. \`POST /v1/devices/{id}/commands\`: a per-device idempotency id so a replay executes once, a
   validity window, an expected acknowledgment, and a per-device command rate limit.
2. A **Redis** shadow: desired and reported documents with independent versions, a reported update
   that merges by version, and a reconciliation that converges on the desired document.
3. A **gRPC** device gateway client: a 5-second deadline per delivery, an offline queue that lasts
   only until the validity window, and "delivered" meaning the device acknowledged.
4. A **Kafka** command event path: one \`iot.command\` event keyed by device id, ids and outcomes
   without payload secrets, an idempotent producer with \`acks=all\`, and an outbox row when the
   produce fails.
5. \`GET /v1/devices/{id}/shadow\`: both documents, both versions, a divergence list, and **404**
   for a device the caller does not own.

## The debugging habit

Every starter in this course compiles and serves the happy path. In each step you debug it against
the failure modes the task names, fix it, and prove the fix with checks that fail on the starter and
pass on your version.

## Left out on purpose

Device provisioning and certificates, firmware updates, MQTT and CoAP transports, command payload
schemas per device model, time-series telemetry storage, multi-region device routing, and operator
RBAC.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Operator', sub: 'HTTPS', x: 0, y: 50},
      {id: 'hub', kind: 'service', label: 'IoT Hub', sub: 'api · read', x: 25, y: 50},
      {id: 'shadow', kind: 'redis', label: 'Shadow', sub: 'desired/reported', x: 25, y: 20},
      {id: 'gateway', kind: 'grpc', label: 'Device Gateway', sub: 'gRPC :50051', x: 55, y: 50},
      {id: 'device', kind: 'external', label: 'Device', sub: 'reported state', x: 80, y: 50},
      {id: 'broker', kind: 'kafka', label: 'iot.command', sub: 'keyed by device', x: 55, y: 20},
      {id: 'audit', kind: 'service', label: 'Fleet Audit', sub: 'consumer group', x: 80, y: 20},
      {id: 'outbox', kind: 'db', label: 'Outbox', sub: 'undelivered events', x: 25, y: 80},
    ],
    edges: [
      {from: 'client', to: 'hub', kind: 'http', label: 'commands · shadow read'},
      {from: 'hub', to: 'shadow', kind: 'redis', label: 'desired/reported versions'},
      {from: 'hub', to: 'gateway', kind: 'grpc', label: 'Deliver · deadline 5 s'},
      {from: 'gateway', to: 'device', kind: 'grpc', label: 'push command'},
      {from: 'device', to: 'hub', kind: 'http', label: 'reported state'},
      {from: 'hub', to: 'broker', kind: 'kafka', label: 'produce iot.command'},
      {from: 'broker', to: 'audit', kind: 'kafka', label: 'consume'},
      {from: 'hub', to: 'outbox', kind: 'plain', label: 'outbox row on failure'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
