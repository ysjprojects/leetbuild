import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Autocomplete: the course is not "return some suggestions from an endpoint", it is the debugging
 * you owe a typeahead before it suggests a person's name. A folded, bounded prefix → a tenant- and
 * version-scoped Redis cache with a TTL and a per-tenant cap → a suggester call with a 150 ms deadline
 * and a versioned fallback nobody caches → tenant-keyed events that carry a prefix hash, with an
 * outbox → a trending read with a window, a floor, a category filter and no user linkage.
 */
export const autocompleteServiceProblem: Problem = {
  id: 'autocomplete-service',
  title: 'Autocomplete',
  tagline: 'Folded prefixes, a capped tenant cache, a 150 ms suggester deadline, hashed events and a trending floor.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Autocomplete

Autocomplete turns the first characters a user types into the few terms worth completing. It is
the most called endpoint of a search product, it answers inside a keystroke, and it sits on the most
sensitive signal the product has: what people search for. A query typed once can be a person's
name, so the parts that decide whether it is safe are the prefix boundary, the cache, the fallback,
the event stream and the trending read.

## The real system

Algolia's Query Suggestions builds its suggestion index from the searches users ran, and most of
its configuration is thresholds: a query enters the index only if it returned at least \`minHits\`
results and has at least \`minLetters\` characters, and an \`exclude\` list keeps named terms out
whatever their popularity. The trending read of this course has the same shape: a floor, a window
and a filter before anything reaches the rail.

## What you build here

One service, **suggestd**, on one term store (\`suggest.terms\`, provided: \`fold\`, \`matching\`,
the catalog version, hourly trend buckets) and one cache (\`get_suggestions\` / \`put_suggestions\`,
built in step 2 and provided to step 3 as \`suggest.cache\`):

1. \`GET /v1/autocomplete?prefix=\` with \`X-Tenant-Id\`: the prefix folded with \`terms.fold\`, 1 to 64
   characters, a control character answered \`400\`, at most ten suggestions after dedupe.
2. A **Redis** cache under \`suggest:cache:{tenant}:v{catalog version}:{prefix}\` with a 300 s TTL
   and at most 100 prefixes per tenant, the coldest evicted first.
3. A **gRPC** \`Suggester.Suggest\` call with a 150 ms deadline and one attempt; on failure a curated,
   versioned fallback marked \`"source": "fallback"\` that is never cached.
4. A **Kafka** \`suggest.event\` stream keyed by tenant, carrying \`prefix_hash\` instead of the text,
   from an idempotent producer with \`acks=all\`; a delivery that fails lands in \`suggest:outbox\`.
5. \`GET /v1/trending\`: the last 24 hourly buckets, terms searched at least 100 times, sensitive
   categories dropped, each entry a term and a count.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the demo (one
tenant, ASCII prefixes, a healthy suggester and broker), and it looks right. In every step, debug it
against the failure modes the task names, fix it, and prove the fix with checks that fail on the
starter and pass on your version.

## Left out on purpose

The ranking model, per-language tokenization, personalization, spelling correction, multi-region
cache topology and the consumer that counts trend buckets. The five pieces above decide whether
autocomplete is correct, isolated and safe to ship.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Search box', sub: 'typeahead · trending rail', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'suggestd', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'terms', kind: 'db', label: 'Term store', sub: 'suggest:terms · trend buckets', x: 46, y: 12},
      {id: 'redis', kind: 'redis', label: 'Suggestion cache', sub: 'suggest:cache:{tenant}:v{n}', x: 46, y: 38},
      {id: 'suggester', kind: 'grpc', label: 'Suggester', sub: 'Suggest · 150 ms', x: 66, y: 38},
      {id: 'kafka', kind: 'kafka', label: 'suggest.event', sub: 'key = tenant', x: 46, y: 64},
      {id: 'outbox', kind: 'redis', label: 'Outbox', sub: 'suggest:outbox', x: 46, y: 88},
      {id: 'consumer', kind: 'service', label: 'Trend counter', sub: 'hourly buckets', x: 66, y: 64},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'terms', kind: 'plain', label: 'matching · trend_counts'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'get · put_suggestions'},
      {from: 'api', to: 'suggester', kind: 'grpc', label: 'Suggest · deadline 150 ms'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce prefix_hash'},
      {from: 'api', to: 'outbox', kind: 'redis', label: 'failed delivery'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'terms', kind: 'plain', label: 'ZINCRBY hour bucket'},
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
