import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Embedding service: bounded batches, a version-aware vector cache, and an event that fires only
 * after every chunk is durable. Every step ships a starter that compiles and demos well but fails
 * under upgrade, concurrency or partial failure.
 */
export const embeddingServiceProblem: Problem = {
  id: 'embedding-service',
  title: 'Embedding Service',
  tagline: 'Batch embeddings behind a Redis vector cache keyed by model version.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Embedding Service

Retrieval starts with vectors. One service turns text into them for every tenant, caches the result
so the model server is paid once per input, and tells the indexer when a document is complete.

## The real system

OpenAI's \`POST /v1/embeddings\` takes up to 2048 inputs per request, caps each input at 8192 tokens
and 300,000 tokens per request, and names the model in every response so a caller can tell which
version produced a vector. Behind an endpoint like that sit a model server with deadlines and a
fallback, a vector cache keyed by model version, and a pipeline that indexes documents once all of
their chunks are embedded.

## What you build here

One service, **embedding**, in five steps:

1. \`POST /v1/embeddings\` turns up to 256 inputs of at most 8 KiB into vectors for the authenticated
   tenant, with an \`Idempotency-Key\` whose digest includes the model version.
2. A **Redis vector cache** keyed by \`(tenant, model version, content hash)\`, written with one
   \`SET NX EX\` so concurrent computes converge on one vector.
3. A **model server call** with a 2-second deadline, two attempts, retries only on \`UNAVAILABLE\`,
   and a fallback model whose vectors live in their own namespace.
4. An **\`embed.ready\` event** keyed by document id, produced with \`acks=all\` after the cache write
   commits, with an outbox row when the broker rejects it.
5. \`GET /v1/embeddings/{content_hash}\`, which resolves the tenant first, reads the version-scoped
   key and answers 404 on a miss.

## Left out on purpose

Tokenization and token-based pricing, the outbox relay, chunking of documents into inputs, and
the retriever that consumes the vectors. Each step is one file with a starter that runs and a set of
checks that say what must change.`,
  diagram: {
    nodes: [
      {id: 'client', label: 'Client', kind: 'client', x: 6, y: 50},
      {id: 'api', label: 'Embedding API', kind: 'http', x: 28, y: 50},
      {id: 'redis', label: 'Vector cache', kind: 'redis', x: 50, y: 20},
      {id: 'meta', label: 'vectors · documents', kind: 'db', x: 50, y: 80},
      {id: 'model', label: 'Model server', kind: 'grpc', x: 72, y: 12},
      {id: 'fallback', label: 'Fallback model', kind: 'external', x: 72, y: 40},
      {id: 'outbox', label: 'Outbox', kind: 'db', x: 72, y: 70},
      {id: 'topic', label: 'embed.ready', kind: 'kafka', x: 92, y: 24},
      {id: 'indexer', label: 'Indexer', kind: 'service', x: 92, y: 76},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'GET / SET vectors'},
      {from: 'api', to: 'meta', kind: 'plain', label: 'idempotency · documents'},
      {from: 'api', to: 'model', kind: 'grpc', label: 'Embed'},
      {from: 'model', to: 'fallback', kind: 'grpc', label: 'on UNAVAILABLE'},
      {from: 'api', to: 'outbox', kind: 'plain', label: 'undelivered event'},
      {from: 'api', to: 'topic', kind: 'kafka', label: 'produce embed.ready'},
      {from: 'topic', to: 'indexer', kind: 'kafka', label: 'consume'},
      {from: 'indexer', to: 'redis', kind: 'redis', label: 'chunk vectors'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
