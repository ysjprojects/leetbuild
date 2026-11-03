import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Crawl & Index: the course is not "follow links from a seed URL", it is the debugging you owe a
 * crawler before it points itself at the internet. A target that passes scheme, allowlist and
 * robots rules before anything is fetched → one Redis queue and token bucket per host, spent in one
 * Lua script → a fetcher call with a deadline and a status policy (retry, refuse, throttle) → page
 * events keyed by host, carrying references, announced after the index write → a job report built
 * from live counts that says when a crawl has stalled.
 */
export const crawlIndexProblem: Problem = {
  id: 'crawl-index',
  title: 'Crawl & Index',
  tagline: 'A per-host Redis frontier, a fetcher status policy, page events keyed by host and a job report.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Crawl & Index

A crawler turns the open web into a corpus you own. It decides which URLs it may fetch, paces
itself per host, survives hosts that fail or refuse, and keeps a report an operator can act on.

## The real system

Scrapy assigns every request to a download slot keyed by the URL's domain, and its AutoThrottle
extension adjusts each slot's delay from that host's measured latency, with one rule worth
copying: the latency of a non-200 response may not lower the delay. Errors mean slow down. The
same shape runs through every polite crawler: a frontier per host, a pace per host, a status
policy that tells a refusal from an outage, and a report computed from live state.

## What you build here

One service, **crawld**, on one \`crawl\` support package every step imports: \`crawl.web\`
(\`split_url\`, \`fetch_robots\`, \`fetch_page\`), \`crawl.registry\` (\`find\`, \`insert\`,
\`job_of\`), \`crawl.frontier\` (step 2, provided to the later steps), \`crawl.records\` (\`mark_fetched\`,
\`mark_refused\`, \`mark_gone\`, \`mark_failed\`, \`mark_indexed\`, \`page_of\`, \`counts\`) and
\`crawl.search\` (\`put\`, \`get\`).

1. \`POST /v1/crawl/targets\` with \`{"job_id", "url"}\` and \`X-Tenant-Id\`: scheme and host allowlist
   checked before anything is fetched, robots rules read before acceptance, one target per
   \`(job_id, url)\`, then \`frontier.enqueue\`.
2. The **Redis** frontier: \`frontier:{job}:{host}\` queues, \`pending:{job}\` (URL → first enqueue
   time), \`bucket:{job}:{host}\` token buckets refilled and spent with the pop in one Lua script, and
   \`throttle:{job}:{host}\` after a 429.
3. **gRPC** \`Fetcher.Fetch(FetchRequest{job_id, url}) → FetchReply{status, content_hash, body_ref,
   retry_after_s}\`: a 5-second deadline, three attempts on \`UNAVAILABLE\` or \`DEADLINE_EXCEEDED\`,
   403 refused, 404 gone, 429 throttles the host.
4. A **Kafka** \`crawl.page\` event keyed by host, \`{job_id, url, host, status, content_hash,
   body_ref}\`, produced with \`acks=all\` after \`search.put\` and \`mark_indexed\`.
5. \`GET /v1/crawl/jobs/{job_id}\`: live counts, \`pending\`, \`oldest_pending_age_s\`, \`stalled\` and a
   \`coverage\` that leaves refused and gone pages out.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Frontier sharding and leases, link extraction and URL normalisation, DNS pinning and TLS
verification, duplicate detection across revisions, ranking, crawl budgets between targets, and the
operator UI.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Operator', sub: 'targets · job reports', x: 8, y: 50},
      {id: 'crawler', kind: 'http', label: 'crawld', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'robots', kind: 'external', label: 'robots.txt', sub: 'crawl.web', x: 46, y: 8},
      {id: 'registry', kind: 'db', label: 'Target registry', sub: 'targets:{job} · job:{job}', x: 46, y: 30},
      {
        id: 'redis',
        kind: 'redis',
        label: 'Redis frontier',
        sub: 'frontier · bucket · throttle · pending',
        x: 46,
        y: 52,
      },
      {id: 'kafka', kind: 'kafka', label: 'crawl.page', sub: 'key = host', x: 46, y: 78},
      {id: 'fetcher', kind: 'grpc', label: 'Fetcher', sub: 'Fetch · 5 s deadline', x: 68, y: 30},
      {id: 'hosts', kind: 'external', label: 'Web hosts', sub: 'GET /path', x: 88, y: 30},
      {id: 'indexer', kind: 'service', label: 'Indexer', sub: 'group crawl-index', x: 68, y: 78},
      {id: 'index', kind: 'db', label: 'Search index', sub: 'index:{url}', x: 88, y: 52},
      {id: 'store', kind: 'db', label: 'Page store', sub: 'body_ref', x: 88, y: 78},
    ],
    edges: [
      {from: 'client', to: 'crawler', kind: 'http', label: 'HTTPS'},
      {from: 'crawler', to: 'registry', kind: 'plain', label: 'find · insert · job_of'},
      {from: 'crawler', to: 'robots', kind: 'plain', label: 'fetch_robots'},
      {from: 'crawler', to: 'redis', kind: 'redis', label: 'enqueue · take · throttle'},
      {from: 'crawler', to: 'fetcher', kind: 'grpc', label: 'Fetch'},
      {from: 'fetcher', to: 'hosts', kind: 'plain', label: 'GET /path'},
      {from: 'fetcher', to: 'store', kind: 'plain', label: 'store body'},
      {from: 'crawler', to: 'index', kind: 'plain', label: 'search.put'},
      {from: 'crawler', to: 'kafka', kind: 'kafka', label: 'produce after the index write'},
      {from: 'kafka', to: 'indexer', kind: 'kafka', label: 'consume'},
      {from: 'indexer', to: 'store', kind: 'plain', label: 'body by reference'},
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
