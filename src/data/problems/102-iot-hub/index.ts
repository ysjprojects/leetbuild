import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * IoT hub on the AI-era track: the course is not "accept a command from a device", it is the
 * review you owe a model-generated device-management layer before it unlocks a door twice. Commands
 * that carry their identity, a validity window and an acknowledgment → a Redis shadow whose desired
 * and reported documents keep independent versions → gRPC delivery to the device gateway with a
 * deadline and queue-only-until-expiry semantics → command events keyed by device with an outbox →
 * a shadow read that shows desired, reported and their divergence instead of a merged blur.
 */
export const iotHubProblem: Problem = {
  id: 'iot-hub',
  title: 'IoT Hub',
  tagline: 'Device shadows that reconcile desired and reported state without losing either.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# IoT Hub

An IoT hub is the piece of a fleet platform that stands between operators and the devices in the
field. It accepts commands and promises each one runs once, keeps a **device shadow** so desired and
reported state can disagree without either being lost, delivers commands to a device gateway that
may be offline for days, and publishes a command history the fleet team can audit. The visible part
is a device turning on; the parts that decide whether the platform is safe are the command's
identity, the shadow's versions, the delivery deadline and the event key.

## The real system

Production hubs receive commands from operators and automations, attach each one an identity and a
validity window, and enforce a per-device rate so one integration cannot flood a device with work.
They keep a shadow document with a **desired** side written by operators and a **reported** side
written by the device, each with its own version, so a device that comes back online with an old
configuration cannot silently erase an operator's change — the hub flags the divergence instead.
They deliver commands through a gateway under a deadline, queue for an offline device only until the
command's window runs out, and require the device's acknowledgment before calling a command
delivered. They publish command events keyed by device so one device's history stays ordered, carry
ids and outcomes but never payload secrets like a door code, and write an outbox row when the broker
rejects the produce so history is never lost. And they answer a shadow read with both documents, both
versions and the explicit list of fields where reported is behind desired — never one merged blur.

## What you build here

One service, **iothub**, with five pieces:

1. \`POST /v1/devices/{id}/commands\`: a per-device idempotency id so a replay executes once, a
   validity window so a stale command is discarded unexecuted, an expected acknowledgment, and a
   per-device command rate limit.
2. A **Redis** shadow: desired and reported documents with **independent versions**, a reported
   update that merges by version so a stale report cannot clobber newer desired state, and a
   reconciliation that converges on the desired document.
3. A **gRPC** device gateway: a 5-second deadline per delivery, an offline device whose commands
   queue only until their validity window, and "delivered" that means the device acknowledged, not
   that the gateway accepted an enqueue.
4. A **Kafka** command event path: one \`iot.command\` event keyed by device id, ids and outcomes
   without payload secrets, an idempotent producer with \`acks=all\`, and an outbox row when the
   produce fails.
5. \`GET /v1/devices/{id}/shadow\`: desired and reported documents, both versions, an explicit
   divergence list, and **404** for a device the caller does not own.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real IoT feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Device provisioning and certificates, firmware updates, MQTT and CoAP transports, command payload
schemas per device model, time-series telemetry storage, multi-region device routing, and operator
RBAC. The five pieces above are the ones that decide whether the hub is correct, isolated and
shippable.`,
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
