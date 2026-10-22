import type {Problem} from '@/lib/types';

import {gracefulShutdownStep} from './steps/1-graceful-shutdown';

/**
 * Kafka drill: a consume-and-forward worker's shutdown — stop polling, finish the record in hand,
 * flush with the time left, commit synchronously, close — always back within the deadline, and a
 * restart that resumes from the committed offsets without losing a record.
 */
export const kafkaGracefulShutdownProblem: Problem = {
  id: 'kafka-graceful-shutdown',
  title: 'Graceful shutdown: drain, commit, close under a deadline',
  tagline:
    'A consume-and-forward worker that stops under a deadline: the record in hand finishes, the forwards flush, the safe offsets commit, the clients close — and a restart loses nothing.',
  difficulty: 'hard',
  concepts: ['kafka'],
  minutes: 35,
  statement: `# Graceful shutdown: drain, commit, close under a deadline

Every Kafka worker gets killed, routinely: a deploy rolls it, an autoscaler drains it, a node goes
away. Between the SIGTERM and the SIGKILL there is a budget — thirty seconds on Kubernetes by
default — and what the worker does with it decides whether the stop is invisible or a page. A
worker that just exits leaves forwards in the producer's buffer and offsets uncommitted; a worker
that waits for the broker without a bound hangs past the budget and is killed mid-commit anyway.

The shape of a correct stop is the same in every consume-transform-produce job: stop taking
records, let the one in hand finish, flush what the producer still owes the broker with the time
that is left, commit synchronously exactly the offsets whose forwards were acknowledged, close the
clients, and report what did not make it so the restart's at-least-once redelivery is expected
rather than a surprise. Stream processors, CDC connectors and outbox relays all contain this loop.

The worker here is a forwarder: \`run(handler)\` consumes \`inbox\` in the group \`forwarder\`, calls
\`handler(record)\` and produces the result to \`outbox\` under the same key, committing each offset
after the forward's acknowledgement; \`shutdown(deadline_s)\` performs the stop above within
\`deadline_s\` of clock time and returns \`{"forwarded", "committed_offsets", "undelivered",
"uncommitted"}\`.

## What you build here

1. \`run(handler)\` and \`shutdown(deadline_s)\` in one module: commit-after-ack forwarding, and a stop
   that drains, commits and closes under a deadline — correct with a healthy broker, with a stalled
   one, with a slow handler, and across a restart.

## Left out on purpose

Rebalance callbacks (a partition revoke is this same stop for one partition), Kafka transactions
that move the forward and the commit together, idempotent downstream writes that make the
redelivery harmless, and the signal handling that calls \`shutdown\` — the drill is the stop itself.`,
  diagram: {
    nodes: [
      {id: 'upstream', kind: 'client', label: 'upstream', sub: 'produces inbox', x: 10, y: 50},
      {id: 'forwarder', kind: 'service', label: 'forwarder', sub: 'run(handler) · shutdown(deadline_s)', x: 50, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'Kafka', sub: 'inbox → outbox · group forwarder', x: 88, y: 50},
    ],
    edges: [
      {from: 'upstream', to: 'kafka', kind: 'kafka', label: 'inbox'},
      {from: 'kafka', to: 'forwarder', kind: 'kafka', label: 'poll inbox · commit'},
      {from: 'forwarder', to: 'kafka', kind: 'kafka', label: 'produce outbox (same key)'},
    ],
  },
  steps: [gracefulShutdownStep],
};
