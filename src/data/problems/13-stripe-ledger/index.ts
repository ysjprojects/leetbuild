import {STRIPE} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {protoFiles, protoModules} from './proto';
import {postTransactionStep} from './steps/1-post-transaction';
import {idempotentPostStep} from './steps/2-idempotent-post';
import {eventIngestionStep} from './steps/3-event-ingestion';
import {exactlyOnceLedgerStep} from './steps/4-exactly-once-ledger';
import {clearingStep} from './steps/5-clearing';
import {balanceServiceStep} from './steps/6-balance-service';
import {supportModules, supportModulesTs} from './support';

/**
 * Stripe's Ledger, rebuilt as the six mechanisms its engineering post describes: an HTTPS
 * `POST /transactions` that refuses anything but balanced double entry → idempotency keys with a
 * request fingerprint in Redis → money-movement events from the payment systems consumed from
 * Kafka and mapped to transactions → an insert-or-skip journal that survives redelivery → clearing
 * accounts tracked in a sorted set so stuck money surfaces after 24 h → balances over gRPC behind a
 * five-second cache.
 */
export const stripeLedgerProblem: Problem = {
  id: 'stripe-ledger',
  title: 'Ledger',
  tagline:
    "Stripe's money-movement ledger: double-entry transactions, events from payment systems through Kafka, idempotent ingestion, clearing accounts that must net to zero, balances over gRPC.",
  difficulty: 'hard',
  concepts: ['http', 'redis', 'kafka', 'grpc'],
  minutes: 100,
  company: STRIPE,
  sources: [
    {
      title: "Ledger: Stripe's system for tracking and validating money movement",
      url: 'https://stripe.com/blog/ledger-stripe-system-for-tracking-and-validating-money-movement',
      by: 'Ilya Ganelin',
      date: '2024-02-16',
      takes:
        'The shape of the system: an immutable double-entry log fed by events from the systems that move money, clearing accounts that must return to zero, and stuck or late money surfacing as a query.',
    },
    {
      title: 'Designing robust and predictable APIs with idempotency',
      url: 'https://stripe.com/blog/idempotency',
      by: 'Brandur Leach',
      date: '2017-02-22',
      takes:
        'The idempotency key: a client-chosen key stored with the first outcome so a retry replays the same result, and a request that reuses a key with a different body is refused.',
    },
  ],
  statement: `# Ledger

Every time money moves — a card is captured, a payout leaves for a bank, a refund goes back — some system
inside the company knows about it. The ledger is the one place where all of those systems agree on what
happened, and it does so by refusing to record anything that does not balance.

## The real system

Stripe's Ledger: an immutable, double-entry log that every money-moving system publishes into, a data-quality
platform computing *clearing*, *timeliness* and *completeness* scores on top of it, fund flows that model
each producer as a state machine, tooling that traces a single transaction across teams, and a reviewed
migration pipeline for correcting data at scale.

## From the source

In "Ledger: Stripe's system for tracking and validating money movement" the team describes a log that
nothing may edit: producers publish events, each event becomes a transaction whose entries move balances
between accounts, and past state is reproducible by replaying the log. The post's central trick is
*clearing*: money in transit sits in clearing accounts that are expected to return to zero once it
reaches its destination, so a missing, late or mislabelled event shows up as a clearing balance that
never clears — "find the clearing accounts with a nonzero balance" is the whole detection query. Around
that they describe timeliness (did the event arrive within its window?) and completeness (does every id
upstream have a matching event?) checks.

This course rebuilds the write path and the clearing check: balanced transactions over HTTPS, an
idempotent API as described in "Designing robust and predictable APIs with idempotency" (one key, one
outcome, replays return it), event ingestion from the payment systems through Kafka with insert-or-skip
so redelivery cannot double-book, a clearing tracker that reports money stuck for more than a day, and a
balance read side over gRPC.

## What you build here

One service, **ledger**, with Postgres, Redis and Kafka behind it:

1. \`POST /transactions\` that accepts only **double entry**: at least two entries, integer minor units,
   one currency, debits and credits netting to zero — anything else is a **422** with a reason.
2. An **Idempotency-Key** layer in Redis: the key is reserved with a fingerprint of the body, the outcome
   is stored next to it, a retry replays it and a different body under the same key is a **409**.
3. A consumer in group \`ledger\` turning \`money-events\` into balanced transactions through a mapping
   table, and parking unknown event types on \`money-events.dead\` instead of stopping.
4. The journal writer: \`INSERT … ON CONFLICT (event_id) DO NOTHING\` so a redelivered event is skipped
   without a second set of entries, with entries carrying the event's own time.
5. **Clearing**: every transaction touching a \`clearing:*\` account is tracked in a sorted set, removed
   when a later transaction settles it, and \`GET /clearing/stuck\` reports what has sat there over **24 h**.
6. \`LedgerService.GetBalance\` over **gRPC**: the sum of an account's entries up to \`as_of\`, served from
   a five-second Redis cache that writers invalidate.

## Left out on purpose

Fund-flow state machines and per-producer modelling, the data-quality scoring and its dashboards,
completeness checks against producer databases, multi-currency conversion, and the migration tooling for
corrections. The six pieces above are the ledger itself: the part everything else is computed from.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Internal callers', sub: 'POST /transactions', x: 8, y: 30},
      {id: 'api', kind: 'http', label: 'ledger', sub: 'HTTPS :8443', x: 26, y: 30},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'idem:{key} · clearing:open · bal:{acct}:{ccy}', x: 48, y: 8},
      {id: 'db', kind: 'db', label: 'Postgres', sub: 'transactions · entries', x: 48, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'money-events', sub: 'key = event id', x: 8, y: 72},
      {id: 'ingest', kind: 'service', label: 'ledger-ingest', sub: 'consumer group ledger', x: 26, y: 72},
      {id: 'dead', kind: 'kafka', label: 'money-events.dead', sub: 'unknown types', x: 26, y: 94},
      {id: 'balance', kind: 'grpc', label: 'LedgerService', sub: 'GetBalance · :9100', x: 70, y: 50},
      {id: 'reports', kind: 'client', label: 'Reporting', sub: 'GetBalance(account, ccy, as_of)', x: 92, y: 50},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'SET NX EX · HSET · ZADD'},
      {from: 'api', to: 'db', kind: 'plain', label: 'transactions + entries (1 tx)'},
      {from: 'kafka', to: 'ingest', kind: 'kafka', label: 'consume'},
      {from: 'ingest', to: 'dead', kind: 'kafka', label: 'produce'},
      {from: 'ingest', to: 'db', kind: 'plain', label: 'INSERT … ON CONFLICT DO NOTHING'},
      {from: 'ingest', to: 'redis', kind: 'redis', label: 'ZADD · ZREM · DEL bal'},
      {from: 'reports', to: 'balance', kind: 'grpc', label: 'GetBalance'},
      {from: 'balance', to: 'redis', kind: 'redis', label: 'GET / SET EX 5'},
      {from: 'balance', to: 'db', kind: 'plain', label: 'SUM(amount)'},
    ],
  },
  steps: [
    postTransactionStep,
    idempotentPostStep,
    eventIngestionStep,
    exactlyOnceLedgerStep,
    clearingStep,
    balanceServiceStep,
  ],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
  },
  learn,
};
