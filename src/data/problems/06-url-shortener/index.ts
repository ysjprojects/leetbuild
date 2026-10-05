import type {Problem} from '@/lib/types';

import {shortenEndpointStep} from './steps/1-shorten-endpoint';
import {keyServiceStep} from './steps/2-key-service';
import {redirectCacheStep} from './steps/3-redirect-cache';
import {clickEventsStep} from './steps/4-click-events';
import {topLinksStep} from './steps/5-top-links';

/**
 * URL shortener: the classic interview warm-up, built as the four pieces that actually matter.
 * HTTPS `POST /shorten` with validation and custom aliases → a key-generation service over gRPC
 * handing out blocks of counters → the redirect path as one Redis hit with negative caching →
 * click events to Kafka without slowing the redirect → a consumer keeping a per-day leaderboard
 * in a sorted set.
 */
export const urlShortenerProblem: Problem = {
  id: 'url-shortener',
  title: 'URL Shortener',
  tagline: 'bit.ly in five pieces: key service over gRPC, a one-hit redirect, clicks through Kafka, a top-links board.',
  difficulty: 'easy',
  concepts: ['http', 'grpc', 'redis', 'kafka'],
  minutes: 45,
  statement: `# URL Shortener

A long URL goes in, a short one comes out, and every click on the short one must land on the long one
in a few milliseconds — the redirect is the product.

## The real system

bit.ly, TinyURL, t.co: custom domains, abuse and malware screening of the targets, link expiry and
ownership, analytics pipelines that answer "clicks by country in the last hour", global replication so
the redirect is fast from everywhere.

## What you build here

One service, **sho.rt**, backed by a links table, Redis and Kafka:

1. \`POST /shorten\` that validates the URL, accepts an optional custom alias, and answers **201** with
   the short link.
2. A **key-generation service** client over gRPC: blocks of counters reserved in one call, codes
   handed out locally as base62, refilled under a deadline.
3. \`GET /{code}\`: the redirect as **one Redis hit** (cache-aside with negative caching), answered
   with a **302** so every click is seen.
4. A **Kafka** producer emitting one \`clicks\` event per redirect without slowing it down.
5. A consumer in group \`top-links\` keeping a per-day **sorted set** of click counts, and
   \`GET /top?day=\` reading the top 10 from it.

## Left out on purpose

Accounts and link ownership, link expiry, malware screening of targets, multi-region replication and
the analytics warehouse. The five pieces above are the ones every shortener — and most read-heavy
services — are made of.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'POST /shorten · GET /{code}', x: 9, y: 50},
      {id: 'api', kind: 'http', label: 'sho.rt', sub: 'HTTPS :8443', x: 31, y: 50},
      {id: 'keys', kind: 'grpc', label: 'Key service', sub: 'ReserveBlock(size)', x: 53, y: 16},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'url:{code} · top:{day}', x: 53, y: 50},
      {id: 'db', kind: 'db', label: 'links', sub: 'code → url', x: 53, y: 84},
      {id: 'kafka', kind: 'kafka', label: 'clicks', sub: 'key = code', x: 73, y: 50},
      {id: 'worker', kind: 'service', label: 'top-links', sub: 'consumer group', x: 91, y: 50},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'keys', kind: 'grpc', label: 'ReserveBlock'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'GET / SET EX'},
      {from: 'api', to: 'db', kind: 'plain', label: 'save · lookup'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce'},
      {from: 'kafka', to: 'worker', kind: 'kafka', label: 'consume'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'ZINCRBY'},
    ],
  },
  steps: [shortenEndpointStep, keyServiceStep, redirectCacheStep, clickEventsStep, topLinksStep],
};
