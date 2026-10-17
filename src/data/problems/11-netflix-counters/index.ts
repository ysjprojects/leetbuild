import {NETFLIX} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {protoModules} from './proto';
import {counterApiStep} from './steps/1-counter-api';
import {bestEffortStep} from './steps/2-best-effort';
import {countEventsStep} from './steps/3-count-events';
import {rollupStep} from './steps/4-rollup';
import {countServiceStep} from './steps/5-count-service';

/**
 * Netflix's distributed counter abstraction, rebuilt as its two halves behind one API. HTTPS
 * AddCount/GetCount/ClearCount over namespaces → best-effort counters as INCRBY in Redis with a TTL
 * armed once → eventually consistent adds as events on Kafka, durable before the 202 → a rollup
 * consumer folding them into per-minute buckets effectively once → GetCount over gRPC from a
 * two-second cache of the rolled-up total.
 */
export const netflixCountersProblem: Problem = {
  id: 'netflix-counters',
  title: 'Distributed Counters',
  tagline:
    "Netflix's counter abstraction: best-effort counters in a cache, exact ones as an event log rolled up in the background, one API over both.",
  difficulty: 'medium',
  concepts: ['http', 'redis', 'kafka', 'grpc'],
  minutes: 60,
  company: NETFLIX,
  sources: [
    {
      title: "Netflix's Distributed Counter Abstraction",
      url: 'https://netflixtechblog.com/netflixs-distributed-counter-abstraction-8d0c45eb66b2',
      by: 'Rajiv Shringi, Oleksii Tkachuk, Kartik Sathyanarayanan',
      date: '2024-11',
      takes:
        'The namespace-configured AddCount/GetCount/ClearCount API, best-effort counters as TTL-bound cache entries, and eventually consistent counters as an idempotency-tokened event log rolled up in time windows and served from a cache.',
    },
  ],
  statement: `# Distributed Counters

"How many times was this title played?" sounds like one number. At Netflix it is tens of thousands of
requests a second across every region, and the honest answer depends on who is asking: a UI badge wants
a number *now* and can be a little wrong, a billing or experimentation pipeline wants the right number and
can wait a few seconds for it.

## The real system

A counting service inside a data platform: counters sharded and replicated globally, namespaces with
their own retention, cardinality limits and consistency settings, a time-series store holding every
increment as an event, a rollup tier aggregating billions of events in immutable time windows, caches in
front of the rolled-up values, and a control plane that configures and deploys all of it per use case.

## From the source

*Netflix's Distributed Counter Abstraction* describes one API — AddCount, GetCount, ClearCount over named
counters in configured namespaces — with two implementations behind it. **Best-Effort** counters are
entries in EVCache with a TTL: fast, cheap, and allowed to be approximate or lost. **Eventually
Consistent** counters never increment anything directly; every add is logged as an event, carrying the
client's idempotency token, to the TimeSeries abstraction. A background rollup pipeline then aggregates
the events of each counter in time windows, deduplicating on the token, and the aggregated values are
cached so reads stay fast while the number converges.

This course rebuilds that shape with Redis in place of EVCache and the rollup store, Kafka in place of the
TimeSeries abstraction, and a single rollup worker in place of the queued rollup tier.

## What you build here

One service, **counters**, plus the rollup worker and a gRPC read endpoint:

1. HTTPS \`POST /counters/{ns}/{name}/add\`, \`GET\` and \`DELETE\`, where the **namespace** decides the kind
   of counter: **200** with the count for best-effort, **202** for eventually consistent.
2. **Best-effort** counters as \`INCRBY\` on \`counter:{ns}:{name}\` with a TTL armed once, at creation.
3. Eventually-consistent adds as **events** on \`counter-events\`, keyed by counter, carrying the token,
   acknowledged by every replica before the 202.
4. A **rollup** consumer in group \`rollup\` folding events into per-minute buckets of
   \`rollup:{ns}:{name}\`, deduplicating on the token before it folds, committing after.
5. **\`CounterService.GetCount\`** over gRPC, serving eventually-consistent totals from a 2-second
   cache-aside entry and answering \`NOT_FOUND\` / \`INVALID_ARGUMENT\` like the API's 404 / 400.

## Left out on purpose

Global replication, per-namespace cardinality limits, the time-series store and its bucketing, the queued
rollup tier with dynamic batching, immutable-window storage of closed buckets, clears as logged events,
and AddAndGetCount. The five pieces above are the ones that make the two kinds of counter different —
and the one API over them the same.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Clients', sub: 'POST …/add · GET · DELETE', x: 8, y: 30},
      {id: 'internal', kind: 'client', label: 'Other services', sub: 'GetCount(ns, name)', x: 8, y: 74},
      {id: 'api', kind: 'http', label: 'counters', sub: 'HTTPS :8443', x: 30, y: 30},
      {id: 'svc', kind: 'grpc', label: 'CounterService', sub: 'gRPC :9000', x: 30, y: 74},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'counter:{ns}:{name} · rollup:… · total:…', x: 56, y: 52},
      {id: 'kafka', kind: 'kafka', label: 'counter-events', sub: 'key = ns:name', x: 56, y: 14},
      {id: 'rollup', kind: 'service', label: 'rollup', sub: 'consumer group', x: 82, y: 14},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'SET NX EX · INCRBY'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce acks=all'},
      {from: 'kafka', to: 'rollup', kind: 'kafka', label: 'consume'},
      {from: 'rollup', to: 'redis', kind: 'redis', label: 'SET seen NX · HINCRBY'},
      {from: 'internal', to: 'svc', kind: 'grpc', label: 'GetCount'},
      {from: 'svc', to: 'redis', kind: 'redis', label: 'GET total · HVALS'},
    ],
  },
  steps: [counterApiStep, bestEffortStep, countEventsStep, rollupStep, countServiceStep],
  support: {python: protoModules},
};
