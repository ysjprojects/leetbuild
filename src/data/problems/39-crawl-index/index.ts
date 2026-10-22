import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Crawl & Index on the AI-era track: the course is not "follow links from a seed URL", it is the
 * review you owe a model-generated crawler before it points itself at the internet. A target that
 * passes scheme, host and robots policy before it is enqueued → one Redis frontier per host with
 * tokens refilled and taken in one atomic script → a fetcher call with a deadline, a bounded retry
 * policy that treats 403 as terminal and 429 as a host-level backoff → page events keyed by host
 * that carry references and are announced only after the index confirms the write → a job report
 * that computes coverage from the live frontier and says out loud when a crawl has stalled.
 */
export const crawlIndexProblem: Problem = {
  id: 'crawl-index',
  title: 'Crawl & Index',
  tagline: 'Polite crawling with a durable frontier and an index whose freshness is provable.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Crawl & Index

A crawler is the piece of a search or AI platform that turns the open web into a corpus you own: it
decides which URLs are worth fetching and which are not, paces itself so it is not a denial of
service attack with a user agent, survives hosts that fail, and keeps a report an operator can
believe. The visible part is a search result; the parts that decide whether the crawl is allowed to
keep running are the admission policy, the frontier, the failure policy and the freshness report.

## The real system

Production crawlers register a target only after they have checked the scheme, resolved the host
against an allowlist and read the host's \`robots.txt\`, because a crawler that will fetch anything
is an SSRF with a queue in front of it. They keep the frontier per host, so a slow host cannot back
up the whole crawl, and they pace each host with a token bucket refilled at the rate that host
tolerates — refilled and spent in one atomic step, because two workers reading the same bucket is
how a crawl ends up at double the agreed rate. They fetch under a deadline, retry only the failures
that deserve it, treat \`403\` as a decision from the site rather than a transient error, and back a
whole host off when it answers \`429\`. They publish one event per page with the host as the key, so a
host's history stays ordered, and they carry a reference to the stored page instead of the page
itself, because a topic is retained and replicated and the web is somebody else's content. And they
report coverage that an operator can defend: live counts, the age of the oldest pending URL, and an
explicit stall flag.

## What you build here

One service, **crawld**, with five pieces:

1. \`POST /v1/crawl/targets\`: authenticated and idempotent registration of a seed URL, with the
   scheme checked, the host resolved against an allowlist, internal addresses refused before any
   fetch, and the host's robots rules read before the target is accepted.
2. A **Redis frontier**: one queue per host (\`frontier:{job_id}:{host}\`), one token bucket per host
   updated at the host's \`rate_per_minute\` inside a single atomic Lua \`EVAL\`, and a host-level
   not-before timestamp so a \`429\` slows the whole host down instead of one URL.
3. A **gRPC** fetcher call: a 5-second deadline per attempt, at most three attempts, retries only on
   \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`, a \`403\` recorded as permanently refused, a \`404\` as
   gone, and the URL off the queue before the network call so one dead host cannot block a shard.
4. A **Kafka** \`crawl.page\` event: keyed by host, carrying \`url\`, \`status\`, \`content_hash\` and
   \`body_ref\` and never the markup, published only after the index write has confirmed.
5. \`GET /v1/crawl/jobs/{job_id}\`: \`fetched\`, \`refused\`, \`pending\` and \`indexed\` counts read
   from the live frontier, the oldest pending URL's age, a coverage number that excludes refused
   pages, and a \`stalled\` flag.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Distributed frontier sharding and leases, link extraction and URL normalisation, DNS pinning and TLS
verification, duplicate detection across revisions, index sharding and ranking, crawl budget
allocation between targets, and the operator UI. The five pieces above are the ones that decide
whether the crawler is polite, isolated and defensible.`,
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
