import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Autocomplete: the course is not "return some suggestions from an endpoint", it is the debugging
 * you owe a typeahead before it suggests a person's name. A bounded, folded prefix → a Redis cache
 * capped per tenant with a TTL → a suggester call with a deadline and a versioned fallback →
 * tenant-keyed events carrying prefix hashes, not text → a trending read with an occurrence floor
 * and no user linkage.
 */
export const autocompleteServiceProblem: Problem = {
  id: 'autocomplete-service',
  title: 'Autocomplete',
  tagline:
    'Typeahead suggestions behind a bounded prefix and a tenant-scoped cache, with a floor before anything trends.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Autocomplete

Autocomplete is the piece of a search product that turns the first few characters a user types into
the handful of terms worth completing. It is the most-used endpoint in most catalogs, it runs on the
request path where latency is measured in milliseconds, and it sits on top of the one signal that is
both the most valuable and the most sensitive the product has: what people are searching for. The
visible part is a dropdown; the parts that decide whether the product is safe are the prefix
boundary, the cache, the failure fallback, the event pipeline and the trending read.

## The real system

Algolia's Query Suggestions product builds its suggestion index from popular searches, and the
configuration is mostly thresholds: a query must have produced at least \`minHits\` results (default
5) and be at least \`minLetters\` long (default 4) to enter the index, and an \`exclude\` list keeps
named terms out whatever their popularity. That is the same shape as this course's trending read: a
floor, a bound and a filter, applied before anything reaches the dropdown. The rest of a production
autocomplete follows the same pattern. The prefix is normalized before anything else, because
\`Café\` and \`cafe\` are the same search, and bounded so a long string cannot walk the whole index.
Top suggestions are cached per \`(tenant, prefix)\` with a TTL and a per-tenant cap, so a flood of
prefixes costs the flooder and not everyone. The suggester is called under a short deadline, and a
curated fallback list, marked as fallback, is served when it is slow. Impression and selection
events are keyed by tenant and carry a prefix hash rather than the raw text, and a broker hiccup
lands the event in an outbox rather than on the floor.

## What you build here

One service, **suggestd**, with five pieces:

1. \`GET /v1/autocomplete\`: an authenticated tenant, a prefix normalized for case and accents,
   bounded to 1–64 characters, control characters rejected with \`400\`, and at most ten
   suggestions after dedupe.
2. A **Redis** cache: top suggestions per \`(tenant, prefix, catalog version)\`, a 5-minute TTL, and a
   per-tenant cap on distinct cached prefixes with the coldest evicted first.
3. A **gRPC** suggester client: a 150 ms deadline, retries dropped rather than run inline, and a
   versioned static fallback list that keeps the UI useful while the suggester is slow.
4. A **Kafka** event path: \`suggest.event\` keyed by tenant, a payload of prefix hashes, positions and
   latencies, an idempotent producer with \`acks=all\`, and an outbox row when the broker rejects.
5. \`GET /v1/trending\`: aggregated popular terms with a 100-occurrence floor, a sensitive-category
   filter, and no user linkage in the response.

## The debugging habit

Every starter in this course is working code with flaws. It compiles, it serves the happy path (one
tenant, English prefixes, a healthy suggester) and it looks right. Your job in every step is the job
you will have on a real search feature: debug it against the failure modes, find the subtle one,
fix it, optimize what is wasteful, and prove the fix with checks that fail on the starter and pass
on your version.

## Left out on purpose

The ranking model itself, tokenization per language, personalization per user, multi-region cache
topology, the schema registry rollout, and the offline job that recomputes trends. The five pieces
above are the ones that decide whether autocomplete is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'typeahead · trending', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Autocomplete API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'store', kind: 'db', label: 'Suggestion index', sub: 'terms · counts', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Suggestion cache', sub: 'tenant + prefix', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'suggest.event', sub: 'key = tenant', x: 44, y: 88},
      {id: 'suggester', kind: 'grpc', label: 'Suggester', sub: 'Suggest(prefix)', x: 66, y: 12},
      {id: 'fallback', kind: 'external', label: 'Curated fallback', sub: 'static · versioned', x: 66, y: 40},
      {id: 'trending', kind: 'service', label: 'Trend service', sub: 'window · floor', x: 66, y: 64},
      {id: 'consumer', kind: 'service', label: 'Event consumer', sub: 'aggregate counts', x: 66, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'store', kind: 'plain', label: 'match prefix'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'cached top-10'},
      {from: 'api', to: 'suggester', kind: 'grpc', label: 'Suggest(prefix)'},
      {from: 'api', to: 'fallback', kind: 'grpc', label: 'on deadline'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce suggest.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'store', kind: 'plain', label: 'HINCRBY counts'},
      {from: 'api', to: 'trending', kind: 'plain', label: 'read trends'},
      {from: 'trending', to: 'store', kind: 'plain', label: 'aggregate window'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
