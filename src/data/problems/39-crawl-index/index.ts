import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Crawl & Index: the course is not "follow links from a seed URL", it is the debugging you owe a
 * crawler before it points itself at the internet. A target that passes scheme, host and robots
 * policy before it is enqueued → one Redis frontier per host with tokens refilled and taken in one
 * atomic script → a fetcher call with a deadline, a bounded retry policy that treats 403 as
 * terminal and 429 as a host-level backoff → page events keyed by host that carry references and
 * are announced only after the index confirms the write → a job report that computes coverage from
 * the live frontier and says out loud when a crawl has stalled.
 */
export const crawlIndexProblem: Problem = {
  id: 'crawl-index',
  title: 'Crawl & Index',
  tagline: 'A per-host frontier in Redis, a fetcher with a failure policy, and a crawl report an operator can act on.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Crawl & Index

A crawler turns the open web into a corpus you own: it decides which URLs are worth fetching, paces
itself so it is not a denial of service with a user agent, survives hosts that fail, and keeps a
report an operator can believe.

## The real system

Production crawlers register a target only after checking the scheme, the allowlist and the host's
\`robots.txt\`, because a crawler that will fetch anything is an SSRF with a queue in front of it.
They keep the frontier per host and pace each host separately. Scrapy assigns every request to a
download slot keyed by the URL's domain, and its AutoThrottle extension adjusts each slot's delay
from that host's measured latency, with the rule that a non-200 response may raise the delay but may
not lower it: errors mean slow down. They fetch under a deadline, retry only the failures that
deserve it, treat \`403\` as a decision from the site, and back a whole host off on \`429\`. They
publish one event per page keyed by host, carrying a reference to the stored page rather than the
page, because a topic is retained and replicated. And they report coverage an operator can defend:
live counts, the oldest pending age, and a stall flag.

## What you build here

One service, **crawld**, with five pieces:

1. \`POST /v1/crawl/targets\`: idempotent seed registration with scheme, allowlist and internal
   addresses checked before any fetch and robots rules read before acceptance.
2. A **Redis frontier**: one queue and one token bucket per host, refilled inside one atomic Lua
   \`EVAL\`, plus a host-level not-before timestamp for \`429\`.
3. A **gRPC** fetcher call: 5-second deadline, at most three attempts, retries only on
   \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`, \`403\` recorded as refused, URL off the queue first.
4. A **Kafka** \`crawl.page\` event: keyed by host, carrying \`content_hash\` and \`body_ref\`
   without the markup, published after the index write confirms.
5. \`GET /v1/crawl/jobs/{job_id}\`: live counts, the oldest pending URL's age, coverage that
   excludes refused pages, and a \`stalled\` flag.

## The debugging habit

Every starter here is working code with flaws: it compiles, serves the happy path, and looks right.
In each step you debug it, fix it, and prove the fix with checks that fail on the starter.

## Left out on purpose

Frontier sharding and leases, link extraction and URL normalisation, DNS pinning and TLS
verification, duplicate detection across revisions, index sharding and ranking, crawl budget
allocation between targets, and the operator UI.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Operator', sub: 'targets · job reports', x: 8, y: 50},
      {id: 'crawler', kind: 'http', label: 'Crawl service', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'robots', kind: 'external', label: 'robots.txt', sub: 'per-host rules', x: 46, y: 8},
      {id: 'registry', kind: 'db', label: 'Target registry', sub: 'job · url → target', x: 46, y: 30},
      {id: 'redis', kind: 'redis', label: 'Redis frontier', sub: 'queues · buckets · throttle', x: 46, y: 52},
      {id: 'kafka', kind: 'kafka', label: 'crawl.page', sub: 'key = host', x: 46, y: 78},
      {id: 'fetcher', kind: 'grpc', label: 'Fetcher', sub: 'Fetch · 5 s deadline', x: 68, y: 30},
      {id: 'hosts', kind: 'external', label: 'Web hosts', sub: 'GET /path', x: 88, y: 30},
      {id: 'indexer', kind: 'service', label: 'Indexer', sub: 'group crawl-index', x: 68, y: 62},
      {id: 'index', kind: 'db', label: 'Search index', sub: 'url · hash · status', x: 88, y: 52},
      {id: 'store', kind: 'db', label: 'Page store', sub: 'content by reference', x: 88, y: 78},
    ],
    edges: [
      {from: 'client', to: 'crawler', kind: 'http', label: 'HTTPS'},
      {from: 'crawler', to: 'registry', kind: 'plain', label: 'find · insert target'},
      {from: 'crawler', to: 'robots', kind: 'plain', label: 'GET /robots.txt'},
      {from: 'crawler', to: 'redis', kind: 'redis', label: 'queues · buckets'},
      {from: 'crawler', to: 'fetcher', kind: 'grpc', label: 'Fetch'},
      {from: 'fetcher', to: 'hosts', kind: 'plain', label: 'GET /path'},
      {from: 'crawler', to: 'kafka', kind: 'kafka', label: 'produce crawl.page'},
      {from: 'kafka', to: 'indexer', kind: 'kafka', label: 'consume'},
      {from: 'indexer', to: 'index', kind: 'plain', label: 'index write'},
      {from: 'indexer', to: 'store', kind: 'plain', label: 'body by reference'},
      {from: 'indexer', to: 'redis', kind: 'redis', label: 'mark indexed'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
